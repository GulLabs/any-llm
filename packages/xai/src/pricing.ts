/**
 * xAI pricing snapshot + cost computation for @gullabs/xai.
 *
 * All rates are in **micro-USD per million tokens** (µUSD/M), matching
 * `@gullabs/core`'s `ModelRates` convention exactly: `cost_µUSD = N *
 * ratePerM / 1_000_000`.
 *
 * This is a SELF-CONTAINED, xai-owned reimplementation — it does NOT import
 * core's Gemini-specific `computeCost`/`GEMINI_PRICING`/`geminiPricingSource`
 * (those are Gemini-only). `PricingSource` is provider-scoped by contract
 * (see `packages/core/src/ports.ts`); this module is xai's own.
 *
 * **Long-context tier.** grok-4.5 / grok-4.6 charge a premium when the GROSS
 * input token count exceeds 200,000 (`long_context_threshold` in xAI's
 * `/v1/models` listing). Selected by `inputTokens` (incl. cached), not by
 * billable input — mirrors core's `selectRates` convention exactly (strictly
 * greater than 200,000).
 *
 * **Service tiers.** grok-4.5 has none. grok-4.6 admits `'priority'`
 * (echo live-verified 2026-08-12). The 2× multiplier is confirmed by
 * fixture `12-grok-4-6-xhigh-priority.json` (`cost_in_usd_ticks` equals
 * exactly 2× standard list). `'default'` (the value xAI echoes when no
 * priority is served) and `undefined` (no tier requested) price at the
 * standard list. Any other defined tier is unpriced (reject-don't-map).
 *
 * **Conversion factor.** xAI's `/v1/models` raw `*_token_price` fields are
 * in hundred-thousandths of a dollar per token (i.e. divide the raw integer
 * by 10,000 to get USD per million tokens): e.g. `grok-4.6`'s raw
 * `prompt_text_token_price: 20000` ÷ 10,000 = $2.00/M.
 *
 * Verified against `/v1/models` on 2026-08-12. Prior snapshot
 * `xai-2026-07-09` priced grok-4.5 cached input at $0.50 / $1.00; the live
 * listing now reports $0.30 / $0.60.
 *
 * @module
 */

import type { Cost, PricingSource, Usage } from '@gullabs/core'

/** Identifies this pricing snapshot — bump the date when rates change. */
export const xaiPricingVersion = 'xai-2026-08-24' as const

/**
 * Live-pinned 2026-08-24 per-invocation tool rates (µUSD per call).
 * Source: `usage.server_side_tool_usage_details` on /v1/responses.
 * $5 / 1,000 web or X searches; $10 / 1,000 attachment/document searches.
 */
export const XAI_TOOL_RATE_MICRO_USD = {
  web_search_calls: 5_000,
  x_search_calls: 5_000,
  document_search_calls: 10_000,
} as const

const XAI_TOOL_COUNTER_KEYS = [
  'web_search_calls',
  'x_search_calls',
  'document_search_calls',
] as const

/**
 * Per-model rate entry (all values in µUSD per million tokens).
 *
 * `gt200k` (when present) applies when GROSS input tokens > 200,000.
 */
export interface XaiModelRates {
  /** µUSD per million input tokens (billable = gross − cached). */
  inputPerM: number
  /** µUSD per million cache-read tokens. */
  cachedPerM: number
  /** µUSD per million output tokens (reasoning tokens are folded in). */
  outputPerM: number
  /** Optional high-tier rates for long-context (GROSS input > 200k). */
  gt200k?: {
    inputPerM: number
    cachedPerM: number
    outputPerM: number
  }
  /**
   * Multiplier for Responses `service_tier: "priority"`. Absent = this
   * model does not admit priority (unpriced). Uncached standard-list 2×
   * is confirmed by fixture `12-grok-4-6-xhigh-priority.json` ticks;
   * cached and `gt200k` legs follow the official 2×-after-cache-discount
   * docs rule (that fixture has cached=0 and input < 200k).
   */
  priorityFactor?: number
}

/**
 * Frozen xAI pricing snapshot (per-1M in µUSD).
 *
 * Keys are EXACT canonical model identifiers — no prefix or alias matching.
 * xAI aliases (e.g. `grok-4.5-latest`, `grok-build-latest`) are deliberately
 * NOT registered/priced (reject-don't-map): callers must use the canonical
 * id; anything else resolves to the unpriced path.
 */
export const XAI_PRICING: Readonly<Record<string, XaiModelRates>> = Object.freeze({
  // ── grok-4.5 ──  $2.00/$6.00 (≤200k), $4.00/$12.00 (>200k); cached $0.30/$0.60
  'grok-4.5': {
    inputPerM: 2_000_000,
    cachedPerM: 300_000,
    outputPerM: 6_000_000,
    gt200k: {
      inputPerM: 4_000_000,
      cachedPerM: 600_000,
      outputPerM: 12_000_000,
    },
  },
  // ── grok-4.6 ──  $2.00/$6.00 (≤200k), $4.00/$12.00 (>200k); cached $0.50/$1.00
  'grok-4.6': {
    inputPerM: 2_000_000,
    cachedPerM: 500_000,
    outputPerM: 6_000_000,
    gt200k: {
      inputPerM: 4_000_000,
      cachedPerM: 1_000_000,
      outputPerM: 12_000_000,
    },
    // Confirmed 2026-08-12 by fixture 12 cost_in_usd_ticks (2× list).
    priorityFactor: 2,
  },
})

const LONG_CONTEXT_THRESHOLD = 200_000

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up rates for a model — EXACT match only.
 *
 * Deliberately no prefix matching (unlike core's Gemini lookup): xAI aliases
 * such as `grok-4.5-latest` would otherwise prefix-match `grok-4.5` and
 * silently reintroduce the alias behavior the model registry rejects. An id
 * that is not an exact `XAI_PRICING` key is unpriced.
 */
function lookupRates(model: string): XaiModelRates | undefined {
  return XAI_PRICING[model]
}

/**
 * Select the applicable rate set for a model given the GROSS input token
 * count. When a model has a `gt200k` tier, that tier's rates apply when
 * `grossInputTokens` is **strictly greater than** 200,000.
 */
function selectRates(
  rates: XaiModelRates,
  grossInputTokens: number,
): { inputPerM: number; cachedPerM: number; outputPerM: number } {
  if (rates.gt200k !== undefined && grossInputTokens > LONG_CONTEXT_THRESHOLD) {
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
 * Compute the cost of an xAI LLM call given a model name and usage data.
 *
 * Pure function — no side effects, always returns a well-formed {@link Cost}.
 *
 * **Algorithm** (mirrors `@gullabs/core`'s `computeCost` exactly, xai-owned):
 * 1. Look up rates for `model`; if not found, return an unpriced `Cost`
 *    (`microUsd: null`) naming the model.
 * 2. `undefined` or `'default'` prices at the standard list.
 *    `'priority'` applies `rates.priorityFactor` when present.
 *    Any other defined tier, or `'priority'` on a model without
 *    `priorityFactor`, is unpriced (reject-don't-map).
 * 3. Select base vs. `>200k` long-context rates from GROSS `inputTokens`.
 * 4. Billable input = `inputTokens − (cachedInputTokens ?? 0)`, clamped to 0.
 * 5. Round each component (input, cached, output) independently to the
 *    nearest integer micro-USD.
 * 6. `microUsd` is the sum of the four components — guarantees
 *    `details.input + details.cached + details.output + details.tools === microUsd`.
 * 7. Tool lanes: live-pinned counters `web_search_calls`, `x_search_calls`,
 *    `document_search_calls`. If `usage.details.server_tools_requested === 1`
 *    and those counters are absent, token lanes are priced, `tools: 0`,
 *    `confidence: 'estimated'`. `'exact'` requires counters present or no
 *    server tools requested.
 */
export function computeXaiCost(model: string, usage: Usage, tier?: string): Cost {
  const rates = lookupRates(model)

  if (rates === undefined) {
    return {
      microUsd: null,
      usd: null,
      pricingVersion: xaiPricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0, tools: 0 },
      unpricedReason: `Unknown model "${model}"; no pricing entry found.`,
    }
  }

  let factor = 1
  if (tier !== undefined && tier !== 'default') {
    if (tier === 'priority' && rates.priorityFactor !== undefined) {
      factor = rates.priorityFactor
    } else {
      return {
        microUsd: null,
        usd: null,
        pricingVersion: xaiPricingVersion,
        confidence: 'estimated',
        details: { input: 0, cached: 0, output: 0, tools: 0 },
        unpricedReason: `Unknown service tier "${tier}"; xai model "${model}" has no such tier, refusing to guess a pricing multiplier.`,
      }
    }
  }

  const base = selectRates(rates, usage.inputTokens)

  const cached = usage.cachedInputTokens ?? 0
  const billableInput = Math.max(0, usage.inputTokens - cached)

  const inputCost = Math.round((billableInput * base.inputPerM * factor) / 1_000_000)
  const cachedCost = Math.round((cached * base.cachedPerM * factor) / 1_000_000)
  const outputCost = Math.round(
    (usage.outputTokens * base.outputPerM * factor) / 1_000_000,
  )

  const serverToolsRequested = usage.details['server_tools_requested'] === 1
  const countersPresent = XAI_TOOL_COUNTER_KEYS.some((key) => key in usage.details)
  const missingRequestedCounters = serverToolsRequested && !countersPresent

  const toolsCost = missingRequestedCounters
    ? 0
    : XAI_TOOL_COUNTER_KEYS.reduce((sum, key) => {
        const count = usage.details[key]
        if (typeof count !== 'number' || count <= 0) return sum
        return sum + Math.round(count * XAI_TOOL_RATE_MICRO_USD[key])
      }, 0)

  const microUsd = inputCost + cachedCost + outputCost + toolsCost

  return {
    microUsd,
    usd: microUsd / 1_000_000,
    pricingVersion: xaiPricingVersion,
    confidence: missingRequestedCounters ? 'estimated' : 'exact',
    details: {
      input: inputCost,
      cached: cachedCost,
      output: outputCost,
      tools: toolsCost,
    },
  }
}

/**
 * Factory that returns the **xai-scoped** {@link PricingSource} port
 * implementation backed by {@link XAI_PRICING}.
 *
 * @example
 * ```ts
 * import { xaiPricingSource } from '@gullabs/xai'
 *
 * const pricing = xaiPricingSource()
 * const cost = pricing.price('grok-4.6', usage)
 * ```
 */
export function xaiPricingSource(): PricingSource {
  return {
    version: xaiPricingVersion,
    price(model: string, usage: Usage, tier?: string): Cost {
      return computeXaiCost(model, usage, tier)
    },
    hasModel(model: string): boolean {
      return lookupRates(model) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(XAI_PRICING)
    },
  }
}
