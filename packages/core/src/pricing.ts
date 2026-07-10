/**
 * Gemini pricing snapshot for @gullabs/core.
 *
 * All rates are in **micro-USD per million tokens** (µUSD/M).
 * To get the cost for N tokens: `cost_µUSD = N * ratePerM / 1_000_000`.
 *
 * **Service tiers.** Rates below are STANDARD-tier. Google's **Batch** tier is a
 * flat 50% discount on standard, and **Flex** matches Batch pricing. The cost
 * engine applies the {@link TIER_FACTOR} multiplier — this snapshot stores
 * standard rates only.
 *
 * **Long-context tier.** Gemini Pro models charge a premium when the GROSS input
 * token count exceeds 200,000. Selected by `inputTokens` (incl. cached), not by
 * billable input.
 *
 * **Thinking tokens.** Already inside `outputTokens` (GROSS convention) and
 * billed at the standard output rate — no separate thinking lane.
 *
 * **Modality caveat (v1 = text).** Gemini 2.5 Flash / Flash-Lite charge a higher
 * INPUT rate for audio tokens than for text/image/video. v1 is text-only and uses
 * the text/img/vid input rate. Per-modality input pricing is a deferred seam
 * (see DESIGN.md) — revisit when audio input is supported.
 *
 * Verified against https://ai.google.dev/gemini-api/docs/pricing on 2026-06-28.
 *
 * @module
 */

/** Identifies this pricing snapshot — bump the date when rates change. */
export const pricingVersion = 'gemini-2026-06-28' as const

/**
 * Service-tier price multipliers. Batch and Flex are a flat 50% of standard
 * (per Google's pricing page: "Batch API — 50% cost reduction"; Flex matches Batch).
 *
 * `serviceTier` is an opaque, provider-defined string end-to-end — this map is
 * the *only* place a tier name is resolved to a multiplier. A tier key not
 * present here is never coerced to `standard`: `computeCost` (cost.ts) treats
 * that as an unpriced call (reject-don't-map), not a mapping to this table's
 * default. `undefined` (no tier requested) is the one case that legitimately
 * defaults to `standard` — that is documented default behavior, not a guess.
 */
export const TIER_FACTOR: Readonly<Record<string, number>> = Object.freeze({
  standard: 1,
  flex: 0.5,
  batch: 0.5,
})

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

/**
 * Frozen Gemini pricing snapshot (STANDARD tier; per-1M in µUSD).
 *
 * Keys are model-string prefixes / exact identifiers used in routing. The cost
 * engine matches exact first, then longest-prefix.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (2026-06-28).
 */
export const GEMINI_PRICING: Readonly<Record<string, ModelRates>> = Object.freeze({
  // ── Gemini 2.5 Pro ──  $1.25/$10 (≤200k), $2.50/$15 (>200k); cached $0.125/$0.25
  'gemini-2.5-pro': {
    inputPerM: 1_250_000,
    cachedPerM: 125_000,
    outputPerM: 10_000_000,
    gt200k: {
      inputPerM: 2_500_000,
      cachedPerM: 250_000,
      outputPerM: 15_000_000,
    },
  },

  // ── Gemini 2.5 Flash ──  input $0.30 (text), output $2.50, cached $0.03
  'gemini-2.5-flash': {
    inputPerM: 300_000,
    cachedPerM: 30_000,
    outputPerM: 2_500_000,
  },

  // ── Gemini 2.5 Flash-Lite ──  input $0.10 (text), output $0.40, cached $0.01
  'gemini-2.5-flash-lite': {
    inputPerM: 100_000,
    cachedPerM: 10_000,
    outputPerM: 400_000,
  },

  // ── Gemini 3.5 Flash ──  input $1.50, output $9.00, cached $0.15
  'gemini-3.5-flash': {
    inputPerM: 1_500_000,
    cachedPerM: 150_000,
    outputPerM: 9_000_000,
  },

  // ── Gemini 3.1 Flash-Lite ──  input $0.25 (text), output $1.50, cached $0.025
  'gemini-3.1-flash-lite': {
    inputPerM: 250_000,
    cachedPerM: 25_000,
    outputPerM: 1_500_000,
  },

  // ── Gemini 3.1 Pro (preview) ──  $2.00/$12 (≤200k), $4.00/$18 (>200k); cached $0.20/$0.40
  'gemini-3.1-pro-preview': {
    inputPerM: 2_000_000,
    cachedPerM: 200_000,
    outputPerM: 12_000_000,
    gt200k: {
      inputPerM: 4_000_000,
      cachedPerM: 400_000,
      outputPerM: 18_000_000,
    },
  },

  // ── Gemini 3 Flash (preview) ──  input $0.50, output $3.00, cached $0.05 (90% discount)
  'gemini-3-flash-preview': {
    inputPerM: 500_000,
    cachedPerM: 50_000,
    outputPerM: 3_000_000,
  },
})
