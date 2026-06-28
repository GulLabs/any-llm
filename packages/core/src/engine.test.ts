/**
 * Engine integration tests for @anyllm/core.
 *
 * These tests drive createClient against port-level fakes (FakeAdapter,
 * fakeAuth, RecordingSink, FakeClock, FakeIds) with the real geminiPricingSource.
 * No network, no SDK, no mocking framework — pure contract assertions.
 *
 * @module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import {
  createClient,
  geminiPricingSource,
  LlmError,
} from './index.js'
import type {
  AdapterResult,
  Usage,
  Telemetry,
  Logger,
} from './index.js'
import {
  FakeAdapter,
  FakeClock,
  FakeIds,
  RecordingSink,
  SignalAwareFakeAdapter,
  fakeAuth,
} from '@anyllm/testing'

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
const AUTH = fakeAuth({ apiKey: 'test-key' })

function makeClient(
  overrides?: Parameters<typeof createClient>[0] extends infer C
    ? Partial<C>
    : never,
) {
  const clock = new FakeClock(1_000)
  const ids = new FakeIds()
  const sink = new RecordingSink()
  const adapter = new FakeAdapter('google', makeSuccessResult())

  const client = createClient({
    adapters: [adapter],
    auth: AUTH,
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

    const result = await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

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
  })

  it('cost on result === cost on record (single source of truth)', async () => {
    const { client, sink } = makeClient()

    const result = await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    const rec = sink.last()!
    expect(result.cost!.microUsd).toBe(rec.costMicroUsd)
    expect(result.cost!.pricingVersion).toBe(rec.pricingVersion)
  })

  it('telemetry onStart and onSuccess are called', async () => {
    const starts: object[] = []
    const successes: object[] = []
    const telemetry: Telemetry = {
      onStart: (e) => { starts.push(e); return 'span' },
      onSuccess: (e, span) => { successes.push({ ...e, span }) },
    }

    const { client } = makeClient({ telemetry })

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(starts).toHaveLength(1)
    expect(successes).toHaveLength(1)
    // Span returned by onStart is forwarded to onSuccess
    expect((successes[0]! as { span: unknown }).span).toBe('span')
  })

  it('passes finishReason and responseId through to result and record', async () => {
    const { client, sink } = makeClient()

    const result = await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(result.finishReason).toBe('stop')
    expect(result.responseId).toBe('resp-abc123')
    expect(sink.last()!.responseId).toBe('resp-abc123')
    expect(sink.last()!.finishReason).toBe('stop')
  })

  it('forwards metadata from request to record', async () => {
    const { client, sink } = makeClient()

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      metadata: { tenantId: 'acme', runId: 'run-1' },
    })

    const rec = sink.last()!
    expect(rec.metadata).toEqual({ tenantId: 'acme', runId: 'run-1' })
  })

  it('serviceTier defaults to flex in record', async () => {
    const { client, sink } = makeClient()

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(sink.last()!.serviceTier).toBe('flex')
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

      const adapter = new FakeAdapter(
        'google',
        makeSuccessResult({ usage: tieredUsage }),
      )
      const sink = new RecordingSink()

      const client = createClient({
        adapters: [adapter],
        auth: AUTH,
        pricing: PRICING,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Test' }] }],
      })

      // GROSS invariants preserved
      expect(result.usage.inputTokens).toBe(250_000)
      expect(result.usage.cachedInputTokens).toBe(100_000)
      expect(result.usage.outputTokens).toBe(5_000)
      expect(result.usage.thinkingTokens).toBe(2_000)

      // gt200k tier chosen: input > 200k
      // billableInput = 250_000 - 100_000 = 150_000 billed at 2_500_000 µUSD/M
      // cachedCost = 100_000 * 630_000 / 1_000_000 = 63_000
      // outputCost = 5_000 * 15_000_000 / 1_000_000 = 75_000
      // inputCost = 150_000 * 2_500_000 / 1_000_000 = 375_000
      const cost = result.cost!
      expect(cost.details.input).toBe(375_000)
      expect(cost.details.cached).toBe(63_000)
      expect(cost.details.output).toBe(75_000)
      expect(cost.microUsd).toBe(513_000)

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
    const telemetry: Telemetry = { onError: (e) => { errors.push(e) } }

    const client = createClient({
      adapters: [adapter],
      auth: AUTH,
      pricing: PRICING,
      sink,
      telemetry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      }),
    ).rejects.toThrow(LlmError)

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      }),
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
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_auth' })

    const rec = sink.last()!
    expect(rec.status).toBe('api_error')
    expect(rec.errorKind).toBe('invalid_auth')
    expect(rec.errorMessage).toContain('Unauthorized')
  })
})

// ---------------------------------------------------------------------------
// 4. parse_error
// ---------------------------------------------------------------------------

describe('engine — parse_error', () => {
  it('rawStructured fails schema → LlmError parse_error, record status parse_error', async () => {
    const schema = z.object({ answer: z.number() })
    const adapter = new FakeAdapter(
      'google',
      makeSuccessResult({ rawStructured: { answer: 'not-a-number' } }),
    )
    const sink = new RecordingSink()
    const errors: object[] = []
    const telemetry: Telemetry = { onError: (e) => { errors.push(e) } }

    const client = createClient({
      adapters: [adapter],
      auth: AUTH,
      pricing: PRICING,
      sink,
      telemetry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        output: { schema },
      }),
    ).rejects.toMatchObject({ kind: 'parse_error', retryable: false })

    const rec = sink.last()!
    expect(rec.status).toBe('parse_error')
    expect(rec.errorKind).toBe('parse_error')
    expect(errors).toHaveLength(1)
  })

  it('rawStructured passes schema → typed output on result', async () => {
    const schema = z.object({ answer: z.number() })
    const adapter = new FakeAdapter(
      'google',
      makeSuccessResult({ rawStructured: { answer: 42 } }),
    )
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      output: { schema },
    })

    expect(result.output).toEqual({ answer: 42 })
    expect(sink.last()!.status).toBe('ok')
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
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // Should NOT throw despite the sink failing
    const result = await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(result.text).toBe('Hello, world!')
    // No records were stored (sink threw before storing)
    expect(sink.records).toHaveLength(0)
  })

  it('sink throws on error-path record → still rethrows the LlmError', async () => {
    const sink = new RecordingSink({ failOnRecord: true })
    const adapter = new FakeAdapter('google', { status: 500 })

    const client = createClient({
      adapters: [adapter],
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // The engine must rethrow the LlmError even when the sink also fails.
    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      }),
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
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        config: { timeoutMs: 1 },
      }),
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
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { temperature: 0.1 },
    })

    // Per-request config overrides defaults
    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      config: { temperature: 0.9 },
    })

    expect(calls[0]?.temperature).toBe(0.9)
  })

  it('serviceTier defaults to flex even with no config supplied', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(sink.last()!.serviceTier).toBe('flex')
  })

  it('per-call serviceTier override wins', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { serviceTier: 'flex' },
    })

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      config: { serviceTier: 'standard' },
    })

    expect(sink.last()!.serviceTier).toBe('standard')
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
    await client.runStructured(callSite, { val: '{{secret}}' })

    // The message delivered to the adapter should contain the literal string
    const req = adapter.calls[0]!
    const text = (req.messages[0]?.parts[0] as { kind: string; text: string } | undefined)?.text
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
      auth: AUTH,
      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { reasoning: { effort: 'low', includeThoughts: false } },
    })

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      config: { reasoning: { includeThoughts: true } },
    })

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
      auth: AUTH,
      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // 'gemini-2.5-pro' with an 'anthropic' adapter — still works (single adapter)
    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(adapter.calls).toHaveLength(1)
  })

  it('multiple adapters: picks by provider prefix; no match → bad_request', async () => {
    const google = new FakeAdapter('google', makeSuccessResult())
    const anthropic = new FakeAdapter('anthropic', makeSuccessResult())

    const client = createClient({
      adapters: [google, anthropic],
      auth: AUTH,
      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    // gemini-* → google
    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })
    expect(google.calls).toHaveLength(1)

    // unknown model → bad_request
    await expect(
      client.generate({
        model: 'unknown-model-xyz',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('custom route function is used when provided', async () => {
    const a = new FakeAdapter('a', makeSuccessResult())
    const b = new FakeAdapter('b', makeSuccessResult())

    const client = createClient({
      adapters: [a, b],
      auth: AUTH,
      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
      route: (_model, adapters) => adapters[1]!, // always pick second
    })

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

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
      info: (_o, m) => { events.push(m) },
      warn: (_o, m) => { events.push(m) },
      error: (_o, m) => { events.push(m) },
    }

    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],
      auth: AUTH,
      pricing: PRICING,
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(events).toContain('llm.call.start')
    expect(events).toContain('llm.call.success')
    expect(events).not.toContain('llm.call.error')
  })

  it('emits llm.call.start, llm.call.error on failure', async () => {
    const events: string[] = []
    const logger: Logger = {
      info: (_o, m) => { events.push(m) },
      warn: (_o, m) => { events.push(m) },
      error: (_o, m) => { events.push(m) },
    }

    const client = createClient({
      adapters: [new FakeAdapter('google', { status: 500 })],
      auth: AUTH,
      pricing: PRICING,
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      }),
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
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    })

    expect(result.reasoningText).toBe('I thought about it...')
    expect(sink.last()!.reasoningText).toBe('I thought about it...')
  })
})

// ---------------------------------------------------------------------------
// 11. Caller-abort (Finding 1): abort always terminates call, adapter observed
// ---------------------------------------------------------------------------

describe('engine — caller abort (Finding 1)', () => {
  it(
    'callerSignal.abort() mid-flight => LlmError aborted, record status aborted, adapter observed',
    async () => {
      const adapter = new SignalAwareFakeAdapter(
        'google',
        makeSuccessResult(),
        { delayMs: 300 },
      )
      const sink = new RecordingSink()

      const client = createClient({
        adapters: [adapter],
        auth: AUTH,
        pricing: PRICING,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const ctrl = new AbortController()
      // Abort after 20ms — well before the adapter's 300ms delay.
      setTimeout(() => ctrl.abort(), 20)

      await expect(
        client.generate({
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        }, { signal: ctrl.signal }),
      ).rejects.toMatchObject({ kind: 'aborted', retryable: false })

      // Record must reflect the abort.
      const rec = sink.last()
      expect(rec).toBeDefined()
      expect(rec!.status).toBe('aborted')
      expect(rec!.errorKind).toBe('aborted')

      // Adapter observed the abort signal.
      expect(adapter.abortObserved).toBe(true)
    },
    2_000,
  )

  it('already-aborted signal => LlmError aborted synchronously', async () => {
    const adapter = new SignalAwareFakeAdapter(
      'google',
      makeSuccessResult(),
      { delayMs: 300 },
    )
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [adapter],
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const ctrl = new AbortController()
    ctrl.abort() // abort BEFORE the call

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      }, { signal: ctrl.signal }),
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
  it(
    'timeout + synchronously-aborting adapter => classified timeout (not aborted)',
    async () => {
      // This adapter rejects with AbortError synchronously when the signal fires.
      // Without the "reject-first" fix, this would race and could produce 'aborted'.
      const adapter = new SignalAwareFakeAdapter(
        'google',
        makeSuccessResult(),
        { delayMs: 5_000, abortsSynchronouslyOnSignal: true },
      )
      const sink = new RecordingSink()

      const client = createClient({
        adapters: [adapter],
        auth: AUTH,
        pricing: PRICING,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      await expect(
        client.generate({
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          config: { timeoutMs: 10 },
        }),
      ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

      const rec = sink.last()
      expect(rec).toBeDefined()
      expect(rec!.status).toBe('timeout')
      expect(rec!.errorKind).toBe('timeout')
    },
    2_000,
  )

  it('timeout with non-cooperative adapter => timeout', async () => {
    // FakeAdapter ignores ctx.signal — should still time out.
    const slow = new FakeAdapter('google', makeSuccessResult(), { delayMs: 500 })
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [slow],
      auth: AUTH,
      pricing: PRICING,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        config: { timeoutMs: 10 },
      }),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    const rec = sink.last()
    expect(rec).toBeDefined()
    expect(rec!.status).toBe('timeout')
  }, 2_000)
})

// ---------------------------------------------------------------------------
// 13. providerOptions deep-merge (Finding 3)
// ---------------------------------------------------------------------------

describe('engine — providerOptions deep-merge (Finding 3)', () => {
  it(
    'sibling keys survive per-call override; array values are replaced wholesale',
    async () => {
      const capturedConfigs: Array<Parameters<typeof capturingAdapter.run>[0]> = []
      const capturingAdapter = new FakeAdapter('google', makeSuccessResult())
      const origRun = capturingAdapter.run.bind(capturingAdapter)
      vi.spyOn(capturingAdapter, 'run').mockImplementation(async (req, ctx) => {
        capturedConfigs.push(req)
        return origRun(req, ctx)
      })

      const client = createClient({
        adapters: [capturingAdapter],
        auth: AUTH,
        pricing: PRICING,
        clock: new FakeClock(),
        ids: new FakeIds(),
        defaults: {
          providerOptions: {
            google: { a: { x: 1, y: 2 }, keep: true },
          },
        },
      })

      // Per-call override touches google.a.x only.
      await client.generate({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        config: {
          providerOptions: {
            google: { a: { x: 99 }, arr: [10, 20] },
          },
        },
      })

      const merged = capturedConfigs[0]?.config.providerOptions
      expect(merged).toBeDefined()

      // x is overridden.
      const google = merged!['google'] as Record<string, unknown>
      const aBlock = google['a'] as Record<string, unknown>
      expect(aBlock['x']).toBe(99)

      // y (sibling of x) survives the per-call override.
      expect(aBlock['y']).toBe(2)

      // keep (sibling of a) survives.
      expect(google['keep']).toBe(true)

      // arr is a new key from the per-call override.
      expect(google['arr']).toEqual([10, 20])
    },
  )

  it('array value in providerOptions is replaced wholesale (not merged)', async () => {
    const capturedConfigs: Array<Parameters<typeof capturingAdapter.run>[0]> = []
    const capturingAdapter = new FakeAdapter('google', makeSuccessResult())
    const origRun = capturingAdapter.run.bind(capturingAdapter)
    vi.spyOn(capturingAdapter, 'run').mockImplementation(async (req, ctx) => {
      capturedConfigs.push(req)
      return origRun(req, ctx)
    })

    const client = createClient({
      adapters: [capturingAdapter],
      auth: AUTH,
      pricing: PRICING,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: {
        providerOptions: { google: { tags: ['a', 'b', 'c'] } },
      },
    })

    await client.generate({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      config: {
        providerOptions: { google: { tags: ['x'] } },
      },
    })

    const google = capturedConfigs[0]?.config.providerOptions?.['google'] as Record<string, unknown>
    // Array is last-write-wins, not merged.
    expect(google['tags']).toEqual(['x'])
  })
})
