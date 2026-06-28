/**
 * Unit tests for errors.ts — classifyHttpStatus and classifyError.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyHttpStatus,
  classifyError,
  LlmError,
} from './errors.js'
import type { LlmErrorKind } from './errors.js'

// ---------------------------------------------------------------------------
// classifyHttpStatus — table-driven
// ---------------------------------------------------------------------------

describe('classifyHttpStatus', () => {
  interface Row {
    status: number
    retryAfterMs?: number
    expectedKind: LlmErrorKind
    expectedRetryable: boolean
    expectedRetryAfterMs?: number
  }

  const table: Row[] = [
    // Auth
    { status: 401, expectedKind: 'invalid_auth', expectedRetryable: false },
    { status: 403, expectedKind: 'invalid_auth', expectedRetryable: false },
    // Timeout
    { status: 408, expectedKind: 'timeout', expectedRetryable: true },
    // Rate limit — without retryAfterMs
    { status: 429, expectedKind: 'rate_limited', expectedRetryable: true },
    // Rate limit — with retryAfterMs propagated
    {
      status: 429,
      retryAfterMs: 5000,
      expectedKind: 'rate_limited',
      expectedRetryable: true,
      expectedRetryAfterMs: 5000,
    },
    // Bad request
    { status: 400, expectedKind: 'bad_request', expectedRetryable: false },
    { status: 422, expectedKind: 'bad_request', expectedRetryable: false },
    // Server errors
    { status: 500, expectedKind: 'server', expectedRetryable: true },
    { status: 502, expectedKind: 'server', expectedRetryable: true },
    { status: 503, expectedKind: 'server', expectedRetryable: true },
    { status: 504, expectedKind: 'server', expectedRetryable: true },
    // Unknown / redirect / info
    { status: 200, expectedKind: 'unknown', expectedRetryable: false },
    { status: 301, expectedKind: 'unknown', expectedRetryable: false },
    { status: 404, expectedKind: 'unknown', expectedRetryable: false },
  ]

  for (const row of table) {
    const label = row.retryAfterMs !== undefined
      ? `status=${row.status} retryAfterMs=${row.retryAfterMs}`
      : `status=${row.status}`

    it(label, () => {
      const result = classifyHttpStatus(row.status, row.retryAfterMs)

      expect(result.kind).toBe(row.expectedKind)
      expect(result.retryable).toBe(row.expectedRetryable)

      if (row.expectedRetryAfterMs !== undefined) {
        expect(result.retryAfterMs).toBe(row.expectedRetryAfterMs)
      } else {
        expect(result.retryAfterMs).toBeUndefined()
      }
    })
  }
})

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  it('passes through an existing LlmError unchanged', () => {
    const original = new LlmError('already classified', {
      kind: 'bad_request',
      retryable: false,
    })
    const result = classifyError(original)
    expect(result).toBe(original)
  })

  it('classifies AbortError as aborted (not retryable)', () => {
    const e = new Error('The user aborted a request.')
    e.name = 'AbortError'

    const result = classifyError(e)

    expect(result).toBeInstanceOf(LlmError)
    expect(result.kind).toBe('aborted')
    expect(result.retryable).toBe(false)
    expect(result.retryAfterMs).toBeUndefined()
    expect(result.cause).toBe(e)
  })

  it('classifies TimeoutError by name as timeout (retryable)', () => {
    const e = new Error('The operation timed out.')
    e.name = 'TimeoutError'

    const result = classifyError(e)

    expect(result).toBeInstanceOf(LlmError)
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
    expect(result.retryAfterMs).toBeUndefined()
    expect(result.cause).toBe(e)
  })

  it('classifies errors with "timeout" in message as timeout (retryable)', () => {
    const e = new Error('Request timeout after 30000ms')

    const result = classifyError(e)

    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
  })

  it('classifies errors with "timed out" in message as timeout (retryable)', () => {
    const e = new Error('Connection timed out')

    const result = classifyError(e)

    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
  })

  it('classifies unknown Error as unknown (not retryable)', () => {
    const e = new Error('something went wrong')

    const result = classifyError(e)

    expect(result).toBeInstanceOf(LlmError)
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.retryAfterMs).toBeUndefined()
    expect(result.cause).toBe(e)
  })

  it('classifies a thrown string as unknown', () => {
    const result = classifyError('plain string error')

    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.message).toBe('plain string error')
  })

  it('classifies a thrown plain object as unknown', () => {
    const obj = { code: 'ECONNREFUSED' }
    const result = classifyError(obj)

    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.cause).toBe(obj)
  })

  it('classifies null as unknown', () => {
    const result = classifyError(null)
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Plain-object provider errors
  // ---------------------------------------------------------------------------

  it('classifies {status:429, retryAfterMs:5000} as rate_limited + retryable + retryAfterMs', () => {
    const result = classifyError({ status: 429, retryAfterMs: 5000 })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryable).toBe(true)
    expect(result.httpStatus).toBe(429)
    expect(result.retryAfterMs).toBe(5000)
    expect(result.cause).toEqual({ status: 429, retryAfterMs: 5000 })
  })

  it('classifies {status:401} as invalid_auth + non-retryable', () => {
    const result = classifyError({ status: 401 })
    expect(result.kind).toBe('invalid_auth')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(401)
    expect(result.retryAfterMs).toBeUndefined()
  })

  it('classifies {code:503} (numeric code) as server + retryable', () => {
    const result = classifyError({ code: 503 })
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.httpStatus).toBe(503)
  })

  it('classifies {response:{status:429}} (nested) as rate_limited + retryable', () => {
    const result = classifyError({ response: { status: 429 } })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryable).toBe(true)
    expect(result.httpStatus).toBe(429)
  })

  it('classifies an unknown plain object (no numeric status/code) as unknown', () => {
    const result = classifyError({ message: 'something failed', foo: 'bar' })
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  it('extracts retryAfterMs from retryAfter (seconds → ms)', () => {
    const result = classifyError({ status: 429, retryAfter: 30 })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryAfterMs).toBe(30_000)
  })

  it('extracts retryAfterMs from headers retry-after string', () => {
    const result = classifyError({ status: 429, headers: { 'retry-after': '60' } })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryAfterMs).toBe(60_000)
  })

  it('extracts retryAfterMs from Headers.get() interface', () => {
    const headers = {
      get: (key: string) => key === 'retry-after' ? '10' : null,
    }
    const result = classifyError({ status: 429, headers })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryAfterMs).toBe(10_000)
  })

  it('classifies Error subclass with .status property via HTTP routing', () => {
    class SdkError extends Error {
      status: number
      constructor(msg: string, status: number) {
        super(msg)
        this.name = 'SdkError'
        this.status = status
      }
    }
    const err = new SdkError('Unauthorized', 403)
    const result = classifyError(err)
    expect(result.kind).toBe('invalid_auth')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(403)
    expect(result.cause).toBe(err)
  })
})

// ---------------------------------------------------------------------------
// LlmError constructor
// ---------------------------------------------------------------------------

describe('LlmError', () => {
  it('sets required fields', () => {
    const e = new LlmError('test error', { kind: 'server', retryable: true })

    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(LlmError)
    expect(e.name).toBe('LlmError')
    expect(e.message).toBe('test error')
    expect(e.kind).toBe('server')
    expect(e.retryable).toBe(true)
  })

  it('sets optional fields when provided', () => {
    const cause = new Error('root cause')
    const e = new LlmError('rate limit hit', {
      kind: 'rate_limited',
      retryable: true,
      httpStatus: 429,
      retryAfterMs: 3000,
      provider: 'google',
      cause,
    })

    expect(e.httpStatus).toBe(429)
    expect(e.retryAfterMs).toBe(3000)
    expect(e.provider).toBe('google')
    expect(e.cause).toBe(cause)
  })

  it('leaves optional fields absent when not provided', () => {
    const e = new LlmError('auth failed', { kind: 'invalid_auth', retryable: false })

    expect(e.httpStatus).toBeUndefined()
    expect(e.retryAfterMs).toBeUndefined()
    expect(e.provider).toBeUndefined()
    expect(e.cause).toBeUndefined()
  })

  it('maintains instanceof across prototype chain', () => {
    const e = new LlmError('test', { kind: 'unknown', retryable: false })
    expect(e instanceof Error).toBe(true)
    expect(e instanceof LlmError).toBe(true)
  })
})
