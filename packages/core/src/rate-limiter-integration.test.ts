/**
 * Engine integration tests for RateLimiter port.
 *
 * Uses a spy/fake limiter (not the in-memory one) to verify the engine's
 * acquire/release contract without importing @gullabs/testing.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, geminiPricingSource, LlmError } from './index.js'
import type { RateLimiter, Release } from './index.js'
import { FakeAdapter, FakeClock, FakeIds } from '@gullabs/testing'
import type { AdapterResult, Usage } from './index.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const GOOD_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  details: {},
  raw: null,
}

function makeSuccessResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    text: 'ok',
    usage: GOOD_USAGE,
    model: 'gemini-2.5-flash',
    warnings: [],
    ...overrides,
  }
}

const PRICING = geminiPricingSource()
const TEST_AUTH = { apiKey: 'test-key' }

// ---------------------------------------------------------------------------
// Spy limiter factory
// ---------------------------------------------------------------------------

interface SpyLimiter extends RateLimiter {
  acquireCalls: Array<{ key: string; signal: AbortSignal | undefined }>
  releaseCalls: number
  /** When set, acquire rejects with this error instead of resolving. */
  rejectWith?: unknown
}

function makeSpyLimiter(): SpyLimiter {
  const spy: SpyLimiter = {
    acquireCalls: [],
    releaseCalls: 0,
    async acquire(key: string, signal?: AbortSignal): Promise<Release> {
      spy.acquireCalls.push({ key, signal })
      if (spy.rejectWith !== undefined) {
        throw spy.rejectWith
      }
      return (): void => {
        spy.releaseCalls++
      }
    },
  }
  return spy
}

function makeClientWithSpy(spy: SpyLimiter) {
  const clock = new FakeClock(1_000)
  const ids = new FakeIds()
  const adapter = new FakeAdapter('google', makeSuccessResult())
  const client = createClient({
    adapters: [adapter],
    pricing: PRICING,
    clock,
    ids,
    rateLimiter: spy,
  })
  return { client, adapter }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('engine — rateLimiter integration', () => {
  it('(a) calls acquire with key "<provider>:<model>" before the adapter runs', async () => {
    const spy = makeSpyLimiter()
    const { client, adapter } = makeClientWithSpy(spy)

    // Verify acquire is called before adapter by checking ordering via interleaved tracking.
    let acquireCalledBeforeAdapter = false
    const originalAcquire = spy.acquire.bind(spy)
    spy.acquire = async (key, signal) => {
      // At the moment acquire is called, the adapter has 0 calls.
      acquireCalledBeforeAdapter = adapter.calls.length === 0
      return originalAcquire(key, signal)
    }

    await client.generate(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(acquireCalledBeforeAdapter).toBe(true)
    expect(spy.acquireCalls).toHaveLength(1)
    expect(spy.acquireCalls[0]!.key).toBe('google:gemini-2.5-flash')
  })

  it('(b) calls Release on the success path', async () => {
    const spy = makeSpyLimiter()
    const { client } = makeClientWithSpy(spy)

    await client.generate(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(spy.releaseCalls).toBe(1)
  })

  it('(c) calls Release on the error path (adapter throws)', async () => {
    const spy = makeSpyLimiter()
    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', { status: 500 })
    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      clock,
      ids,
      rateLimiter: spy,
    })

    await expect(
      client.generate(
        {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toBeInstanceOf(LlmError)

    // Release must still have been called despite the adapter error.
    expect(spy.releaseCalls).toBe(1)
  })

  it('(d) if acquire rejects, the call fails and the adapter is never invoked', async () => {
    const spy = makeSpyLimiter()
    spy.rejectWith = new LlmError('rate limiter refused', {
      kind: 'rate_limited',
      retryable: true,
    })

    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', makeSuccessResult())
    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      clock,
      ids,
      rateLimiter: spy,
    })

    const err = await client
      .generate(
        {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('rate_limited')
    // Adapter must never have been called.
    expect(adapter.calls).toHaveLength(0)
    // Release must never have been called (acquire never resolved).
    expect(spy.releaseCalls).toBe(0)
  })

  it('(e) timeout during blocked acquire → kind=timeout (not aborted)', async () => {
    // A rate limiter whose acquire() never resolves until the signal aborts.
    // This simulates acquire blocking indefinitely while waiting for a slot.
    const blockingLimiter: RateLimiter = {
      acquire(_key: string, signal?: AbortSignal): Promise<Release> {
        return new Promise<Release>((_resolve, reject) => {
          if (signal === undefined) return
          if (signal.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
            )
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
              )
            },
            { once: true },
          )
        })
      },
    }

    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', makeSuccessResult())

    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      clock,
      ids,
      rateLimiter: blockingLimiter,
    })

    const err = await client
      .generate(
        {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          config: { timeoutMs: 20 },
        },
        { auth: TEST_AUTH },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
  }, 2_000)

  it('(f) caller-abort during blocked acquire → kind=aborted', async () => {
    // Same blocking limiter as (e).
    const blockingLimiter: RateLimiter = {
      acquire(_key: string, signal?: AbortSignal): Promise<Release> {
        return new Promise<Release>((_resolve, reject) => {
          if (signal === undefined) return
          if (signal.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
            )
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
              )
            },
            { once: true },
          )
        })
      },
    }

    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', makeSuccessResult())

    const client = createClient({
      adapters: [adapter],
      pricing: PRICING,
      clock,
      ids,
      rateLimiter: blockingLimiter,
    })

    const ac = new AbortController()
    // Abort shortly after the call starts (blocking in acquire).
    setTimeout(() => ac.abort(), 20)

    const err = await client
      .generate(
        {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH, signal: ac.signal },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
  }, 2_000)
})
