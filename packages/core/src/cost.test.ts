/**
 * Tests for cost computation in @gullabs/core.
 *
 * Covers:
 * - The codex-mandated 250k/100k/5k/2k scenario (no double-counting).
 * - Long-context tier boundary at exactly 200k (base rate applies).
 * - cached === input (billable input = 0).
 * - cached > input (defensive clamp; no negative cost).
 * - Zero tokens everywhere.
 * - Unknown model → microUsd null + confidence estimated.
 * - Flat (non-tiered) model pricing.
 * - Property: sum(details) === microUsd for arbitrary usages on a known model.
 */

import { describe, it, expect } from 'vitest'
import { computeCost, geminiPricingSource } from './cost.js'
import { pricingVersion, GEMINI_PRICING } from './pricing.js'
import type { Usage } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Usage with the open details map and raw blob. */
function makeUsage(fields: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  thinkingTokens?: number
  totalTokens?: number
}): Usage {
  return {
    ...fields,
    details: {},
    raw: null,
  }
}

// ---------------------------------------------------------------------------
// Helper: expected per-component micro-USD
// ---------------------------------------------------------------------------

/**
 * Reference computation used inside tests.
 * Mirrors the cost.ts algorithm so assertions remain tightly coupled to the spec.
 */
function expectedComponents(
  inputPerM: number,
  cachedPerM: number,
  outputPerM: number,
  billableInput: number,
  cached: number,
  outputTokens: number,
): { inputCost: number; cachedCost: number; outputCost: number; microUsd: number } {
  const inputCost = Math.round((billableInput * inputPerM) / 1_000_000)
  const cachedCost = Math.round((cached * cachedPerM) / 1_000_000)
  const outputCost = Math.round((outputTokens * outputPerM) / 1_000_000)
  return { inputCost, cachedCost, outputCost, microUsd: inputCost + cachedCost + outputCost }
}

// ---------------------------------------------------------------------------
// The codex-mandated high-risk test
// ---------------------------------------------------------------------------

describe('computeCost — codex-mandated double-counting scenario', () => {
  it('usage {input:250k, cached:100k, output:5k, thinking:2k} on gemini-2.5-pro', () => {
    // GIVEN
    const usage = makeUsage({
      inputTokens: 250_000,
      cachedInputTokens: 100_000,
      outputTokens: 5_000,
      thinkingTokens: 2_000,
    })

    // WHEN
    const cost = computeCost('gemini-2.5-pro', usage)

    // Assert: gross input (250k) > 200k → >200k tier MUST be chosen.
    // We verify by using the gt200k rates from the snapshot.
    const proRates = GEMINI_PRICING['gemini-2.5-pro']
    expect(proRates).toBeDefined()
    expect(proRates?.gt200k).toBeDefined()
    const gt200k = proRates!.gt200k!

    // Billable input = 250k − 100k = 150k (not 250k, not 100k alone).
    const billableInput = 150_000
    const cached = 100_000
    const outputTokens = 5_000

    const expected = expectedComponents(
      gt200k.inputPerM,
      gt200k.cachedPerM,
      gt200k.outputPerM,
      billableInput,
      cached,
      outputTokens,
    )

    // microUsd must be a number (not null).
    expect(cost.microUsd).not.toBeNull()
    expect(typeof cost.microUsd).toBe('number')

    // Assert tier: cost.microUsd must equal the >200k-tier calculation.
    expect(cost.microUsd).toBe(expected.microUsd)

    // Assert each component individually.
    expect(cost.details.input).toBe(expected.inputCost)    // 150k billed at >200k input rate
    expect(cost.details.cached).toBe(expected.cachedCost)  // 100k at cached rate
    expect(cost.details.output).toBe(expected.outputCost)  // 5k billed once at output rate

    // Assert: thinkingTokens (2k) adds ZERO incremental cost.
    // Verify: same result with thinkingTokens stripped out.
    const noThinkingUsage = makeUsage({
      inputTokens: 250_000,
      cachedInputTokens: 100_000,
      outputTokens: 5_000, // same outputTokens; thinkingTokens is just metadata
    })
    const costNoThinking = computeCost('gemini-2.5-pro', noThinkingUsage)
    expect(cost.microUsd).toBe(costNoThinking.microUsd)
    expect(cost.details).toEqual(costNoThinking.details)

    // Assert sum invariant — the critical constraint.
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(cost.microUsd)

    // Confirm >200k rates produce a higher cost than base rates would.
    const baseExpected = expectedComponents(
      proRates!.inputPerM,
      proRates!.cachedPerM,
      proRates!.outputPerM,
      billableInput,
      cached,
      outputTokens,
    )
    expect(cost.microUsd as number).toBeGreaterThan(baseExpected.microUsd)

    // Confidence and version.
    expect(cost.confidence).toBe('exact')
    expect(cost.pricingVersion).toBe(pricingVersion)
  })
})

// ---------------------------------------------------------------------------
// Tier boundary
// ---------------------------------------------------------------------------

describe('computeCost — tier boundary', () => {
  it('GROSS input exactly at 200k uses base rate (not >200k)', () => {
    const usage = makeUsage({ inputTokens: 200_000, outputTokens: 1_000 })
    const cost = computeCost('gemini-2.5-pro', usage)

    const proRates = GEMINI_PRICING['gemini-2.5-pro']!
    const expected = expectedComponents(
      proRates.inputPerM,
      proRates.cachedPerM,
      proRates.outputPerM,
      200_000,
      0,
      1_000,
    )
    expect(cost.microUsd).toBe(expected.microUsd)
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(cost.microUsd)
  })

  it('GROSS input one token above 200k triggers >200k tier', () => {
    const usage = makeUsage({ inputTokens: 200_001, outputTokens: 1_000 })
    const cost = computeCost('gemini-2.5-pro', usage)

    const proRates = GEMINI_PRICING['gemini-2.5-pro']!
    const expected = expectedComponents(
      proRates.gt200k!.inputPerM,
      proRates.gt200k!.cachedPerM,
      proRates.gt200k!.outputPerM,
      200_001,
      0,
      1_000,
    )
    expect(cost.microUsd).toBe(expected.microUsd)
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(cost.microUsd)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('computeCost — edge cases', () => {
  it('cached === input → zero billable input, only cached + output cost', () => {
    const usage = makeUsage({
      inputTokens: 50_000,
      cachedInputTokens: 50_000,
      outputTokens: 2_000,
    })
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).not.toBeNull()
    expect(cost.details.input).toBe(0) // 0 billable input tokens
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(cost.microUsd)
  })

  it('cached > input → clamps to zero billable input (no negative cost)', () => {
    // Defensive: violates GROSS invariant but must not throw or produce negative cost.
    const usage = makeUsage({
      inputTokens: 1_000,
      cachedInputTokens: 5_000, // more than input — invalid but handled defensively
      outputTokens: 500,
    })
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).not.toBeNull()
    expect(cost.details.input).toBeGreaterThanOrEqual(0) // never negative
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(cost.microUsd)
  })

  it('zero tokens everywhere → microUsd = 0', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0 })
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).toBe(0)
    expect(cost.details).toEqual({ input: 0, cached: 0, output: 0 })
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(cost.microUsd)
  })

  it('unknown model → microUsd null, confidence estimated, details zero', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const cost = computeCost('some-future-model-xyz', usage)

    expect(cost.microUsd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.details).toEqual({ input: 0, cached: 0, output: 0 })
    expect(cost.pricingVersion).toBe(pricingVersion)
  })

  it('flat (non-tiered) model: gemini-2.5-flash-lite', () => {
    const usage = makeUsage({
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 50_000,
    })
    const cost = computeCost('gemini-2.5-flash-lite', usage)

    const liteRates = GEMINI_PRICING['gemini-2.5-flash-lite']!
    // No gt200k tier exists on flash-lite.
    expect(liteRates.gt200k).toBeUndefined()

    const expected = expectedComponents(
      liteRates.inputPerM,
      liteRates.cachedPerM,
      liteRates.outputPerM,
      800_000, // 1_000_000 − 200_000
      200_000,
      50_000,
    )

    expect(cost.microUsd).toBe(expected.microUsd)
    expect(cost.confidence).toBe('exact')
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(cost.microUsd)
  })

  it('prefix match: gemini-2.5-pro-001 → matched to gemini-2.5-pro rates', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const costFull = computeCost('gemini-2.5-pro', usage)
    const costVersioned = computeCost('gemini-2.5-pro-001', usage)

    expect(costVersioned.microUsd).toBe(costFull.microUsd)
    expect(costVersioned.confidence).toBe('exact')
  })
})

// ---------------------------------------------------------------------------
// geminiPricingSource() port implementation
// ---------------------------------------------------------------------------

describe('geminiPricingSource', () => {
  it('implements PricingSource: version matches pricingVersion', () => {
    const src = geminiPricingSource()
    expect(src.version).toBe(pricingVersion)
  })

  it('price() delegates to computeCost correctly', () => {
    const src = geminiPricingSource()
    const usage = makeUsage({ inputTokens: 100_000, outputTokens: 5_000 })
    const direct = computeCost('gemini-2.5-flash', usage)
    const viaSrc = src.price('gemini-2.5-flash', usage)

    expect(viaSrc).toEqual(direct)
  })

  it('price() handles unknown model consistently with computeCost', () => {
    const src = geminiPricingSource()
    const usage = makeUsage({ inputTokens: 1_000, outputTokens: 100 })
    const cost = src.price('totally-unknown-model', usage, 'flex')

    expect(cost.microUsd).toBeNull()
    expect(cost.confidence).toBe('estimated')
  })
})

// ---------------------------------------------------------------------------
// Property: sum(details) === microUsd for randomised usages
// ---------------------------------------------------------------------------

describe('property — sum(details) === microUsd', () => {
  const KNOWN_MODELS = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ] as const

  // Deterministic pseudo-random number generator (LCG) so tests are
  // reproducible without importing a random library.
  function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = Math.imul(1664525, s) + 1013904223
      return (s >>> 0) / 0x100000000
    }
  }

  it('holds for 200 randomised usages across known models', () => {
    const rand = lcg(0xdeadbeef)
    const failures: string[] = []

    for (let i = 0; i < 200; i++) {
      const model = KNOWN_MODELS[i % KNOWN_MODELS.length]!
      const inputTokens = Math.floor(rand() * 500_000)
      const maxCached = Math.min(inputTokens, Math.floor(rand() * inputTokens))
      const cachedInputTokens = Math.floor(rand() * maxCached)
      const outputTokens = Math.floor(rand() * 100_000)
      const thinkingTokens = Math.floor(rand() * outputTokens)

      const usage = makeUsage({
        inputTokens,
        outputTokens,
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
      })

      const cost = computeCost(model, usage)

      if (cost.microUsd === null) {
        // Unknown model shouldn't appear here, but skip gracefully.
        continue
      }

      const sum = cost.details.input + cost.details.cached + cost.details.output
      if (sum !== cost.microUsd) {
        failures.push(
          `i=${i} model=${model} input=${inputTokens} cached=${cachedInputTokens} output=${outputTokens}` +
          ` → sum=${sum} !== microUsd=${cost.microUsd}`,
        )
      }
    }

    expect(failures).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// usd convenience field
// ---------------------------------------------------------------------------

describe('Cost.usd — derived convenience field', () => {
  it('usd === microUsd / 1e6 for a priced call (round-trip within 1 µUSD)', () => {
    const usage = makeUsage({ inputTokens: 100_000, outputTokens: 5_000 })
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).not.toBeNull()
    expect(cost.usd).not.toBeNull()
    // Round-trip: converting usd back to µUSD must equal the canonical value.
    expect(Math.round(cost.usd! * 1_000_000)).toBe(cost.microUsd)
  })

  it('usd === null when model is unpriced (microUsd null)', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const cost = computeCost('some-future-model-xyz', usage)

    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
  })

  it('usd is exact division without rounding (microUsd / 1_000_000)', () => {
    // Use a model and token count that produces a non-round microUsd.
    const usage = makeUsage({ inputTokens: 1_000, outputTokens: 333 })
    const cost = computeCost('gemini-2.5-flash', usage)

    if (cost.microUsd !== null) {
      expect(cost.usd).toBe(cost.microUsd / 1_000_000)
    }
  })
})
