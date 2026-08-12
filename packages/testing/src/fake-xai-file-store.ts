/* eslint-disable @typescript-eslint/require-await -- Promise-shaped API; body is sync in-memory */
/**
 * FakeXaiFileStore — in-memory stand-in for `@gullabs/xai` `XaiFileStore`.
 *
 * Structural (no import of `@gullabs/xai`): hosts inject this where production
 * code takes a store-shaped object. Supports upload/get/list/delete/getContent
 * with optional TTL expiry via an injectable clock, and fail-closed delete.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Public types (mirror @gullabs/xai FileDeleteOptions / handle shapes)
// ---------------------------------------------------------------------------

export interface FakeXaiFileHandle {
  id: string
  filename?: string
  bytes?: number
  purpose?: string
  createdAt?: Date
  expiresAt?: Date
}

export interface FakeXaiFileUploadInput {
  data: Uint8Array | Blob
  filename: string
  mimeType?: string
  expiresAfterSeconds?: number
  purpose?: string
}

export interface FakeXaiFileDeleteOptions {
  signal?: AbortSignal
  failClosed?: boolean
}

export interface FakeXaiFileStoreOptions {
  /** Injectable clock (ms). Default: `Date.now`. */
  now?: () => number
  /**
   * When true, {@link FakeXaiFileStore.delete} throws on missing id
   * (simulates non-404 provider failure). Default: missing id is 404-success.
   */
  deleteMissingAsError?: boolean
  onDeleteError?: (fileId: string, err: unknown) => void
}

type Stored = {
  handle: FakeXaiFileHandle
  bytes: Uint8Array
  expiresAtMs?: number
}

const TTL_MIN = 3_600
const TTL_MAX = 2_592_000

function badRequest(message: string): LlmError {
  return new LlmError(message, { kind: 'bad_request', retryable: false, provider: 'xai' })
}

function notFound(fileId: string): LlmError {
  return new LlmError(`xAI file not found: "${fileId}"`, {
    kind: 'bad_request',
    retryable: false,
    httpStatus: 404,
    provider: 'xai',
  })
}

async function toBytes(data: Uint8Array | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  const buf = await data.arrayBuffer()
  return new Uint8Array(buf)
}

// ---------------------------------------------------------------------------
// FakeXaiFileStore
// ---------------------------------------------------------------------------

export class FakeXaiFileStore {
  private readonly files = new Map<string, Stored>()
  private readonly now: () => number
  private readonly deleteMissingAsError: boolean
  private readonly onDeleteError: (fileId: string, err: unknown) => void
  private seq = 0

  constructor(opts: FakeXaiFileStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.deleteMissingAsError = opts.deleteMissingAsError === true
    this.onDeleteError =
      opts.onDeleteError ??
      ((_id, err) => {
        // default: swallow (fail-open)
        void err
      })
  }

  /** Test helper: how many files are currently stored (not expired). */
  get size(): number {
    this.purgeExpired()
    return this.files.size
  }

  async upload(
    input: FakeXaiFileUploadInput,
    _signal?: AbortSignal,
  ): Promise<FakeXaiFileHandle> {
    if (typeof input.filename !== 'string' || input.filename.trim() === '') {
      throw badRequest('filename must be a non-empty string.')
    }
    if (input.expiresAfterSeconds !== undefined) {
      const ttl = input.expiresAfterSeconds
      if (
        typeof ttl !== 'number' ||
        !Number.isInteger(ttl) ||
        ttl < TTL_MIN ||
        ttl > TTL_MAX
      ) {
        throw badRequest(
          `expiresAfterSeconds must be an integer in [${TTL_MIN}, ${TTL_MAX}].`,
        )
      }
    }

    const bytes = await toBytes(input.data)
    this.seq += 1
    const id = `file_fake_${this.seq}`
    const createdMs = this.now()
    const handle: FakeXaiFileHandle = {
      id,
      filename: input.filename,
      bytes: bytes.byteLength,
      purpose: input.purpose ?? 'assistants',
      createdAt: new Date(createdMs),
    }
    const stored: Stored = { handle: { ...handle }, bytes }
    if (input.expiresAfterSeconds !== undefined) {
      const expiresAtMs = createdMs + input.expiresAfterSeconds * 1000
      handle.expiresAt = new Date(expiresAtMs)
      stored.handle = { ...handle }
      stored.expiresAtMs = expiresAtMs
    }

    this.files.set(id, stored)
    return { ...handle }
  }

  async get(fileId: string, _signal?: AbortSignal): Promise<FakeXaiFileHandle> {
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }
    this.purgeExpired()
    const stored = this.files.get(fileId)
    if (stored === undefined) {
      throw notFound(fileId)
    }
    return { ...stored.handle }
  }

  async list(
    opts?: { limit?: number },
    _signal?: AbortSignal,
  ): Promise<{ files: FakeXaiFileHandle[] }> {
    this.purgeExpired()
    let files = [...this.files.values()].map((s) => ({ ...s.handle }))
    if (opts?.limit !== undefined) {
      files = files.slice(0, opts.limit)
    }
    return { files }
  }

  async delete(
    fileIdOrHandle: string | Pick<FakeXaiFileHandle, 'id'>,
    opts?: FakeXaiFileDeleteOptions,
  ): Promise<void> {
    const fileId = typeof fileIdOrHandle === 'string' ? fileIdOrHandle : fileIdOrHandle.id
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }

    const failClosed = opts?.failClosed === true
    this.purgeExpired()

    if (!this.files.has(fileId)) {
      if (this.deleteMissingAsError) {
        const err = new LlmError('simulated delete failure', {
          kind: 'server',
          retryable: true,
          provider: 'xai',
        })
        if (failClosed) throw err
        this.onDeleteError(fileId, err)
        return
      }
      // 404 success
      return
    }

    this.files.delete(fileId)
  }

  async deleteAll(
    ids: ReadonlyArray<string | Pick<FakeXaiFileHandle, 'id'>>,
    opts?: FakeXaiFileDeleteOptions,
  ): Promise<void> {
    if (opts?.failClosed === true) {
      await Promise.all(ids.map((id) => this.delete(id, opts)))
      return
    }
    await Promise.allSettled(ids.map((id) => this.delete(id, opts)))
  }

  async getContent(fileId: string, _signal?: AbortSignal): Promise<Uint8Array> {
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }
    this.purgeExpired()
    const stored = this.files.get(fileId)
    if (stored === undefined) {
      throw notFound(fileId)
    }
    return stored.bytes.slice()
  }

  private purgeExpired(): void {
    const t = this.now()
    for (const [id, stored] of this.files) {
      if (stored.expiresAtMs !== undefined && stored.expiresAtMs <= t) {
        this.files.delete(id)
      }
    }
  }
}
