/**
 * Tests for xai pricing computation (`computeXaiCost` / `xaiPricingSource`).
 *
 * Covers standard-tier cost math, the >200k gt200k boundary, cached-token
 * math, an unpriced/unknown-model path, and `hasModel`/`listModels`.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { Usage } from '@gullabs/core'
import {
  computeXaiCost,
  xaiPricingSource,
  xaiPricingVersion,
  XAI_PRICING,
} from './pricing.js'

/** xAI `/v1/models` raw price → µUSD/M (raw / 10_000 = USD/M; × 1e6 = µUSD/M). */
function rawToMicroPerM(raw: number): number {
  return (raw / 10_000) * 1_000_000
}

const v1Models = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/14-v1-models-pricing.json', import.meta.url)),
    'utf8',
  ),
) as {
  models: Record<
    string,
    {
      prompt_text_token_price: number
      cached_prompt_text_token_price: number
      completion_text_token_price: number
      prompt_text_token_price_long_context: number
      cached_prompt_text_token_price_long_context: number
      completion_text_token_price_long_context: number
    }
  >
}

const grok46PriorityFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./__fixtures__/12-grok-4-6-xhigh-priority.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  body: {
    usage: {
      input_tokens: number
      input_tokens_details?: { cached_tokens?: number }
      output_tokens: number
      cost_in_usd_ticks: number
    }
  }
}

function makeUsage(fields: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}): Usage {
  return {
    ...fields,
    details: {},
    raw: null,
  }
}

describe('computeXaiCost — standard tier', () => {
  it('computes exact µUSD for a small usage sample (grok-4.5)', () => {
    // input: 1000 tokens, 200 cached, output: 500 tokens
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const cost = computeXaiCost('grok-4.5', usage)

    // billableInput = 1000 - 200 = 800
    // inputCost = round(800 * 2_000_000 / 1_000_000) = 1600
    // cachedCost = round(200 * 300_000 / 1_000_000) = 60
    // outputCost = round(500 * 6_000_000 / 1_000_000) = 3000
    expect(cost.confidence).toBe('exact')
    expect(cost.pricingVersion).toBe(xaiPricingVersion)
    expect(cost.details).toEqual({ input: 1600, cached: 60, output: 3000, tools: 0 })
    expect(cost.microUsd).toBe(1600 + 60 + 3000)
    expect(cost.usd).toBe((1600 + 60 + 3000) / 1_000_000)
  })

  it('sum invariant: details.input + details.cached + details.output === microUsd', () => {
    const usage = makeUsage({
      inputTokens: 12345,
      outputTokens: 678,
      cachedInputTokens: 111,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    expect(
      cost.details.input + cost.details.cached + cost.details.output + cost.details.tools,
    ).toBe(cost.microUsd)
  })
})

describe('computeXaiCost — >200k gt200k boundary', () => {
  it('applies standard rates at exactly 200,000 gross input tokens', () => {
    const usage = makeUsage({
      inputTokens: 200_000,
      outputTokens: 100,
      cachedInputTokens: 0,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // standard inputPerM = 2_000_000 -> inputCost = round(200000 * 2_000_000 / 1e6) = 400_000
    expect(cost.details.input).toBe(400_000)
  })

  it('applies gt200k rates at 200,001 gross input tokens', () => {
    const usage = makeUsage({
      inputTokens: 200_001,
      outputTokens: 100,
      cachedInputTokens: 0,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // gt200k inputPerM = 4_000_000 -> inputCost = round(200001 * 4_000_000 / 1e6) = 800_004
    expect(cost.details.input).toBe(800_004)
  })
})

describe('computeXaiCost — cached-token math', () => {
  it('bills cached tokens at cachedPerM and non-cached billable input at inputPerM', () => {
    // Below the 200k long-context threshold, so standard rates apply.
    const usage = makeUsage({
      inputTokens: 150_000,
      outputTokens: 0,
      cachedInputTokens: 150_000,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // billableInput = 0, cachedCost = round(150_000 * 300_000 / 1e6) = 45_000
    expect(cost.details.input).toBe(0)
    expect(cost.details.cached).toBe(45_000)
    expect(cost.details.output).toBe(0)
  })

  it('prices grok-4.6 cached tokens at the 4.6 cachedPerM ($0.50)', () => {
    const usage = makeUsage({
      inputTokens: 150_000,
      outputTokens: 0,
      cachedInputTokens: 150_000,
    })
    const cost = computeXaiCost('grok-4.6', usage)
    // cachedCost = round(150_000 * 500_000 / 1e6) = 75_000
    expect(cost.details.input).toBe(0)
    expect(cost.details.cached).toBe(75_000)
    expect(cost.details.output).toBe(0)
  })
})

describe('computeXaiCost — unpriced paths', () => {
  it('returns microUsd: null for an unknown model', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-99', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toMatch(/grok-99/)
  })

  it('returns microUsd: null when an unrecognized tier is supplied', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-4.5', usage, 'flex')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/flex/)
  })

  it('returns microUsd: null when priority is supplied for grok-4.5', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-4.5', usage, 'priority')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/priority/)
  })

  it('prices grok-4.6 priority at 2× the standard list', () => {
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const standard = computeXaiCost('grok-4.6', usage)
    const priority = computeXaiCost('grok-4.6', usage, 'priority')
    expect(standard.microUsd).not.toBeNull()
    expect(standard.confidence).toBe('exact')
    expect(priority.microUsd).toBe((standard.microUsd as number) * 2)
    expect(priority.confidence).toBe('exact')
    expect(priority.details.input).toBe(standard.details.input * 2)
    expect(priority.details.cached).toBe(standard.details.cached * 2)
    expect(priority.details.output).toBe(standard.details.output * 2)
  })

  it('prices grok-4.6 served tier default at the standard list (exact)', () => {
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const standard = computeXaiCost('grok-4.6', usage)
    const servedDefault = computeXaiCost('grok-4.6', usage, 'default')
    expect(servedDefault).toEqual(standard)
    expect(servedDefault.confidence).toBe('exact')
  })

  it('prices grok-4.5 served tier default at the standard list (exact)', () => {
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const standard = computeXaiCost('grok-4.5', usage)
    const servedDefault = computeXaiCost('grok-4.5', usage, 'default')
    expect(servedDefault).toEqual(standard)
    expect(servedDefault.confidence).toBe('exact')
  })

  it('does NOT prefix-match aliases — grok-4.5-latest is unpriced', () => {
    // Alias ids are deliberately not registered/priced (reject-don't-map);
    // exact-match-only lookup prevents `grok-4.5-latest` from silently
    // pricing as `grok-4.5`.
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000 })
    const cost = computeXaiCost('grok-4.5-latest', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toMatch(/grok-4\.5-latest/)
  })

  it('does NOT prefix-match grok-build-latest either', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-build-latest', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/grok-build-latest/)
  })
})

describe('XAI_PRICING vs live /v1/models fixture', () => {
  it.each(['grok-4.5', 'grok-4.6'] as const)(
    'pins %s rates to captured /v1/models raw fields',
    (model) => {
      const raw = v1Models.models[model]
      const rates = XAI_PRICING[model]
      if (raw === undefined || rates === undefined) {
        throw new Error(`missing pricing fixture or rates for ${model}`)
      }
      expect(rates.inputPerM).toBe(rawToMicroPerM(raw.prompt_text_token_price))
      expect(rates.cachedPerM).toBe(rawToMicroPerM(raw.cached_prompt_text_token_price))
      expect(rates.outputPerM).toBe(rawToMicroPerM(raw.completion_text_token_price))
      expect(rates.gt200k?.inputPerM).toBe(
        rawToMicroPerM(raw.prompt_text_token_price_long_context),
      )
      expect(rates.gt200k?.cachedPerM).toBe(
        rawToMicroPerM(raw.cached_prompt_text_token_price_long_context),
      )
      expect(rates.gt200k?.outputPerM).toBe(
        rawToMicroPerM(raw.completion_text_token_price_long_context),
      )
    },
  )
})

describe('computeXaiCost vs live cost_in_usd_ticks', () => {
  it('reconciles grok-4.6 priority fixture ticks at 2× the standard list', () => {
    const usage = grok46PriorityFixture.body.usage
    const cost = computeXaiCost(
      'grok-4.6',
      makeUsage({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      }),
      'priority',
    )
    // 1 tick = 1e-10 USD; Cost.usd is USD. Fixture 12: 82_960_000 ticks.
    expect(cost.usd).toBe(usage.cost_in_usd_ticks * 1e-10)
    expect(cost.confidence).toBe('exact')
  })
})

describe('xaiPricingSource', () => {
  it('hasModel is true for grok-4.5 / grok-4.6 and false for an unknown model', () => {
    const source = xaiPricingSource()
    expect(source.hasModel('grok-4.5')).toBe(true)
    expect(source.hasModel('grok-4.6')).toBe(true)
    expect(source.hasModel('grok-99')).toBe(false)
  })

  it('hasModel is exact-match only — aliases are not recognized', () => {
    const source = xaiPricingSource()
    expect(source.hasModel('grok-4.5-latest')).toBe(false)
    expect(source.hasModel('grok-build-latest')).toBe(false)
  })

  it('listModels returns the XAI_PRICING keys', () => {
    const source = xaiPricingSource()
    expect(source.listModels()).toEqual(Object.keys(XAI_PRICING))
  })

  it('version matches xaiPricingVersion', () => {
    expect(xaiPricingSource().version).toBe(xaiPricingVersion)
  })

  it('price() delegates to computeXaiCost', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500 })
    const cost = xaiPricingSource().price('grok-4.5', usage)
    expect(cost.confidence).toBe('exact')
  })
})

describe('computeXaiCost — tool lanes (live-pinned 2026-08-24)', () => {
  it('prices web_search_calls and x_search_calls at $5/1k and document_search_calls at $10/1k', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: {
        web_search_calls: 2,
        x_search_calls: 1,
        document_search_calls: 3,
      },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    // 2*5000 + 1*5000 + 3*10000 = 45000
    expect(cost.details.tools).toBe(45_000)
    expect(cost.confidence).toBe('exact')
    expect(
      cost.details.input + cost.details.cached + cost.details.output + cost.details.tools,
    ).toBe(cost.microUsd)
  })

  it('gt200k token rates still apply independently of tool lanes', () => {
    const usage: Usage = {
      inputTokens: 200_001,
      outputTokens: 0,
      details: { web_search_calls: 1 },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.input).toBe(800_004)
    expect(cost.details.tools).toBe(5_000)
  })

  it('server_tools_requested without counters → tools 0, estimated', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: { server_tools_requested: 1 },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(0)
    expect(cost.confidence).toBe('estimated')
    expect(cost.details.input).toBeGreaterThan(0)
  })

  it('no server tools requested → exact, tools 0', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 0 })
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(0)
    expect(cost.confidence).toBe('exact')
  })

  it('server_tools_requested with counters present → exact and priced', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: { server_tools_requested: 1, web_search_calls: 1 },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(5_000)
    expect(cost.confidence).toBe('exact')
  })
})
