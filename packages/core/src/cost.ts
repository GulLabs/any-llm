/**
 * Cost computation for @gullabs/core.
 *
 * This module provides `computeCost` — a **pure function** with zero
 * provider/tier vocabulary. Core has no pricing tables, no tier names
 * (`flex`/`standard`/`batch` are Google's, not core's), and no per-model rate
 * data: every provider package (e.g. `@gullabs/google`) owns its own rates
 * table + tier-factor map and supplies them to `computeCost` as explicit
 * parameters. This is the seam that lets a new provider ship pricing with
 * zero core changes — see `@gullabs/google`'s `pricing.ts`/`cost.ts` for the
 * Gemini-specific rates table, tier-factor map, and `geminiPricingSource`
 * factory built on top of this function.
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
 * Each component (input, cached, output, tools) is rounded independently to
 * an integer micro-USD value.  `microUsd` is then defined as their sum, so
 * `details.input + details.cached + details.output + details.tools === microUsd`
 * is always true — there is no residual rounding error. Core's
 * {@link computeCost} prices tokens only and always sets `tools: 0`;
 * provider sources that price tool invocations add that lane themselves.
 *
 * @module
 */

import type { Cost, Usage } from './types.js'
import type { ModelRates } from './pricing.js'

/**
 * A caller-supplied rates lookup: given a bare model identifier, resolves the
 * applicable {@link ModelRates}, or `undefined` if the model is unpriced.
 *
 * Provider packages own the actual lookup strategy (exact match, longest-
 * prefix match, etc.) against their own rates table — core just calls this
 * once per {@link computeCost} invocation.
 */
export interface CostRatesLookup {
  (model: string): ModelRates | undefined
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Select the applicable rate set for a model given the GROSS input token count.
 *
 * When a model has a `gt200k` tier, that tier's rates apply when
 * `grossInputTokens` is **strictly greater than** 200,000.
 *
 * This predicate operates purely on the generic {@link ModelRates} shape
 * (which core already owns), so it stays in core rather than moving with the
 * provider-specific rates table + lookup walk.
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
 * **Seam:** `rates` and `tierFactors` are supplied by the caller (a provider
 * package's `PricingSource` factory) instead of being read from a
 * module-level table. Core has zero provider/tier vocabulary — every
 * provider package supplies its own rates table + tier-factor map.
 *
 * **Algorithm:**
 * 1. Resolve rates via `rates(model)`; if `undefined`, return an `estimated`
 *    Cost with `microUsd: null`, zero-filled details, and an `unpricedReason`
 *    naming the model.
 * 2. Resolve the service-tier multiplier from `tier` via `tierFactors`.
 *    `undefined` defaults to standard (factor 1). A *defined* tier absent
 *    from `tierFactors` is never coerced to standard — it short-circuits to
 *    the same unpriced shape as step 1, with an `unpricedReason` naming the
 *    tier.
 * 3. Determine which rate tier applies (base vs. `>200k` long-context).
 * 4. Compute billable input: `inputTokens − (cachedInputTokens ?? 0)`, clamped
 *    to `0` if cached > input (defensive; the GROSS invariant should prevent
 *    this, but we protect against malformed adapter output).
 * 5. Round each component to the nearest integer micro-USD **independently**.
 * 6. Define `microUsd` as the sum of the three components — this guarantees
 *    `details.input + details.cached + details.output + details.tools === microUsd`
 *    exactly. Token-only sources (this function) set `tools: 0`.
 *
 * @param model - Model identifier string used for routing (e.g. `"gemini-2.5-pro"`).
 * @param usage - GROSS token usage for the call.
 * @param tier - Opaque, provider-defined service tier string (e.g. `'flex'`,
 *   `'standard'`, `'batch'`). Only tiers present in `tierFactors` carry a
 *   known pricing multiplier. `undefined` means "no tier specified" and
 *   defaults to the `'standard'` multiplier (1×) — this is a documented
 *   default, not a guess. A *defined* tier that is not a `tierFactors` key is
 *   never mapped to `standard` (reject-don't-map): the call resolves to the
 *   unpriced path instead, per the same convention used for unknown models.
 * @param rates - Caller-supplied rates lookup (see {@link CostRatesLookup}).
 * @param tierFactors - Caller-supplied tier → multiplier map.
 * @param pricingVersion - Caller-supplied pricing snapshot identifier, echoed
 *   verbatim onto the returned {@link Cost}.
 * @returns A frozen {@link Cost} value.
 */
export function computeCost(
  model: string,
  usage: Usage,
  tier: string | undefined,
  rates: CostRatesLookup,
  tierFactors: Readonly<Record<string, number>>,
  pricingVersion: string,
): Cost {
  const modelRates = rates(model)

  // Unknown model — return null cost; tokens still captured for backfill.
  if (modelRates === undefined) {
    return {
      microUsd: null,
      usd: null,
      pricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0, tools: 0 },
      unpricedReason: `Unknown model "${model}"; no pricing entry found.`,
    }
  }

  // Resolve the service-tier multiplier. `undefined` means "unspecified" and
  // defaults to standard (factor 1) — that is documented default behavior,
  // not a mapping. A *defined* tier that isn't a recognized tierFactors key
  // must NOT be silently rewritten to standard rates (reject-don't-map): it
  // resolves to the unpriced path instead, mirroring the unknown-model case.
  const factor = tier === undefined ? 1 : tierFactors[tier]
  if (factor === undefined) {
    return {
      microUsd: null,
      usd: null,
      pricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0, tools: 0 },
      unpricedReason: `Unknown service tier "${tier}"; refusing to guess a pricing multiplier.`,
    }
  }

  // Select rate tier based on GROSS input token count (long-context premium).
  const base = selectRates(modelRates, usage.inputTokens)

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
      tools: 0,
    },
  }
}
