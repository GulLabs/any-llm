/**
 * Generic `PricingSource` test fixture builder for @gullabs/core.
 *
 * Core carries no pricing tables of its own — engine-level integration tests
 * still need a real (if synthetic) `PricingSource` to exercise the cost
 * pipeline end-to-end. This helper builds one from a caller-supplied rates
 * table via `computeCost`, mirroring the exact-then-longest-prefix lookup
 * strategy a provider package (e.g. `@gullabs/google`) would implement.
 *
 * Sibling to `test-model-descriptor.ts` — both are non-`.test.ts` helpers
 * kept in `src/` because they're imported across multiple test files.
 *
 * @module
 */

import { computeCost } from './cost.js'
import type { ModelRates } from './pricing.js'
import type { PricingSource } from './ports.js'
import type { Cost, Usage } from './types.js'

export function makeTestPricingSource(
  rates: Readonly<Record<string, ModelRates>>,
  tierFactors: Readonly<Record<string, number>>,
  version: string,
): PricingSource {
  function lookup(model: string): ModelRates | undefined {
    const exact = rates[model]
    if (exact !== undefined) return exact

    let bestKey = ''
    let bestRates: ModelRates | undefined
    for (const key of Object.keys(rates)) {
      if (model.startsWith(key) && key.length > bestKey.length) {
        bestKey = key
        bestRates = rates[key]
      }
    }
    return bestRates
  }

  return {
    version,
    price(model: string, usage: Usage, tier?: string): Cost {
      return computeCost(model, usage, tier, lookup, tierFactors, version)
    },
    hasModel(model: string): boolean {
      return lookup(model) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(rates)
    },
  }
}
