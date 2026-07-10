/**
 * Gemini pricing source for @gullabs/google.
 *
 * Provides `geminiPricingSource` — a factory returning a `PricingSource` port
 * implementation backed by the frozen Gemini pricing snapshot ({@link
 * GEMINI_PRICING}). Walks the rates table (exact-then-longest-prefix match)
 * and delegates the actual arithmetic to `@gullabs/core`'s `computeCost`,
 * supplying this package's rates table + tier-factor map as explicit
 * parameters — core itself carries zero Gemini pricing knowledge.
 *
 * @module
 */

import { computeCost } from '@gullabs/core'
import type { Cost, ModelRates, PricingSource, Usage } from '@gullabs/core'

import { GEMINI_PRICING, TIER_FACTOR, pricingVersion } from './pricing.js'

/**
 * Look up rates for a model.
 *
 * Performs an exact-key match first, then falls back to longest-prefix match
 * (e.g. `"gemini-2.5-pro-001"` matches `"gemini-2.5-pro"`).
 *
 * @returns The matched {@link ModelRates}, or `undefined` if no entry found.
 */
function lookupRates(model: string): ModelRates | undefined {
  // 1. Exact match — fast path.
  const exact = GEMINI_PRICING[model]
  if (exact !== undefined) return exact

  // 2. Longest-prefix match.
  let bestKey = ''
  let bestRates: ModelRates | undefined
  for (const key of Object.keys(GEMINI_PRICING)) {
    if (model.startsWith(key) && key.length > bestKey.length) {
      bestKey = key
      bestRates = GEMINI_PRICING[key]
    }
  }
  return bestRates
}

/**
 * Factory that returns the **google-scoped** {@link PricingSource} port
 * implementation backed by the built-in Gemini pricing snapshot.
 *
 * `PricingSource` is provider-scoped by contract — this source only knows
 * bare Gemini/Gemma model keys. Compose it into `ClientConfig.pricingSources`
 * under the `'google'` key (or bundle it via {@link googleProvider}); do not
 * use it for other providers.
 *
 * The returned object is stateless and can be shared across calls.
 *
 * @example
 * ```ts
 * import { geminiPricingSource } from '@gullabs/google'
 *
 * const pricing = geminiPricingSource()
 * const cost = pricing.price('gemini-2.5-pro', usage, 'flex')
 * ```
 */
export function geminiPricingSource(): PricingSource {
  return {
    version: pricingVersion,
    price(model: string, usage: Usage, tier?: string): Cost {
      return computeCost(model, usage, tier, lookupRates, TIER_FACTOR, pricingVersion)
    },
    hasModel(model: string): boolean {
      return lookupRates(model) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(GEMINI_PRICING)
    },
  }
}
