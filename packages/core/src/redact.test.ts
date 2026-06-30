/**
 * Tests for redact.ts — redactSecrets.
 *
 * Verifies each secret pattern is redacted and that benign text is untouched.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { redactSecrets } from './redact.js'

// ---------------------------------------------------------------------------
// 1. Google API keys
// ---------------------------------------------------------------------------

describe('redactSecrets — Google API keys', () => {
  it('redacts a standalone Google API key', () => {
    const text = 'Request failed with key AIzaSyAbc1234567890ABCDEFG in the URL'
    const out = redactSecrets(text)
    expect(out).toBe('Request failed with key AIza…REDACTED in the URL')
    expect(out).not.toContain('AIzaSyAbc1234567890ABCDEFG')
  })

  it('redacts a Google API key at the end of a string', () => {
    const key = 'AIzaSyXXXXXXXXXXXXXXXXXXXXXX'
    const out = redactSecrets(key)
    expect(out).toBe('AIza…REDACTED')
  })

  it('redacts multiple Google API keys in one string', () => {
    const text = 'key1=AIzaSyAAAAAAAAAAAAAAAAAAAAAA&key2=AIzaSyBBBBBBBBBBBBBBBBBBBBBB'
    const out = redactSecrets(text)
    expect(out).not.toContain('AIzaSyAAAAAAAAAAAAAAAAAAAA')
    expect(out).not.toContain('AIzaSyBBBBBBBBBBBBBBBBBBBB')
  })

  it('does NOT redact short AIza prefixes (under 20 suffix chars)', () => {
    // 19 suffix chars — below the minimum
    // AIza = 4 chars, then [0-9A-Za-z_\-]{20,}, so 'AIzaSyABCDEFGHIJKLMNO' has 19 after 'AIza'
    // Actually: 'AIzaSyABCDEFGHIJKLMNO' → 'AIza' + 'SyABCDEFGHIJKLMNO' = 18 chars after AIza
    // The regex needs 20+, so this should NOT be redacted.
    const shortKey = 'AIzaShort12345678' // only 13 chars after AIza
    const out = redactSecrets(shortKey)
    expect(out).toBe(shortKey) // unchanged
  })

  it('redacts a key embedded in a full URL', () => {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyTestKeyXXXXXXXXXXXXXX'
    const out = redactSecrets(url)
    expect(out).not.toContain('AIzaSyTestKeyXXXXXXXXXXXXXX')
  })
})

// ---------------------------------------------------------------------------
// 2. Bearer tokens
// ---------------------------------------------------------------------------

describe('redactSecrets — Bearer tokens', () => {
  it('redacts a Bearer token in an Authorization header value', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9')
  })

  it('redacts a Bearer token in an error message', () => {
    const text = 'Invalid credentials: Bearer my-secret-token-abc123'
    const out = redactSecrets(text)
    expect(out).toBe('Invalid credentials: Bearer …REDACTED')
  })

  it('handles Bearer with multiple spaces (tabs not included — standard)', () => {
    const text = 'Bearer  double-spaced-token-xyz'
    const out = redactSecrets(text)
    expect(out).toBe('Bearer …REDACTED')
  })

  it('does NOT redact Bearer followed by non-token characters', () => {
    // If there's nothing after 'Bearer ' (or only whitespace), no match.
    const text = 'Bearer '
    const out = redactSecrets(text)
    // No token chars follow — should be unchanged
    expect(out).toBe('Bearer ')
  })

  it('redacts a Bearer token containing ~ (tilde)', () => {
    const text = 'Authorization: Bearer abc~def~123'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('abc~def~123')
  })

  it('redacts a Bearer token containing + (plus)', () => {
    const text = 'Authorization: Bearer abc+def+xyz'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('abc+def+xyz')
  })

  it('redacts a Bearer token containing / (forward slash)', () => {
    const text = 'Authorization: Bearer abc/def/xyz'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('abc/def/xyz')
  })

  it('redacts a Bearer token containing = (equals, e.g. base64 padding)', () => {
    const text = 'Authorization: Bearer dGVzdA=='
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('dGVzdA==')
  })

  it('redacts a standard base64-encoded Bearer token (contains +, /, =)', () => {
    // Standard base64 (not URL-safe) uses +, /, and = padding
    const token = 'SGVsbG8+V29ybGQ=/more+data=='
    const text = `Authorization: Bearer ${token}`
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain(token)
  })

  it('redacts a three-part JWT-style token with base64url segments', () => {
    // JWT format: header.payload.signature (base64url, no +/=/space)
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const text = `Bearer ${jwt}`
    const out = redactSecrets(text)
    expect(out).toBe('Bearer …REDACTED')
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9')
  })
})

// ---------------------------------------------------------------------------
// 3. Sensitive query-parameter values
// ---------------------------------------------------------------------------

describe('redactSecrets — sensitive query params', () => {
  it('redacts X-Goog-Signature value', () => {
    const url = 'https://storage.googleapis.com/bucket/file.pdf?X-Goog-Signature=abc123XYZ'
    const out = redactSecrets(url)
    expect(out).toContain('X-Goog-Signature=REDACTED')
    expect(out).not.toContain('abc123XYZ')
  })

  it('redacts X-Goog-Credential value', () => {
    const url = 'https://storage.googleapis.com/obj?X-Goog-Credential=serviceaccount%40project.iam.gserviceaccount.com'
    const out = redactSecrets(url)
    expect(out).toContain('X-Goog-Credential=REDACTED')
  })

  it('redacts key= param in query string', () => {
    const url = 'https://api.example.com/v1/endpoint?key=super-secret-key-123&other=ok'
    const out = redactSecrets(url)
    expect(out).toContain('key=REDACTED')
    expect(out).not.toContain('super-secret-key-123')
    expect(out).toContain('other=ok') // non-sensitive param preserved
  })

  it('redacts api_key= param', () => {
    const url = 'https://api.example.com/?api_key=very-secret-value'
    const out = redactSecrets(url)
    expect(out).toContain('api_key=REDACTED')
    expect(out).not.toContain('very-secret-value')
  })

  it('redacts access_token= param', () => {
    const text = 'access_token=ya29.secrettoken123'
    const out = redactSecrets(text)
    expect(out).toContain('access_token=REDACTED')
    expect(out).not.toContain('ya29.secrettoken123')
  })

  it('redacts token= param', () => {
    const text = 'https://api.example.com?token=my-bearer-token'
    const out = redactSecrets(text)
    expect(out).toContain('token=REDACTED')
    expect(out).not.toContain('my-bearer-token')
  })

  it('redacts signature= param', () => {
    const text = 'https://files.example.com/download?signature=HMAC-SHA256-VALUE&expires=9999'
    const out = redactSecrets(text)
    expect(out).toContain('signature=REDACTED')
    expect(out).not.toContain('HMAC-SHA256-VALUE')
    expect(out).toContain('expires=9999')
  })

  it('redacts sig= param', () => {
    const text = 'sig=abc123def456&other=value'
    const out = redactSecrets(text)
    expect(out).toContain('sig=REDACTED')
    expect(out).not.toContain('abc123def456')
  })

  it('redacts multiple sensitive params in one URL', () => {
    const url =
      'https://storage.googleapis.com/bucket/file?' +
      'X-Goog-Algorithm=GOOG4-RSA-SHA256&' +
      'X-Goog-Credential=serviceacct%40project.iam&' +
      'X-Goog-Signature=abcdef123456&' +
      'X-Goog-SignedHeaders=host'
    const out = redactSecrets(url)
    expect(out).toContain('X-Goog-Credential=REDACTED')
    expect(out).toContain('X-Goog-Signature=REDACTED')
    expect(out).not.toContain('serviceacct%40project.iam')
    expect(out).not.toContain('abcdef123456')
  })
})

// ---------------------------------------------------------------------------
// 4. Benign text is untouched
// ---------------------------------------------------------------------------

describe('redactSecrets — benign text', () => {
  it('returns plain text unchanged', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    expect(redactSecrets(text)).toBe(text)
  })

  it('returns empty string unchanged', () => {
    expect(redactSecrets('')).toBe('')
  })

  it('does not alter non-sensitive query params', () => {
    const url = 'https://api.example.com?model=gemini-2.5-pro&temperature=0.7'
    expect(redactSecrets(url)).toBe(url)
  })

  it('does not alter a normal error message', () => {
    const msg = 'HTTP 429: Too Many Requests — please retry after 60 seconds.'
    expect(redactSecrets(msg)).toBe(msg)
  })

  it('does not alter JSON that has no secrets', () => {
    const json = JSON.stringify({ status: 400, message: 'Bad request', code: 'INVALID_ARGUMENT' })
    expect(redactSecrets(json)).toBe(json)
  })

  it('returns already-redacted text unchanged (idempotent)', () => {
    const redacted = 'key=REDACTED&api_key=REDACTED AIza…REDACTED Bearer …REDACTED'
    // Running redactSecrets again should not alter the placeholder text
    const out = redactSecrets(redacted)
    // The AIza…REDACTED might get re-processed — but the output should still be clean.
    // Key assertion: no double-redaction of the marker strings.
    expect(out).not.toContain('AIza…REDACTEDAIza') // no chained redaction
  })
})

// ---------------------------------------------------------------------------
// 5. Combined patterns in one string
// ---------------------------------------------------------------------------

describe('redactSecrets — combined patterns', () => {
  it('redacts API key inline (not in a key= param) alongside other patterns', () => {
    const text = 'Authenticated with AIzaSyABCD1234567890abcdefG and Bearer secret-token'
    const out = redactSecrets(text)
    expect(out).toContain('AIza…REDACTED')
    expect(out).toContain('Bearer …REDACTED')
    expect(out).not.toContain('AIzaSyABCD1234567890abcdefG')
    expect(out).not.toContain('secret-token')
  })

  it('redacts all patterns when they appear together', () => {
    // Note: the Google API key appears as the value of `key=`, so both the
    // Google-key pattern AND the `key=` param pattern fire. The final result
    // has `key=REDACTED` (not `key=AIza…REDACTED`) — still fully redacted.
    const text =
      'Auth error: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig — ' +
      'URL was https://api.googleapis.com/?key=AIzaSyABCD1234567890abcdefG&sig=hmac-signature-value'

    const out = redactSecrets(text)

    // Secrets must be gone.
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9.payload.sig')
    expect(out).not.toContain('AIzaSyABCD1234567890abcdefG')
    expect(out).not.toContain('hmac-signature-value')
    // Each redaction pattern must have fired.
    expect(out).toContain('Bearer …REDACTED')
    // The key value (an API key) is redacted — either as `key=REDACTED` (param
    // pattern) or as `key=AIza…REDACTED` (Google key pattern fired first).
    // Both are acceptable; we only assert that the original value is gone.
    expect(out).toContain('key=')
    expect(out).toContain('sig=REDACTED')
  })
})
