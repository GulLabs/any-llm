/**
 * FakeAdapter and fakeAuth — port-level fakes for engine integration tests.
 *
 * These fakes operate at the {@link ProviderAdapter} / {@link AuthProvider}
 * level (not the SDK level), letting tests drive the engine pipeline without
 * any provider SDK or network dependency.
 *
 * @module
 */

import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  AuthMaterial,
  AuthProvider,
} from '@gullabs/core'

// ---------------------------------------------------------------------------
// FakeAdapter script entry
// ---------------------------------------------------------------------------

/**
 * A scripted response entry for {@link FakeAdapter}.
 *
 * - {@link AdapterResult}: the adapter returns this as a success response.
 * - `Error`: the adapter throws it (goes through engine's `classifyError`).
 * - Plain object (e.g. `{ status: 429 }`): thrown as-is; `classifyError`
 *   extracts the HTTP status for classification.
 */
export type FakeAdapterEntry =
  | AdapterResult
  | Error
  | Record<string, unknown>

// ---------------------------------------------------------------------------
// FakeAdapter
// ---------------------------------------------------------------------------

/**
 * A scriptable {@link ProviderAdapter} for engine integration tests.
 *
 * Supply a single response (used for every call) or an array of responses
 * (consumed in order; the last entry is repeated when exhausted).
 *
 * Every received {@link ResolvedRequest} is pushed to `calls` for assertion.
 *
 * @example
 * ```ts
 * const adapter = new FakeAdapter('google', successResult)
 *
 * const adapter2 = new FakeAdapter('google', [
 *   successResult,
 *   { status: 429 },  // engine classifies as rate_limited
 * ])
 *
 * // Slow adapter for timeout tests:
 * const slow = new FakeAdapter('google', successResult, { delayMs: 200 })
 * ```
 */
export class FakeAdapter implements ProviderAdapter {
  /** Provider identifier — must match the routing key used in tests. */
  readonly id: string

  /** All {@link ResolvedRequest} objects received by this adapter, in order. */
  readonly calls: ResolvedRequest[] = []

  private readonly _entries: FakeAdapterEntry[]

  /**
   * Optional artificial delay before returning/throwing, in milliseconds.
   * Use `timeoutMs < delayMs` in the client config to test timeout behaviour.
   */
  private readonly _delayMs: number

  /**
   * @param id - Provider ID (e.g. `'google'`).
   * @param entries - One or more scripted responses consumed sequentially;
   *   the last entry repeats when the list is exhausted.
   * @param opts.delayMs - Artificial per-call delay in milliseconds (default 0).
   */
  constructor(
    id: string,
    entries: FakeAdapterEntry | FakeAdapterEntry[],
    opts?: { delayMs?: number },
  ) {
    this.id = id
    this._entries = Array.isArray(entries) ? entries : [entries]
    this._delayMs = opts?.delayMs ?? 0
  }

  async run(req: ResolvedRequest, _ctx: AdapterCtx): Promise<AdapterResult> {
    this.calls.push(req)

    if (this._delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this._delayMs))
    }

    // Pick entry: sequential, clamped to last when exhausted.
    const idx = Math.min(this.calls.length - 1, this._entries.length - 1)
    const entry: FakeAdapterEntry | undefined = this._entries[idx]

    if (entry === undefined) {
      // Should never happen since _entries is guaranteed non-empty.
      throw new Error('FakeAdapter: no entries configured')
    }

    // If it looks like an AdapterResult (has the required `usage` field), return it.
    // Otherwise throw it (covers Error instances and plain-object HTTP-style errors).
    if (!(entry instanceof Error) && 'usage' in entry) {
      return entry as AdapterResult
    }

    throw entry
  }
}

// ---------------------------------------------------------------------------
// fakeAuth
// ---------------------------------------------------------------------------

/**
 * Returns an {@link AuthProvider} that always resolves to the given material,
 * regardless of the requested provider name.
 *
 * @param material - Credential material to return for every `credentials()` call.
 *
 * @example
 * ```ts
 * const auth = fakeAuth({ apiKey: 'test-key' })
 * await auth.credentials('google')  // → { apiKey: 'test-key' }
 * ```
 */
export function fakeAuth(material: AuthMaterial): AuthProvider {
  return {
    async credentials(_provider: string): Promise<AuthMaterial> {
      return material
    },
  }
}
