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
export function makeGeminiConfigSchema(opts: { sampling: 'tunable' | 'fixed' }): JsonValue {
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
          effort: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
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

        if (opts.sampling === 'tunable') {
          return { value }
        }

        // sampling === 'fixed': collect all forbidden-field violations.
        const cfg = value as Record<string, unknown>
        const issues: StandardSchemaV1.Issue[] = []

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
      reasoningApi: 'budget',
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
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
      reasoningApi: 'budget',
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
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
      reasoningApi: 'budget',
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'tunable' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'tunable' }),
  },

  // ── Gemini 3.x series — thinkingLevel API, fixed sampling ───────────────
  // caching minTokens: Gemini 3.x series floor is 4096 (Gemini context-caching docs).
  {
    id: 'gemini-3.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-3.5-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
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
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'fixed' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'fixed' }),
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    pricingFamily: 'gemini-3.1-pro-preview',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'fixed' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'fixed' }),
  },
  {
    id: 'gemini-3-flash-preview',
    provider: 'google',
    pricingFamily: 'gemini-3-flash-preview',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
    },
    configJsonSchema: makeGeminiConfigSchema({ sampling: 'fixed' }),
    validateConfig: makeGeminiConfigValidator({ sampling: 'fixed' }),
  },
]

/**
 * Pre-built registry for all known Gemini models.
 * Used by default in {@link createClient} when no `modelRegistry` is supplied.
 */
export const defaultGeminiRegistry: ModelRegistry = createModelRegistry(geminiModelDescriptors)
