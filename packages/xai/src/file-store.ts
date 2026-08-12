/**
 * XaiFileStore — thin wrapper over the xAI Files REST API.
 *
 * Upload / get / list / delete / content over injectable `fetch`.
 * No READY-state polling (upload returns metadata immediately).
 * No ambient credential reads — auth is injected at construction.
 *
 * @module
 */

import type { AuthMaterial, JsonValue, Logger } from '@gullabs/core'
import { LlmError, classifyError, redactSecrets } from '@gullabs/core'

import { requireApiKey } from './client.js'
import { classifyXaiError } from './adapter.js'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** xAI minimum `expires_after` (1 hour), inclusive. */
export const XAI_FILE_TTL_MIN_SECONDS = 3_600

/** xAI maximum `expires_after` (30 days), inclusive. */
export const XAI_FILE_TTL_MAX_SECONDS = 2_592_000

/**
 * Conservative max upload size (48 MiB). Managing-files docs say ~48 MB;
 * upload REST says 50 MB — we take the lower bound.
 */
export const XAI_FILE_MAX_BYTES = 48 * 1024 * 1024

/** Default Files API base (includes `/v1`). */
export const XAI_FILES_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A handle to a file stored in the xAI Files API. */
export interface XaiFileHandle {
  /** File id, e.g. `"file_a128090d-…"`. Use as `FileRefPart.fileId`. */
  id: string
  filename?: string
  bytes?: number
  purpose?: string
  createdAt?: Date
  /** Present when the file has a TTL; key omitted when permanent / unknown. */
  expiresAt?: Date
  /** Full vendor JSON object for forward-compat (P2 raw lane). */
  raw?: { [k: string]: JsonValue }
}

export interface XaiFileUploadInput {
  data: Uint8Array | Blob
  filename: string
  mimeType?: string
  /**
   * TTL in seconds. Must be an integer in
   * `[XAI_FILE_TTL_MIN_SECONDS, XAI_FILE_TTL_MAX_SECONDS]` when set.
   * Omit only for permanent storage (discouraged for ephemeral corpus).
   */
  expiresAfterSeconds?: number
  /** Default `"assistants"` (OpenAI SDK convention; xAI does not enforce). */
  purpose?: string
}

export interface XaiFileListOptions {
  /** 1..100. Server default is 100 when omitted. */
  limit?: number
  order?: 'asc' | 'desc'
  sortBy?: 'created_at' | 'filename' | 'size'
  paginationToken?: string
}

export interface XaiFileListResult {
  files: XaiFileHandle[]
  paginationToken?: string
}

export interface XaiFileStoreOptions {
  auth: AuthMaterial
  /** Default {@link XAI_FILES_DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** Injectable fetch for tests. Default: global `fetch`. */
  fetch?: typeof fetch
  /**
   * Delete failures that are NOT already-gone (404).
   * Default: `logger.error` or `console.error` with a redacted message.
   */
  onDeleteError?: (fileId: string, err: unknown) => void
  logger?: Logger
  /** Injectable clock for tests. Default: `Date.now`. */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type VendorFileObject = {
  id?: unknown
  filename?: unknown
  bytes?: unknown
  purpose?: unknown
  created_at?: unknown
  expires_at?: unknown
  object?: unknown
  [k: string]: unknown
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badRequest(message: string): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider: 'xai',
  })
}

function resolveFileId(fileIdOrHandle: string | Pick<XaiFileHandle, 'id'>): string {
  if (typeof fileIdOrHandle === 'string') {
    return fileIdOrHandle
  }
  return fileIdOrHandle.id
}

function unixSecondsToDate(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return new Date(value * 1000)
}

function makeHandle(raw: VendorFileObject): XaiFileHandle {
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new LlmError('File response missing required field (id)', {
      kind: 'server',
      retryable: false,
      provider: 'xai',
    })
  }

  const handle: XaiFileHandle = {
    id: raw.id,
    raw: raw as { [k: string]: JsonValue },
  }

  if (typeof raw.filename === 'string' && raw.filename.length > 0) {
    handle.filename = raw.filename
  }
  if (typeof raw.bytes === 'number' && Number.isFinite(raw.bytes)) {
    handle.bytes = raw.bytes
  }
  if (typeof raw.purpose === 'string') {
    handle.purpose = raw.purpose
  }

  const createdAt = unixSecondsToDate(raw.created_at)
  if (createdAt !== undefined) {
    handle.createdAt = createdAt
  }

  // expires_at is null for permanent files — omit the key entirely (Google parity).
  if (raw.expires_at !== null && raw.expires_at !== undefined) {
    const expiresAt = unixSecondsToDate(raw.expires_at)
    if (expiresAt !== undefined) {
      handle.expiresAt = expiresAt
    }
  }

  return handle
}

function byteLengthOf(data: Uint8Array | Blob): number {
  return data instanceof Uint8Array ? data.byteLength : data.size
}

function toBlob(data: Uint8Array | Blob, mimeType: string | undefined): Blob {
  if (data instanceof Blob) {
    return data
  }
  // Copy into a plain ArrayBuffer-backed view for BlobPart typing.
  const copy = Uint8Array.from(data)
  return mimeType !== undefined && mimeType.length > 0
    ? new Blob([copy], { type: mimeType })
    : new Blob([copy])
}

/**
 * Shape a non-2xx fetch response into a throw value that
 * {@link classifyXaiError} / {@link classifyError} understand:
 * - `.status` for HTTP routing
 * - `.error` for structured body (auth-body detection)
 */
/**
 * Error shaped for {@link classifyError} / {@link classifyXaiError}:
 * numeric `.status` for HTTP routing, `.error` for structured body text.
 */
class XaiFilesHttpError extends Error {
  readonly status: number
  readonly error: unknown

  constructor(status: number, message: string, errorBody: unknown) {
    super(message)
    this.name = 'XaiFilesHttpError'
    this.status = status
    this.error = errorBody
  }
}

async function throwHttpFailure(res: Response): Promise<never> {
  const status = res.status
  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch {
    bodyText = ''
  }

  let parsed: unknown = bodyText
  if (bodyText.length > 0) {
    try {
      parsed = JSON.parse(bodyText) as unknown
    } catch {
      parsed = bodyText
    }
  }

  let message = `xAI Files API HTTP ${status}`
  if (typeof parsed === 'string' && parsed.length > 0) {
    message = parsed
  } else if (isPlainRecord(parsed) && typeof parsed['error'] === 'string') {
    message = parsed['error']
  }

  throw new XaiFilesHttpError(status, message, parsed)
}

function isNotFoundError(err: unknown): boolean {
  if (err instanceof LlmError && err.httpStatus === 404) {
    return true
  }
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown }).status
    if (status === 404) return true
    const httpStatus = (err as { httpStatus?: unknown }).httpStatus
    if (httpStatus === 404) return true
  }
  return false
}

function notFoundError(fileId: string, operation: string): LlmError {
  return new LlmError(`xAI file not found during ${operation}: "${fileId}"`, {
    kind: 'bad_request',
    retryable: false,
    httpStatus: 404,
    provider: 'xai',
  })
}

function maybeZdrHint(message: string): string {
  if (
    /zero\s*data\s*retention|\bzdr\b|files?\s+(api\s+)?(disabled|unavailable|not supported)/i.test(
      message,
    )
  ) {
    return `${message} (xAI Zero Data Retention blocks new file uploads and file_id attachments for this team.)`
  }
  return message
}

/** Prefer structured body text / explicit message over generic `HTTP NNN`. */
function extractThrownMessage(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj['message'] === 'string' && obj['message'].length > 0) {
    return obj['message']
  }
  const err = obj['error']
  if (typeof err === 'string' && err.length > 0) return err
  if (typeof err === 'object' && err !== null) {
    const nested = err as Record<string, unknown>
    if (typeof nested['error'] === 'string' && nested['error'].length > 0) {
      return nested['error']
    }
    if (typeof nested['message'] === 'string' && nested['message'].length > 0) {
      return nested['message']
    }
  }
  return undefined
}

function classifyStoreError(raw: unknown): LlmError {
  if (raw instanceof LlmError) {
    return raw
  }
  const classified = classifyXaiError(raw)
  const bodyMessage = extractThrownMessage(raw)
  // classifyError maps plain `{ status }` throws to generic "HTTP NNN" — prefer
  // the structured body text we attached in throwHttpFailure when present.
  const baseMessage =
    bodyMessage !== undefined &&
    (classified.message.startsWith('HTTP ') || classified.message.length === 0)
      ? bodyMessage
      : classified.message
  const hinted = maybeZdrHint(baseMessage)
  if (
    hinted === classified.message &&
    classified.provider === 'xai' &&
    bodyMessage === undefined
  ) {
    return classified
  }
  return new LlmError(hinted, {
    kind: classified.kind,
    retryable: classified.retryable,
    ...(classified.httpStatus !== undefined ? { httpStatus: classified.httpStatus } : {}),
    ...(classified.retryAfterMs !== undefined
      ? { retryAfterMs: classified.retryAfterMs }
      : {}),
    provider: 'xai',
    cause: classified.cause ?? raw,
  })
}

// ---------------------------------------------------------------------------
// XaiFileStore
// ---------------------------------------------------------------------------

/**
 * **Auth snapshot note:** captures `AuthMaterial` at construction and holds
 * the resolved API key for the store lifetime. Correct for static API keys.
 * Refreshable credentials would need a resolver callback (see GoogleFileStore
 * / ADR-020).
 */
export class XaiFileStore {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly onDeleteError: (fileId: string, err: unknown) => void
  private readonly logger: Logger | undefined

  constructor(opts: XaiFileStoreOptions) {
    this.apiKey = requireApiKey(opts.auth)
    this.baseUrl = (opts.baseUrl ?? XAI_FILES_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    this.logger = opts.logger
    this.onDeleteError =
      opts.onDeleteError ??
      ((fileId, err) => {
        const message = redactSecrets(classifyError(err).message)
        if (this.logger !== undefined) {
          this.logger.error({ fileId, error: message }, 'xai.file.delete.failed')
        } else {
          console.error(`[XaiFileStore] delete failed for "${fileId}":`, message)
        }
      })
  }

  private authHeaders(): Headers {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${this.apiKey}`)
    return headers
  }

  private filesUrl(path = ''): string {
    if (path.length === 0) return `${this.baseUrl}/files`
    return `${this.baseUrl}/files/${path.replace(/^\//, '')}`
  }

  /** Build RequestInit without writing `signal: undefined` (exactOptionalPropertyTypes). */
  private requestInit(
    method: string,
    opts?: { body?: FormData; signal?: AbortSignal },
  ): RequestInit {
    const init: RequestInit = {
      method,
      headers: this.authHeaders(),
    }
    if (opts?.body !== undefined) {
      init.body = opts.body
    }
    if (opts?.signal !== undefined) {
      init.signal = opts.signal
    }
    return init
  }

  /**
   * Upload bytes to xAI Files. Returns immediately with metadata (no poll).
   *
   * Multipart field order is load-bearing: `expires_after` then `purpose`
   * then `file` — reversing order yields HTTP 400 from xAI.
   */
  async upload(input: XaiFileUploadInput, signal?: AbortSignal): Promise<XaiFileHandle> {
    if (typeof input.filename !== 'string' || input.filename.trim() === '') {
      throw badRequest('XaiFileUploadInput.filename must be a non-empty string.')
    }

    const size = byteLengthOf(input.data)
    if (size > XAI_FILE_MAX_BYTES) {
      throw badRequest(
        `xAI file uploads must be at most ${XAI_FILE_MAX_BYTES} bytes (48 MiB); got ${size}.`,
      )
    }

    if (input.expiresAfterSeconds !== undefined) {
      const ttl = input.expiresAfterSeconds
      if (
        typeof ttl !== 'number' ||
        !Number.isInteger(ttl) ||
        ttl < XAI_FILE_TTL_MIN_SECONDS ||
        ttl > XAI_FILE_TTL_MAX_SECONDS
      ) {
        throw badRequest(
          `expiresAfterSeconds must be an integer in [${XAI_FILE_TTL_MIN_SECONDS}, ${XAI_FILE_TTL_MAX_SECONDS}]; got ${String(ttl)}.`,
        )
      }
    }

    const purpose = input.purpose ?? 'assistants'
    const form = new FormData()

    // Order: expires_after → purpose → file (xAI multipart requirement).
    if (input.expiresAfterSeconds !== undefined) {
      form.append('expires_after', String(input.expiresAfterSeconds))
    }
    form.append('purpose', purpose)
    form.append('file', toBlob(input.data, input.mimeType), input.filename)

    let res: Response
    try {
      res = await this.fetchImpl(
        this.filesUrl(),
        this.requestInit('POST', {
          body: form,
          ...(signal !== undefined ? { signal } : {}),
        }),
      )
    } catch (e) {
      if (signal?.aborted === true) {
        throw new LlmError('xAI file upload aborted', {
          kind: 'aborted',
          retryable: false,
          provider: 'xai',
        })
      }
      throw classifyStoreError(e)
    }

    if (!res.ok) {
      try {
        await throwHttpFailure(res)
      } catch (e) {
        throw classifyStoreError(e)
      }
    }

    let json: unknown
    try {
      json = await res.json()
    } catch (e) {
      throw new LlmError('xAI file upload returned non-JSON body', {
        kind: 'server',
        retryable: false,
        provider: 'xai',
        cause: e,
      })
    }

    return makeHandle(json as VendorFileObject)
  }

  async get(fileId: string, signal?: AbortSignal): Promise<XaiFileHandle> {
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }

    let res: Response
    try {
      res = await this.fetchImpl(
        this.filesUrl(fileId),
        this.requestInit('GET', signal !== undefined ? { signal } : {}),
      )
    } catch (e) {
      if (signal?.aborted === true) {
        throw new LlmError('xAI file get aborted', {
          kind: 'aborted',
          retryable: false,
          provider: 'xai',
        })
      }
      throw classifyStoreError(e)
    }

    if (res.status === 404) {
      throw notFoundError(fileId, 'get')
    }

    if (!res.ok) {
      try {
        await throwHttpFailure(res)
      } catch (e) {
        throw classifyStoreError(e)
      }
    }

    const json = (await res.json()) as VendorFileObject
    return makeHandle(json)
  }

  async list(
    opts: XaiFileListOptions = {},
    signal?: AbortSignal,
  ): Promise<XaiFileListResult> {
    if (opts.limit !== undefined) {
      if (
        typeof opts.limit !== 'number' ||
        !Number.isInteger(opts.limit) ||
        opts.limit < 1 ||
        opts.limit > 100
      ) {
        throw badRequest('list.limit must be an integer in [1, 100].')
      }
    }

    const params = new URLSearchParams()
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.order !== undefined) params.set('order', opts.order)
    if (opts.sortBy !== undefined) params.set('sort_by', opts.sortBy)
    if (opts.paginationToken !== undefined) {
      params.set('pagination_token', opts.paginationToken)
    }

    const qs = params.toString()
    const url = qs.length > 0 ? `${this.filesUrl()}?${qs}` : this.filesUrl()

    let res: Response
    try {
      res = await this.fetchImpl(
        url,
        this.requestInit('GET', signal !== undefined ? { signal } : {}),
      )
    } catch (e) {
      if (signal?.aborted === true) {
        throw new LlmError('xAI file list aborted', {
          kind: 'aborted',
          retryable: false,
          provider: 'xai',
        })
      }
      throw classifyStoreError(e)
    }

    if (!res.ok) {
      try {
        await throwHttpFailure(res)
      } catch (e) {
        throw classifyStoreError(e)
      }
    }

    const json = (await res.json()) as {
      data?: VendorFileObject[]
      pagination_token?: string
    }
    const files = Array.isArray(json.data) ? json.data.map((f) => makeHandle(f)) : []
    const result: XaiFileListResult = { files }
    if (typeof json.pagination_token === 'string' && json.pagination_token.length > 0) {
      result.paginationToken = json.pagination_token
    }
    return result
  }

  /**
   * Delete a file. Idempotent: HTTP 404 → success.
   * Other errors are forwarded to `onDeleteError` and **not** rethrown (P5).
   */
  async delete(
    fileIdOrHandle: string | Pick<XaiFileHandle, 'id'>,
    signal?: AbortSignal,
  ): Promise<void> {
    const fileId = resolveFileId(fileIdOrHandle)
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      // Fail-open still applies — surface via callback rather than throw.
      this.onDeleteError(String(fileId), badRequest('fileId must be a non-empty string.'))
      return
    }

    try {
      let res: Response
      try {
        res = await this.fetchImpl(
          this.filesUrl(fileId),
          this.requestInit('DELETE', signal !== undefined ? { signal } : {}),
        )
      } catch (e) {
        if (signal?.aborted === true) {
          // Aborts are caller intent; still fail-open on delete side-effects.
          this.onDeleteError(
            fileId,
            new LlmError('xAI file delete aborted', {
              kind: 'aborted',
              retryable: false,
              provider: 'xai',
            }),
          )
          return
        }
        throw e
      }

      if (res.status === 404) {
        return
      }

      if (!res.ok) {
        await throwHttpFailure(res)
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        return
      }
      this.onDeleteError(fileId, classifyStoreError(err))
    }
  }

  /**
   * Delete many files. Each failure is individually fail-open; none are thrown.
   */
  async deleteAll(
    ids: ReadonlyArray<string | Pick<XaiFileHandle, 'id'>>,
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.allSettled(ids.map((id) => this.delete(id, signal)))
  }

  /** Download raw file bytes. */
  async getContent(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }

    let res: Response
    try {
      res = await this.fetchImpl(
        this.filesUrl(`${fileId}/content`),
        this.requestInit('GET', signal !== undefined ? { signal } : {}),
      )
    } catch (e) {
      if (signal?.aborted === true) {
        throw new LlmError('xAI file content download aborted', {
          kind: 'aborted',
          retryable: false,
          provider: 'xai',
        })
      }
      throw classifyStoreError(e)
    }

    if (res.status === 404) {
      throw notFoundError(fileId, 'getContent')
    }

    if (!res.ok) {
      try {
        await throwHttpFailure(res)
      } catch (e) {
        throw classifyStoreError(e)
      }
    }

    const buf = await res.arrayBuffer()
    return new Uint8Array(buf)
  }
}
