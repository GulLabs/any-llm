/**
 * Engine integration tests for @gullabs/core.
 *
 * These tests drive createClient against port-level fakes (FakeAdapter,
 * fakeAuth, RecordingSink, FakeClock, FakeIds) with the real geminiPricingSource.
 * No network, no SDK, no mocking framework — pure contract assertions.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createClient,
  geminiPricingSource,
  createModelRegistry,
  gemmaModelDescriptors,
  LlmError,
  retryMiddleware,
} from './index.js'
import type {
  AdapterResult,
  AdapterCtx,
  ProviderAdapter,
  ResolvedRequest,
  Usage,
  Telemetry,
  Logger,
  CallStartEvent,
  CallSuccessEvent,
  ModelRegistry,
  ProviderOptions,
} from './index.js'
import {
  FakeAdapter,
  FakeClock,
  FakeIds,
  RecordingSink,
  SignalAwareFakeAdapter,
} from '@gullabs/testing'
import { makeTestDescriptor } from './test-model-descriptor.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const GOOD_USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  details: {},
  raw: { total: 120 },
}

function makeSuccessResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    text: 'Hello, world!',
    usage: GOOD_USAGE,
    model: 'gemini-2.5-pro',
    modelVersion: 'gemini-2.5-pro-001',
    finishReason: 'stop',
    responseId: 'resp-abc123',
    warnings: [],
    ...overrides,
  }
}

const PRICING = geminiPricingSource()
const TEST_AUTH = { apiKey: 'test-key' }

function makeClient(
  overrides?: Parameters<typeof createClient>[0] extends infer C ? Partial<C> : never,
) {
  const clock = new FakeClock(1_000)
  const ids = new FakeIds()
  const sink = new RecordingSink()
  const adapter = new FakeAdapter('google', makeSuccessResult())

  const client = createClient({
    adapters: [adapter],
    pricing: PRICING,
    sink,
    clock,
    ids,
    ...overrides,
  })

  return { client, adapter, sink, clock, ids }
}

// ---------------------------------------------------------------------------
// 1. Success path
// ---------------------------------------------------------------------------

describe('engine — success path', () => {
  it('returns usage, cost, latency and writes exactly one ok record', async () => {
    const { client, sink, clock } = makeClient()
    clock.set(1_000)

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    // Result fields
    expect(result.text).toBe('Hello, world!')
    expect(result.model).toBe('gemini-2.5-pro')
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(20)
    expect(result.cost).toBeDefined()
    expect(result.cost!.microUsd).toBeTypeOf('number')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.warnings).toEqual([])

    // Exactly one record
    expect(sink.records).toHaveLength(1)
    const rec = sink.last()!
    expect(rec.status).toBe('ok')
    expect(rec.recordSchemaVersion).toBe(1)
    expect(rec.callId).toBe('call_1')
    expect(rec.attemptId).toBe('attempt_1')
    expect(rec.provider).toBe('google')
    expect(rec.model).toBe('gemini-2.5-pro')
    expect(rec.inputTokens).toBe(100)
    expect(rec.outputTokens).toBe(20)

    // result.callId and result.attemptId must match the persisted record
    expect(result.callId).toBe('call_1')
    expect(result.attemptId).toBe('attempt_1')
    expect(result.callId).toBe(rec.callId)
    expect(result.attemptId).toBe(rec.attemptId)
  })

  it('cost on result === cost on record (single source of truth)', async () => {
    const { client, sink } = makeClient()

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    const rec = sink.last()!
    expect(result.cost!.microUsd).toBe(rec.costMicroUsd)
    expect(result.cost!.pricingVersion).toBe(rec.pricingVersion)
  })

  it('telemetry onStart and onSuccess are called', async () => {
    const starts: object[] = []
    const successes: object[] = []
    const telemetry: Telemetry = {
      onStart: (e) => {
        starts.push(e)
        return 'span'
      },
      onSuccess: (e, span) => {
        successes.push({ ...e, span })
      },
    }

    const { client } = makeClient({ telemetry })

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(starts).toHaveLength(1)
    expect(successes).toHaveLength(1)
    // Span returned by onStart is forwarded to onSuccess
    expect((successes[0]! as { span: unknown }).span).toBe('span')
  })

  it('passes finishReason and responseId through to result and record', async () => {
    const { client, sink } = makeClient()

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.finishReason).toBe('stop')
    expect(result.responseId).toBe('resp-abc123')
    expect(sink.last()!.responseId).toBe('resp-abc123')
    expect(sink.last()!.finishReason).toBe('stop')
  })

  it('forwards metadata from request to record', async () => {
    const { client, sink } = makeClient()

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        metadata: { tenantId: 'acme', runId: 'run-1' },
      },
      { auth: TEST_AUTH },
    )

    const rec = sink.last()!
    expect(rec.metadata).toEqual({ tenantId: 'acme', runId: 'run-1' })
  })

  it('omits serviceTier from record and adapter request when request config omits it', async () => {
    const { client, sink, adapter } = makeClient()

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(adapter.calls[0]!.config.serviceTier).toBeUndefined()
    expect(sink.last()!.serviceTier).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. THE double-count integration test (SPEC-mandated, codex-signed-off)
// ---------------------------------------------------------------------------

describe('engine — double-count integration', () => {
  it(
    'usage 250k/100k/5k/2k on gemini-2.5-pro: gt200k tier, no double-count, ' +
      'sum(details)===microUsd, record cost === result cost',
    async () => {
      // inputTokens=250_000 > 200_000 → gt200k tier
      // cachedInputTokens=100_000 → subset of inputTokens
      // outputTokens=5_000 (includes thinkingTokens=2_000)
      // thinkingTokens adds ZERO cost (folded into output rate)
      const tieredUsage: Usage = {
        inputTokens: 250_000,
        cachedInputTokens: 100_000,
        outputTokens: 5_000,
        thinkingTokens: 2_000,
        details: {},
        raw: null,
      }

      const adapter = new FakeAdapter('google', makeSuccessResult({ usage: tieredUsage }))
      const sink = new RecordingSink()

      const client = createClient({
        adapters: [adapter],

        pricing: PRICING,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Test' }] }],
          config: { serviceTier: 'standard' },
        },
        { auth: TEST_AUTH },
      )

      // GROSS invariants preserved
      expect(result.usage.inputTokens).toBe(250_000)
      expect(result.usage.cachedInputTokens).toBe(100_000)
      expect(result.usage.outputTokens).toBe(5_000)
      expect(result.usage.thinkingTokens).toBe(2_000)

      // gt200k tier chosen: input > 200k. STANDARD service tier.
      // billableInput = 250_000 - 100_000 = 150_000 @ 2_500_000 µUSD/M = 375_000
      // cachedCost = 100_000 @ 250_000 µUSD/M = 25_000
      // outputCost = 5_000 @ 15_000_000 µUSD/M = 75_000
      const cost = result.cost!
      expect(cost.details.input).toBe(375_000)
      expect(cost.details.cached).toBe(25_000)
      expect(cost.details.output).toBe(75_000)
      expect(cost.microUsd).toBe(475_000)

      // sum(details) === microUsd (guaranteed by construction)
      expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
        cost.microUsd,
      )

      // Thinking tokens persist but add ZERO extra cost
      // (thinkingTokens is inside outputTokens, already billed at output rate)
      expect(cost.details).not.toHaveProperty('thinking')

      // Persisted record cost === returned result cost exactly
      const rec = sink.last()!
      expect(rec.costMicroUsd).toBe(cost.microUsd)
      expect(rec.thinkingTokens).toBe(2_000)
      expect(rec.cachedInputTokens).toBe(100_000)

      // FLEX service tier = 50% of standard.
      const flex = await client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Test' }] }],
          config: { serviceTier: 'flex' },
        },
        { auth: TEST_AUTH },
      )
      expect(flex.cost!.microUsd).toBe(237_500) // exactly half of 475_000
      expect(flex.cost!.details).toEqual({
        input: 187_500,
        cached: 12_500,
        output: 37_500,
      })
    },
  )
})

// ---------------------------------------------------------------------------
// 3. Failure path
// ---------------------------------------------------------------------------

describe('engine — failure path', () => {
  it('adapter throws {status:429} → rethrows LlmError rate_limited, record written', async () => {
    const adapter = new FakeAdapter('google', { status: 429 })
    const sink = new RecordingSink()
    const errors: object[] = []
    const telemetry: Telemetry = {
      onError: (e) => {
        errors.push(e)
      },
    }

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      telemetry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toThrow(LlmError)

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryable: true })

    // Record was written with error kind
    expect(sink.records.length).toBeGreaterThanOrEqual(1)
    const rec = sink.records[0]!
    expect(rec.status).toBe('api_error')
    expect(rec.errorKind).toBe('rate_limited')

    // telemetry.onError was called
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  it('adapter throws LlmError invalid_auth → record status api_error', async () => {
    const err = new LlmError('Unauthorized', { kind: 'invalid_auth', retryable: false })
    const adapter = new FakeAdapter('google', err)
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'invalid_auth' })

    const rec = sink.last()!
    expect(rec.status).toBe('api_error')
    expect(rec.errorKind).toBe('invalid_auth')
    expect(rec.errorMessage).toContain('Unauthorized')
  })
})

// ---------------------------------------------------------------------------
// 4. Structured output parsing
// ---------------------------------------------------------------------------

describe('engine — structured output', () => {
  it('shape mismatch still succeeds; caller owns validation', async () => {
    const jsonSchema = { type: 'object', properties: { answer: { type: 'number' } } }
    const adapter = new FakeAdapter(
      'google',
      makeSuccessResult({ rawStructured: { answer: 'not-a-number' } }),
    )
    const sink = new RecordingSink()
    const errors: object[] = []
    const telemetry: Telemetry = {
      onError: (e) => {
        errors.push(e)
      },
    }

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      telemetry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        output: { jsonSchema },
      },
      { auth: TEST_AUTH },
    )

    const rec = sink.last()!
    expect(result.output).toEqual({ answer: 'not-a-number' })
    expect(result.outputParsed).toBe(true)
    expect(rec.status).toBe('ok')
    expect(errors).toHaveLength(0)
  })

  it('rawStructured present → outputParsed true on result', async () => {
    const jsonSchema = { type: 'object', properties: { answer: { type: 'number' } } }
    const adapter = new FakeAdapter(
      'google',
      makeSuccessResult({ rawStructured: { answer: 42 } }),
    )
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        output: { jsonSchema },
      },
      { auth: TEST_AUTH },
    )

    expect(result.output).toEqual({ answer: 42 })
    expect(result.outputParsed).toBe(true)
    expect(sink.last()!.status).toBe('ok')
    expect(sink.last()!.outputParsed).toBe(true)
  })

  it('persists outputParsed false for malformed structured output', async () => {
    const adapter = new FakeAdapter('google', makeSuccessResult())
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        output: { jsonSchema: { type: 'object' } },
      },
      { auth: TEST_AUTH },
    )

    expect(result.output).toBeUndefined()
    expect(result.outputParsed).toBe(false)
    expect(sink.last()!.status).toBe('ok')
    expect(sink.last()!.outputParsed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Fail-open sink
// ---------------------------------------------------------------------------

describe('engine — fail-open sink', () => {
  it('sink that throws on record does NOT fail the generate call', async () => {
    const sink = new RecordingSink({ failOnRecord: true })

    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // Should NOT throw despite the sink failing
    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.text).toBe('Hello, world!')
    // No records were stored (sink threw before storing)
    expect(sink.records).toHaveLength(0)
  })

  it('sink throws on error-path record → still rethrows the LlmError', async () => {
    const sink = new RecordingSink({ failOnRecord: true })
    const adapter = new FakeAdapter('google', { status: 500 })

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // The engine must rethrow the LlmError even when the sink also fails.
    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'server' })
  })
})

// ---------------------------------------------------------------------------
// 6. Timeout
// ---------------------------------------------------------------------------

describe('engine — timeout', () => {
  it('timeoutMs=1 with slow adapter → LlmError timeout + record', async () => {
    const slow = new FakeAdapter('google', makeSuccessResult(), { delayMs: 200 })
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [slow],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          config: { timeoutMs: 1 },
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    const rec = sink.last()!
    expect(rec.status).toBe('timeout')
    expect(rec.errorKind).toBe('timeout')
  }, 2_000)
})

// ---------------------------------------------------------------------------
// 7. Config resolution
// ---------------------------------------------------------------------------

describe('engine — config resolution', () => {
  it('libDefaults < callSite.config < opts.config (per-call wins)', async () => {
    const calls: Array<{ temperature: number | undefined }> = []

    const capturingAdapter = new FakeAdapter('google', makeSuccessResult())
    // Spy on calls
    const origRun = capturingAdapter.run.bind(capturingAdapter)
    vi.spyOn(capturingAdapter, 'run').mockImplementation(async (req, ctx) => {
      calls.push({ temperature: req.config.temperature })
      return origRun(req, ctx)
    })

    const sink = new RecordingSink()
    const client = createClient({
      adapters: [capturingAdapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { temperature: 0.1 },
    })

    // Per-request config overrides defaults
    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        config: { temperature: 0.9 },
      },
      { auth: TEST_AUTH },
    )

    expect(calls[0]?.temperature).toBe(0.9)
  })

  it('merged config is validated before dispatch and rejects flexFallback without explicit flex tier', async () => {
    const adapter = new FakeAdapter('google', makeSuccessResult())
    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { flexFallback: false },
    })

    await expect(
      client.runStructured(
        {
          id: 'callsite-1',
          model: 'gemini-2.5-pro',
          userTemplate: 'Hi',
          config: { serviceTier: 'flex' },
        },
        {},
        {
          auth: TEST_AUTH,
          config: { serviceTier: 'standard' },
        },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })

    expect(adapter.calls).toHaveLength(0)
  })

  it('per-call serviceTier override wins', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { serviceTier: 'flex' },
    })

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        config: { serviceTier: 'standard' },
      },
      { auth: TEST_AUTH },
    )

    expect(sink.last()!.serviceTier).toBe('standard')
  })

  it('Gemma requests stay tierless when no serviceTier is provided', async () => {
    const gemma = gemmaModelDescriptors.find((d) => d.id === 'gemma-4-31b-it')!
    const adapter = new FakeAdapter(
      'google',
      makeSuccessResult({ model: 'gemma-4-31b-it' }),
    )
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client.generate(
      {
        model: 'gemma-4-31b-it',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(adapter.calls[0]!.modelDescriptor).toEqual(gemma)
    expect(adapter.calls[0]!.config.serviceTier).toBeUndefined()
    expect(sink.last()!.serviceTier).toBeUndefined()
  })

  it('interpolation is non-recursive: var value containing {{x}} is not expanded', async () => {
    const { client, adapter } = makeClient()

    // runStructured exercises the interpolation path
    const callSite = {
      id: 'test',
      model: 'gemini-2.5-pro',
      userTemplate: 'Value: {{val}}',
    }

    // The var value itself contains a template placeholder — must NOT expand it
    await client.runStructured(callSite, { val: '{{secret}}' }, { auth: TEST_AUTH })

    // The message delivered to the adapter should contain the literal string
    const req = adapter.calls[0]!
    const text = (req.messages[0]?.parts[0] as { kind: string; text: string } | undefined)
      ?.text
    expect(text).toBe('Value: {{secret}}')
  })

  it('deep-merges reasoning config (per-call wins on sub-keys)', async () => {
    const calls: Array<Parameters<typeof capturingAdapter.run>[0]> = []
    const capturingAdapter = new FakeAdapter('google', makeSuccessResult())
    const origRun = capturingAdapter.run.bind(capturingAdapter)
    vi.spyOn(capturingAdapter, 'run').mockImplementation(async (req, ctx) => {
      calls.push(req)
      return origRun(req, ctx)
    })

    const client = createClient({
      adapters: [capturingAdapter],

      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { reasoning: { effort: 'low', includeThoughts: false } },
    })

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        config: { reasoning: { includeThoughts: true } },
      },
      { auth: TEST_AUTH },
    )

    const resolved = calls[0]?.config.reasoning
    // per-call includeThoughts=true wins; effort='low' is inherited from defaults
    expect(resolved?.includeThoughts).toBe(true)
    expect(resolved?.effort).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// 8. Routing
// ---------------------------------------------------------------------------

describe('engine — routing', () => {
  it('single adapter: used unconditionally regardless of model', async () => {
    const adapter = new FakeAdapter('anthropic', makeSuccessResult())
    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // 'gemini-2.5-pro' with an 'anthropic' adapter — still works (single adapter)
    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(adapter.calls).toHaveLength(1)
  })

  it('multiple adapters: picks by provider prefix; no match → bad_request', async () => {
    const google = new FakeAdapter('google', makeSuccessResult())
    const anthropic = new FakeAdapter('anthropic', makeSuccessResult())

    const client = createClient({
      adapters: [google, anthropic],

      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // gemini-* → google
    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )
    expect(google.calls).toHaveLength(1)

    // unknown model → bad_request
    await expect(
      client.generate(
        {
          model: 'unknown-model-xyz',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('custom route function is used when provided', async () => {
    const a = new FakeAdapter('a', makeSuccessResult())
    const b = new FakeAdapter('b', makeSuccessResult())

    const client = createClient({
      adapters: [a, b],

      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
      route: (_model, adapters) => adapters[1]!, // always pick second
    })

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 9. Logger events
// ---------------------------------------------------------------------------

describe('engine — logger', () => {
  it('emits llm.call.start, llm.call.success on success', async () => {
    const events: string[] = []
    const logger: Logger = {
      info: (_o, m) => {
        events.push(m)
      },
      warn: (_o, m) => {
        events.push(m)
      },
      error: (_o, m) => {
        events.push(m)
      },
      debug: (_o, m) => {
        events.push(m)
      },
    }

    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],

      pricing: PRICING,
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(events).toContain('llm.call.start')
    expect(events).toContain('llm.call.success')
    expect(events).not.toContain('llm.call.error')
  })

  it('emits llm.call.start, llm.call.error on failure', async () => {
    const events: string[] = []
    const logger: Logger = {
      info: (_o, m) => {
        events.push(m)
      },
      warn: (_o, m) => {
        events.push(m)
      },
      error: (_o, m) => {
        events.push(m)
      },
      debug: (_o, m) => {
        events.push(m)
      },
    }

    const client = createClient({
      adapters: [new FakeAdapter('google', { status: 500 })],

      pricing: PRICING,
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toThrow()

    expect(events).toContain('llm.call.start')
    expect(events).toContain('llm.call.error')
    expect(events).not.toContain('llm.call.success')
  })
})

// ---------------------------------------------------------------------------
// 10. Reasoning text capture
// ---------------------------------------------------------------------------

describe('engine — reasoning text', () => {
  it('reasoningText from adapter appears on result and record', async () => {
    const adapter = new FakeAdapter(
      'google',
      makeSuccessResult({ reasoningText: 'I thought about it...' }),
    )
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.reasoningText).toBe('I thought about it...')
    expect(sink.last()!.reasoningText).toBe('I thought about it...')
  })
})

// ---------------------------------------------------------------------------
// 11. Caller-abort (Finding 1): abort always terminates call, adapter observed
// ---------------------------------------------------------------------------

describe('engine — caller abort (Finding 1)', () => {
  it('callerSignal.abort() mid-flight => LlmError aborted, record status aborted, adapter observed', async () => {
    const adapter = new SignalAwareFakeAdapter('google', makeSuccessResult(), {
      delayMs: 300,
    })
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const ctrl = new AbortController()
    // Abort after 20ms — well before the adapter's 300ms delay.
    setTimeout(() => ctrl.abort(), 20)

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH, signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ kind: 'aborted', retryable: false })

    // Record must reflect the abort.
    const rec = sink.last()
    expect(rec).toBeDefined()
    expect(rec!.status).toBe('aborted')
    expect(rec!.errorKind).toBe('aborted')

    // Adapter observed the abort signal.
    expect(adapter.abortObserved).toBe(true)
  }, 2_000)

  it('already-aborted signal => LlmError aborted synchronously', async () => {
    const adapter = new SignalAwareFakeAdapter('google', makeSuccessResult(), {
      delayMs: 300,
    })
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const ctrl = new AbortController()
    ctrl.abort() // abort BEFORE the call

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH, signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ kind: 'aborted' })

    const rec = sink.last()
    expect(rec).toBeDefined()
    expect(rec!.status).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// 12. Timeout determinism (Finding 2): timeout wins even with synchronously-aborting adapter
// ---------------------------------------------------------------------------

describe('engine — timeout determinism (Finding 2)', () => {
  it('timeout + synchronously-aborting adapter => classified timeout (not aborted)', async () => {
    // This adapter rejects with AbortError synchronously when the signal fires.
    // Without the "reject-first" fix, this would race and could produce 'aborted'.
    const adapter = new SignalAwareFakeAdapter('google', makeSuccessResult(), {
      delayMs: 5_000,
      abortsSynchronouslyOnSignal: true,
    })
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          config: { timeoutMs: 10 },
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    const rec = sink.last()
    expect(rec).toBeDefined()
    expect(rec!.status).toBe('timeout')
    expect(rec!.errorKind).toBe('timeout')
  }, 2_000)

  it('timeout with non-cooperative adapter => timeout', async () => {
    // FakeAdapter ignores ctx.signal — should still time out.
    const slow = new FakeAdapter('google', makeSuccessResult(), { delayMs: 500 })
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [slow],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          config: { timeoutMs: 10 },
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    const rec = sink.last()
    expect(rec).toBeDefined()
    expect(rec!.status).toBe('timeout')
  }, 2_000)
})

// ---------------------------------------------------------------------------
// 13. providerOptions strict merge
// ---------------------------------------------------------------------------

describe('engine — providerOptions strict merge', () => {
  it('deep-merges only allowlisted providerOptions.google keys before adapter dispatch', async () => {
    const capturedConfigs: Array<Parameters<typeof capturingAdapter.run>[0]> = []
    const capturingAdapter = new FakeAdapter('google', makeSuccessResult())
    const origRun = capturingAdapter.run.bind(capturingAdapter)
    vi.spyOn(capturingAdapter, 'run').mockImplementation(async (req, ctx) => {
      capturedConfigs.push(req)
      return origRun(req, ctx)
    })

    const client = createClient({
      adapters: [capturingAdapter],

      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: {
        providerOptions: {
          google: {
            httpOptions: { timeout: 1_000 },
            safetySettings: [{ category: 'harm', threshold: 'block_only_high' }],
          },
        },
      },
    })

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        config: {
          providerOptions: {
            google: {
              httpOptions: { timeout: 2_000 },
              cachedContent: 'cached/abc123',
            },
          },
        },
      },
      { auth: TEST_AUTH },
    )

    const merged = capturedConfigs[0]?.config.providerOptions
    expect(merged).toBeDefined()

    const google = merged!['google'] as Record<string, unknown>
    expect(google['httpOptions']).toEqual({ timeout: 2_000 })
    expect(google['cachedContent']).toBe('cached/abc123')
    expect(google['safetySettings']).toEqual([
      { category: 'harm', threshold: 'block_only_high' },
    ])
  })

  it('rejects unknown providerOptions.google keys before adapter dispatch', async () => {
    const { client, adapter } = makeClient()

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          config: {
            providerOptions: { google: { tags: ['x'] } } as unknown as ProviderOptions,
          },
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })

    expect(adapter.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 12. pricingFamily routing
// ---------------------------------------------------------------------------

describe('engine — pricingFamily routing', () => {
  it('pricingFamily on descriptor routes pricing to the family key', async () => {
    // Use a model string that has no pricing entry of its own, but whose
    // descriptor has pricingFamily pointing to 'gemini-2.5-pro' which IS priced.
    const customRegistry = createModelRegistry([
      makeTestDescriptor({
        id: 'my-custom-model',
        provider: 'google',
        pricingFamily: 'gemini-2.5-pro',
        capabilities: { reasoning: false },
      }),
    ])
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      modelRegistry: customRegistry,
    })

    await client.generate(
      {
        model: 'my-custom-model',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    const rec = sink.records[0]!
    // The record's model is the actual model string, not the pricingFamily.
    expect(rec.model).toBe('my-custom-model')
    // Cost should be computed (not null) because pricingFamily → 'gemini-2.5-pro' IS priced.
    expect(rec.costMicroUsd).not.toBeNull()
    expect(rec.pricingVersion).toBeDefined()
  })

  it('strictPricing rejects the default registry because Gemma 4 is intentionally unpriced', () => {
    expect(() =>
      createClient({
        adapters: [new FakeAdapter('google', makeSuccessResult())],
        pricing: PRICING,
        strictPricing: true,
      }),
    ).toThrow(LlmError)
  })

  it('strictPricing constructs when every registered descriptor resolves to pricing', () => {
    const customRegistry = createModelRegistry([
      makeTestDescriptor({
        id: 'my-priced-model',
        provider: 'google',
        pricingFamily: 'gemini-2.5-pro',
      }),
    ])

    expect(() =>
      createClient({
        adapters: [new FakeAdapter('google', makeSuccessResult())],
        pricing: PRICING,
        modelRegistry: customRegistry,
        strictPricing: true,
      }),
    ).not.toThrow()
  })

  it('strictPricing requires custom registries to implement listDescriptors', () => {
    const registryWithoutEnumeration: ModelRegistry = {
      resolve(model) {
        if (model === 'my-priced-model') {
          return makeTestDescriptor({
            id: 'my-priced-model',
            provider: 'google',
            pricingFamily: 'gemini-2.5-pro',
          })
        }
        return undefined
      },
    }

    expect(() =>
      createClient({
        adapters: [new FakeAdapter('google', makeSuccessResult())],
        pricing: PRICING,
        modelRegistry: registryWithoutEnumeration,
        strictPricing: true,
      }),
    ).toThrow(/listDescriptors/)
  })

  it('default pricing remains fail-open for unpriced models and emits a warning', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [
        new FakeAdapter('google', makeSuccessResult({ model: 'gemma-4-31b-it' })),
      ],
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        model: 'gemma-4-31b-it',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.cost?.microUsd).toBeNull()
    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: 'other',
        message: expect.stringContaining('unpriced'),
      }),
    ])
    expect(sink.last()!.costMicroUsd).toBeNull()
    expect(sink.last()!.warnings).toEqual([
      expect.objectContaining({
        type: 'other',
        message: expect.stringContaining('unpriced'),
      }),
    ])
  })
})

// ---------------------------------------------------------------------------
// Standard Schema — engine validation path
// ---------------------------------------------------------------------------

describe('engine — structured output parse-only path', () => {
  it('passes structured output through without Standard Schema validation', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'number' } } }
    const { client } = makeClient({
      adapters: [
        new FakeAdapter('google', makeSuccessResult({ rawStructured: { score: 42 } })),
      ],
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Score?' }] }],
        output: { jsonSchema },
      },
      { auth: TEST_AUTH },
    )

    expect(result.output).toEqual({ score: 42 })
    expect(result.outputParsed).toBe(true)
  })

  it('does not throw when output shape mismatches the hint', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'number' } } }
    const { client } = makeClient({
      adapters: [
        new FakeAdapter(
          'google',
          makeSuccessResult({ rawStructured: { wrong: 'data' } }),
        ),
      ],
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Score?' }] }],
        output: { jsonSchema },
      },
      { auth: TEST_AUTH },
    )

    expect(result.output).toEqual({ wrong: 'data' })
    expect(result.outputParsed).toBe(true)
  })

  it('reports outputParsed true for parsed structured output', async () => {
    const jsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } } }

    const { client } = makeClient({
      adapters: [
        new FakeAdapter('google', makeSuccessResult({ rawStructured: { ok: true } })),
      ],
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'ok?' }] }],
        output: { jsonSchema },
      },
      { auth: TEST_AUTH },
    )

    expect(result.output).toEqual({ ok: true })
    expect(result.outputParsed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reconcile loop: callId / attemptId / telemetry event types
// ---------------------------------------------------------------------------

describe('engine — reconcile loop (callId/attemptId/telemetry)', () => {
  it('result.callId and result.attemptId match the persisted record', async () => {
    const { client, sink } = makeClient()
    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )
    const rec = sink.last()!
    expect(result.callId).toBe(rec.callId)
    expect(result.attemptId).toBe(rec.attemptId)
    expect(result.callId).toBeTypeOf('string')
    expect(result.attemptId).toBeTypeOf('string')
  })

  it('with retry: callId is stable, result.attemptId is the succeeding attempt id', async () => {
    let callCount = 0
    const flakyAdapter: ProviderAdapter = {
      id: 'google',
      async run(_req: ResolvedRequest, _ctx: AdapterCtx): Promise<AdapterResult> {
        callCount++
        if (callCount === 1) {
          throw new LlmError('transient', { kind: 'server', retryable: true })
        }
        return makeSuccessResult()
      },
    }

    const sink = new RecordingSink()
    const ids = new FakeIds()
    const client = createClient({
      adapters: [flakyAdapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids,
      middleware: [retryMiddleware({ maxAttempts: 2, baseDelayMs: 0 })],
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    // Two records written: one for the failed attempt, one for the success
    expect(sink.records).toHaveLength(2)
    const failedRecord = sink.records[0]!
    const successRecord = sink.records[1]!
    expect(successRecord.status).toBe('ok')

    // callId is stable across both attempts
    expect(result.callId).toBe(failedRecord.callId)
    expect(result.callId).toBe(successRecord.callId)

    // result.attemptId is the SUCCEEDING attempt (second record)
    expect(result.attemptId).toBe(successRecord.attemptId)
    // And it differs from the first (failed) attempt
    expect(result.attemptId).not.toBe(failedRecord.attemptId)
  })

  it('idempotencyKey is deterministic but still preserves per-attempt retry records', async () => {
    const adapter = new FakeAdapter('google', [
      new LlmError('transient', { kind: 'server', retryable: true }),
      makeSuccessResult(),
    ])
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 2, baseDelayMs: 0 },
          { sleep: async () => {}, random: () => 0, now: () => 0 },
        ),
      ],
    })

    const result = await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        idempotencyKey: 'ctx-123',
      },
      { auth: TEST_AUTH },
    )

    expect(sink.records).toHaveLength(2)
    expect(sink.records[0]!.attemptId).toBe('ctx-123')
    expect(sink.records[0]!.status).toBe('api_error')
    expect(sink.records[1]!.attemptId).toBe('ctx-123:2')
    expect(sink.records[1]!.status).toBe('ok')
    expect(result.attemptId).toBe('ctx-123:2')
  })

  it('externalId round-trips to success records', async () => {
    const { client, sink } = makeClient()

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        externalId: 'ai-studio-context-1',
      },
      { auth: TEST_AUTH },
    )

    expect(sink.last()!.externalId).toBe('ai-studio-context-1')
  })

  it('error path: thrown LlmError carries callId and attemptId matching the error record', async () => {
    const adapterErr = new LlmError('fail', { kind: 'server', retryable: false })
    const adapter = new FakeAdapter('google', adapterErr)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],

      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    let caughtErr: LlmError | undefined
    try {
      await client.generate(
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      )
    } catch (e) {
      caughtErr = e as LlmError
    }

    expect(caughtErr).toBeInstanceOf(LlmError)
    expect(caughtErr!.callId).toBe('call_1')
    expect(caughtErr!.callId).toBe(sink.last()!.callId)
    expect(caughtErr!.attemptId).toBeTypeOf('string')
    expect(caughtErr!.attemptId).toBe(sink.last()!.attemptId)
  })

  it('telemetry events carry metadata, callId, and model', async () => {
    const startEvents: CallStartEvent[] = []
    const successEvents: CallSuccessEvent[] = []
    const telemetry: Telemetry = {
      onStart: (e) => {
        startEvents.push(e)
      },
      onSuccess: (e) => {
        successEvents.push(e)
      },
    }

    const { client } = makeClient({ telemetry })

    await client.generate(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        metadata: { tenantId: 'acme', traceId: 'trace-99' },
      },
      { auth: TEST_AUTH },
    )

    expect(startEvents).toHaveLength(1)
    expect(startEvents[0]!.callId).toBeTypeOf('string')
    expect(startEvents[0]!.model).toBe('gemini-2.5-pro')
    expect(startEvents[0]!.metadata).toEqual({ tenantId: 'acme', traceId: 'trace-99' })

    expect(successEvents).toHaveLength(1)
    expect(successEvents[0]!.callId).toBe(startEvents[0]!.callId)
    expect(successEvents[0]!.model).toBe('gemini-2.5-pro')
    expect(successEvents[0]!.metadata).toEqual({ tenantId: 'acme', traceId: 'trace-99' })
    expect(successEvents[0]!.usage).toBeDefined()
    expect(successEvents[0]!.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Fail-closed: missing opts or empty apiKey must throw LlmError(invalid_auth)
// ---------------------------------------------------------------------------

describe('engine — fail-closed auth guard', () => {
  const req = {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hi' }] }],
  }
  const callSite = { id: 'test', model: 'gemini-2.5-pro', userTemplate: 'Hi' }

  it('generate() with no opts arg throws LlmError invalid_auth (not TypeError)', async () => {
    const { client } = makeClient()
    // Simulate a JS/any-typed caller omitting the options object entirely.
    await expect((client.generate as any)(req)).rejects.toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
    // Must be LlmError, not a raw TypeError.
    await expect((client.generate as any)(req)).rejects.toBeInstanceOf(LlmError)
  })

  it('generate() with { auth: { apiKey: "" } } throws LlmError invalid_auth', async () => {
    const { client } = makeClient()
    await expect(client.generate(req, { auth: { apiKey: '' } })).rejects.toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
  })

  it('runStructured() with no opts arg (one arg form) throws LlmError invalid_auth', async () => {
    const { client } = makeClient()
    await expect((client.runStructured as any)(callSite)).rejects.toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
    await expect((client.runStructured as any)(callSite)).rejects.toBeInstanceOf(LlmError)
  })

  it('runStructured() with (callSite, vars) and no opts throws LlmError invalid_auth', async () => {
    const { client } = makeClient()
    await expect(
      (client.runStructured as any)(callSite, { x: 'y' }),
    ).rejects.toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
  })
})
