/**
 * GoogleFileStore unit tests.
 *
 * All tests use an injected fake GeminiFilesClientLike — no network.
 * sleep is injected as () => Promise.resolve() for instant polling.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LlmError } from '@gullabs/core'
import { GoogleFileStore } from './file-store.js'
import type { GeminiFilesClientLike, GoogleFileHandle } from './file-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeAuth = { apiKey: 'test-key' }
const fastSleep = (): Promise<void> => Promise.resolve()

function makeClient(overrides: Partial<GeminiFilesClientLike> = {}): GeminiFilesClientLike {
  return {
    upload: vi.fn().mockResolvedValue({
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
      state: 'ACTIVE',
    }),
    get: vi.fn().mockResolvedValue({
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
      state: 'ACTIVE',
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleFileStore', () => {
  // 1. ACTIVE immediately — no polling
  it('returns a handle when upload state is ACTIVE immediately', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
        expirationTime: '2026-07-01T00:00:00Z',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1, 2, 3]), 'image/png')

    expect(handle.name).toBe('files/abc123')
    expect(handle.uri).toBe('https://example.com/files/abc123')
    expect(handle.mimeType).toBe('image/png')
    expect(client.get).not.toHaveBeenCalled()
  })

  // 2. Polls through PROCESSING then ACTIVE
  it('polls through PROCESSING then resolves when ACTIVE', async () => {
    const getResponses = [
      { state: 'PROCESSING', name: 'files/abc123', uri: 'https://example.com/files/abc123', mimeType: 'image/png' },
      { state: 'PROCESSING', name: 'files/abc123', uri: 'https://example.com/files/abc123', mimeType: 'image/png' },
      { state: 'ACTIVE', name: 'files/abc123', uri: 'https://example.com/files/abc123', mimeType: 'image/png' },
    ]
    let getCallIdx = 0

    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockImplementation(() => Promise.resolve(getResponses[getCallIdx++])),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')

    expect(handle.name).toBe('files/abc123')
    expect(client.get).toHaveBeenCalledTimes(3)
  })

  // 3. FAILED state → LlmError kind === 'bad_request'
  it('throws LlmError bad_request when upload state is FAILED immediately', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'FAILED',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toBeInstanceOf(LlmError)
  })

  it('throws LlmError bad_request when FAILED during polling', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'FAILED',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('bad_request')
    expect((err as LlmError).retryable).toBe(false)
  })

  // 4. Poll timeout → LlmError kind === 'timeout'
  it('throws LlmError timeout when polling exceeds timeoutMs', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        state: 'PROCESSING',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      }),
    })

    // Zero timeout to trigger immediately
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      poll: { timeoutMs: 0, intervalMs: 0 },
    })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
    expect((err as LlmError).retryable).toBe(true)
  })

  // 5. expiresAt is Date when expirationTime present; absent (not undefined key) when not
  it('maps expirationTime to expiresAt Date when present', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
        expirationTime: '2026-07-01T00:00:00Z',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')
    expect(handle.expiresAt).toBeInstanceOf(Date)
    expect(handle.expiresAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('omits expiresAt key entirely when expirationTime is absent', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
        // no expirationTime
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')
    expect('expiresAt' in handle).toBe(false)
  })

  // 6. delete swallows error and calls onDeleteError
  it('swallows delete error and calls onDeleteError with the name', async () => {
    const deleteError = new Error('network error')
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(deleteError),
    })
    const onDeleteError = vi.fn()

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep, onDeleteError })
    const handle: GoogleFileHandle = { name: 'files/abc123', uri: 'u', mimeType: 'image/png' }

    // Should not throw
    await expect(store.delete(handle)).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalledWith('files/abc123', deleteError)
  })

  // NEW: deterministic timeout via injected now (not just timeoutMs:0)
  it('times out based on injected clock across multiple polls', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
    })

    // Injected clock: starts at 0, advances past deadline (5000) after first sleep
    let tick = 0
    const now = () => (tick === 0 ? 0 : 5_001)
    const countingSleep = (): Promise<void> => {
      tick++
      return Promise.resolve()
    }

    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: countingSleep,
      now,
      poll: { timeoutMs: 5_000, intervalMs: 0 },
    })

    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
    // Exactly one poll happened before the virtual clock crossed the deadline
    expect(client.get).toHaveBeenCalledTimes(1)
  })

  // NEW: client.upload throwing → classified LlmError (not raw object)
  it('classifies raw SDK error from client.upload as LlmError', async () => {
    const sdkError = Object.assign(new Error('SDK boom'), { status: 503 })
    const client = makeClient({
      upload: vi.fn().mockRejectedValue(sdkError),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    // Must NOT be the raw SDK error object
    expect(err).not.toBe(sdkError)
  })

  // NEW: client.get throwing during poll → classified LlmError
  it('classifies raw SDK error from client.get during polling as LlmError', async () => {
    const sdkError = Object.assign(new Error('network glitch'), { status: 500 })
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockRejectedValue(sdkError),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).not.toBe(sdkError)
  })

  // NEW: default onDeleteError logs sanitized message, NOT raw error
  it('default onDeleteError logs a sanitized message without the raw error object', async () => {
    const rawErr = Object.assign(new Error('secret-api-key-in-message'), { secretField: 'supersecret' })
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(rawErr),
    })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // No onDeleteError override → uses default sanitized handler
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      const handle: GoogleFileHandle = { name: 'files/abc123', uri: 'u', mimeType: 'image/png' }
      await store.delete(handle)

      expect(consoleSpy).toHaveBeenCalledOnce()
      // The raw Error object must NOT appear as any argument
      const callArgs = consoleSpy.mock.calls[0]!
      expect(callArgs).not.toContain(rawErr)
      // The second arg (sanitized message) must be a string, not an object
      expect(typeof callArgs[1]).toBe('string')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  // 7. deleteAll continues past individual failures
  it('deleteAll continues past individual failures and calls onDeleteError for each', async () => {
    const onDeleteError = vi.fn()
    const deleteError = new Error('fail')
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(deleteError),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep, onDeleteError })
    const handles: GoogleFileHandle[] = [
      { name: 'files/a', uri: 'ua', mimeType: 'image/png' },
      { name: 'files/b', uri: 'ub', mimeType: 'image/png' },
      { name: 'files/c', uri: 'uc', mimeType: 'image/png' },
    ]

    await expect(store.deleteAll(handles)).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalledTimes(3)
    expect(onDeleteError).toHaveBeenCalledWith('files/a', deleteError)
    expect(onDeleteError).toHaveBeenCalledWith('files/b', deleteError)
    expect(onDeleteError).toHaveBeenCalledWith('files/c', deleteError)
  })
})
