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
      return { type: 'input_image', image_url: p.uri }
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
 * **xAI extras** (captured, not billed): every additional NUMERIC top-level
 * usage field (`num_sources_used`, `num_server_side_tools_used`,
 * `cost_in_usd_ticks`, and anything xAI adds later) is surfaced into
 * `details` under its raw name. Non-numeric extras (e.g. `context_details`)
 * belong to `AdapterResult.providerMetadata` (see the adapter) and the full
 * raw payload always lands in `Usage.raw` verbatim.
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
 * Classify a raw error thrown from the xAI Responses API call into a typed
 * {@link LlmError}.
 *
 * xAI's Responses API returns HTTP 400 (NOT 401) for an invalid API key, so
 * generic {@link classifyHttpStatus}-based classification (which maps 400 →
 * `bad_request`) is wrong for this one case. This function special-cases it:
 * a 400 response whose STRUCTURED parsed body matches the exact recorded
 * xAI auth-failure signature (`code: 'invalid-argument'` AND message prefix
 * `"Incorrect API key provided"` — see fixture 09) is reclassified as
 * `invalid_auth`. Free-form `Error.message` text is never scanned, so a 400
 * whose message merely *mentions* an API key (e.g. schema validation echoing
 * user content) stays `bad_request`. When the structured body is unavailable
 * or unparseable, classification falls through to the status-based
 * `classifyError` from `@gullabs/core`.
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

      // serviceTier — xAI has no service-tier concept for grok-4.5.
      if (genConfig.serviceTier !== undefined) {
        throw badXaiRequest(
          `serviceTier is not supported for xai models (got "${genConfig.serviceTier}").`,
        )
      }

      // ------------------------------------------------------------------
      // 3. Reasoning → { effort: 'low' | 'high' }
      //
      // grok-4.5 admits ONLY 'low' | 'high' (default 'high'); 'none' and
      // 'medium' are rejected by the live API. budgetTokens is not
      // supported (level-style reasoning, no token budget). includeThoughts
      // is a no-op for xAI — reasoning summaries come back unconditionally
      // whenever reasoning ran, so reasoningText is always surfaced below
      // regardless of this flag; we do not throw on it since it is a
      // legitimate ReasoningIntent field this provider simply doesn't need.
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
          if (effort !== 'low' && effort !== 'high') {
            throw badXaiRequest(
              `reasoning.effort "${effort}" is not supported for xai model "${model}" (only "low" and "high" are admitted).`,
            )
          }
          const admitted = req.modelDescriptor?.capabilities?.admittedReasoningEfforts
          if (admitted !== undefined && !admitted.includes(effort)) {
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

      for (const item of response.output) {
        if (item.type === 'message') {
          text += item.content.map((part) => part.text).join('')
        } else {
          const joined = item.summary.map((s) => s.text).join('')
          if (joined.length > 0) {
            reasoningText = (reasoningText ?? '') + joined
          }
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

      const result: AdapterResult = {
        model: response.model,
        usage,
        warnings,
        finishReason,
        responseId: response.id,
        ...(text.length > 0 ? { text } : {}),
        ...(reasoningText !== undefined ? { reasoningText } : {}),
        ...(rawStructured !== undefined ? { rawStructured } : {}),
        ...(Object.keys(providerMeta).length > 0
          ? { providerMetadata: providerMeta }
          : {}),
      }

      return result
    },
  }
}
