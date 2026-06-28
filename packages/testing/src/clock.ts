/**
 * FakeClock — a deterministic Clock for use in tests.
 *
 * @module
 */

import type { Clock } from '@gullabs/core'

/**
 * A deterministic Clock whose current time is fully controlled by the caller.
 *
 * ```ts
 * const clock = new FakeClock(1_000)
 * clock.now()        // 1000
 * clock.advance(500)
 * clock.now()        // 1500
 * clock.set(0)
 * clock.now()        // 0
 * ```
 */
export class FakeClock implements Clock {
  private _ms: number

  /**
   * @param startMs - Initial value returned by `now()`.  Defaults to `0`.
   */
  constructor(startMs: number = 0) {
    this._ms = startMs
  }

  /** Returns the current fake time in milliseconds. */
  now(): number {
    return this._ms
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this._ms += ms
  }

  /** Jump the clock to an absolute millisecond value. */
  set(ms: number): void {
    this._ms = ms
  }
}
