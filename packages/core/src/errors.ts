/**
 * Typed errors for @anyllm/core.
 *
 * Every throw from the engine is an {@link LlmError}.  Adapters classify raw
 * SDK errors into an LlmError; the engine surfaces them to callers.  Side-effect
 * failures (sink, telemetry) are logged but never rethrown.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Error kind
// ---------------------------------------------------------------------------

/**
 * Discriminant for every failure mode the library can surface.
 *
 * - `'invalid_auth'`    — 401/403; credentials wrong or missing.
 * - `'rate_limited'`    — 429; back-off and retry.
 * - `'server'`          — 5xx; transient provider error, retry.
 * - `'timeout'`         — request exceeded `timeoutMs` or network timeout.
 * - `'aborted'`         — caller cancelled via `AbortSignal`.
 * - `'bad_request'`     — 400/422; the request itself is malformed.
 * - `'content_filter'`  — provider refused output for safety reasons.
 * - `'parse_error'`     — Zod validation failed on structured output; terminal.
 * - `'unknown'`         — uncategorised; inspect `cause` for details.
 */
export type LlmErrorKind =
  | 'invalid_auth'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'bad_request'
  | 'content_filter'
  | 'parse_error'
  | 'unknown'

// ---------------------------------------------------------------------------
// LlmError
// ---------------------------------------------------------------------------

/**
 * Options accepted by the {@link LlmError} constructor.
 */
export interface LlmErrorOptions {
  /** Error category — drives retry logic and record `status`. */
  kind: LlmErrorKind
  /** Whether the caller may safely retry this error. */
  retryable: boolean
  /** HTTP status code, when the error originated from an HTTP response. */
  httpStatus?: number
  /**
   * How long (in ms) the caller should wait before retrying.
   * Derived from the provider's `Retry-After` header when available.
   */
  retryAfterMs?: number
  /** Adapter / provider identifier (e.g. `"google"`). */
  provider?: string
  /** The underlying error that caused this one. */
  cause?: unknown
}

/**
 * The single error class thrown by the engine and adapters.
 *
 * All rejections from `generate()` / `runStructured()` are `LlmError`.
 * Callers can narrow by `kind` to decide whether to retry, surface to the
 * user, or log.
 *
 * @example
 * ```ts
 * try {
 *   const result = await generate(request)
 * } catch (e) {
 *   if (e instanceof LlmError && e.retryable) scheduleRetry(e.retryAfterMs)
 *   else throw e
 * }
 * ```
 */
export class LlmError extends Error {
  /** Error category. */
  readonly kind: LlmErrorKind
  /** Whether the caller may safely retry. */
  readonly retryable: boolean
  /** HTTP status code, if applicable. */
  readonly httpStatus?: number
  /** Suggested retry delay in milliseconds. */
  readonly retryAfterMs?: number
  /** Provider identifier, if known. */
  readonly provider?: string
  /**
   * Underlying cause.
   * Overrides the standard `Error.cause` to accept `unknown` (not just `Error`).
   */
  override readonly cause?: unknown

  constructor(message: string, options: LlmErrorOptions) {
    super(message)
    this.name = 'LlmError'
    this.kind = options.kind
    this.retryable = options.retryable
    // With exactOptionalPropertyTypes we must not assign `undefined` to optional
    // properties — only conditionally include them.
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs
    }
    if (options.provider !== undefined) {
      this.provider = options.provider
    }
    if (options.cause !== undefined) {
      this.cause = options.cause
    }

    // Maintain a proper prototype chain in transpiled ES5 environments.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// HTTP status classifier
// ---------------------------------------------------------------------------

/**
 * The result of classifying an HTTP status code.
 */
export interface HttpClassification {
  /** The error kind that corresponds to this HTTP status. */
  kind: LlmErrorKind
  /** Whether the caller may retry after receiving this status. */
  retryable: boolean
  /**
   * Suggested retry delay in milliseconds.
   * Present only for `429` responses when `retryAfterMs` was passed in.
   */
  retryAfterMs?: number
}

/**
 * Maps an HTTP response status code to a typed error classification.
 *
 * | Status      | Kind            | Retryable |
 * |-------------|-----------------|-----------|
 * | 401, 403    | `invalid_auth`  | No        |
 * | 408         | `timeout`       | Yes       |
 * | 429         | `rate_limited`  | Yes       |
 * | 400, 422    | `bad_request`   | No        |
 * | 5xx         | `server`        | Yes       |
 * | other       | `unknown`       | No        |
 *
 * @param status - The HTTP response status code.
 * @param retryAfterMs - When available (from a `Retry-After` header parsed by
 *   the adapter), this value is forwarded in the returned classification for
 *   `429` responses.
 */
export function classifyHttpStatus(
  status: number,
  retryAfterMs?: number,
): HttpClassification {
  if (status === 401 || status === 403) {
    return { kind: 'invalid_auth', retryable: false }
  }
  if (status === 408) {
    return { kind: 'timeout', retryable: true }
  }
  if (status === 429) {
    if (retryAfterMs !== undefined) {
      return { kind: 'rate_limited', retryable: true, retryAfterMs }
    }
    return { kind: 'rate_limited', retryable: true }
  }
  if (status === 400 || status === 422) {
    return { kind: 'bad_request', retryable: false }
  }
  if (status >= 500) {
    return { kind: 'server', retryable: true }
  }
  return { kind: 'unknown', retryable: false }
}

// ---------------------------------------------------------------------------
// Generic error classifier
// ---------------------------------------------------------------------------

/**
 * Classifies an arbitrary thrown value into a typed {@link LlmError}.
 *
 * Detection order:
 * 1. Already an `LlmError` → returned as-is.
 * 2. `Error.name === 'AbortError'` → `'aborted'` (not retryable).
 * 3. `Error.name === 'TimeoutError'` or message contains `'timeout'` /
 *    `'timed out'` (case-insensitive) → `'timeout'` (retryable).
 * 4. Anything else → `'unknown'` (not retryable).
 *
 * The original error is always attached as `cause`.
 *
 * @param e - Any thrown value (the engine catches `unknown`).
 */
export function classifyError(e: unknown): LlmError {
  // Already classified — pass through unchanged.
  if (e instanceof LlmError) return e

  if (e instanceof Error) {
    // AbortSignal cancellation.
    if (e.name === 'AbortError') {
      return new LlmError(e.message || 'Request aborted', {
        kind: 'aborted',
        retryable: false,
        cause: e,
      })
    }

    // Timeout — named TimeoutError (Node.js fetch / AbortSignal.timeout) or
    // message heuristic for SDK-level timeout errors.
    if (
      e.name === 'TimeoutError' ||
      /timeout|timed?\s+out/i.test(e.message)
    ) {
      return new LlmError(e.message || 'Request timed out', {
        kind: 'timeout',
        retryable: true,
        cause: e,
      })
    }

    // Fallthrough — unknown error.
    return new LlmError(e.message || 'Unknown error', {
      kind: 'unknown',
      retryable: false,
      cause: e,
    })
  }

  // Non-Error thrown value (string, plain object, etc.).
  const message = typeof e === 'string' ? e : 'Unknown error'
  return new LlmError(message, {
    kind: 'unknown',
    retryable: false,
    cause: e,
  })
}
