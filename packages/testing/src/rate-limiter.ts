export { inMemoryRateLimiter, type InMemoryRateLimiterOptions } from '@gullabs/core'
import type { RateLimiter, Release } from '@gullabs/core'

export interface ScriptedRateLimiterOptions {
  /** Fixed delay (ms) the limiter waits before resolving `acquire`. */
  delayMs: number
  /**
   * Optional deterministic test clock hook. When supplied, `acquire` advances
   * this clock by `delayMs` and resolves on the next microtask instead of
   * sleeping in wall-clock time.
   */
  clock?: { advance(ms: number): void }
}

/**
 * A RateLimiter test double with an injectable wait, for asserting
 * `queueDelayMs` without live provider traffic or a hand-rolled fake.
 */
export function scriptedRateLimiter(opts: ScriptedRateLimiterOptions): RateLimiter {
  return {
    acquire(_key: string, signal?: AbortSignal): Promise<Release> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = (): void => {
          cleanup()
          reject(new DOMException('Aborted', 'AbortError'))
        }
        const cleanup = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
          signal?.removeEventListener('abort', onAbort)
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        if (opts.clock !== undefined) {
          opts.clock.advance(opts.delayMs)
          queueMicrotask(() => {
            cleanup()
            resolve(() => {})
          })
          return
        }

        timer = setTimeout(() => {
          cleanup()
          resolve(() => {})
        }, opts.delayMs)
      })
    },
  }
}
