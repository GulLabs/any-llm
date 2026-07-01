import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@gullabs/core'
import {
  checkProviderQuota,
  enforceProviderQuota,
  quotaPolicyForGemini,
  type QuotaEvent,
  type QuotaStore,
  type QuotaStoreCheckInput,
  type QuotaStoreCheckResult,
} from './index.js'

function makeStore(result: QuotaStoreCheckResult): QuotaStore {
  return {
    checkAndConsume: vi.fn(async (_input: QuotaStoreCheckInput) => result),
  }
}

describe('@gullabs/quota', () => {
  it('checkProviderQuota returns deny for rpd=0 without retryAfterMs', async () => {
    const store: QuotaStore = {
      checkAndConsume: vi.fn(async () => {
        throw new Error('store should not be called for provider-disabled models')
      }),
    }

    const decision = await checkProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-pro',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-pro': { rpd: 0 },
        },
      }),
      store,
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    })

    expect(decision).toEqual({
      kind: 'deny',
      scope: 'google:gemini-2.5-pro',
      reason: 'provider_disabled',
    })
    expect('retryAfterMs' in decision).toBe(false)
    expect(store.checkAndConsume).not.toHaveBeenCalled()
  })

  it('enforceProviderQuota emits a deny event and throws a non-retryable rate_limited error', async () => {
    const events: QuotaEvent[] = []
    const error = await enforceProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-pro',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-pro': { rpd: 0 },
        },
      }),
      store: makeStore({}),
      onEvent: (event) => events.push(event),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
    })
    expect('retryAfterMs' in (error as LlmError)).toBe(false)
    expect((error as LlmError).message).toContain('Provider quota disabled')

    expect(events).toEqual([
      {
        type: 'deny',
        provider: 'google',
        model: 'gemini-2.5-pro',
        scope: 'google:gemini-2.5-pro',
        decision: {
          kind: 'deny',
          scope: 'google:gemini-2.5-pro',
          reason: 'provider_disabled',
        },
      },
    ])
  })

  it('rpm exhaustion defers with retryable=true and retryAfterMs', async () => {
    const events: QuotaEvent[] = []
    const error = await enforceProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-flash',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-flash': { rpm: 60, rpd: 2_000 },
        },
      }),
      store: makeStore({
        rpm: { allowed: false, retryAfterMs: 1_500 },
        rpd: { allowed: true },
      }),
      onEvent: (event) => events.push(event),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 1_500,
    })
    expect(events).toEqual([
      {
        type: 'defer',
        provider: 'google',
        model: 'gemini-2.5-flash',
        scope: 'google:gemini-2.5-flash',
        decision: {
          kind: 'defer',
          scope: 'google:gemini-2.5-flash',
          reason: 'rpm_exhausted',
          retryAfterMs: 1_500,
        },
      },
    ])
  })

  it('rpd exhaustion defers with retryable=true and retryAfterMs', async () => {
    const error = await enforceProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-flash',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-flash': { rpm: 60, rpd: 2_000 },
        },
      }),
      store: makeStore({
        rpm: { allowed: true },
        rpd: { allowed: false, retryAfterMs: 12_000 },
      }),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 12_000,
    })
  })

  it('message helpers keep exhaustive switch guards for defer and deny reasons', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    expect(source).toContain('function messageForDefer')
    expect(source).toContain('function messageForDeny')
    expect(source.match(/const exhaustive: never = reason/g)).toHaveLength(1)
    expect(source).toContain('satisfies Record<QuotaDenyReason')
  })
})
