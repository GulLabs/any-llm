/**
 * Model descriptor registry for @gullabs/core.
 *
 * Centralises model/provider knowledge so string-heuristics (gemini-* → google)
 * live in one place and unknown models fail fast at call time.
 *
 * @module
 */

import { LlmError } from './errors.js'
import type { JsonValue } from './types.js'
import type { StandardSchemaV1 } from './standard-schema.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Describes a single model variant: which provider it belongs to, optional
 * pricing-table family, and capability flags.
 */
export interface ModelDescriptor {
  /**
   * Model identifier — used as the exact-match key and as the prefix for
   * longest-prefix matching (e.g. `"gemini-2.5-pro"` also matches
   * `"gemini-2.5-pro-001"`).
   */
  id: string
  /** Provider identifier (e.g. `"google"`). Must match the adapter's `id`. */
  provider: string
  /**
   * Key into the pricing table (e.g. `"gemini-2.5-pro"`).
   * When omitted, cost computation falls back to the pricing table's own
   * prefix-match logic.
   */
  pricingFamily?: string
  /** Capability flags for routing and adapter logic. */
  capabilities?: {
    /** `true` when the model supports reasoning / chain-of-thought output. */
    reasoning?: boolean
    /** `true` when the model supports structured JSON output. */
    structuredOutput?: boolean
    /**
     * `true` when the provider can enforce structured output natively.
     * When false, adapters should rely on prompt text + engine validation only.
     */
    nativeStructuredOutput?: boolean
    /** `true` when the model accepts image/video input parts. */
    vision?: boolean
    /** `true` when the model accepts audio input parts. */
    audioInput?: boolean
    /**
     * Which thinkingConfig API variant the model uses.
     * - `'budget'` → `thinkingBudget` (gemini-2.5* series).
     * - `'level'`  → `thinkingLevel`  (gemini-3.* series).
     * Omitted for models that do not support reasoning.
     */
    reasoningApi?: 'budget' | 'level'
    /**
     * Whether the model supports tunable sampling parameters.
     * - `'tunable'` — temperature, topP, topK are accepted (Gemini 2.5 series).
     * - `'fixed'`   — sampling is fixed; temperature/topP/topK are rejected
     *                 at dispatch time (Gemini 3.x series).
     */
    sampling?: 'tunable' | 'fixed'
    /**
     * Explicit context caching configuration for this model.
     * `explicit` — whether the model supports explicit cache creation.
     * `minTokens` — minimum token count required before caching takes effect.
     */
    caching?: { explicit: boolean; minTokens: number }
    /**
     * `true` when the model supports Google Search grounding.
     * Per-model grounding support is populated in the grounding batch after verification.
     */
    grounding?: boolean
    /**
     * Provider service tiers safe to send to the SDK for this model.
     * Omit when the adapter should not emit serviceTier at all.
     */
    serviceTiers?: ('flex' | 'standard')[]
  }
  /**
   * Plain JSON Schema object (suitable for client UX form-generation).
   * Typed as {@link JsonValue} so it can be serialised without any schema lib.
   */
  configJsonSchema?: JsonValue
  /**
   * Hand-written Standard Schema v1 validator the engine runs before dispatch.
   * Receives a projection of the resolved config (excluding execution-spine
   * fields such as `timeoutMs`).  Returns `{ value }` on success or
   * `{ issues }` on failure.
   */
  validateConfig?: StandardSchemaV1
}

/**
 * Registry that resolves a model string to a {@link ModelDescriptor}.
 *
 * Resolution order:
 * 1. Exact match on `descriptor.id`.
 * 2. Longest-prefix match (e.g. `"gemini-2.5-pro-001"` → `"gemini-2.5-pro"`).
 * 3. `undefined` when no descriptor matches.
 */
export interface ModelRegistry {
  resolve(model: string): ModelDescriptor | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link ModelRegistry} from a list of {@link ModelDescriptor}s.
 *
 * Duplicate `id` values throw immediately — a registry with conflicting
 * descriptors is always a programming error.
 *
 * @throws {@link LlmError} `'bad_request'` when any two descriptors share the
 *   same `id`.
 */
export function createModelRegistry(descriptors: ModelDescriptor[]): ModelRegistry {
  const map = new Map<string, ModelDescriptor>()
  for (const d of descriptors) {
    if (map.has(d.id)) {
      throw new LlmError(`Duplicate model descriptor id "${d.id}"`, {
        kind: 'bad_request',
        retryable: false,
      })
    }
    map.set(d.id, d)
  }

  return {
    resolve(model: string): ModelDescriptor | undefined {
      // 1. Exact match — O(1) fast path.
      const exact = map.get(model)
      if (exact !== undefined) return exact

      // 2. Longest-prefix match (e.g. "gemini-2.5-pro-001" → "gemini-2.5-pro").
      let best: ModelDescriptor | undefined
      let bestLen = 0
      for (const [id, desc] of map) {
        if (model.startsWith(id) && id.length > bestLen) {
          best = desc
          bestLen = id.length
        }
      }
      return best
    },
  }
}

// ---------------------------------------------------------------------------
// Gemini config schema + validator factories
// ---------------------------------------------------------------------------

/**
 * Returns a plain JSON Schema object for Gemini generation config.
 *
 * Common properties (both families): `maxOutputTokens`, `stopSequences`,
 * `reasoning`, `serviceTier`.
 *
 * When `sampling === 'tunable'`, also includes `temperature`, `topP`, `topK`.
 * When `sampling === 'fixed'`, those three are omitted.
 *
 * Typed as {@link JsonValue} — no schema library required.
 */
export function makeGeminiConfigSchema(opts: {
  sampling: 'tunable' | 'fixed'
  reasoningEfforts?: ReadonlyArray<'none' | 'low' | 'medium' | 'high'>
}): JsonValue {
  const samplingProps: { [k: string]: JsonValue } =
    opts.sampling === 'tunable'
      ? {
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          topP: { type: 'number' },
          topK: { type: 'integer' },
        }
      : {}

  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      maxOutputTokens: { type: 'integer' },
      stopSequences: { type: 'array', items: { type: 'string' } },
      reasoning: {
        type: 'object',
        properties: {
          effort: {
            type: 'string',
            enum: opts.reasoningEfforts
              ? [...opts.reasoningEfforts]
              : ['none', 'low', 'medium', 'high'],
          },
          budgetTokens: { type: 'integer' },
          includeThoughts: { type: 'boolean' },
        },
      },
      serviceTier: { type: 'string', enum: ['flex', 'standard'] },
      ...samplingProps,
    },
  }
}

/**
 * Returns a hand-written Standard Schema v1 validator for Gemini generation
 * config.
 *
 * Behaviour:
 * - Non-object value → single issue (not a plain object).
 * - `sampling === 'fixed'` and `temperature` present → issue with path.
 * - `sampling === 'fixed'` and `topP` present → issue with path.
 * - `sampling === 'fixed'` and `topK` present → issue with path.
 * - All issues are collected before returning (no short-circuit).
 * - `sampling === 'tunable'` → always passes (no further constraints in v1).
 */
export function makeGeminiConfigValidator(opts: {
  sampling: 'tunable' | 'fixed'
  reasoningEfforts?: ReadonlyArray<'none' | 'low' | 'medium' | 'high'>
}): StandardSchemaV1 {
  return {
    '~standard': {
      vendor: 'gullabs-gemini',
      version: 1,
      validate(value: unknown): StandardSchemaV1.Result<unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return {
            issues: [{ message: 'config must be an object' }],
          }
        }

        const cfg = value as Record<string, unknown>
        const issues: StandardSchemaV1.Issue[] = []

        if (opts.sampling === 'fixed') {
          if (cfg['temperature'] !== undefined) {
            issues.push({
              message:
                'temperature is not supported on this model (Gemini 3.x fixes sampling); remove it.',
              path: ['temperature'],
            })
          }
          if (cfg['topP'] !== undefined) {
            issues.push({
              message:
                'topP is not supported on this model (Gemini 3.x fixes sampling); remove it.',
              path: ['topP'],
            })
          }
          if (cfg['topK'] !== undefined) {
            issues.push({
              message:
                'topK is not supported on this model (Gemini 3.x fixes sampling); remove it.',
              path: ['topK'],
            })
          }
        }

        if (
          opts.reasoningEfforts !== undefined &&
          cfg['reasoning'] !== null &&
          typeof cfg['reasoning'] === 'object' &&
          !Array.isArray(cfg['reasoning'])
        ) {
          const reasoning = cfg['reasoning'] as Record<string, unknown>
          const effort = reasoning['effort']
          if (
            effort !== undefined &&
            !(opts.reasoningEfforts as ReadonlyArray<unknown>).includes(effort)
          ) {
            const effortLabel =
              typeof effort === 'string' ? effort : JSON.stringify(effort)
            issues.push({
              message: `reasoning.effort "${effortLabel}" is not supported on this model; supported efforts: ${opts.reasoningEfforts.join(
                ', ',
              )}.`,
              path: ['reasoning', 'effort'],
            })
          }
        }

        if (issues.length > 0) {
          return { issues }
        }
        return { value }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Built-in Gemini descriptor set (derived from GEMINI_PRICING + adapter logic)
// ---------------------------------------------------------------------------

/**
 * Default set of Gemini model descriptors.
 *
 * Derived from the {@link GEMINI_PRICING} snapshot and the adapter's reasoning
 * detection (`gemini-2.5*` and `gemini-3*` both support thinkingConfig).
 * Extend or replace via `ClientConfig.modelRegistry`.
 *
 * Grounding support:
 * Google Search grounding is supported on all Gemini 2.5 and 3.x models listed
 * here.  Enable it by passing `{ googleSearch: {} }` in
 * `config.providerOptions.google.tools`.  Note: grounding is mutually exclusive
 * with structured output (`output.jsonSchema`) — the adapter enforces this at call
 * time with a `bad_request` LlmError.  postbuzz uses grounding primarily with
 * gemini-3.1-flash-lite and gemini-3.5-flash.
 */
export const geminiModelDescriptors: ModelDescriptor[] = [
  // ── Gemini 2.5 series — thinkingBudget API, tunable sampling ────────────
  // caching minTokens: Gemini 2.5 series floor is 2048 (Gemini context-caching docs).
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    pricingFamily: 'gemini-2.5-pro',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'tunable' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'tunable' }),
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'tunable' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'tunable' }),
  },
  {
    id: 'gemini-2.5-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash-lite',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'tunable' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'tunable' }),
  },

  // ── Gemini 3.x series — thinkingLevel API, fixed sampling ───────────────
  // caching minTokens: Gemini 3.x series floor is 2048 (Google explicit-cache docs).
  {
    id: 'gemini-3.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-3.5-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'fixed' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'fixed' }),
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-3.1-flash-lite',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'fixed' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'fixed' }),
  },
  {
    // gemini-3.1-pro-preview cannot disable thinking: the model rejects thinkingLevel
    // MINIMAL with HTTP 400, so effort: 'none' is rejected at validation time.
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    pricingFamily: 'gemini-3.1-pro-preview',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configJsonSchema: makeGeminiConfigSchema({
      sampling: 'fixed',
      reasoningEfforts: ['low', 'medium', 'high'],
    }),
    validateConfig: makeGeminiConfigValidator({
      sampling: 'fixed',
      reasoningEfforts: ['low', 'medium', 'high'],
    }),
  },
  {
    id: 'gemini-3-flash-preview',
    provider: 'google',
    pricingFamily: 'gemini-3-flash-preview',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      serviceTiers: ['flex', 'standard'],
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'fixed' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'fixed' }),
  },
]

/**
 * API-verified Gemma 4 model descriptors.
 *
 * Only two Gemma 4 model IDs are confirmed to exist and be callable via the
 * Google Gemini API. All other IDs (e2b, e4b, 12b variants, google/ aliases)
 * return HTTP 404 and are omitted. This set matches verified live-API behaviour.
 *
 * Capabilities confirmed against the live API:
 * - `reasoning: true` with `reasoningApi: 'level'` — thinkingLevel works;
 *   thinkingBudget is rejected with HTTP 400.
 * - `structuredOutput: true` and `nativeStructuredOutput: true` — responseMimeType
 *   and responseSchema are accepted.
 * - `grounding: true` — tools:[{googleSearch:{}}] is accepted.
 * - `vision: true` — inline image input is accepted.
 * - `sampling: 'tunable'` — temperature, topP, topK are supported.
 *
 * Intentionally omitted (not verified): pricingFamily, serviceTiers, caching,
 * audioInput.
 *
 * Reasoning effort is binary on Gemma 4: only `effort: 'none'` (MINIMAL) and
 * `effort: 'high'` (HIGH) are accepted by the API; `effort: 'low'` and
 * `effort: 'medium'` are rejected at validation time with a `bad_request` error
 * because the model only supports MINIMAL and HIGH `thinkingLevel` values.
 */
export const gemmaModelDescriptors: ModelDescriptor[] = [
  {
    id: 'gemma-4-31b-it',
    provider: 'google',
    capabilities: {
      reasoning: true,
      reasoningApi: 'level',
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      vision: true,
      sampling: 'tunable',
    },
    configJsonSchema: makeGeminiConfigSchema({
      sampling: 'tunable',
      reasoningEfforts: ['none', 'high'],
    }),
    validateConfig: makeGeminiConfigValidator({
      sampling: 'tunable',
      reasoningEfforts: ['none', 'high'],
    }),
  },
  {
    id: 'gemma-4-26b-a4b-it',
    provider: 'google',
    capabilities: {
      reasoning: true,
      reasoningApi: 'level',
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      vision: true,
      sampling: 'tunable',
    },
    configJsonSchema: makeGeminiConfigSchema({
      sampling: 'tunable',
      reasoningEfforts: ['none', 'high'],
    }),
    validateConfig: makeGeminiConfigValidator({
      sampling: 'tunable',
      reasoningEfforts: ['none', 'high'],
    }),
  },
]

/**
 * Pre-built registry for all known Google-hosted model descriptors.
 * Used by default in {@link createClient} when no `modelRegistry` is supplied.
 */
export const defaultGeminiRegistry: ModelRegistry = createModelRegistry([
  ...geminiModelDescriptors,
  ...gemmaModelDescriptors,
])
