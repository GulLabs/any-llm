/**
 * Tests for per-model config validation (Batch 2b).
 *
 * Verifies that:
 * - 3.x models with temperature/topP/topK in config throw bad_request
 * - 2.5 models accept temperature/topP/topK
 * - timeoutMs on 3.x does NOT trigger rejection
 * - All 7 descriptors have configJsonSchema and validateConfig
 * - gemini-3-flash-preview resolves and is priced
 * - Failed validation writes an error record to the sink
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  createClient,
  geminiPricingSource,
  geminiModelDescriptors,
  defaultGeminiRegistry,
  LlmError,
} from './index.js'
import type { AdapterResult, Usage } from './index.js'
import {
  FakeAdapter,
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeAuth,
} from '@gullabs/testing'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PRICING = geminiPricingSource()
const AUTH = fakeAuth({ apiKey: 'test-key' })

const GOOD_USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  details: {},
  raw: null,
}

function makeSuccessResult(model: string): AdapterResult {
  return {
    text: 'ok',
    usage: GOOD_USAGE,
    model,
    warnings: [],
  }
}

/**
 * Creates a client wired to a FakeAdapter that reports `model` as the
 * resolved model name.  The registry used is the default Gemini registry so
 * per-model validateConfig is present.
 */
function makeClient(model: string) {
  const clock = new FakeClock(1_000)
  const ids = new FakeIds()
  const sink = new RecordingSink()
  const adapter = new FakeAdapter('google', makeSuccessResult(model))

  const client = createClient({
    adapters: [adapter],
    auth: AUTH,
    pricing: PRICING,
    sink,
    clock,
    ids,
    // Use the default registry (includes validateConfig on each descriptor).
    modelRegistry: defaultGeminiRegistry,
  })

  return { client, sink, clock, ids }
}

const MESSAGES = [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] }]

// ---------------------------------------------------------------------------
// Helper: run a generate call that is expected to throw an LlmError,
// returning both the error and the sink state for inspection.
// ---------------------------------------------------------------------------
async function expectBadRequest(
  client: ReturnType<typeof makeClient>['client'],
  model: string,
  config: Parameters<typeof client.generate>[0]['config'],
): Promise<LlmError> {
  try {
    await client.generate({ model, messages: MESSAGES, config })
    throw new Error('expected generate() to throw, but it resolved')
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError)
    const err = e as LlmError
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    return err
  }
}

// ---------------------------------------------------------------------------
// 1. Descriptor completeness — all 7 models have configJsonSchema + validateConfig
// ---------------------------------------------------------------------------

describe('geminiModelDescriptors — Batch 2b fields', () => {
  it('has exactly 7 descriptors', () => {
    expect(geminiModelDescriptors).toHaveLength(7)
  })

  it('every descriptor has configJsonSchema (non-null JsonValue)', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.configJsonSchema, `${d.id} should have configJsonSchema`).toBeDefined()
      expect(d.configJsonSchema, `${d.id} configJsonSchema must not be null`).not.toBeNull()
    }
  })

  it('every descriptor has validateConfig (Standard Schema v1 shape)', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.validateConfig, `${d.id} should have validateConfig`).toBeDefined()
      expect(d.validateConfig!['~standard'].vendor).toBe('gullabs-gemini')
      expect(d.validateConfig!['~standard'].version).toBe(1)
      expect(typeof d.validateConfig!['~standard'].validate).toBe('function')
    }
  })

  it('2.5 models have sampling: tunable', () => {
    const tunable = geminiModelDescriptors.filter((d) => d.id.startsWith('gemini-2.5'))
    expect(tunable.length).toBeGreaterThan(0)
    for (const d of tunable) {
      expect(d.capabilities?.sampling, `${d.id}`).toBe('tunable')
    }
  })

  it('3.x models have sampling: fixed', () => {
    const fixed = geminiModelDescriptors.filter((d) => d.id.startsWith('gemini-3'))
    expect(fixed.length).toBeGreaterThan(0)
    for (const d of fixed) {
      expect(d.capabilities?.sampling, `${d.id}`).toBe('fixed')
    }
  })

  it('all 7 descriptors have caching.explicit === true', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.capabilities?.caching?.explicit, `${d.id}`).toBe(true)
    }
  })

  it('2.5 models have caching.minTokens === 2048', () => {
    const tunable = geminiModelDescriptors.filter((d) => d.id.startsWith('gemini-2.5'))
    for (const d of tunable) {
      expect(d.capabilities?.caching?.minTokens, `${d.id}`).toBe(2048)
    }
  })

  it('3.x models have caching.minTokens === 4096', () => {
    const fixed = geminiModelDescriptors.filter((d) => d.id.startsWith('gemini-3'))
    for (const d of fixed) {
      expect(d.capabilities?.caching?.minTokens, `${d.id}`).toBe(4096)
    }
  })

  it('gemini-3-flash-preview is in the descriptor list with correct fields', () => {
    const found = geminiModelDescriptors.find((d) => d.id === 'gemini-3-flash-preview')
    expect(found).toBeDefined()
    expect(found!.provider).toBe('google')
    expect(found!.capabilities?.reasoningApi).toBe('level')
    expect(found!.capabilities?.sampling).toBe('fixed')
    expect(found!.capabilities?.grounding).toBeUndefined()
    expect(found!.capabilities?.caching).toEqual({ explicit: true, minTokens: 4096 })
  })
})

// ---------------------------------------------------------------------------
// 2. makeGeminiConfigSchema — JSON Schema shape
// ---------------------------------------------------------------------------

describe('configJsonSchema shape', () => {
  it('2.5 model configJsonSchema includes temperature, topP, topK', () => {
    const desc = geminiModelDescriptors.find((d) => d.id === 'gemini-2.5-pro')!
    const schema = desc.configJsonSchema as Record<string, unknown>
    const props = schema['properties'] as Record<string, unknown>
    expect(props['temperature']).toBeDefined()
    expect(props['topP']).toBeDefined()
    expect(props['topK']).toBeDefined()
    expect(props['maxOutputTokens']).toBeDefined()
    expect(props['stopSequences']).toBeDefined()
    expect(props['serviceTier']).toBeDefined()
    expect(props['reasoning']).toBeDefined()
  })

  it('3.x model configJsonSchema omits temperature, topP, topK', () => {
    const desc = geminiModelDescriptors.find((d) => d.id === 'gemini-3.5-flash')!
    const schema = desc.configJsonSchema as Record<string, unknown>
    const props = schema['properties'] as Record<string, unknown>
    expect(props['temperature']).toBeUndefined()
    expect(props['topP']).toBeUndefined()
    expect(props['topK']).toBeUndefined()
    // Common props still present
    expect(props['maxOutputTokens']).toBeDefined()
    expect(props['serviceTier']).toBeDefined()
    expect(props['reasoning']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Engine validation — 3.x model rejects sampling params
// ---------------------------------------------------------------------------

describe('engine — config validation for 3.x (fixed sampling) models', () => {
  const FIXED_MODELS = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
  ]

  for (const model of FIXED_MODELS) {
    it(`${model} + temperature → bad_request, message mentions temperature`, async () => {
      const { client, sink } = makeClient(model)
      const err = await expectBadRequest(client, model, { temperature: 0.7 })
      expect(err.message).toMatch(/temperature/)

      // Error record IS written to sink
      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.status).toBe('api_error')
    })

    it(`${model} + topP → bad_request, message mentions topP`, async () => {
      const { client, sink } = makeClient(model)
      const err = await expectBadRequest(client, model, { topP: 0.9 })
      expect(err.message).toMatch(/topP/)

      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.status).toBe('api_error')
    })

    it(`${model} + topK → bad_request, message mentions topK`, async () => {
      const { client, sink } = makeClient(model)
      const err = await expectBadRequest(client, model, { topK: 40 })
      expect(err.message).toMatch(/topK/)

      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.status).toBe('api_error')
    })
  }

  it('temperature + topP together — both issues reported in single message', async () => {
    const { client } = makeClient('gemini-3.5-flash')
    const err = await expectBadRequest(client, 'gemini-3.5-flash', {
      temperature: 0.7,
      topP: 0.9,
    })
    // Both violations are collected (no short-circuit)
    expect(err.message).toMatch(/temperature/)
    expect(err.message).toMatch(/topP/)
  })

  it('timeoutMs only on 3.x model → NOT rejected (execution-spine field excluded from projection)', async () => {
    const { client, sink } = makeClient('gemini-3.5-flash')

    // timeoutMs is excluded from config projection — must not trigger validation failure.
    // The fake adapter returns in <1ms so a 30s timeout will not fire.
    const result = await client.generate({
      model: 'gemini-3.5-flash',
      messages: MESSAGES,
      config: { timeoutMs: 30_000 },
    })

    expect(result).toBeDefined()
    expect(sink.records).toHaveLength(1)
    expect(sink.last()!.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 4. Engine validation — 2.5 model accepts sampling params
// ---------------------------------------------------------------------------

describe('engine — 2.5 (tunable) models accept sampling params', () => {
  const TUNABLE_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']

  for (const model of TUNABLE_MODELS) {
    it(`${model} + temperature/topP/topK → resolves successfully`, async () => {
      const { client, sink } = makeClient(model)

      const result = await client.generate({
        model,
        messages: MESSAGES,
        config: { temperature: 0.8, topP: 0.95, topK: 64 },
      })

      expect(result).toBeDefined()
      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.status).toBe('ok')
    })
  }
})

// ---------------------------------------------------------------------------
// 5. gemini-3-flash-preview — registry resolution + pricing
// ---------------------------------------------------------------------------

describe('gemini-3-flash-preview — resolution and pricing', () => {
  it('resolves exact id from defaultGeminiRegistry', () => {
    const desc = defaultGeminiRegistry.resolve('gemini-3-flash-preview')
    expect(desc).toBeDefined()
    expect(desc!.id).toBe('gemini-3-flash-preview')
    expect(desc!.provider).toBe('google')
  })

  it('prefix-matches gemini-3-flash-preview-001', () => {
    const desc = defaultGeminiRegistry.resolve('gemini-3-flash-preview-001')
    expect(desc).toBeDefined()
    expect(desc!.id).toBe('gemini-3-flash-preview')
  })

  it('produces a non-null microUsd cost via the engine (flex tier)', async () => {
    const { client, sink } = makeClient('gemini-3-flash-preview')

    const result = await client.generate({
      model: 'gemini-3-flash-preview',
      messages: MESSAGES,
    })

    expect(result.cost).toBeDefined()
    expect(result.cost!.microUsd).not.toBeNull()
    expect(typeof result.cost!.microUsd).toBe('number')
    // 100 input + 20 output at flex (50% of standard):
    //   input:  100 * 500_000 / 1_000_000 * 0.5 = 25 µUSD
    //   output:  20 * 3_000_000 / 1_000_000 * 0.5 = 30 µUSD
    //   total: 55 µUSD
    expect(result.cost!.microUsd).toBe(55)

    // Cost on result === cost on record
    expect(sink.last()!.costMicroUsd).toBe(result.cost!.microUsd)
  })
})

// ---------------------------------------------------------------------------
// 6. Error record path — failed validation writes a record to the sink
// ---------------------------------------------------------------------------

describe('engine — failed validation writes error record to sink', () => {
  it('bad_request from validateConfig still produces a sink record with api_error status', async () => {
    const { client, sink } = makeClient('gemini-3.5-flash')

    await expect(
      client.generate({
        model: 'gemini-3.5-flash',
        messages: MESSAGES,
        config: { temperature: 1.0 },
      }),
    ).rejects.toBeInstanceOf(LlmError)

    // Sink received exactly one error record
    expect(sink.records).toHaveLength(1)
    const rec = sink.last()!
    expect(rec.status).toBe('api_error')
    expect(rec.model).toBe('gemini-3.5-flash')
    expect(rec.provider).toBe('google')
  })

  it('error record attemptId matches the thrown LlmError.attemptId', async () => {
    const { client, sink } = makeClient('gemini-3.5-flash')

    let thrownErr: LlmError | undefined
    try {
      await client.generate({
        model: 'gemini-3.5-flash',
        messages: MESSAGES,
        config: { temperature: 0.5 },
      })
    } catch (e) {
      thrownErr = e as LlmError
    }

    expect(thrownErr).toBeDefined()
    expect(thrownErr!.attemptId).toBe('attempt_1')
    expect(sink.last()!.attemptId).toBe('attempt_1')
  })
})
