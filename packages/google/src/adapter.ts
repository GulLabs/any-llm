/**
 * geminiAdapter — @gullabs/google Gemini provider adapter.
 *
 * Pure request⇄response mapping over @google/genai (via GeminiClientLike).
 * Never persists, never computes cost, never loops.
 *
 * @module
 */

import { LlmError, classifyError, assertNever, EFFORT_BUDGET } from '@gullabs/core'
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
import {
  buildGoogleClient,
  FLEX_DEFAULT_TIMEOUT_MS,
  STANDARD_DEFAULT_TIMEOUT_MS,
  TRANSPORT_TIMEOUT_BUFFER_MS,
} from './client.js'
import type {
  GeminiClientLike,
  GeminiGenerateConfig,
  GeminiContent,
  GeminiContentPart,
  GeminiResponseShape,
  GeminiUsageMetadataShape,
} from './client.js'
import { isGeminiCapacityError } from './flex-fallback.js'

// ---------------------------------------------------------------------------
// Exported types for consumers that inject a custom client
// ---------------------------------------------------------------------------
export type { GeminiClientLike }

// ---------------------------------------------------------------------------
// FinishReason mapping (Gemini SDK enum → our FinishReason)
// ---------------------------------------------------------------------------

function mapFinishReason(raw: string | undefined): FinishReason | undefined {
  if (raw === undefined) return undefined
  switch (raw) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'IMAGE_SAFETY':
      return 'content_filter'
    default:
      return 'other'
  }
}

// ---------------------------------------------------------------------------
// mediaResolution mapping (normalized hint → Gemini PartMediaResolutionLevel)
// ---------------------------------------------------------------------------

/**
 * Map our normalized cross-provider `mediaResolution` hint to the Gemini
 * `PartMediaResolutionLevel` string-enum value emitted on `Part.mediaResolution`.
 */
function mapMediaResolution(
  res: 'low' | 'medium' | 'high',
): 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH' {
  switch (res) {
    case 'low':
      return 'MEDIA_RESOLUTION_LOW'
    case 'medium':
      return 'MEDIA_RESOLUTION_MEDIUM'
    case 'high':
      return 'MEDIA_RESOLUTION_HIGH'
    default:
      return assertNever(res)
  }
}

// ---------------------------------------------------------------------------
// Usage mapping — #1 correctness rule
// ---------------------------------------------------------------------------

/**
 * Map Gemini usageMetadata to our Usage type.
 *
 * **GROSS convention enforced here:**
 * - outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)
 *   → thinkingTokens ⊆ outputTokens so cost math doesn't double-count.
 * - inputTokens = promptTokenCount (cachedContentTokenCount is already a
 *   subset of promptTokenCount → cachedInputTokens = cachedContentTokenCount).
 */
function mapUsage(meta: GeminiUsageMetadataShape | undefined): Usage {
  const promptTokenCount = meta?.promptTokenCount ?? 0
  const candidatesTokenCount = meta?.candidatesTokenCount ?? 0
  const cachedContentTokenCount = meta?.cachedContentTokenCount
  const thoughtsTokenCount = meta?.thoughtsTokenCount

  // #1 RULE: outputTokens = candidates + thoughts (GROSS; thinking ⊆ output)
  const outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)
  const inputTokens = promptTokenCount
  const totalTokens = meta?.totalTokenCount

  // Canonical details keys: input, cached, output.
  const details: Record<string, number> = {
    input: inputTokens,
    output: outputTokens,
    ...(cachedContentTokenCount !== undefined ? { cached: cachedContentTokenCount } : {}),
    ...(thoughtsTokenCount !== undefined ? { thinking: thoughtsTokenCount } : {}),
  }

  // Raw: the full usageMetadata object verbatim (as JsonValue).
  const raw: JsonValue =
    meta !== undefined ? (meta as unknown as { [k: string]: JsonValue }) : null

  const usage: Usage = {
    inputTokens,
    outputTokens,
    details,
    raw,
    ...(cachedContentTokenCount !== undefined
      ? { cachedInputTokens: cachedContentTokenCount }
      : {}),
    ...(thoughtsTokenCount !== undefined ? { thinkingTokens: thoughtsTokenCount } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }

  return usage
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface GeminiAdapterOptions {
  /**
   * Inject a pre-built client (real or fake).
   * When omitted, `buildGoogleClient` is called with `ctx.auth` at call time,
   * inside the classified try/catch so any construction failure is wrapped
   * as a typed `LlmError`.
   */
  client?: GeminiClientLike
  /**
   * @internal Testing-only.
   *
   * Override the default `buildGoogleClient` factory.  Allows unit tests to
   * simulate construction failures (e.g. bad credentials) without importing
   * the real `@google/genai` SDK.  Never set this in production code.
   */
  _clientFactory?: (auth: AuthMaterial) => GeminiClientLike | Promise<GeminiClientLike>
}

// ---------------------------------------------------------------------------
// geminiAdapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Gemini provider adapter.
 *
 * @param opts.client - Optional pre-built client (e.g. for testing).
 */
export function geminiAdapter(opts?: GeminiAdapterOptions): ProviderAdapter {
  return {
    id: 'google',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      const warnings: Warning[] = []
      const model = req.model

      // ------------------------------------------------------------------
      // 1. Map messages → contents
      // ------------------------------------------------------------------

      /**
       * Map a single {@link Part} to its Gemini SDK equivalent.
       *
       * - `text`          → `{ text }`
       * - `inline-media`  → `{ inlineData: { mimeType, data } }` + optional `mediaResolution`
       * - `file-uri`      → `{ fileData: { mimeType, fileUri } }` + optional `mediaResolution`
       *
       * `mediaResolution` IS supported as a per-part field by the Gemini SDK
       * (`Part.mediaResolution`).  The normalised value is mapped to the
       * `PartMediaResolutionLevel` string enum before emission.
       */
      const mapPart = (p: Part): GeminiContentPart => {
        switch (p.kind) {
          case 'text':
            return { text: p.text }

          case 'inline-media': {
            return {
              inlineData: {
                mimeType: p.mimeType,
                data: p.data,
              },
              ...(p.mediaResolution !== undefined
                ? { mediaResolution: { level: mapMediaResolution(p.mediaResolution) } }
                : {}),
            }
          }

          case 'file-uri': {
            return {
              fileData: {
                mimeType: p.mimeType,
                fileUri: p.uri,
              },
              ...(p.mediaResolution !== undefined
                ? { mediaResolution: { level: mapMediaResolution(p.mediaResolution) } }
                : {}),
            }
          }

          default:
            return assertNever(p)
        }
      }

      const contents: GeminiContent[] = req.messages.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: msg.parts.map(mapPart),
      }))

      // ------------------------------------------------------------------
      // 2. Build GenerateContentConfig
      // ------------------------------------------------------------------
      const genConfig = req.config
      const config: GeminiGenerateConfig = {}

      // System instruction
      if (req.system !== undefined) {
        config.systemInstruction = { parts: [{ text: req.system }] }
      }

      // Basic generation parameters (only include when defined)
      if (genConfig.temperature !== undefined) {
        config.temperature = genConfig.temperature
      }
      if (genConfig.topP !== undefined) {
        config.topP = genConfig.topP
      }
      if (genConfig.topK !== undefined) {
        config.topK = genConfig.topK
      }
      if (genConfig.maxOutputTokens !== undefined) {
        config.maxOutputTokens = genConfig.maxOutputTokens
      }
      if (genConfig.stopSequences !== undefined) {
        config.stopSequences = genConfig.stopSequences
      }

      // Service tier (FLEX or STANDARD)
      // Real SDK: GenerateContentConfig.serviceTier = ServiceTier enum ("flex"|"standard")
      const explicit = (genConfig as { serviceTier?: 'flex' | 'standard' }).serviceTier
      const supported = req.modelDescriptor?.capabilities?.serviceTiers
      if (explicit !== undefined) {
        // caller explicitly chose a tier — reject if the model can't honour it
        if (
          req.modelDescriptor !== undefined &&
          (supported === undefined || !supported.includes(explicit))
        ) {
          throw new LlmError(
            `serviceTier "${explicit}" is not supported for model "${model}".`,
            { kind: 'bad_request', retryable: false },
          )
        }
        config.serviceTier = explicit
      } else {
        // no explicit choice — default to flex only when the model supports it
        if (req.modelDescriptor === undefined) {
          config.serviceTier = 'flex'
        } else if (supported?.includes('flex') === true) {
          config.serviceTier = 'flex'
        }
        // otherwise omit serviceTier entirely
      }

      // ------------------------------------------------------------------
      // 3. Reasoning → thinkingConfig
      // ------------------------------------------------------------------
      const reasoning = genConfig.reasoning
      if (reasoning !== undefined) {
        const reasoningApi = req.modelDescriptor?.capabilities?.reasoningApi

        if (reasoning.effort !== undefined && reasoning.budgetTokens !== undefined) {
          throw new LlmError(
            `Provide either reasoning.effort or reasoning.budgetTokens, not both, for model "${model}".`,
            { kind: 'bad_request', retryable: false },
          )
        }

        if (reasoningApi === 'budget') {
          // gemini-2.5* → thinkingBudget
          const budget =
            reasoning.budgetTokens !== undefined
              ? reasoning.budgetTokens
              : reasoning.effort !== undefined
              ? EFFORT_BUDGET[reasoning.effort]
              : undefined

          config.thinkingConfig = {
            ...(budget !== undefined ? { thinkingBudget: budget } : {}),
            ...(reasoning.includeThoughts === true ? { includeThoughts: true } : {}),
          }
        } else if (reasoningApi === 'level') {
          // gemini-3.* → thinkingLevel
          if (reasoning.budgetTokens !== undefined) {
            throw new LlmError(
              `reasoning.budgetTokens is not supported for model "${model}" (it uses thinkingLevel, not thinkingBudget); use reasoning.effort instead.`,
              { kind: 'bad_request', retryable: false },
            )
          }

          // Real SDK ThinkingLevel enum: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL"
          let thinkingLevel: string | undefined
          if (reasoning.effort !== undefined) {
            switch (reasoning.effort) {
              case 'none':
                thinkingLevel = 'MINIMAL'
                break
              case 'low':
                thinkingLevel = 'LOW'
                break
              case 'medium':
                thinkingLevel = 'MEDIUM'
                break
              case 'high':
                thinkingLevel = 'HIGH'
                break
              default:
                assertNever(reasoning.effort)
            }
          }

          config.thinkingConfig = {
            ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
            ...(reasoning.includeThoughts === true ? { includeThoughts: true } : {}),
          }
        } else {
          throw new LlmError(
            `Model "${model}" does not support reasoning/thinkingConfig.`,
            { kind: 'bad_request', retryable: false },
          )
        }
      }

      // ------------------------------------------------------------------
      // 4. Structured output → responseMimeType + responseSchema
      // ------------------------------------------------------------------
      const structuredOutputRequested = req.outputJsonSchema !== undefined
      if (structuredOutputRequested) {
        const nativeStructuredOutput =
          req.modelDescriptor?.capabilities?.nativeStructuredOutput !== false

        if (nativeStructuredOutput) {
          config.responseMimeType = 'application/json'
          config.responseSchema = req.outputJsonSchema as NonNullable<
            GeminiGenerateConfig['responseSchema']
          >
        }
      }

      // ------------------------------------------------------------------
      // 5. providerOptions.google → spread verbatim (last, caller wins)
      // ------------------------------------------------------------------
      const googleOpts = genConfig.providerOptions?.['google']
      if (
        googleOpts !== undefined &&
        typeof googleOpts === 'object' &&
        googleOpts !== null
      ) {
        Object.assign(config, googleOpts)
      }

      // ------------------------------------------------------------------
      // 5a. Re-assert serviceTier validity AFTER providerOptions merge.
      //     providerOptions.google is a last-write-wins escape hatch; without
      //     this re-check a caller can inject an arbitrary serviceTier string
      //     that bypasses the earlier validation.
      // ------------------------------------------------------------------
      const mergedServiceTier = (config as { serviceTier?: string }).serviceTier
      if (mergedServiceTier !== undefined && req.modelDescriptor !== undefined) {
        const supportedAfterMerge = req.modelDescriptor.capabilities?.serviceTiers
        if (
          supportedAfterMerge === undefined ||
          !supportedAfterMerge.includes(mergedServiceTier as 'flex' | 'standard')
        ) {
          throw new LlmError(
            `serviceTier "${mergedServiceTier}" is not supported for model "${model}".`,
            { kind: 'bad_request', retryable: false },
          )
        }
      }

      // ------------------------------------------------------------------
      // 5c. Re-assert fixed-sampling invariant AFTER providerOptions merge.
      //     providerOptions.google is a last-write-wins escape hatch, but on
      //     Gemini 3.x (sampling: 'fixed') the API rejects temperature/topP/topK
      //     unconditionally.  Throw so the caller knows they sent bad config.
      // ------------------------------------------------------------------
      if (req.modelDescriptor?.capabilities?.sampling === 'fixed') {
        const offendingSampling: string[] = []
        if ('temperature' in config) {
          offendingSampling.push('temperature')
        }
        if ('topP' in config) {
          offendingSampling.push('topP')
        }
        if ('topK' in config) {
          offendingSampling.push('topK')
        }
        if (offendingSampling.length > 0) {
          throw new LlmError(
            `Sampling parameters [${offendingSampling.join(
              ', ',
            )}] are not supported for model "${model}" (fixed sampling); they were supplied via providerOptions.google.`,
            { kind: 'bad_request', retryable: false },
          )
        }
      }

      // ------------------------------------------------------------------
      // 5b. Grounding ↔ structured-output conflict guard
      //     Tools arrive via providerOptions.google; check after the merge.
      // ------------------------------------------------------------------
      const configAsAny = config as { tools?: unknown[] }
      const groundingRequested =
        Array.isArray(configAsAny.tools) &&
        configAsAny.tools.some((t): boolean => {
          if (t !== null && typeof t === 'object') {
            const tool = t as Record<string, unknown>
            return 'googleSearch' in tool || 'googleSearchRetrieval' in tool
          }
          return false
        })

      if (groundingRequested && structuredOutputRequested) {
        throw new LlmError(
          'Grounding (googleSearch) cannot be combined with structured output (output.jsonSchema) on Gemini; choose one.',
          { kind: 'bad_request', retryable: false },
        )
      }

      // ------------------------------------------------------------------
      // 6. AbortSignal passthrough + FIX A-2: client-side flex ceiling
      //
      // FIX A-2 belt-and-suspenders: @google/genai issue #1277 — on some SDK
      // versions httpOptions.timeout is a no-op for generateContent.  On the
      // flex-default path (flex tier, no explicit timeoutMs) the engine arms NO
      // AbortSignal; relying solely on httpOptions.timeout risks a silent hang.
      // We arm our own AbortController here and combine it with any incoming
      // signal so WE enforce the ceiling regardless of the SDK bug.
      //
      // Flex and standard default paths need this extra timer when timeoutMs is
      // absent. When timeoutMs IS set the engine already arms a hard AbortSignal
      // at exactly timeoutMs.
      //
      // Abort reason uses DOMException with name 'TimeoutError' so classifyError
      // maps the resulting LlmError to kind:'timeout' (retryable:true), matching
      // how the rest of the codebase surfaces timeout errors.
      //
      // AbortSignal.any requires Node ≥ 20.3; our engine floor is Node ≥ 20,
      // so this is always available in supported environments.
      //
      // Real SDK: GenerateContentConfig.abortSignal (in config, NOT in params)
      // ------------------------------------------------------------------
      let tierTimeoutHandle: ReturnType<typeof setTimeout> | undefined

      const clearTierTimeout = (): void => {
        if (tierTimeoutHandle !== undefined) {
          clearTimeout(tierTimeoutHandle)
          tierTimeoutHandle = undefined
        }
      }

      const applyTierTimeout = (tier: string | undefined): void => {
        clearTierTimeout()
        delete config.abortSignal

        const defaultTimeoutMs =
          genConfig.timeoutMs === undefined
            ? tier === 'flex'
              ? FLEX_DEFAULT_TIMEOUT_MS
              : tier === 'standard'
              ? STANDARD_DEFAULT_TIMEOUT_MS
              : undefined
            : undefined

        if (defaultTimeoutMs !== undefined) {
          const tierController = new AbortController()
          const tierLabel = tier === 'standard' ? 'Standard' : 'Flex'
          const timeoutReason = new DOMException(
            `${tierLabel} timeout: call exceeded ${defaultTimeoutMs}ms client-side ceiling` +
              ' (@google/genai #1277 belt-and-suspenders)',
            'TimeoutError',
          )
          tierTimeoutHandle = setTimeout(() => {
            tierController.abort(timeoutReason)
          }, defaultTimeoutMs)
          config.abortSignal =
            ctx.signal !== undefined
              ? AbortSignal.any([tierController.signal, ctx.signal])
              : tierController.signal
        } else if (ctx.signal !== undefined) {
          config.abortSignal = ctx.signal
        }
      }

      applyTierTimeout(config.serviceTier)

      // ------------------------------------------------------------------
      // 7. Transport timeout — set httpOptions.timeout so the @google/genai
      //    HTTP transport does NOT preempt the AbortSignal hard ceiling.
      //
      //    Policy (precedence, highest first):
      //    1. Caller-supplied httpOptions via providerOptions.google.httpOptions
      //       WIN unconditionally; any extra fields are also preserved.
      //    2. timeoutMs is set → computed transport timeout = timeoutMs +
      //       TRANSPORT_TIMEOUT_BUFFER_MS so the engine's AbortSignal (hard
      //       ceiling at timeoutMs) always fires before the SDK transport timer.
      //    3. serviceTier 'flex', no timeoutMs → FLEX_DEFAULT_TIMEOUT_MS (no
      //       buffer; there is no engine AbortSignal deadline in this case).
      //    4. serviceTier 'standard', no timeoutMs → STANDARD_DEFAULT_TIMEOUT_MS.
      //
      //    Merge order: computed timeout first, caller's httpOptions spread on
      //    top so caller values always win.  Only assign config.httpOptions when
      //    the merged object is non-empty (exactOptionalPropertyTypes-safe).
      // ------------------------------------------------------------------

      // Capture caller-supplied httpOptions BEFORE we overwrite.
      // These arrived via Object.assign(config, googleOpts) above and may
      // include a caller timeout and/or other httpOptions fields.
      const callerHttpOptions = config.httpOptions as Record<string, unknown> | undefined

      const computedTimeoutMs: number | undefined =
        genConfig.timeoutMs !== undefined
          ? genConfig.timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS
          : config.serviceTier === 'flex'
          ? FLEX_DEFAULT_TIMEOUT_MS
          : config.serviceTier === 'standard'
          ? STANDARD_DEFAULT_TIMEOUT_MS
          : undefined

      // Merge: our computed timeout is the base; caller wins on top.
      const mergedHttpOptions: Record<string, unknown> = {
        ...(computedTimeoutMs !== undefined ? { timeout: computedTimeoutMs } : {}),
        ...callerHttpOptions,
      }

      if (Object.keys(mergedHttpOptions).length > 0) {
        config.httpOptions = mergedHttpOptions
      }

      // ------------------------------------------------------------------
      // 8b. Client construction + SDK call — both inside the classifier
      //     so that ANY failure in run() (including a bad auth constructor)
      //     is rethrown as a typed LlmError(provider:'google').
      // ------------------------------------------------------------------
      let response: GeminiResponseShape
      let servedServiceTier = config.serviceTier
      const dispatch = async (): Promise<GeminiResponseShape> => {
        const dispatchConfig: GeminiGenerateConfig = {
          ...config,
          ...(config.httpOptions !== undefined
            ? { httpOptions: { ...config.httpOptions } }
            : {}),
        }
        const params = {
          model,
          contents,
          config: dispatchConfig,
        }
        const buildClient = opts?._clientFactory ?? buildGoogleClient
        const client: GeminiClientLike =
          opts?.client !== undefined ? opts.client : await buildClient(ctx.auth)
        ctx.logger.debug(
          {
            model,
            configKeys: Object.keys(dispatchConfig),
            serviceTier: dispatchConfig.serviceTier,
          },
          'llm.adapter.dispatch',
        )
        return client.models.generateContent(params)
      }
      try {
        response = await dispatch()
      } catch (rawErr) {
        // Classify SDK errors → LlmError
        const classified = classifyError(rawErr)
        const typed = new LlmError(classified.message, {
          kind: classified.kind,
          retryable: classified.retryable,
          ...(classified.httpStatus !== undefined
            ? { httpStatus: classified.httpStatus }
            : {}),
          ...(classified.retryAfterMs !== undefined
            ? { retryAfterMs: classified.retryAfterMs }
            : {}),
          provider: 'google',
          cause: classified.cause ?? rawErr,
          ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
        })

        if (
          config.serviceTier === 'flex' &&
          genConfig.flexFallback !== false &&
          isGeminiCapacityError(typed)
        ) {
          config.serviceTier = 'standard'
          servedServiceTier = 'standard'
          const fallbackTimeout =
            genConfig.timeoutMs !== undefined
              ? genConfig.timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS
              : STANDARD_DEFAULT_TIMEOUT_MS
          config.httpOptions = {
            timeout: fallbackTimeout,
            ...callerHttpOptions,
          }
          applyTierTimeout('standard')
          try {
            response = await dispatch()
          } catch (fallbackRawErr) {
            const fallbackClassified = classifyError(fallbackRawErr)
            throw new LlmError(fallbackClassified.message, {
              kind: fallbackClassified.kind,
              retryable: fallbackClassified.retryable,
              ...(fallbackClassified.httpStatus !== undefined
                ? { httpStatus: fallbackClassified.httpStatus }
                : {}),
              ...(fallbackClassified.retryAfterMs !== undefined
                ? { retryAfterMs: fallbackClassified.retryAfterMs }
                : {}),
              provider: 'google',
              cause: fallbackClassified.cause ?? fallbackRawErr,
              servedServiceTier: 'standard',
            })
          }
        } else {
          throw typed
        }
      } finally {
        // FIX A-2: always clear the tier timeout timer so it never leaks,
        // regardless of whether the call succeeded, threw, or was aborted.
        clearTierTimeout()
      }

      // ------------------------------------------------------------------
      // 8. Blocked response check
      //    promptFeedback.blockReason set OR no candidates → content_filter
      // ------------------------------------------------------------------
      const hasBlockReason = response.promptFeedback?.blockReason !== undefined
      const hasCandidates =
        response.candidates !== undefined && response.candidates.length > 0

      if (hasBlockReason || !hasCandidates) {
        const reason = response.promptFeedback?.blockReason ?? 'NO_CANDIDATES'
        throw new LlmError(`Gemini response blocked: ${reason}`, {
          kind: 'content_filter',
          retryable: false,
          provider: 'google',
        })
      }

      // ------------------------------------------------------------------
      // 9. Map response
      // ------------------------------------------------------------------
      const candidates = response.candidates
      if (candidates === undefined || candidates.length === 0) {
        throw new LlmError('Gemini response blocked: NO_CANDIDATES', {
          kind: 'content_filter',
          retryable: false,
          provider: 'google',
        })
      }
      const candidate = candidates[0]
      if (candidate === undefined) {
        throw new LlmError('Gemini response blocked: NO_CANDIDATES', {
          kind: 'content_filter',
          retryable: false,
          provider: 'google',
        })
      }
      const parts = candidate.content?.parts ?? []

      // Separate thought parts from text parts.
      const textParts: string[] = []
      const thoughtParts: string[] = []

      for (const part of parts) {
        if (part.text !== undefined) {
          if (part.thought === true) {
            thoughtParts.push(part.text)
          } else {
            textParts.push(part.text)
          }
        }
      }

      const text = textParts.join('')
      const reasoningText = thoughtParts.length > 0 ? thoughtParts.join('') : undefined

      // Parse structured output (JSON text → rawStructured).
      let rawStructured: unknown
      if (structuredOutputRequested && text.length > 0) {
        try {
          rawStructured = JSON.parse(text)
        } catch {
          // Core reports outputParsed:false; callers own validation/retry policy.
        }
      }

      // ------------------------------------------------------------------
      // 10. Build AdapterResult
      // ------------------------------------------------------------------
      const usage = mapUsage(response.usageMetadata)
      const finishReason = mapFinishReason(candidate.finishReason)

      const result: AdapterResult = {
        model,
        usage,
        warnings,
        ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
        ...(text.length > 0 ? { text } : {}),
        ...(reasoningText !== undefined ? { reasoningText } : {}),
        ...(rawStructured !== undefined ? { rawStructured } : {}),
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(response.modelVersion !== undefined
          ? { modelVersion: response.modelVersion }
          : {}),
        ...(response.responseId !== undefined ? { responseId: response.responseId } : {}),
        // Build providerMetadata — merge promptFeedback + groundingMetadata when present.
        ...((): { providerMetadata: JsonValue } | Record<string, never> => {
          const pf = response.promptFeedback
          const gm = candidate.groundingMetadata
          if (pf === undefined && gm === undefined) return {}
          const meta: { [k: string]: JsonValue } = {}
          if (pf !== undefined) {
            meta['promptFeedback'] = pf as unknown as JsonValue
          }
          if (gm !== undefined) {
            meta['groundingMetadata'] = gm as unknown as JsonValue
          }
          return { providerMetadata: meta as JsonValue }
        })(),
      }

      return result
    },
  }
}
