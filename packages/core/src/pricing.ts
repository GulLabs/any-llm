/**
 * Gemini pricing snapshot for @gullabs/core.
 *
 * All rates are in **micro-USD per million tokens** (µUSD/M).
 * To get the cost for N tokens: `cost_µUSD = N * ratePerM / 1_000_000`.
 *
 * **Long-context tier:** Gemini Pro models charge a premium when the GROSS
 * input token count exceeds 200,000.  The tier is selected by `inputTokens`
 * (the total including cached tokens), not by billable input.
 *
 * **Thinking tokens:** Thinking tokens are already accounted for inside
 * `outputTokens` (GROSS convention) and are billed at the standard output
 * rate — there is no separate thinking lane in this table.
 *
 * All entries marked `// VERIFY` reflect best-effort values derived from
 * Google's public pricing page and should be re-confirmed before use in
 * production billing systems.
 *
 * @module
 */

/** Identifies this pricing snapshot — bump the date when rates change. */
export const pricingVersion = 'gemini-2026-06-27' as const

/**
 * Per-model rate entry (all values in µUSD per million tokens).
 *
 * `tiered` models have two rate sets; the `gt200k` set applies when the GROSS
 * input token count is strictly greater than 200,000.
 */
export interface ModelRates {
  /** µUSD per million input tokens (billable = gross − cached). */
  inputPerM: number
  /** µUSD per million cache-read tokens. */
  cachedPerM: number
  /** µUSD per million output tokens (thinking is folded in). */
  outputPerM: number
  /**
   * Optional high-tier rates for long-context models (GROSS input > 200k).
   * When present, the engine selects these rates instead of the base rates.
   */
  gt200k?: {
    inputPerM: number
    cachedPerM: number
    outputPerM: number
  }
}

/**
 * Frozen Gemini pricing snapshot.
 *
 * Keys are model-string prefixes / exact identifiers as used in routing.
 * The cost engine performs an exact-match lookup first, then falls back to
 * prefix matching (longest prefix wins).
 *
 * Sources:
 * - https://ai.google.dev/pricing  (accessed 2026-06-27)
 * - https://cloud.google.com/vertex-ai/generative-ai/pricing
 */
export const GEMINI_PRICING: Readonly<Record<string, ModelRates>> = Object.freeze({
  // ── Gemini 2.5 Pro ────────────────────────────────────────────────────────
  // Tiered pricing: base rate ≤ 200k GROSS input tokens; premium above 200k.
  // Source: https://ai.google.dev/pricing#2_5pro
  'gemini-2.5-pro': {
    inputPerM: 1_250_000,   // $1.25 / M  → 1 250 000 µUSD / M
    cachedPerM: 310_000,    // $0.31 / M  → 310 000 µUSD / M
    outputPerM: 10_000_000, // $10.00 / M → 10 000 000 µUSD / M
    gt200k: {
      inputPerM: 2_500_000,   // $2.50 / M  → 2 500 000 µUSD / M  // VERIFY
      cachedPerM: 630_000,    // $0.63 / M  → 630 000 µUSD / M    // VERIFY
      outputPerM: 15_000_000, // $15.00 / M → 15 000 000 µUSD / M // VERIFY
    },
  },

  // ── Gemini 2.5 Flash ──────────────────────────────────────────────────────
  // Flat pricing; thinking tokens billed at output rate (no separate lane).
  // Source: https://ai.google.dev/pricing#2_5flash
  'gemini-2.5-flash': {
    inputPerM: 300_000,    // $0.30 / M  → 300 000 µUSD / M  // VERIFY (non-thinking input)
    cachedPerM: 75_000,    // $0.075 / M → 75 000 µUSD / M   // VERIFY
    outputPerM: 2_500_000, // $2.50 / M  → 2 500 000 µUSD / M // VERIFY (blended; thinking billed here)
  },

  // ── Gemini 2.5 Flash-Lite ─────────────────────────────────────────────────
  // Optimised for latency-sensitive / low-cost workloads; flat pricing.
  // Source: https://ai.google.dev/pricing#2_5flash-lite
  'gemini-2.5-flash-lite': {
    inputPerM: 100_000,   // $0.10 / M  → 100 000 µUSD / M // VERIFY
    cachedPerM: 25_000,   // $0.025 / M → 25 000 µUSD / M  // VERIFY
    outputPerM: 400_000,  // $0.40 / M  → 400 000 µUSD / M // VERIFY
  },

  // ── Gemini 3.x Flash (placeholder — verify before use) ───────────────────
  // Gemini 3.0 Flash rates are not publicly confirmed as of 2026-06-27.
  // These values are extrapolated from the 2.5-Flash trajectory; MUST be
  // verified against the official pricing page before billing.
  'gemini-3.0-flash': {
    inputPerM: 250_000,   // $0.25 / M  → 250 000 µUSD / M // VERIFY — estimated
    cachedPerM: 62_500,   // $0.0625 / M → 62 500 µUSD / M  // VERIFY — estimated
    outputPerM: 2_000_000, // $2.00 / M  → 2 000 000 µUSD / M // VERIFY — estimated
  },

  // ── Gemini 3.x Flash-Lite (placeholder — verify before use) ──────────────
  'gemini-3.0-flash-lite': {
    inputPerM: 80_000,    // $0.08 / M  → 80 000 µUSD / M  // VERIFY — estimated
    cachedPerM: 20_000,   // $0.02 / M  → 20 000 µUSD / M  // VERIFY — estimated
    outputPerM: 300_000,  // $0.30 / M  → 300 000 µUSD / M // VERIFY — estimated
  },
})
