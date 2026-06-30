/**
 * GoogleFileStore — thin wrapper over the Gemini File API.
 *
 * Handles upload + polling until ACTIVE, and tracked deletion.
 * Injectable sleep and client for tests (no network required).
 *
 * @module
 */

import type { AuthMaterial } from '@gullabs/core'
import { LlmError, classifyError, redactSecrets } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A handle to a file stored in the Gemini File API. */
export interface GoogleFileHandle {
  /** Resource name, e.g. "files/abc123". */
  name: string
  /** URI to pass as FileUriPart.uri in an LlmRequest. */
  uri: string
  mimeType: string
  /** Provider auto-deletes ~48 h after upload. Absent when not returned. */
  expiresAt?: Date
}

/**
 * Minimal structural interface for the Gemini Files client surface we use.
 * Satisfied by the real ai.files object or a test fake.
 */
export interface GeminiFilesClientLike {
  upload(params: {
    file: Uint8Array | Blob
    config?: { mimeType?: string; displayName?: string }
  }): Promise<{
    name?: string
    uri?: string
    mimeType?: string
    state?: string
    expirationTime?: string
  }>
  get(params: { name: string }): Promise<{
    name?: string
    uri?: string
    mimeType?: string
    state?: string
    expirationTime?: string
  }>
  delete(params: { name: string }): Promise<void>
}

export interface GoogleFileStoreOptions {
  auth: AuthMaterial
  /** Injectable client for tests; skips SDK import when provided. */
  client?: GeminiFilesClientLike
  /** Called on delete failures instead of rethrowing. Default: console.error. */
  onDeleteError?: (name: string, err: unknown) => void
  poll?: {
    /** Delay between state polls. Default: 3000 ms. */
    intervalMs?: number
    /** Max time to wait for ACTIVE. Default: 300 000 ms (5 min). */
    timeoutMs?: number
  }
  /** Injectable sleep for tests. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock for deterministic tests. Default: `Date.now`. */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 300_000

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function buildFilesClient(auth: AuthMaterial): Promise<GeminiFilesClientLike> {
  const { GoogleGenAI } = await import('@google/genai')

  const ai = new GoogleGenAI({ apiKey: auth.apiKey })

  return {
    async upload(params) {
      // Real SDK accepts string | Blob; convert Uint8Array → Blob.
      const fileArg: Blob =
        params.file instanceof Uint8Array
          ? new Blob(
              [params.file],
              params.config?.mimeType !== undefined && params.config.mimeType.length > 0
                ? { type: params.config.mimeType }
                : {},
            )
          : params.file

      const result = await (
        ai.files.upload as (p: unknown) => Promise<{
          name?: string
          uri?: string
          mimeType?: string
          state?: string
          expirationTime?: string
        }>
      )({
        file: fileArg,
        ...(params.config !== undefined ? { config: params.config } : {}),
      })
      return result
    },

    async get(params) {
      const result = await (
        ai.files.get as (p: unknown) => Promise<{
          name?: string
          uri?: string
          mimeType?: string
          state?: string
          expirationTime?: string
        }>
      )(params)
      return result
    },

    async delete(params) {
      await (ai.files.delete as (p: unknown) => Promise<unknown>)(params)
    },
  }
}

type FileResp = {
  name?: string
  uri?: string
  mimeType?: string
  state?: string
  expirationTime?: string
}

function makeHandle(
  resp: FileResp,
  fallback: { name: string; uri: string; mimeType: string },
): GoogleFileHandle {
  const et = resp.expirationTime
  return {
    name: resp.name ?? fallback.name,
    uri: resp.uri ?? fallback.uri,
    mimeType: resp.mimeType ?? fallback.mimeType,
    ...(et !== undefined && et.length > 0 ? { expiresAt: new Date(et) } : {}),
  }
}

// ---------------------------------------------------------------------------
// GoogleFileStore
// ---------------------------------------------------------------------------

/**
 * **Auth snapshot note:** this store captures the `AuthMaterial` at construction
 * time and memoizes a single SDK client from it (`clientPromise`).  This is
 * correct and sufficient for static API keys.  If refreshable credentials
 * (short-lived OAuth/STS tokens) are added in the future, this memoization is
 * the seam that will need rework: the cached client would hold stale credentials
 * for the lifetime of a long-lived store instance.  At that point, the store
 * will need to either rebuild the client on each operation or accept a
 * credential-resolver callback rather than a plain `AuthMaterial` value.
 * See ADR-020 in DECISIONS.md.
 */
export class GoogleFileStore {
  private readonly auth: AuthMaterial
  private readonly clientOverride: GeminiFilesClientLike | undefined
  private readonly onDeleteError: (name: string, err: unknown) => void
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  /** Memoised client promise — built at most once per store instance. */
  private clientPromise: Promise<GeminiFilesClientLike> | undefined

  constructor(opts: GoogleFileStoreOptions) {
    this.auth = opts.auth
    this.clientOverride = opts.client
    this.onDeleteError =
      opts.onDeleteError ??
      ((name, err) => {
        console.error(
          `[GoogleFileStore] delete failed for "${name}":`,
          redactSecrets(classifyError(err).message),
        )
      })
    this.intervalMs = opts.poll?.intervalMs ?? DEFAULT_INTERVAL_MS
    this.timeoutMs = opts.poll?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.sleep = opts.sleep ?? realSleep
    this.now = opts.now ?? (() => Date.now())
  }

  private getClient(): Promise<GeminiFilesClientLike> {
    if (this.clientOverride !== undefined) return Promise.resolve(this.clientOverride)
    if (this.clientPromise === undefined) {
      this.clientPromise = buildFilesClient(this.auth)
    }
    return this.clientPromise
  }

  /**
   * Upload bytes to the Gemini File API and wait until the file is ACTIVE.
   *
   * @param source  - Raw bytes or Blob.
   * @param mimeType - IANA media type, e.g. `"image/png"`.
   * @param opts    - Optional display name.
   */
  async upload(
    source: Uint8Array | Blob,
    mimeType: string,
    opts?: { displayName?: string; signal?: AbortSignal },
  ): Promise<GoogleFileHandle> {
    const signal = opts?.signal
    const client = await this.getClient()

    let uploadResp: {
      name?: string
      uri?: string
      mimeType?: string
      state?: string
      expirationTime?: string
    }
    try {
      uploadResp = await client.upload({
        file: source,
        config: {
          mimeType,
          ...(opts?.displayName !== undefined ? { displayName: opts.displayName } : {}),
        },
      })
    } catch (e) {
      throw classifyError(e)
    }

    const { name, uri } = uploadResp

    if (
      name === undefined ||
      name.length === 0 ||
      uri === undefined ||
      uri.length === 0
    ) {
      throw new LlmError('File upload response missing required fields (name or uri)', {
        kind: 'bad_request',
        retryable: false,
      })
    }

    const fallback = { name, uri, mimeType }

    if (uploadResp.state === 'ACTIVE') {
      return makeHandle(uploadResp, fallback)
    }

    if (uploadResp.state === 'FAILED') {
      throw new LlmError('File processing failed immediately after upload', {
        kind: 'bad_request',
        retryable: false,
      })
    }

    // PROCESSING (or unknown) — poll until ACTIVE or timeout.
    const deadline = this.now() + this.timeoutMs

    // Pre-flight: if the signal is already aborted, throw before creating any
    // promise so we never produce an unhandled rejection.
    if (signal?.aborted === true) {
      throw new LlmError('File upload polling aborted', {
        kind: 'aborted',
        retryable: false,
      })
    }

    // Build an abort-race promise so future aborts wake up the sleep race
    // immediately rather than waiting the full interval.  Created only when
    // the signal is NOT already aborted (guard above handles that case).
    const abortRacePromise: Promise<never> | undefined =
      signal !== undefined
        ? new Promise<never>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(
                  new LlmError('File upload polling aborted', {
                    kind: 'aborted',
                    retryable: false,
                  }),
                )
              },
              { once: true },
            )
          })
        : undefined

    for (;;) {
      if (this.now() >= deadline) {
        throw new LlmError('Timed out waiting for uploaded file to become ACTIVE', {
          kind: 'timeout',
          retryable: true,
        })
      }

      // Sleep — race against the abort promise so we wake up immediately
      // when the signal fires rather than waiting the full interval.
      const sleepCall = this.sleep(this.intervalMs)
      await (abortRacePromise !== undefined
        ? Promise.race([sleepCall, abortRacePromise])
        : sleepCall)

      let pollResp: {
        name?: string
        uri?: string
        mimeType?: string
        state?: string
        expirationTime?: string
      }
      try {
        pollResp = await client.get({ name })
      } catch (e) {
        throw classifyError(e)
      }

      // Also guard here: the signal may have fired during client.get()
      // before we looped back to the sleep race.
      // Cast needed: TS 5.6 persists readonly-property narrowing across awaits,
      // making it think `aborted` is still `false | undefined` after the preflight.
      if ((signal?.aborted as boolean | undefined) === true) {
        throw new LlmError('File upload polling aborted', {
          kind: 'aborted',
          retryable: false,
        })
      }

      if (pollResp.state === 'ACTIVE') {
        return makeHandle(pollResp, fallback)
      }

      if (pollResp.state === 'FAILED') {
        throw new LlmError('File processing failed during polling', {
          kind: 'bad_request',
          retryable: false,
        })
      }
      // PROCESSING — continue loop
    }
  }

  /**
   * Delete a single uploaded file.
   * Errors are forwarded to `onDeleteError` and NOT rethrown.
   */
  async delete(handle: GoogleFileHandle): Promise<void> {
    try {
      const client = await this.getClient()
      await client.delete({ name: handle.name })
    } catch (err) {
      this.onDeleteError(handle.name, err)
    }
  }

  /**
   * Delete multiple files.
   * Each failure is individually forwarded to `onDeleteError`; none are thrown.
   */
  async deleteAll(handles: GoogleFileHandle[]): Promise<void> {
    await Promise.allSettled(handles.map((h) => this.delete(h)))
  }
}
