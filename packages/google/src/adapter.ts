/**
 * geminiAdapter — @gullabs/google Gemini provider adapter.
 *
 * Pure request⇄response mapping over @google/genai (via GeminiClientLike).
 * Never persists, never computes cost, never loops.
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
import type { ZodTypeAny } from 'zod'
import { buildGoogleClient, FLEX_DEFAULT_TIMEOUT_MS } from './client.js'
import type {
  GeminiClientLike,
  GeminiGenerateConfig,
  GeminiContent,
  GeminiContentPart,
  GeminiResponseShape,
  GeminiUsageMetadataShape,
} from './client.js'
import { zodToGeminiSchema } from './schema.js'

// ---------------------------------------------------------------------------
// Exported types for consumers that inject a custom client
// ---------------------------------------------------------------------------
export type { GeminiClientLike }

// ---------------------------------------------------------------------------
// Reasoning effort → thinkingBudget mapping (gemini-2.5* models)
// ---------------------------------------------------------------------------

const EFFORT_BUDGET: Record<string, number> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
}

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
    meta !== undefined
      ? (meta as unknown as { [k: string]: JsonValue })
      : null

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
      config.serviceTier = genConfig.serviceTier === 'standard' ? 'standard' : 'flex'

      // ------------------------------------------------------------------
      // 3. Reasoning → thinkingConfig
      // ------------------------------------------------------------------
      const reasoning = genConfig.reasoning
      if (reasoning !== undefined) {
        const reasoningApi = req.modelDescriptor?.capabilities?.reasoningApi

        if (reasoningApi === 'budget') {
          // gemini-2.5* → thinkingBudget
          const budget =
            reasoning.budgetTokens !== undefined
              ? reasoning.budgetTokens
              : reasoning.effort !== undefined
                ? (EFFORT_BUDGET[reasoning.effort] ?? 0)
                : undefined

          config.thinkingConfig = {
            ...(budget !== undefined ? { thinkingBudget: budget } : {}),
            ...(reasoning.includeThoughts === true ? { includeThoughts: true } : {}),
          }

          if (reasoning.effort !== undefined && reasoning.budgetTokens !== undefined) {
            warnings.push({
              type: 'reasoning-mapping',
              quality: 'approximate',
              details: 'budgetTokens takes precedence over effort for thinkingBudget',
            })
          }
        } else if (reasoningApi === 'level') {
          // gemini-3.* → thinkingLevel
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

          if (reasoning.budgetTokens !== undefined) {
            warnings.push({
              type: 'reasoning-mapping',
              quality: 'approximate',
              details:
                'budgetTokens is not supported for gemini-3.x models; mapping effort to thinkingLevel instead',
            })
          }

          config.thinkingConfig = {
            ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
            ...(reasoning.includeThoughts === true ? { includeThoughts: true } : {}),
          }
        } else {
          // No descriptor or descriptor has no reasoningApi — emit unsupported warning.
          warnings.push({
            type: 'reasoning-mapping',
            quality: 'unsupported',
            details: `thinkingConfig not mapped for model "${model}"; unknown generation`,
          })
        }
      }

      // ------------------------------------------------------------------
      // 4. Structured output → responseMimeType + responseSchema
      // ------------------------------------------------------------------
      let outputSchemaRequested = false
      if (req.outputSchema !== undefined) {
        outputSchemaRequested = true
        config.responseMimeType = 'application/json'

        if (req.outputSchema['~standard'].vendor === 'zod') {
          // Legitimate vendor-specific cast: we've confirmed this is a Zod schema,
          // so casting to ZodTypeAny for the Zod-specific converter is safe.
          const geminiSchema = zodToGeminiSchema(req.outputSchema as ZodTypeAny)
          if (geminiSchema !== undefined) {
            config.responseSchema = geminiSchema
          } else {
            warnings.push({
              type: 'unsupported-setting',
              setting: 'output.schema',
              details:
                'Could not convert Zod schema to Gemini responseSchema; ' +
                'proceeding with responseMimeType only. Engine will still validate.',
            })
          }
        } else {
          // Non-Zod schema: native provider schema enforcement is unavailable.
          // The engine still validates output via Standard Schema, so correctness
          // is preserved — only the provider-side enforcement optimization is skipped.
          warnings.push({
            type: 'other',
            message:
              `Native Gemini responseSchema conversion is not available for vendor ` +
              `"${req.outputSchema['~standard'].vendor}"; ` +
              `proceeding with responseMimeType only. Engine will validate output client-side via Standard Schema.`,
          })
        }
      }

      // ------------------------------------------------------------------
      // 5. providerOptions.google → spread verbatim (last, caller wins)
      // ------------------------------------------------------------------
      const googleOpts = genConfig.providerOptions?.['google']
      if (googleOpts !== undefined && typeof googleOpts === 'object' && googleOpts !== null) {
        Object.assign(config, googleOpts)
      }

      // ------------------------------------------------------------------
      // 6. AbortSignal passthrough
      // Real SDK: GenerateContentConfig.abortSignal (in config, NOT in params)
      // ------------------------------------------------------------------
      if (ctx.signal !== undefined) {
        config.abortSignal = ctx.signal
      }

      // ------------------------------------------------------------------
      // 7. Transport timeout — set httpOptions.timeout so the @google/genai
      //    HTTP transport does NOT preempt the AbortSignal hard ceiling.
      //
      //    Policy:
      //    - timeoutMs is set     → transport timeout = timeoutMs
      //      (the AbortSignal fires at the same deadline; transport timeout
      //       just prevents the SDK from killing the request earlier)
      //    - serviceTier 'flex', no timeoutMs → FLEX_DEFAULT_TIMEOUT_MS (15 min)
      //    - standard, no timeoutMs          → no forced timeout (SDK default)
      //
      //    exactOptionalPropertyTypes: only set when defined.
      // ------------------------------------------------------------------
      const transportTimeoutMs: number | undefined =
        genConfig.timeoutMs !== undefined
          ? genConfig.timeoutMs
          : genConfig.serviceTier === 'flex'
            ? FLEX_DEFAULT_TIMEOUT_MS
            : undefined

      if (transportTimeoutMs !== undefined) {
        config.httpOptions = { timeout: transportTimeoutMs }
      }

      // ------------------------------------------------------------------
      // 8. Build params + call the SDK
      // ------------------------------------------------------------------
      const params = {
        model,
        contents,
        config,
      }

      // ------------------------------------------------------------------
      // 8b. Client construction + SDK call — both inside the classifier
      //     so that ANY failure in run() (including a bad auth constructor)
      //     is rethrown as a typed LlmError(provider:'google').
      // ------------------------------------------------------------------
      let response: GeminiResponseShape
      try {
        const buildClient = opts?._clientFactory ?? buildGoogleClient
        const client: GeminiClientLike =
          opts?.client !== undefined ? opts.client : await buildClient(ctx.auth)
        response = await client.models.generateContent(params)
      } catch (rawErr) {
        // Classify SDK errors → LlmError
        const classified = classifyError(rawErr)
        // Attach provider tag via re-throw (LlmError is already classified).
        throw new LlmError(classified.message, {
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
        })
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
        throw new LlmError(
          `Gemini response blocked: ${reason}`,
          {
            kind: 'content_filter',
            retryable: false,
            provider: 'google',
          },
        )
      }

      // ------------------------------------------------------------------
      // 9. Map response
      // ------------------------------------------------------------------
      const candidate = response.candidates![0]!
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
      const reasoningText =
        thoughtParts.length > 0 ? thoughtParts.join('') : undefined

      // Parse structured output (JSON text → rawStructured).
      let rawStructured: unknown
      if (outputSchemaRequested && text.length > 0) {
        try {
          rawStructured = JSON.parse(text)
        } catch {
          // Engine will surface parse_error; leave rawStructured undefined.
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
        ...(text.length > 0 ? { text } : {}),
        ...(reasoningText !== undefined ? { reasoningText } : {}),
        ...(rawStructured !== undefined ? { rawStructured } : {}),
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(response.modelVersion !== undefined
          ? { modelVersion: response.modelVersion }
          : {}),
        ...(response.responseId !== undefined
          ? { responseId: response.responseId }
          : {}),
        ...(response.promptFeedback !== undefined
          ? { providerMetadata: response.promptFeedback as unknown as JsonValue }
          : {}),
      }

      return result
    },
  }
}
