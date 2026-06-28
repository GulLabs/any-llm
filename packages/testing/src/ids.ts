/**
 * FakeIds — a deterministic IdGenerator for use in tests.
 *
 * @module
 */

import type { IdGenerator } from '@anyllm/core'

/**
 * An IdGenerator that returns sequential, assertable IDs.
 *
 * Call IDs are `call_1`, `call_2`, … and attempt IDs are `attempt_1`,
 * `attempt_2`, … with separate independent counters.  Both sequences
 * restart from `1` after `reset()`.
 *
 * ```ts
 * const ids = new FakeIds()
 * ids.callId()    // 'call_1'
 * ids.callId()    // 'call_2'
 * ids.attemptId() // 'attempt_1'
 * ids.reset()
 * ids.callId()    // 'call_1'
 * ```
 */
export class FakeIds implements IdGenerator {
  private _callCount: number = 0
  private _attemptCount: number = 0

  /** Returns the next sequential call ID (`call_<n>`). */
  callId(): string {
    this._callCount += 1
    return `call_${this._callCount}`
  }

  /** Returns the next sequential attempt ID (`attempt_<n>`). */
  attemptId(): string {
    this._attemptCount += 1
    return `attempt_${this._attemptCount}`
  }

  /** Reset both counters back to zero. */
  reset(): void {
    this._callCount = 0
    this._attemptCount = 0
  }
}
