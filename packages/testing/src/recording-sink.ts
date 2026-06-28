/**
 * RecordingSink — an in-memory UsageSink for use in tests.
 *
 * @module
 */

import type { UsageSink, LlmCallRecord } from '@anyllm/core'

/**
 * Options for {@link RecordingSink}.
 */
export interface RecordingSinkOptions {
  /**
   * When set, `record()` will throw instead of storing the record.
   *
   * - `true` — throws a generic `Error`.
   * - An `Error` instance — throws that exact error.
   *
   * Use this to verify the engine's fail-open behaviour (a broken sink must
   * never fail the LLM call).
   */
  failOnRecord?: boolean | Error
}

/**
 * An in-memory {@link UsageSink} that accumulates every record it receives.
 *
 * ```ts
 * const sink = new RecordingSink()
 * // … run the engine …
 * expect(sink.records).toHaveLength(1)
 * expect(sink.last()?.status).toBe('ok')
 * ```
 */
export class RecordingSink implements UsageSink {
  /** Every record received by this sink, in insertion order. */
  readonly records: LlmCallRecord[] = []

  private readonly _failOnRecord: boolean | Error

  constructor(opts: RecordingSinkOptions = {}) {
    this._failOnRecord = opts.failOnRecord ?? false
  }

  async record(r: LlmCallRecord): Promise<void> {
    if (this._failOnRecord !== false) {
      if (this._failOnRecord instanceof Error) {
        throw this._failOnRecord
      }
      throw new Error('RecordingSink: configured to fail on record')
    }
    this.records.push(r)
  }

  /**
   * Returns the most recently recorded `LlmCallRecord`, or `undefined` if
   * nothing has been recorded yet.
   */
  last(): LlmCallRecord | undefined {
    return this.records[this.records.length - 1]
  }
}
