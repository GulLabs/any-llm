/**
 * xaiAdapter — @gullabs/xai xAI Grok provider adapter.
 *
 * Pure request⇄response mapping over the xAI Responses API (via
 * XaiClientLike). Never persists, never computes cost, never loops.
 *
 * @module
 */

import { LlmError, classifyError, assertNever } from '@gullabs/core'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Usage,
  Warning,
  FinishReason,
  JsonValue,
  AuthMaterial,
  Part,
} from '@gullabs/core'
import { buildXaiClient } from './client.js'
import type {
  XaiClientLike,
  XaiResponseCreateParams,
  XaiInputItem,
  XaiInputContentPart,
  XaiResponseShape,
  XaiUsageShape,
  XaiMessageOutputItem,
} from './client.js'

// ---------------------------------------------------------------------------
// Small object-shape helpers (mirrors google adapter's local helpers)
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badXaiRequest(message: string): LlmError {
  return new LlmError(message, { kind: 'bad_request', retryable: false })
}

// ---------------------------------------------------------------------------
// Vision / media mapping
// ---------------------------------------------------------------------------

const ALLOWED_XAI_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png'])

/** 20 MiB, xAI's documented inline-image size ceiling. */
const MAX_XAI_INLINE_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Map a single {@link Part} to its xAI Responses API input-content-part
 * equivalent.
 *
 * - `text`         → `{ type: 'input_text', text }`
 * - `inline-media` → `{ type: 'input_image', image_url: 'data:<mime>;base64,<data>' }`;
 *   rejected (`bad_request`) when `mimeType` is not jpg/jpeg/png, or when the
 *   decoded payload exceeds 20 MiB.
 * - `file-uri`     → `{ type: 'input_image', image_url: uri }` ONLY when
 *   `uri` is a public `http(s)://` URL AND `mimeType` is an allowed image
 *   type — a provider-hosted URI from another provider (e.g. Gemini's Files
 *   API `https://generativelanguage.googleapis.com/...` — which itself
 *   happens to be `https://`, but is not dereferenceable by xAI) is not
 *   portable and callers should not reuse `FileUriPart` cross-provider.
 * - `file-ref`     → `{ type: 'input_file', file_id }` for xAI Files uploads.
 *   Attaching files implicitly enables xAI's `attachment_search` agentic tool
 *   (extra tool billing may apply). Empty `fileId` → `bad_request`.
 *
 * Note: xAI enforces an undocumented server-side minimum image size
 * (observed ~8px/side, ~512 total px). This adapter does not pre-validate
 * pixel dimensions — a too-small image surfaces as a `bad_request` from the
 * live API, classified normally by {@link classifyXaiError}.
 */
function mapPart(p: Part): XaiInputContentPart {
  switch (p.kind) {
    case 'text':
      return { type: 'input_text', text: p.text }

    case 'inline-media': {
      if (!ALLOWED_XAI_IMAGE_MIME_TYPES.has(p.mimeType)) {
        throw badXaiRequest(
          `xAI vision only supports image/jpeg and image/png; got mimeType "${p.mimeType}".`,
        )
      }
      const byteLength = Buffer.from(p.data, 'base64').length
      if (byteLength > MAX_XAI_INLINE_IMAGE_BYTES) {
        throw badXaiRequest(
          `xAI inline images must be at most 20 MiB; got ${byteLength} bytes.`,
        )
      }
      return { type: 'input_image', image_url: `data:${p.mimeType};base64,${p.data}` }
    }

    case 'file-uri': {
      const isPublicHttpUrl = p.uri.startsWith('http://') || p.uri.startsWith('https://')
      const isAllowedImageType = ALLOWED_XAI_IMAGE_MIME_TYPES.has(p.mimeType)
      if (!isPublicHttpUrl || !isAllowedImageType) {
        throw badXaiRequest(
          `xAI only accepts public http(s) image URLs via FileUriPart; got scheme of "${p.uri}" / mimeType "${p.mimeType}".`,
        )
      }
      // Reject known foreign provider hosts even when scheme+mime look valid.
      if (
        p.uri.includes('generativelanguage.googleapis.com') ||
        p.uri.includes('googleapis.com/v1beta/files')
      ) {
        throw badXaiRequest(
          `xAI cannot dereference Gemini/Google Files URIs via FileUriPart; upload to xAI Files and use FileRefPart (file_id) instead. Got "${p.uri}".`,
        )
      }
      return { type: 'input_image', image_url: p.uri }
    }

    case 'file-ref': {
      if (typeof p.fileId !== 'string' || p.fileId.trim() === '') {
        throw badXaiRequest('FileRefPart.fileId must be a non-empty string.')
      }
      return { type: 'input_file', file_id: p.fileId }
    }

    default:
      return assertNever(p)
  }
}

// ---------------------------------------------------------------------------
// providerOptions.xai → explicit allowlisted mapping
// ---------------------------------------------------------------------------

function mapXaiProviderOptions(
  xaiOpts: unknown,
  model: string,
): { promptCacheKey?: string } {
  if (xaiOpts === undefined) {
    return {}
  }

  if (!isPlainRecord(xaiOpts)) {
    throw badXaiRequest(`providerOptions.xai must be an object for model "${model}".`)
  }

  const unknownKeys = Object.keys(xaiOpts).filter((key) => key !== 'promptCacheKey')
  if (unknownKeys.length > 0) {
    throw badXaiRequest(
      `providerOptions.xai contains unsupported keys [${unknownKeys.join(
        ', ',
      )}] for model "${model}". Allowed keys: promptCacheKey.`,
    )
  }

  const mapped: { promptCacheKey?: string } = {}
  if (xaiOpts['promptCacheKey'] !== undefined) {
    if (
      typeof xaiOpts['promptCacheKey'] !== 'string' ||
      xaiOpts['promptCacheKey'].length === 0
    ) {
      throw badXaiRequest(
        `providerOptions.xai.promptCacheKey must be a non-empty string for model "${model}".`,
      )
    }
    mapped.promptCacheKey = xaiOpts['promptCacheKey']
  }

  return mapped
}

// ---------------------------------------------------------------------------
// FinishReason mapping (xAI status/incomplete_details → our FinishReason)
// ---------------------------------------------------------------------------

function mapFinishReason(response: XaiResponseShape): FinishReason {
  if (response.status === 'completed') {
    return 'stop'
  }
  if (
    response.status === 'incomplete' &&
    response.incomplete_details?.reason === 'max_output_tokens'
  ) {
    return 'length'
  }
  // Any other status/incomplete_details combination without fixture
  // evidence (or a status we don't recognize) maps to 'other' — the core
  // FinishReason union is closed to these four values.
  return 'other'
}

// ---------------------------------------------------------------------------
// Usage mapping — #1 correctness rule
// ---------------------------------------------------------------------------

/**
 * Usage fields already mapped into canonical {@link Usage} counters — never
 * duplicated into `details` under their raw xAI names.
 */
const CANONICALLY_MAPPED_USAGE_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
])

/**
 * Map xAI's `usage` object to our {@link Usage} type.
 *
 * **GROSS convention (ADR-004):**
 * - `usage.input_tokens` is already GROSS (includes cached) → `inputTokens`.
 * - `usage.output_tokens` is already GROSS (includes reasoning) → `outputTokens`.
 * Unlike Gemini, xAI does not require us to sum sub-fields into the gross
 * total — the top-level fields are already gross.
 *
 * **xAI extras** (captured, not billed in `computeXaiCost`): every additional
 * NUMERIC top-level usage field (`num_sources_used`,
 * `num_server_side_tools_used` — e.g. after implicit `attachment_search` when
 * files are attached — `cost_in_usd_ticks`, and anything xAI adds later) is
 * surfaced into `details` under its raw name for host visibility. Non-numeric
 * extras (e.g. `context_details`) belong to `AdapterResult.providerMetadata`
 * (see the adapter) and the full raw payload always lands in `Usage.raw`
 * verbatim. Tool invocation fees are not yet a separate Cost lane.
 */
function mapUsage(usage: XaiUsageShape): Usage {
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens
  const thinkingTokens = usage.output_tokens_details?.reasoning_tokens
  const totalTokens = usage.total_tokens

  // Canonical details keys: input, output, cached, thinking.
  const details: Record<string, number> = {
    input: inputTokens,
    output: outputTokens,
    ...(cachedInputTokens !== undefined ? { cached: cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinking: thinkingTokens } : {}),
  }

  // Numeric xAI extras — surfaced under their raw names.
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number' && !CANONICALLY_MAPPED_USAGE_KEYS.has(key)) {
      details[key] = value
    }
  }

  const raw: JsonValue = usage as unknown as { [k: string]: JsonValue }

  const result: Usage = {
    inputTokens,
    outputTokens,
    details,
    raw,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }

  return result
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Structured-body auth-failure signature, taken verbatim from the recorded
 * live error taxonomy (`__fixtures__/09-error-taxonomy.json`,
 * `invalid_api_key` case): HTTP 400 with body
 * `{ code: 'invalid-argument', error: 'Incorrect API key provided. …' }`.
 *
 * The body `code` (`'invalid-argument'`) is NOT discriminating — xAI uses it
 * for genuinely bad requests too (e.g. `Model not found: grok-99`) — and the
 * `openai` SDK's `APIError` drops it (it hoists only the body's `error`
 * field onto `.error`). The exact message PREFIX xAI emits for bad keys is
 * therefore the signature.
 */
const XAI_AUTH_ERROR_MESSAGE_PREFIX = 'Incorrect API key provided'

/**
 * Extract the STRUCTURED error-body text from a raw thrown value.
 *
 * Consulted shapes (both are parsed-body fields, never free-form
 * `Error.message` text):
 * - `rawErr.error` as a string — the `openai` SDK's `APIError` hoists the
 *   response body's `error` field onto `.error`, which for xAI's
 *   `{ code, error }` bodies is the message string itself.
 * - `rawErr.error` as an object — the full parsed body (test fakes and
 *   hand-rolled throws of the fixture shape `{ status, error: <body> }`);
 *   its `error` (xAI) or `message` (OpenAI-style) string field is read.
 *
 * Free-form `Error.message` is deliberately ignored so arbitrary request
 * content echoed into a message (e.g. a schema-validation error quoting user
 * text that mentions "api key") can never influence classification.
 */
function extractXaiErrorBodyText(rawErr: unknown): string | undefined {
  if (rawErr === null || typeof rawErr !== 'object') {
    return undefined
  }
  const body = (rawErr as Record<string, unknown>)['error']
  if (typeof body === 'string') {
    return body
  }
  if (isPlainRecord(body)) {
    if (typeof body['error'] === 'string') {
      return body['error']
    }
    if (typeof body['message'] === 'string') {
      return body['message']
    }
  }
  return undefined
}

/** True iff the structured body matches xAI's recorded bad-API-key signature. */
function isXaiAuthFailureBody(rawErr: unknown): boolean {
  const text = extractXaiErrorBodyText(rawErr)
  return text !== undefined && text.startsWith(XAI_AUTH_ERROR_MESSAGE_PREFIX)
}

/**
 * Structured-body safety-check signature, taken from the live 2026-08-14
 * capture (`__fixtures__/15-safety-check-403.json`): HTTP 403 with
 * `err.error` as the plain string
 * `"Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER"`.
 *
 * Match the PREFIX only — `SAFETY_CHECK_TYPE_*` suffixes vary. Free-form
 * `Error.message` is never scanned (same anti-echo rule as the auth overlay).
 */
const XAI_SAFETY_CHECK_MESSAGE_PREFIX = 'Content violates usage guidelines'

/** True iff the structured body matches xAI's recorded safety-check signature. */
function isXaiSafetyCheckBody(rawErr: unknown): boolean {
  const text = extractXaiErrorBodyText(rawErr)
  return text !== undefined && text.startsWith(XAI_SAFETY_CHECK_MESSAGE_PREFIX)
}

/**
 * Message/errno signatures of a transport-level failure: the request never
 * reached xAI's servers (or the connection was severed mid-flight), so there
 * is no HTTP response for {@link classifyHttpStatus} to route by status.
 * Covers the `openai` SDK's own default message (`"Connection error."`,
 * thrown by `APIConnectionError`) plus the Node/undici errno codes that
 * surface when the underlying `fetch` rejects before a response arrives.
 */
const XAI_TRANSPORT_ERROR_PATTERN =
  /connection error|econnreset|econnrefused|etimedout|eai_again|epipe|socket hang up|fetch failed/i

/** True iff `err.message` or `err.code` matches a known transport-failure signature. */
function matchesXaiTransportSignature(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (XAI_TRANSPORT_ERROR_PATTERN.test(err.message)) return true
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && XAI_TRANSPORT_ERROR_PATTERN.test(code)
}

/**
 * True iff `rawErr` is (or wraps) a transport-level connection failure —
 * observed live killing Temporal-orchestrated audit runs when the `openai`
 * SDK's `APIConnectionError` ("Connection error.") fell through
 * `classifyError`'s generic HTTP-status classification to `kind: 'unknown',
 * retryable: false`.
 *
 * Detection order:
 * 1. `rawErr.constructor.name` matches the `openai` SDK's
 *    `APIConnectionError` / `APIConnectionTimeoutError` classes. Matched by
 *    constructor name rather than `instanceof` so this file does not need a
 *    runtime import of `openai` — per `client.ts`, that package is imported
 *    ONLY in `buildXaiClient`, keeping unit tests independent of the real
 *    SDK.
 * 2. `rawErr.message` / `rawErr.code` matches a known transport-failure
 *    signature (handles the SDK's default message text directly, without
 *    relying on the class name surviving minification).
 * 3. A wrapped `rawErr.cause` matches either of the above —
 *    `APIConnectionError` attaches the underlying fetch/socket error as
 *    `.cause`.
 */
function isXaiTransportError(rawErr: unknown): boolean {
  if (!(rawErr instanceof Error)) return false

  const ctorName = rawErr.constructor.name
  if (ctorName === 'APIConnectionError' || ctorName === 'APIConnectionTimeoutError') {
    return true
  }

  if (matchesXaiTransportSignature(rawErr)) return true

  const cause = (rawErr as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const causeCtorName = cause.constructor.name
    if (
      causeCtorName === 'APIConnectionError' ||
      causeCtorName === 'APIConnectionTimeoutError'
    ) {
      return true
    }
    if (matchesXaiTransportSignature(cause)) return true
  }

  return false
}

/**
 * Classify a raw error thrown from the xAI Responses API call into a typed
 * {@link LlmError}.
 *
 * HTTP status is a hint, not a kind. Overlays inspect the STRUCTURED parsed
 * body only — never free-form `Error.message` — so echoed user content cannot
 * change classification.
 *
 * 1. Already an {@link LlmError} → returned unchanged (including an untagged
 *    one).
 * 2. HTTP 400 whose structured body starts with
 *    `"Incorrect API key provided"` (fixture 09; prefix only — the SDK may
 *    drop `code`) → `invalid_auth`.
 * 3. HTTP 403 whose structured body starts with
 *    `"Content violates usage guidelines"` (fixture 15; `SAFETY_CHECK_TYPE_*`
 *    suffixes vary) → `content_filter`. A bare 403 without that body stays
 *    the core default, `invalid_auth`.
 * 4. `kind: 'unknown'` with a known transport-failure signature (see
 *    {@link isXaiTransportError}) → `server`, retryable. A connection that
 *    never reached xAI is not the caller's fault.
 * 5. Else rebuild the core classification tagged `provider: 'xai'`.
 */
export function classifyXaiError(rawErr: unknown): LlmError {
  if (rawErr instanceof LlmError) {
    return rawErr
  }

  const base = classifyError(rawErr)

  if (base.httpStatus === 400 && isXaiAuthFailureBody(rawErr)) {
    return new LlmError(base.message, {
      kind: 'invalid_auth',
      retryable: false,
      httpStatus: base.httpStatus,
      provider: 'xai',
      cause: base.cause ?? rawErr,
    })
  }

  if (base.httpStatus === 403 && isXaiSafetyCheckBody(rawErr)) {
    const bodyText = extractXaiErrorBodyText(rawErr)
    return new LlmError(bodyText ?? base.message, {
      kind: 'content_filter',
      retryable: false,
      httpStatus: base.httpStatus,
      provider: 'xai',
      cause: base.cause ?? rawErr,
    })
  }

  if (base.kind === 'unknown' && isXaiTransportError(rawErr)) {
    return new LlmError(base.message, {
      kind: 'server',
      retryable: true,
      provider: 'xai',
      cause: base.cause ?? rawErr,
    })
  }

  return new LlmError(base.message, {
    kind: base.kind,
    retryable: base.retryable,
    ...(base.httpStatus !== undefined ? { httpStatus: base.httpStatus } : {}),
    ...(base.retryAfterMs !== undefined ? { retryAfterMs: base.retryAfterMs } : {}),
    provider: 'xai',
    cause: base.cause ?? rawErr,
  })
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface XaiAdapterOptions {
  /**
   * Inject a pre-built client (real or fake).
   * When omitted, `buildXaiClient` is called with `ctx.auth` at call time,
   * inside the classified try/catch so any construction failure is wrapped
   * as a typed `LlmError`.
   */
  client?: XaiClientLike
  /**
   * @internal Testing-only.
   *
   * Override the default `buildXaiClient` factory. Allows unit tests to
   * simulate construction failures without importing the real `openai` SDK.
   * Never set this in production code. Mirrors `GeminiAdapterOptions._clientFactory`.
   */
  _clientFactory?: (auth: AuthMaterial) => XaiClientLike | Promise<XaiClientLike>
}

// ---------------------------------------------------------------------------
// xaiAdapter factory
// ---------------------------------------------------------------------------

/**
 * Create an xAI Grok provider adapter (Responses API).
 *
 * @param opts.client - Optional pre-built client (e.g. for testing).
 */
export function xaiAdapter(opts?: XaiAdapterOptions): ProviderAdapter {
  return {
    id: 'xai',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      if (req.provider !== 'xai') {
        throw new LlmError(
          `xaiAdapter received a request for provider "${req.provider}", expected "xai".`,
          { kind: 'bad_request', retryable: false },
        )
      }

      const warnings: Warning[] = []
      const model = req.model
      const genConfig = req.config

      // ------------------------------------------------------------------
      // 1. Map messages → input
      // ------------------------------------------------------------------
      const input: XaiInputItem[] = req.messages.map((msg) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.parts.map(mapPart),
      }))

      // ------------------------------------------------------------------
      // 2. Build request params
      // ------------------------------------------------------------------
      const params: XaiResponseCreateParams = {
        model,
        input,
        store: false,
      }

      if (req.system !== undefined) {
        params.instructions = req.system
      }

      // Sampling — forwarded verbatim, no clamping (schema enforces bounds
      // upstream of the adapter).
      if (genConfig.temperature !== undefined) {
        params.temperature = genConfig.temperature
      }
      if (genConfig.topP !== undefined) {
        params.top_p = genConfig.topP
      }

      // max_output_tokens — no artificial ceiling; truncation surfaces as
      // finishReason:'length', not an error (see mapFinishReason).
      if (genConfig.maxOutputTokens !== undefined) {
        params.max_output_tokens = genConfig.maxOutputTokens
      }

      // serviceTier — descriptor-driven. grok-4.5 admits none (live 2026-07-09
      // rejected `service_tier`). grok-4.6 admits `'priority'` only
      // (live-verified 2026-08-12: `priority` is echoed; `flex` is silently
      // remapped to `default` by xAI, so this adapter rejects it rather
      // than forwarding a no-op).
      const admittedTiers = req.modelDescriptor?.capabilities?.serviceTiers
      if (genConfig.serviceTier !== undefined) {
        if (
          admittedTiers === undefined ||
          !admittedTiers.includes(genConfig.serviceTier)
        ) {
          throw badXaiRequest(
            `serviceTier is not supported for xai model "${model}" (got "${genConfig.serviceTier}").`,
          )
        }
        if (genConfig.serviceTier !== 'priority') {
          throw badXaiRequest(
            `serviceTier "${genConfig.serviceTier}" is not supported for xai model "${model}" (only "priority" is admitted).`,
          )
        }
        params.service_tier = 'priority'
      }

      // ------------------------------------------------------------------
      // 3. Reasoning → { effort }
      //
      // Admitted efforts are descriptor-owned. grok-4.5: `'low' | 'high'`
      // (2026-07-09 live probe; 2026-08-12 also accepted `medium`/`xhigh`
      // but this library does not silently widen 4.5 — hosts stay on the
      // frozen 4.5 schema). grok-4.6: `'low' | 'medium' | 'high' | 'xhigh'`
      // (live-verified 2026-08-12). `'none'` is rejected by both. budgetTokens
      // is not supported (level-style reasoning). includeThoughts is a no-op
      // for xAI — reasoning summaries come back unconditionally whenever
      // reasoning ran, so reasoningText is always surfaced below regardless
      // of this flag; we do not throw on it since it is a legitimate
      // ReasoningIntent field this provider simply doesn't need.
      // ------------------------------------------------------------------
      const reasoning = genConfig.reasoning
      if (reasoning !== undefined) {
        if (reasoning.budgetTokens !== undefined) {
          throw badXaiRequest(
            `reasoning.budgetTokens is not supported for model "${model}" (xAI uses effort-level reasoning, not token budgets); use reasoning.effort instead.`,
          )
        }

        if (reasoning.effort !== undefined) {
          const effort = reasoning.effort
          if (effort === 'none') {
            throw badXaiRequest(
              `reasoning.effort "none" is not supported for xai model "${model}".`,
            )
          }
          const admitted = req.modelDescriptor?.capabilities?.admittedReasoningEfforts
          // Fail-closed without a descriptor, matching the serviceTier branch:
          // a host-supplied descriptor that omits admittedReasoningEfforts
          // must not silently re-admit medium/xhigh onto grok-4.5.
          if (admitted === undefined || !admitted.includes(effort)) {
            throw badXaiRequest(
              `reasoning.effort "${effort}" is not supported for xai model "${model}".`,
            )
          }
          params.reasoning = { effort }
        }
      }

      // ------------------------------------------------------------------
      // 4. Structured output → text.format (NOT response_format)
      // ------------------------------------------------------------------
      const structuredOutputRequested = req.outputJsonSchema !== undefined
      if (structuredOutputRequested) {
        const schema = req.outputJsonSchema
        const name =
          isPlainRecord(schema) &&
          typeof schema['title'] === 'string' &&
          schema['title'].length > 0
            ? schema['title']
            : 'structured_output'
        params.text = {
          format: { type: 'json_schema', name, schema, strict: true },
        }
      }

      // ------------------------------------------------------------------
      // 5. providerOptions.xai → prompt_cache_key
      // ------------------------------------------------------------------
      const xaiProviderConfig = mapXaiProviderOptions(
        genConfig.providerOptions?.['xai'],
        model,
      )
      if (xaiProviderConfig.promptCacheKey !== undefined) {
        params.prompt_cache_key = xaiProviderConfig.promptCacheKey
      }

      // ------------------------------------------------------------------
      // 6. Client construction + SDK call — inside the classifier so ANY
      //    failure (including bad auth construction) is rethrown as a typed
      //    LlmError(provider:'xai').
      // ------------------------------------------------------------------
      let response: XaiResponseShape
      try {
        const buildClient = opts?._clientFactory ?? buildXaiClient
        const client: XaiClientLike =
          opts?.client !== undefined ? opts.client : await buildClient(ctx.auth)
        ctx.logger.debug(
          { model, configKeys: Object.keys(params) },
          'llm.adapter.dispatch',
        )
        response = await client.responses.create(
          params,
          ctx.signal !== undefined ? { signal: ctx.signal } : undefined,
        )
      } catch (rawErr) {
        throw classifyXaiError(rawErr)
      }

      // ------------------------------------------------------------------
      // 7. Map response
      // ------------------------------------------------------------------
      let text = ''
      let reasoningText: string | undefined
      const messageItems: XaiMessageOutputItem[] = []

      for (const item of response.output) {
        if (item.type === 'message') {
          messageItems.push(item)
        } else {
          const joined = item.summary.map((s) => s.text).join('')
          if (joined.length > 0) {
            reasoningText = (reasoningText ?? '') + joined
          }
        }
      }

      // xAI's Responses API convention: when multiple `type: 'message'`
      // output items are present, the LAST one is the response — earlier
      // ones are superseded (observed live in strict json_schema mode,
      // grok-4.5, reasoning effort high: two complete-JSON message items in
      // one response). Concatenating across items corrupts the payload
      // (e.g. two JSON documents back-to-back); joining `output_text` parts
      // WITHIN a single message item is still correct (segmentation, not
      // duplication).
      if (messageItems.length > 0) {
        const lastMessage = messageItems[messageItems.length - 1] as XaiMessageOutputItem
        text = lastMessage.content.map((part) => part.text).join('')

        if (messageItems.length > 1) {
          warnings.push({
            type: 'other',
            message: `xai: response contained ${messageItems.length} message output items; using the last one and discarding ${
              messageItems.length - 1
            } earlier message item(s).`,
          })
        }
      }

      // Parse structured output (JSON text → rawStructured).
      let rawStructured: unknown
      if (structuredOutputRequested && text.length > 0) {
        try {
          rawStructured = JSON.parse(text)
        } catch {
          // Core reports unparsed via absence of rawStructured; callers own
          // validation/retry policy (ADR-009).
        }
      }

      const usage = mapUsage(response.usage)
      const finishReason = mapFinishReason(response)

      // Response-level metadata → providerMetadata: usage.context_details
      // (non-numeric usage extra) and response.metadata (e.g.
      // system_fingerprint). Numeric usage extras live in usage.details; the
      // full raw usage payload is already in usage.raw.
      const providerMeta: { [k: string]: JsonValue } = {}
      const contextDetails = response.usage['context_details']
      if (isPlainRecord(contextDetails)) {
        providerMeta['context_details'] = contextDetails as unknown as JsonValue
      }
      if (isPlainRecord(response.metadata)) {
        providerMeta['metadata'] = response.metadata as unknown as JsonValue
      }

      // Surface the echoed tier verbatim. xAI can remap (flex → default);
      // discarding non-priority values would let the engine fall back to the
      // requested tier and bill 2× on a default-served call.
      const servedServiceTier =
        typeof response.service_tier === 'string' && response.service_tier.length > 0
          ? response.service_tier
          : undefined

      const result: AdapterResult = {
        model: response.model,
        usage,
        warnings,
        finishReason,
        responseId: response.id,
        ...(text.length > 0 ? { text } : {}),
        ...(reasoningText !== undefined ? { reasoningText } : {}),
        ...(rawStructured !== undefined ? { rawStructured } : {}),
        ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
        ...(Object.keys(providerMeta).length > 0
          ? { providerMetadata: providerMeta }
          : {}),
      }

      return result
    },
  }
}
