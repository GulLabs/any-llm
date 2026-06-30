import type { LlmError } from '@gullabs/core'

const CAPACITY_PATTERNS = [
  /capacity/i,
  /overload/i,
  /overloaded/i,
  /unavailable/i,
  /no\s+capacity/i,
  /temporar(?:y|ily)/i,
  /try\s+again/i,
]

const QUOTA_PATTERNS = [
  /quota/i,
  /billing/i,
  /billable/i,
  /payment/i,
  /rate\s+limit/i,
  /exceeded/i,
  /insufficient/i,
]

export function isGeminiCapacityError(err: LlmError): boolean {
  if (err.kind === 'server') return err.httpStatus === 503
  if (err.kind !== 'rate_limited') return false

  const message = err.message
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(message))) {
    return false
  }
  return CAPACITY_PATTERNS.some((pattern) => pattern.test(message))
}
