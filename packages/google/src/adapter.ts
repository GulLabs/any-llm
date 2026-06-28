/**
 * geminiAdapter — @anyllm/google Gemini provider adapter.
 *
 * Pure request⇄response mapping over @google/genai (via GeminiClientLike).
 * Never persists, never computes cost, never loops.
 *
 * @module
 */

import { LlmError, classifyError } from '@anyllm/core'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Usage,
  Warning,
  FinishReason,
  JsonValue,
} from '@anyllm/core'
import type { ZodTypeAny } from 'zod'
import { buildGoogleClient } from './client.js'
import type {
  GeminiClientLike,
  GeminiGenerateConfig,
  GeminiContent,
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
   * When omitted, buildGoogleClient is called with ctx.auth at call time.
   */
  client?: GeminiClientLike
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
      const contents: GeminiContent[] = req.messages.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: msg.parts
          .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
          .map((p) => ({ text: p.text })),
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
        const is25Model = /^gemini-2\.5/.test(model)
        const is3xModel = /^gemini-3/.test(model)

        if (is25Model) {
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
        } else if (is3xModel) {
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
          // Unknown model generation — emit unsupported warning
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

        const geminiSchema = zodToGeminiSchema(req.outputSchema as ZodTypeAny)
        if (geminiSchema !== undefined) {
          config.responseSchema = geminiSchema
        } else {
          warnings.push({
            type: 'unsupported-setting',
            setting: 'output.schema',
            details:
              'Could not convert Zod schema to Gemini responseSchema; ' +
              'proceeding with responseMimeType only. Engine will still Zod-validate.',
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
      // 7. Build params + call the SDK
      // ------------------------------------------------------------------
      const params = {
        model,
        contents,
        config,
      }

      const client: GeminiClientLike =
        opts?.client !== undefined ? opts.client : buildGoogleClient(ctx.auth)

      let response: GeminiResponseShape
      try {
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

      // Build provider metadata (forward-compat blob).
      const providerMetadata: JsonValue =
        response.promptFeedback !== undefined
          ? (response.promptFeedback as unknown as JsonValue)
          : undefined as unknown as JsonValue

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

      void providerMetadata // used above in the spread
      return result
    },
  }
}
