/**
 * First-party retry middleware for @gullabs/core.
 *
 * `retryMiddleware` wraps the call chain and re-invokes the next handler
 * (typically `runAttempt`) on retryable failures, with configurable
 * exponential back-off and full jitter.
 *
 * Each invocation of `next()` produces a FRESH `attemptId` and sinks exactly
 * one record — the retry is transparent to the engine's record-per-attempt
 * guarantee.
 *
 * @module
 */

import { LlmError, classifyError } from './errors.js'
import type { Middleware, Handler, EngineCtx } from './ports.js'
import type { ResolvedRequest } from './ports.js'
import type { LlmResult } from './types.js'

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link retryMiddleware}.
 */
export interface RetryPolicy {
  /**
   * Maximum number of total attempts (including the first).
   * With `maxAttempts: 3`, the first call + up to 2 retries will be tried.
   * @default 3
   */
  maxAttempts?: number
  /**
   * Base delay in milliseconds for exponential back-off.
   * Actual delay = `min(maxDelayMs, baseDelayMs * 2^(attempt-1)) * rand()`.
   * @default 500
   */
  baseDelayMs?: number
  /**
   * Hard cap on computed delay in milliseconds.
   * Also caps `retryAfterMs` values supplied by the provider.
   * @default 30_000
   */
  maxDelayMs?: number
  /**
   * Predicate that decides whether to retry a specific error.
   * Called with the `LlmError` and the 1-based attempt number that just failed.
   * @default `(err) => err.retryable === true`
   */
  shouldRetry?(err: LlmError, attempt: number): boolean
}

// ---------------------------------------------------------------------------
// Pure back-off computation (exported for deterministic unit tests)
// ---------------------------------------------------------------------------

/**
 * Computes the delay in milliseconds before the next retry attempt.
 *
 * Two modes:
 * - **retryAfterMs present**: honor the provider's hint, capped at `maxDelayMs`.
 * - **no retryAfterMs**: exponential back-off with FULL JITTER.
 *   `delay = rand() * min(maxDelayMs, baseDelayMs * 2^(attempt-1))`
 *   where `attempt` is the 1-based number of the attempt that just failed.
 *
 * @param attempt      - 1-based attempt number that just failed.
 * @param policy       - Resolved `baseDelayMs` and `maxDelayMs`.
 * @param retryAfterMs - Provider-supplied hint (ms). `undefined` → use exponential.
 * @param rand         - RNG in [0, 1). Inject `Math.random` in production;
 *                       a deterministic function in tests.
 * @returns Computed delay in milliseconds.
 */
export function computeBackoffMs(
  attempt: number,
  policy: Required<Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>>,
  retryAfterMs: number | undefined,
  rand: () => number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, policy.maxDelayMs)
  }
  // Exponential back-off ceiling, capped at maxDelayMs.
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, attempt - 1))
  // Full jitter: uniform in [0, ceiling).
  return ceiling * rand()
}

// ---------------------------------------------------------------------------
// Abortable sleep (internal)
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves after `ms` milliseconds, or rejects with an
 * `LlmError('aborted')` if `signal` fires first.
 *
 * Cleans up all listeners and timers on both resolution and rejection, so no
 * leaks occur even when `ms` is very large.
 */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new LlmError('Request aborted during retry delay', {
          kind: 'aborted',
          retryable: false,
          ...(signal.reason !== undefined ? { cause: signal.reason as unknown } : {}),
        }),
      )
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', abortHandler)
        abortHandler = undefined
      }
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    if (signal !== undefined) {
      abortHandler = (): void => {
        cleanup()
        reject(
          new LlmError('Request aborted during retry delay', {
            kind: 'aborted',
            retryable: false,
            ...(signal.reason !== undefined ? { cause: signal.reason as unknown } : {}),
          }),
        )
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates a {@link Middleware} that retries on retryable errors with
 * exponential back-off and full jitter.
 *
 * Retry semantics:
 * - Retries when `shouldRetry(err, attempt)` returns `true` (default:
 *   `err.retryable === true`) AND the total attempt count is below
 *   `maxAttempts`.
 * - **Never** retries when `err.kind === 'aborted'` — even if a custom
 *   `shouldRetry` policy would say yes.  Abort is terminal.
 * - The back-off delay is abortable by `ctx.signal`: if the caller aborts
 *   during a sleep, the promise rejects promptly with `LlmError('aborted')`.
 *
 * Each invocation of `next()` produces a separate `attemptId` in the sink
 * (because `runAttempt` generates a fresh ID on every call).
 *
 * @param policy - Override any subset of the default retry policy.
 * @param opts   - Injectable `sleep` and `random` for deterministic tests.
 *
 * @example
 * ```ts
 * const client = createClient({
 *   // ...
 *   middleware: [retryMiddleware({ maxAttempts: 3 })],
 * })
 * ```
 */
export function retryMiddleware(
  policy?: RetryPolicy,
  opts?: {
    /** Injected sleep function for testing (default: `abortableSleep`). */
    sleep?(ms: number, signal?: AbortSignal): Promise<void>
    /** Injected RNG for deterministic back-off tests (default: `Math.random`). */
    random?(): number
  },
): Middleware {
  const maxAttempts = policy?.maxAttempts ?? 3
  const baseDelayMs = policy?.baseDelayMs ?? 500
  const maxDelayMs = policy?.maxDelayMs ?? 30_000
  const shouldRetryFn =
    policy?.shouldRetry ?? ((err: LlmError): boolean => err.retryable === true)
  const sleepFn = opts?.sleep ?? abortableSleep
  const rand = opts?.random ?? ((): number => Math.random())

  return {
    id: 'retry',

    async intercept(
      req: ResolvedRequest,
      ctx: EngineCtx,
      next: Handler,
    ): Promise<LlmResult> {
      let attempt = 0

      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt++

        try {
          return await next(req, ctx)
        } catch (rawErr) {
          const err = classifyError(rawErr)

          // Abort is always terminal — never retry.
          if (err.kind === 'aborted') throw err

          // Out of attempts — propagate the last error.
          if (attempt >= maxAttempts) throw err

          // Policy veto — propagate without sleeping.
          if (!shouldRetryFn(err, attempt)) throw err

          // Compute and sleep the back-off delay.
          const delayMs = computeBackoffMs(
            attempt,
            { baseDelayMs, maxDelayMs },
            err.retryAfterMs,
            rand,
          )

          await sleepFn(delayMs, ctx.signal)
        }
      }
    },
  }
}
