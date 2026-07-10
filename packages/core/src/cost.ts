/**
 * Cost computation for @gullabs/core.
 *
 * This module provides `computeCost` (pure function) and
 * `geminiPricingSource` (factory returning a {@link PricingSource} port
 * implementation backed by the frozen Gemini pricing snapshot).
 *
 * **GROSS token convention** (enforced here, not by callers):
 * - `cachedInputTokens` is a *subset* of `inputTokens` — the cached portion
 *   already counted inside `inputTokens`.
 * - `thinkingTokens` is a *subset* of `outputTokens` — the thinking portion
 *   already counted inside `outputTokens`.
 *
 * **Double-counting is prevented** by computing:
 * ```
 * billableInput = inputTokens − (cachedInputTokens ?? 0)   // net non-cached
 * ```
 * and billing `cachedInputTokens` at the (discounted) cached rate.
 * `thinkingTokens` requires no adjustment — it is already inside
 * `outputTokens` and is billed at the standard output rate.
 *
 * **Sum invariant** is guaranteed by construction:
 * Each component (input, cached, output) is rounded independently to an
 * integer micro-USD value.  `microUsd` is then defined as their sum, so
 * `details.input + details.cached + details.output === microUsd` is always
 * true — there is no residual rounding error.
 *
 * @module
 */

import type { Cost, Usage } from './types.js'
import type { PricingSource } from './ports.js'
import {
  GEMINI_PRICING,
  TIER_FACTOR,
  pricingVersion,
  type ModelRates,
} from './pricing.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
 * Select the applicable rate set for a model given the GROSS input token count.
 *
 * When a model has a `gt200k` tier, that tier's rates apply when
 * `grossInputTokens` is **strictly greater than** 200,000.
 */
function selectRates(
  rates: ModelRates,
  grossInputTokens: number,
): { inputPerM: number; cachedPerM: number; outputPerM: number } {
  if (rates.gt200k !== undefined && grossInputTokens > 200_000) {
    return rates.gt200k
  }
  return {
    inputPerM: rates.inputPerM,
    cachedPerM: rates.cachedPerM,
    outputPerM: rates.outputPerM,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the cost of an LLM call given a model name and usage data.
 *
 * This is a **pure function** — it has no side effects and always returns a
 * well-formed {@link Cost} value.
 *
 * **Algorithm:**
 * 1. Look up rates for `model`; if not found, return an `estimated` Cost with
 *    `microUsd: null`, zero-filled details, and an `unpricedReason` naming
 *    the model.
 * 2. Resolve the service-tier multiplier from `tier`. `undefined` defaults to
 *    standard (factor 1). A *defined* tier absent from {@link TIER_FACTOR} is
 *    never coerced to standard — it short-circuits to the same unpriced shape
 *    as step 1, with an `unpricedReason` naming the tier.
 * 3. Determine which rate tier applies (base vs. `>200k` long-context).
 * 4. Compute billable input: `inputTokens − (cachedInputTokens ?? 0)`, clamped
 *    to `0` if cached > input (defensive; the GROSS invariant should prevent
 *    this, but we protect against malformed adapter output).
 * 5. Round each component to the nearest integer micro-USD **independently**.
 * 6. Define `microUsd` as the sum of the three components — this guarantees
 *    `details.input + details.cached + details.output === microUsd` exactly.
 *
 * @param model - Model identifier string used for routing (e.g. `"gemini-2.5-pro"`).
 * @param usage - GROSS token usage for the call.
 * @param tier - Opaque, provider-defined service tier string (e.g. `'flex'`,
 *   `'standard'`, `'batch'`). Only tiers present in {@link TIER_FACTOR} carry a
 *   known pricing multiplier. `undefined` means "no tier specified" and
 *   defaults to the `'standard'` multiplier (1×) — this is a documented
 *   default, not a guess. A *defined* tier that is not a `TIER_FACTOR` key is
 *   never mapped to `standard` (reject-don't-map): the call resolves to the
 *   unpriced path instead, per the same convention used for unknown models.
 * @returns A frozen {@link Cost} value.
 */
export function computeCost(model: string, usage: Usage, tier?: string): Cost {
  const rates = lookupRates(model)

  // Unknown model — return null cost; tokens still captured for backfill.
  if (rates === undefined) {
    return {
      microUsd: null,
      usd: null,
      pricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0 },
      unpricedReason: `Unknown model "${model}"; no pricing entry found.`,
    }
  }

  // Resolve the service-tier multiplier. `undefined` means "unspecified" and
  // defaults to standard (factor 1) — that is documented default behavior,
  // not a mapping. A *defined* tier that isn't a recognized TIER_FACTOR key
  // must NOT be silently rewritten to standard rates (reject-don't-map): it
  // resolves to the unpriced path instead, mirroring the unknown-model case.
  const factor = tier === undefined ? 1 : TIER_FACTOR[tier]
  if (factor === undefined) {
    return {
      microUsd: null,
      usd: null,
      pricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0 },
      unpricedReason: `Unknown service tier "${tier}"; refusing to guess a pricing multiplier.`,
    }
  }

  // Select rate tier based on GROSS input token count (long-context premium).
  const base = selectRates(rates, usage.inputTokens)

  const inputPerM = base.inputPerM * factor
  const cachedPerM = base.cachedPerM * factor
  const outputPerM = base.outputPerM * factor

  const cached = usage.cachedInputTokens ?? 0

  // Billable (non-cached) input: gross minus cached, clamped to zero.
  // The GROSS convention means cached ≤ input, but we defend against
  // malformed adapter output without throwing.
  const billableInput = Math.max(0, usage.inputTokens - cached)

  // Round each component independently to integer micro-USD.
  // Rates are µUSD per million tokens, so: tokens * ratePerM / 1_000_000.
  const inputCost = Math.round((billableInput * inputPerM) / 1_000_000)
  const cachedCost = Math.round((cached * cachedPerM) / 1_000_000)
  const outputCost = Math.round((usage.outputTokens * outputPerM) / 1_000_000)

  // Sum defines microUsd — guarantees sum(details) === microUsd by construction.
  const microUsd = inputCost + cachedCost + outputCost

  return {
    microUsd,
    usd: microUsd / 1_000_000,
    pricingVersion,
    confidence: 'exact',
    details: {
      input: inputCost,
      cached: cachedCost,
      output: outputCost,
    },
  }
}

/**
 * Factory that returns the **google-scoped** {@link PricingSource} port
 * implementation backed by the built-in Gemini pricing snapshot.
 *
 * `PricingSource` is provider-scoped by contract — this source only knows
 * bare Gemini/Gemma model keys. Compose it into `ClientConfig.pricingSources`
 * under the `'google'` key; do not use it for other providers.
 *
 * The returned object is stateless and can be shared across calls.
 *
 * @example
 * ```ts
 * import { geminiPricingSource } from '@gullabs/core'
 *
 * const pricing = geminiPricingSource()
 * const cost = pricing.price('gemini-2.5-pro', usage, 'flex')
 * ```
 */
export function geminiPricingSource(): PricingSource {
  return {
    version: pricingVersion,
    price(model: string, usage: Usage, tier?: string): Cost {
      return computeCost(model, usage, tier)
    },
    hasModel(model: string): boolean {
      return lookupRates(model) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(GEMINI_PRICING)
    },
  }
}
