/**
 * GoogleCacheStore unit tests.
 *
 * All tests use an injected fake GeminiCachesClientLike and injected `now` — no
 * network or real clock required.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { GoogleCacheStore } from './cache-store.js'
import type { GeminiCachesClientLike, GoogleCacheHandle } from './cache-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeAuth = { apiKey: 'test-key' }

/** Baseline "now" — arbitrary fixed epoch. */
const BASE_NOW = 1_700_000_000_000

function makeClient(overrides: Partial<GeminiCachesClientLike> = {}): GeminiCachesClientLike {
  return {
    create: vi.fn().mockResolvedValue({
      name: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
    }),
    update: vi.fn().mockResolvedValue({
      name: 'cachedContents/abc123',
      expireTime: new Date(BASE_NOW + 7200 * 1000).toISOString(),
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleCacheStore', () => {
  // 1. create returns correct handle
  it('create returns correct handle with cacheName, model, and expiresAt from ttl', async () => {
    const ttlSeconds = 3600
    const client = makeClient()
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle = await store.create({
      model: 'gemini-2.0-flash',
      ttlSeconds,
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })

    expect(handle.cacheName).toBe('cachedContents/abc123')
    expect(handle.model).toBe('gemini-2.0-flash')
    // Server returned expireTime — should be parsed
    expect(handle.expiresAt).toBeInstanceOf(Date)
    expect(handle.expiresAt.getTime()).toBe(BASE_NOW + ttlSeconds * 1000)
  })

  it('create falls back to local clock expiry when server omits expireTime', async () => {
    const ttlSeconds = 1800
    const client = makeClient({
      create: vi.fn().mockResolvedValue({ name: 'cachedContents/xyz', model: 'gemini-2.0-flash' }),
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle = await store.create({ model: 'gemini-2.0-flash', ttlSeconds })

    expect(handle.cacheName).toBe('cachedContents/xyz')
    expect(handle.expiresAt.getTime()).toBe(BASE_NOW + ttlSeconds * 1000)
  })

  // 2. getOrCreate: first call invokes factory+create; second call returns cached entry
  it('getOrCreate: first call invokes factory+create; second call (still fresh) reuses without calling create again', async () => {
    const client = makeClient()
    const factory = vi.fn().mockResolvedValue({
      ttlSeconds: 3600,
      contents: [{ role: 'user', parts: [{ text: 'cached' }] }],
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const key = { model: 'gemini-2.0-flash', stableKey: 'key-1' }

    const h1 = await store.getOrCreate(key, factory)
    const h2 = await store.getOrCreate(key, factory)

    // factory and create called only once (the second call reuses the in-process map)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(h1).toBe(h2)
  })

  // 3. getOrCreate with coalesce:true — two concurrent calls share one in-flight create
  it('getOrCreate with coalesce:true: two concurrent calls for the same key invoke factory exactly once', async () => {
    const client = makeClient()
    let resolveFactory!: (v: { ttlSeconds: number }) => void
    const blockedFactory = vi.fn(
      () =>
        new Promise<{ ttlSeconds: number }>((res) => {
          resolveFactory = res
        }),
    )

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      coalesce: true,
      now: () => BASE_NOW,
    })

    const key = { model: 'gemini-2.0-flash', stableKey: 'coalesce-key' }

    // Start two concurrent calls without awaiting
    const p1 = store.getOrCreate(key, blockedFactory)
    const p2 = store.getOrCreate(key, blockedFactory)

    // Unblock factory
    resolveFactory({ ttlSeconds: 3600 })

    const [h1, h2] = await Promise.all([p1, p2])

    // Factory should have been called exactly once due to coalescing
    expect(blockedFactory).toHaveBeenCalledTimes(1)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(h1.cacheName).toBe(h2.cacheName)
  })

  it('getOrCreate with coalesce:true: different keys create independently', async () => {
    let callCount = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          name: `cachedContents/entry-${callCount}`,
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
    })

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      coalesce: true,
      now: () => BASE_NOW,
    })

    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })

    const [h1, h2] = await Promise.all([
      store.getOrCreate({ model: 'gemini-2.0-flash', stableKey: 'k1' }, factory),
      store.getOrCreate({ model: 'gemini-2.0-flash', stableKey: 'k2' }, factory),
    ])

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(h1.cacheName).not.toBe(h2.cacheName)
  })

  // 4. Expired entry triggers a fresh create
  it('expired entry: advances now past expiresAt-skew, verifies a fresh create is triggered', async () => {
    const ttlSeconds = 3600
    const skewSeconds = 30
    // expiresAt will be BASE_NOW + 3600*1000 (from server)
    const client = makeClient()
    let nowMs = BASE_NOW

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      expirySkewSeconds: skewSeconds,
      now: () => nowMs,
    })

    const key = { model: 'gemini-2.0-flash', stableKey: 'expire-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds })

    // First call — creates entry
    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // Advance clock past expiry (accounting for skew)
    nowMs = BASE_NOW + ttlSeconds * 1000 - skewSeconds * 1000 + 1

    // Second call — entry is now considered expired; should create again
    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  // 5. refreshIfExpiringSoon
  it('refreshIfExpiringSoon extends when near expiry', async () => {
    const ttlSeconds = 3600
    const client = makeClient()
    // Set now such that expiresAt - now <= threshold (default 300s)
    // expiresAt = BASE_NOW + 3600*1000; if now = BASE_NOW + 3600*1000 - 100*1000, diff = 100s < 300s
    const nearExpiryNow = BASE_NOW + ttlSeconds * 1000 - 100 * 1000

    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => nearExpiryNow })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + ttlSeconds * 1000),
    }

    const newHandle = await store.refreshIfExpiringSoon(handle)

    expect(client.update).toHaveBeenCalledTimes(1)
    // Server returned expireTime = BASE_NOW + 7200*1000
    expect(newHandle.expiresAt.getTime()).toBe(BASE_NOW + 7200 * 1000)
    expect(newHandle.cacheName).toBe(handle.cacheName)
  })

  it('refreshIfExpiringSoon: no update call when not near expiry', async () => {
    const client = makeClient()
    // expiresAt = BASE_NOW + 3600*1000; now = BASE_NOW; diff = 3600s >> 300s threshold
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    const result = await store.refreshIfExpiringSoon(handle)

    expect(client.update).not.toHaveBeenCalled()
    expect(result).toBe(handle)
  })

  it('refreshIfExpiringSoon: returns original handle when update throws (fail-open)', async () => {
    const client = makeClient({
      update: vi.fn().mockRejectedValue(new Error('network error')),
    })
    const nearExpiryNow = BASE_NOW + 3600 * 1000 - 100 * 1000

    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => nearExpiryNow })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    // Should NOT throw
    const result = await store.refreshIfExpiringSoon(handle)
    expect(result).toBe(handle)
  })

  // NEW (a): coalesce:false → two concurrent same-key getOrCreate do NOT share
  it('coalesce:false: two concurrent same-key calls invoke create twice', async () => {
    let callCount = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          name: `cachedContents/entry-${callCount}`,
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
    })

    const store = new GoogleCacheStore({ auth: fakeAuth, client, coalesce: false, now: () => BASE_NOW })
    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })
    const key = { model: 'gemini-2.0-flash', stableKey: 'no-coalesce-key' }

    const [h1, h2] = await Promise.all([
      store.getOrCreate(key, factory),
      store.getOrCreate(key, factory),
    ])

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(2)
    // They get different handles (different names)
    expect(h1.cacheName).not.toBe(h2.cacheName)
  })

  // NEW (b): coalesced create that REJECTS clears inflight and doesn't poison entries
  it('coalesce:true: rejected create clears inflight so a retry succeeds independently', async () => {
    let attempt = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        attempt++
        if (attempt === 1) {
          return Promise.reject(new Error('transient failure'))
        }
        return Promise.resolve({
          name: 'cachedContents/retry-ok',
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
    })

    const store = new GoogleCacheStore({ auth: fakeAuth, client, coalesce: true, now: () => BASE_NOW })
    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })
    const key = { model: 'gemini-2.0-flash', stableKey: 'retry-key' }

    // First attempt — both concurrent callers share the failing create
    const firstAttempt = store.getOrCreate(key, factory).catch((e) => e)
    const firstAttempt2 = store.getOrCreate(key, factory).catch((e) => e)
    const [r1, r2] = await Promise.all([firstAttempt, firstAttempt2])
    expect(r1).toBeInstanceOf(Error)
    expect(r2).toBeInstanceOf(Error)

    // entries must NOT be poisoned
    // Retry — inflight was cleared, so a fresh create runs
    const retryHandle = await store.getOrCreate(key, factory)
    expect(retryHandle.cacheName).toBe('cachedContents/retry-ok')
    // factory called: once for first pair (coalesced) + once for retry = 2
    expect(factory).toHaveBeenCalledTimes(2)
    expect(client.create).toHaveBeenCalledTimes(2)
  })

  // NEW (c): successful refreshIfExpiringSoon updates the entry so later getOrCreate reuses it
  it('refreshIfExpiringSoon: successful update causes later getOrCreate to reuse refreshed handle', async () => {
    const ttlSeconds = 3600
    const client = makeClient()
    // Start near expiry so refresh fires: expiresAt = BASE_NOW + 3600*1000; threshold 300s
    // nearExpiryNow → expiresAt - now = 100s < 300s → refresh fires
    let nowMs = BASE_NOW + ttlSeconds * 1000 - 100 * 1000

    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => nowMs })
    const key = { model: 'gemini-2.0-flash', stableKey: 'refresh-reuse-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds })

    // Create initial entry
    const initial = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // Refresh (near expiry at nowMs)
    const refreshed = await store.refreshIfExpiringSoon(initial)
    expect(client.update).toHaveBeenCalledTimes(1)
    // Server returns expireTime = BASE_NOW + 7200*1000
    expect(refreshed.expiresAt.getTime()).toBe(BASE_NOW + 7200 * 1000)

    // Advance clock but still within the NEW expiry window (7200s from BASE_NOW)
    nowMs = BASE_NOW + 5000 * 1000 // 5000s from BASE_NOW, < 7200s

    // getOrCreate should reuse the refreshed entry without creating again
    const reused = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1) // still 1 — no new create
    expect(reused.cacheName).toBe(refreshed.cacheName)
    expect(reused.expiresAt.getTime()).toBe(refreshed.expiresAt.getTime())
  })

  // NEW (d): delete() evicts entry so next getOrCreate creates fresh (even if remote delete throws)
  it('delete: evicts local entry so next getOrCreate creates a new cache even when remote delete throws', async () => {
    let callCount = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          name: `cachedContents/entry-${callCount}`,
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
      delete: vi.fn().mockRejectedValue(new Error('remote delete failed')),
    })
    const onDeleteError = vi.fn()

    const store = new GoogleCacheStore({ auth: fakeAuth, client, onDeleteError, now: () => BASE_NOW })
    const key = { model: 'gemini-2.0-flash', stableKey: 'evict-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })

    const h1 = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // delete should evict locally even though remote throws
    await store.delete(h1)
    expect(onDeleteError).toHaveBeenCalledOnce()

    // Next getOrCreate must create fresh
    const h2 = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(h2.cacheName).not.toBe(h1.cacheName)
  })

  // NEW (e): expiry boundary — when expiresAt - skew === now exactly, treat as EXPIRED
  it('expiry boundary: entry where expiresAt - skew === now is treated as expired', async () => {
    const ttlSeconds = 3600
    const skewSeconds = 30
    const client = makeClient()

    // expiresAt = BASE_NOW + 3600*1000; skewMs = 30*1000
    // boundary: expiresAt - skewMs = BASE_NOW + 3570*1000
    // isLive uses `> now`, so if now === boundary, entry is NOT live
    let nowMs = BASE_NOW
    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      expirySkewSeconds: skewSeconds,
      now: () => nowMs,
    })

    const key = { model: 'gemini-2.0-flash', stableKey: 'boundary-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds })

    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // Advance clock to exact boundary: expiresAt - skewMs
    nowMs = BASE_NOW + ttlSeconds * 1000 - skewSeconds * 1000

    // At exactly the boundary, isLive returns false → re-create
    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  // 6. delete swallows a throwing client and calls onDeleteError
  it('delete swallows a throwing client and calls onDeleteError with cacheName and error', async () => {
    const deleteError = new Error('delete failed')
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(deleteError),
    })
    const onDeleteError = vi.fn()

    const store = new GoogleCacheStore({ auth: fakeAuth, client, onDeleteError, now: () => BASE_NOW })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    // Should not throw
    await expect(store.delete(handle)).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalledWith('cachedContents/abc123', deleteError)
  })
})
