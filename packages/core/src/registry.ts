/**
 * Model descriptor registry for @gullabs/core.
 *
 * Centralises model/provider knowledge so string-heuristics (gemini-* → google)
 * live in one place and unknown models fail fast at call time.
 *
 * @module
 */

import { LlmError } from './errors.js'

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
  }
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
  // ── Gemini 2.5 series — thinkingBudget API ──────────────────────────────
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    pricingFamily: 'gemini-2.5-pro',
    capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash',
    capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
  },
  {
    id: 'gemini-2.5-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash-lite',
    capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'budget' },
  },

  // ── Gemini 3.x series — thinkingLevel API ───────────────────────────────
  {
    id: 'gemini-3.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-3.5-flash',
    capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'level' },
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-3.1-flash-lite',
    capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'level' },
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    pricingFamily: 'gemini-3.1-pro-preview',
    capabilities: { reasoning: true, structuredOutput: true, reasoningApi: 'level' },
  },
]

/**
 * Pre-built registry for all known Gemini models.
 * Used by default in {@link createClient} when no `modelRegistry` is supplied.
 */
export const defaultGeminiRegistry: ModelRegistry = createModelRegistry(geminiModelDescriptors)
