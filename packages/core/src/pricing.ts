/**
 * Generic pricing shapes for @gullabs/core.
 *
 * Core owns zero provider pricing data — every provider package supplies its
 * own rates table (see `@gullabs/google`'s `pricing.ts` for the Gemini
 * snapshot) and passes it into {@link computeCost} (cost.ts) as an explicit
 * parameter. This module keeps only the generic `ModelRates` shape that
 * `computeCost` and the `PricingSource` port are typed against.
 *
 * @module
 */

/**
 * Per-model rate entry (all values in µUSD per million tokens, STANDARD tier).
 *
 * `gt200k` (when present) applies when GROSS input tokens > 200,000.
 */
export interface ModelRates {
  /** µUSD per million input tokens (text/img/vid; billable = gross − cached). */
  inputPerM: number
  /** µUSD per million cache-read tokens. */
  cachedPerM: number
  /** µUSD per million output tokens (thinking is folded in). */
  outputPerM: number
  /** Optional high-tier rates for long-context (GROSS input > 200k). */
  gt200k?: {
    inputPerM: number
    cachedPerM: number
    outputPerM: number
  }
}
