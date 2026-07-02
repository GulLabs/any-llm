import { describe, it, expect, vi } from 'vitest'
import { inMemoryRateLimiter } from './rate-limiter.js'
import type { RateLimiter } from './ports.js'

describe('inMemoryRateLimiter (core)', () => {
  it('resolves immediately when under the concurrency cap', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 2 })
    const r1 = await limiter.acquire('google:gemini-2.5-pro')
    const r2 = await limiter.acquire('google:gemini-2.5-pro')
    expect(typeof r1).toBe('function')
    expect(typeof r2).toBe('function')
    r1()
    r2()
  })

  it('resolves immediately with no cap (Infinity default)', async () => {
    const limiter = inMemoryRateLimiter()
    const releases = await Promise.all([
      limiter.acquire('k'),
      limiter.acquire('k'),
      limiter.acquire('k'),
    ])
    for (const r of releases) r()
  })

  it('blocks a second acquire until the first releases (cap=1)', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release1 = await limiter.acquire('google:gemini-2.5-pro')

    let secondResolved = false
    const p2 = limiter.acquire('google:gemini-2.5-pro').then((r) => {
      secondResolved = true
      return r
    })

    await Promise.resolve()
    expect(secondResolved).toBe(false)

    release1()
    const release2 = await p2
    expect(secondResolved).toBe(true)
    release2()
  })

  it('release frees the slot and the next waiter resolves', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 2 })

    const r1 = await limiter.acquire('key')
    const r2 = await limiter.acquire('key')

    let r3Resolved = false
    let r4Resolved = false
    const p3 = limiter.acquire('key').then((r) => {
      r3Resolved = true
      return r
    })
    const p4 = limiter.acquire('key').then((r) => {
      r4Resolved = true
      return r
    })

    await Promise.resolve()
    expect(r3Resolved).toBe(false)
    expect(r4Resolved).toBe(false)

    r1()
    const r3 = await p3
    expect(r3Resolved).toBe(true)
    expect(r4Resolved).toBe(false)

    r2()
    const r4 = await p4
    expect(r4Resolved).toBe(true)

    r3()
    r4()
  })

  it('keys are independent — cap is per key', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })

    const r1 = await limiter.acquire('provider:model-a')
    const r2 = await limiter.acquire('provider:model-b')

    expect(typeof r1).toBe('function')
    expect(typeof r2).toBe('function')
    r1()
    r2()
  })

  it('abort signal rejects an already-aborted acquire immediately', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release = await limiter.acquire('key')

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(limiter.acquire('key', controller.signal)).rejects.toThrow()

    release()
  })

  it('abort signal rejects a queued waiter when signal fires', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release1 = await limiter.acquire('key')

    const controller = new AbortController()
    const p = limiter.acquire('key', controller.signal)

    controller.abort(new Error('user cancelled'))

    await expect(p).rejects.toThrow('user cancelled')

    release1()
  })

  it('abort signal with a non-Error reason synthesizes an AbortError for an already-aborted acquire', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release = await limiter.acquire('key')

    const controller = new AbortController()
    controller.abort('some string reason')

    let caught: unknown
    try {
      await limiter.acquire('key', controller.signal)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('AbortError')

    release()
  })

  it('abort signal with an undefined reason synthesizes an AbortError for an already-aborted acquire', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release = await limiter.acquire('key')

    const controller = new AbortController()
    // Simulate a signal that is aborted with no reason set.
    Object.defineProperty(controller.signal, 'reason', { value: undefined })
    controller.abort()

    let caught: unknown
    try {
      await limiter.acquire('key', controller.signal)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('AbortError')

    release()
  })

  it('abort signal with a non-Error reason synthesizes an AbortError for a queued waiter', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release1 = await limiter.acquire('key')

    const controller = new AbortController()
    const p = limiter.acquire('key', controller.signal)

    controller.abort('queued cancel reason')

    let caught: unknown
    try {
      await p
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('AbortError')

    release1()
  })

  it('removes an aborted waiter from the queue without double-resolving, and frees a slot for the next legitimate waiter', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release1 = await limiter.acquire('key')

    const controller = new AbortController()
    let abortedSettled = false
    let abortedResolvedAgain = false
    const abortedPromise = limiter.acquire('key', controller.signal).then(
      () => {
        abortedResolvedAgain = true
      },
      () => {
        abortedSettled = true
      },
    )

    let thirdResolved = false
    const p3 = limiter.acquire('key').then((r) => {
      thirdResolved = true
      return r
    })

    controller.abort(new Error('abandon queued waiter'))
    await abortedPromise
    expect(abortedSettled).toBe(true)

    // Release the only held slot — this must free the third (legitimate)
    // waiter, not the aborted (already-removed) one.
    release1()
    const release3 = await p3
    expect(thirdResolved).toBe(true)
    expect(abortedResolvedAgain).toBe(false)

    release3()
  })

  it('clears the abort listener when a queued waiter resolves normally (not aborted)', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release1 = await limiter.acquire('key')

    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

    const p2 = limiter.acquire('key', controller.signal)

    release1()
    const release2 = await p2

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))

    release2()
  })

  it('satisfies the RateLimiter interface structurally', () => {
    const limiter: RateLimiter = inMemoryRateLimiter()
    expect(typeof limiter.acquire).toBe('function')
  })
})
