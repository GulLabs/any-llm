/**
 * Best-effort secret redaction for persisted/logged error text.
 *
 * **Not a full DLP solution.** This module provides a lightweight, regex-based
 * scrubber intended to reduce accidental secret exposure in audit records and
 * log lines. It covers the most common patterns seen in provider error messages
 * and signed URLs. It will not catch every possible credential format.
 *
 * Pure function; no dependencies. Safe to call in hot paths.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Google API key: `AIza` prefix followed by 20 or more alphanumeric /
 * underscore / hyphen characters (the documented format for Cloud API keys).
 */
const GOOGLE_API_KEY_RE = /AIza[0-9A-Za-z_\-]{20,}/g

/**
 * HTTP Bearer token value in an `Authorization` header or error message.
 * Matches `Bearer ` followed by the token characters.
 */
const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g

/**
 * Sensitive query-parameter key=value pairs.
 *
 * Covers:
 * - `X-Goog-*` signed-URL parameters (e.g. `X-Goog-Signature`, `X-Goog-Credential`)
 * - `key`, `api_key`, `access_token`, `token`, `signature`, `sig`
 *
 * Value is the run of non-delimiter characters following `=`.
 * Delimiter set: `&`, whitespace, `#`, `"`, `'`, `<`, `>`.
 *
 * Word-boundary `\b` before the key prevents false matches on longer words
 * (e.g. `token_type` is not matched as `token`).
 */
const SENSITIVE_PARAM_RE =
  /\b(X-Goog-[^=&\s#"'<>]+|api_key|access_token|signature|sig|token|key)=([^&\s#"'<>]+)/g

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redacts known secret patterns from a string.
 *
 * **Best-effort, not full DLP.** Covers:
 * - Google API keys (`AIza…` prefix, 20+ chars)
 * - HTTP Bearer tokens
 * - Common sensitive URL query-param values:
 *   `X-Goog-*`, `key`, `api_key`, `access_token`, `token`, `signature`, `sig`
 *
 * Benign text is returned unchanged. The function is idempotent: calling it
 * twice on already-redacted text produces the same output.
 *
 * @param text - The string to redact secrets from.
 * @returns A new string with secrets replaced by placeholder values.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // 1. Google API keys first (they may appear inside URLs too, before param redaction)
      .replace(GOOGLE_API_KEY_RE, 'AIza…REDACTED')
      // 2. Bearer tokens in Authorization header values / error messages
      .replace(BEARER_TOKEN_RE, 'Bearer …REDACTED')
      // 3. Sensitive query-parameter values in URLs and inline key=value pairs
      .replace(
        SENSITIVE_PARAM_RE,
        (_match, key: string, _value: string) => `${key}=REDACTED`,
      )
  )
}
