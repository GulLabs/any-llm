/**
 * Persisted call record for @anyllm/core.
 *
 * `LlmCallRecord` is the canonical shape written to the `llm_calls` table by
 * `@anyllm/drizzle` (or any custom `UsageSink`).  `buildRecord` assembles it
 * from engine-internal inputs with no I/O.
 *
 * @module
 */

import type { JsonValue, Usage, FinishReason, Warning, GenConfig, Cost } from './types.js'
import type { LlmErrorKind, LlmError } from './errors.js'

// ---------------------------------------------------------------------------
// Record interface
// ---------------------------------------------------------------------------

/**
 * A complete, immutable snapshot of a single LLM call attempt.
 *
 * Designed for append-only storage: the record is written once after the call
 * completes (success or failure).  Idempotency key: `attemptId`.
 *
 * `recordSchemaVersion` must be checked before deserialization; increment it
 * on any breaking schema change.
 */
export interface LlmCallRecord {
  /** Schema version — always `1` for this release. */
  recordSchemaVersion: 1

  // --- identity ---
  /** Unique ID for the logical call (shared across retries). */
  callId: string
  /** Unique ID for this specific attempt (the idempotency key). */
  attemptId: string
  /** Optional call-site identifier for grouping by prompt template. */
  callSiteId?: string

  // --- routing ---
  /** Provider identifier (e.g. `"google"`). */
  provider: string
  /** Requested model string (e.g. `"gemini-2.5-pro"`). */
  model: string
  /** Provider-specific model version returned in the response. */
  modelVersion?: string
  /** Provider-assigned response ID for deduplication and support queries. */
  responseId?: string
  /** Service tier used for this call (e.g. `"flex"` | `"standard"`). */
  serviceTier?: string

  // --- outcome ---
  /**
   * Call outcome.
   *
   * | Value            | Meaning                                        |
   * |------------------|------------------------------------------------|
   * | `'ok'`           | Success                                        |
   * | `'parse_error'`  | Zod validation failed on structured output     |
   * | `'api_error'`    | Auth/rate-limit/server/bad-request/unknown     |
   * | `'timeout'`      | Request exceeded timeout                       |
   * | `'aborted'`      | Caller cancelled via AbortSignal               |
   * | `'content_filter'` | Provider refused output for safety reasons   |
   */
  status: 'ok' | 'parse_error' | 'api_error' | 'timeout' | 'aborted' | 'content_filter'
  /** Why the model stopped generating (absent on error). */
  finishReason?: FinishReason
  /** Wall-clock latency in milliseconds from dispatch to response. */
  latencyMs: number

  // --- usage (typed hot fields) ---
  /** Total input tokens (includes cached; GROSS). */
  inputTokens?: number
  /** Total output tokens (includes thinking; GROSS). */
  outputTokens?: number
  /** Cached input tokens (subset of `inputTokens`). */
  cachedInputTokens?: number
  /** Internal reasoning tokens (subset of `outputTokens`). */
  thinkingTokens?: number
  /** `inputTokens + outputTokens`, if returned by the provider. */
  totalTokens?: number

  // --- cost (frozen at write time) ---
  /**
   * Total cost in micro-USD.
   * `null` when the model is not priced; `undefined` when cost was not computed.
   */
  costMicroUsd?: number | null
  /** Pricing snapshot identifier (e.g. `"gemini-2026-06-27"`). */
  pricingVersion?: string

  // --- forward-compat JSONB lanes ---
  /** Open token-type detail map from `Usage.details` (JSONB). */
  tokenDetails: JsonValue
  /** Raw provider usage object from `Usage.raw` (JSONB). */
  rawUsage: JsonValue
  /** Raw provider metadata (grounding, safety ratings, etc.) (JSONB). */
  providerMetadata?: JsonValue
  /** Serialized `Warning[]` (JSONB). */
  warnings?: JsonValue

  // --- generation config ---
  /** Effective generation config sent to the provider (JSONB, transport keys stripped). */
  generationConfig: JsonValue

  // --- reasoning capture (goal 3) ---
  /**
   * Thought-summary text returned by the provider.
   * Present only when `config.reasoning.includeThoughts` was `true` and the
   * provider returned thought text.  Truncated to a cap in the engine.
   */
  reasoningText?: string

  // --- postmortem (diagnostics on failure) ---
  /** Error kind from the classified `LlmError` (absent on success). */
  errorKind?: LlmErrorKind
  /** Truncated error message (absent on success). */
  errorMessage?: string

  // --- host anchors ---
  /** Host-supplied metadata (tenantId, runId, traceId, etc.) (JSONB). */
  metadata: JsonValue
  /** ISO-8601 creation timestamp, stamped by the `Clock` port. */
  createdAt: string
}

// ---------------------------------------------------------------------------
// buildRecord inputs
// ---------------------------------------------------------------------------

/**
 * The engine-internal inputs required to assemble an `LlmCallRecord`.
 */
export interface BuildRecordInput {
  /** Unique call ID. */
  callId: string
  /** Unique attempt ID (idempotency key). */
  attemptId: string
  /** Optional call-site identifier. */
  callSiteId?: string
  /** Provider identifier. */
  provider: string
  /** Requested model string. */
  model: string
  /** Provider-returned model version. */
  modelVersion?: string
  /** Provider-assigned response ID. */
  responseId?: string
  /** Service tier used. */
  serviceTier?: string
  /** Token usage for the call. */
  usage: Usage
  /** Computed cost (absent when model is unpriced or cost failed). */
  cost?: Cost
  /** Wall-clock latency in milliseconds. */
  latencyMs: number
  /**
   * Call outcome status.
   * The engine computes this from the call result or classified error.
   */
  status: LlmCallRecord['status']
  /** Finish reason (absent on error paths). */
  finishReason?: FinishReason
  /** Warnings emitted during the call. */
  warnings?: Warning[]
  /** Effective generation config that was sent to the provider. */
  generationConfig: GenConfig
  /** Host-supplied metadata (JSONB). */
  metadata: JsonValue
  /** ISO-8601 timestamp from the `Clock` port. */
  createdAt: string
  /** Classified error (absent on success). */
  error?: LlmError
  /**
   * Provider thought-summary text.
   * Present when `includeThoughts` was requested and the provider responded.
   */
  reasoningText?: string
  /** Raw provider metadata (JSONB). */
  providerMetadata?: JsonValue
}

// ---------------------------------------------------------------------------
// Error kind → record status mapping
// ---------------------------------------------------------------------------

/**
 * Maps an `LlmErrorKind` to a record `status`.
 *
 * - `'parse_error'`, `'timeout'`, `'aborted'`, `'content_filter'` are direct.
 * - All other error kinds collapse to `'api_error'`.
 */
function errorKindToStatus(kind: LlmErrorKind): LlmCallRecord['status'] {
  switch (kind) {
    case 'parse_error':
      return 'parse_error'
    case 'timeout':
      return 'timeout'
    case 'aborted':
      return 'aborted'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'api_error'
  }
}

// Keep the function in scope so it can be used if the engine wants to derive
// status from an error kind without building a full record.
export { errorKindToStatus }

// ---------------------------------------------------------------------------
// Public usage normalizer (thin wrapper around sanitizeUsage for the engine)
// ---------------------------------------------------------------------------

/**
 * Validates and normalises GROSS/subset token invariants.
 *
 * Re-exports the internal {@link sanitizeUsage} logic with a stable public name
 * so the engine can normalise usage exactly once (SPEC step 7) and share the
 * same `Usage` value for the result, cost, and record — no silent divergence.
 *
 * @param usage - Raw usage from the adapter.
 * @returns The clamped `usage` and any `warnings` about violations.
 */
export function normalizeUsage(usage: Usage): { usage: Usage; warnings: Warning[] } {
  const { usage: normalized, clampWarnings } = sanitizeUsage(usage)
  return { usage: normalized, warnings: clampWarnings }
}

// ---------------------------------------------------------------------------
// Usage invariant sanitizer — helpers
// ---------------------------------------------------------------------------

/**
 * Recursively replaces non-finite numbers (NaN, ±Infinity) in a `JsonValue`
 * with `null` so every persisted blob is valid JSON.
 *
 * `JSON.stringify` already coerces non-finite numbers to `null`, but making
 * the replacement explicit before storage means the in-memory `rawUsage` value
 * is consistent with what is written to the database.
 *
 * @param value - Any JSON-compatible value.
 * @returns `{ sanitized, hadNonFinite }` — a safe copy and a changed flag.
 */
function sanitizeRawJson(value: JsonValue): { sanitized: JsonValue; hadNonFinite: boolean } {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { sanitized: null, hadNonFinite: true }
    return { sanitized: value, hadNonFinite: false }
  }
  if (Array.isArray(value)) {
    let hadNonFinite = false
    const out: JsonValue[] = value.map((item) => {
      const r = sanitizeRawJson(item)
      if (r.hadNonFinite) hadNonFinite = true
      return r.sanitized
    })
    return { sanitized: hadNonFinite ? out : value, hadNonFinite }
  }
  if (value !== null && typeof value === 'object') {
    let hadNonFinite = false
    const out: { [k: string]: JsonValue } = {}
    for (const [k, v] of Object.entries(value)) {
      const r = sanitizeRawJson(v)
      if (r.hadNonFinite) hadNonFinite = true
      out[k] = r.sanitized
    }
    return { sanitized: hadNonFinite ? out : value, hadNonFinite }
  }
  // null | boolean | string — always JSON-safe.
  return { sanitized: value, hadNonFinite: false }
}

/**
 * Sanitizes the open token-detail map (`Usage.details`).
 *
 * Each value is coerced to a finite non-negative number; non-finite or
 * negative values are replaced with `0` and a warning is pushed.
 *
 * @param details - Raw details map from the adapter.
 * @param warnings - Mutable array to append fix-up warnings into.
 * @returns `{ sanitized, hadFix }` — the sanitized map and a changed flag.
 */
function sanitizeDetails(
  details: Record<string, number>,
  warnings: Warning[],
): { sanitized: Record<string, number>; hadFix: boolean } {
  let hadFix = false
  const sanitized: Record<string, number> = {}
  for (const [key, val] of Object.entries(details)) {
    if (!Number.isFinite(val) || val < 0) {
      warnings.push({
        type: 'other',
        message: `usage.details["${key}"] (${String(val)}) is non-finite or negative; clamped to 0`,
      })
      sanitized[key] = 0
      hadFix = true
    } else {
      sanitized[key] = val
    }
  }
  return { sanitized: hadFix ? sanitized : details, hadFix }
}

// ---------------------------------------------------------------------------
// Usage invariant sanitizer
// ---------------------------------------------------------------------------

/**
 * The result of {@link sanitizeUsage}.
 */
interface SanitizeUsageResult {
  /** Usage with subset token counts clamped to their parent GROSS fields. */
  usage: Usage
  /** Warnings emitted for each violation that was corrected. */
  clampWarnings: Warning[]
}

/**
 * Validates GROSS/subset token invariants and clamps any violations.
 *
 * Per the SPEC:
 * - `cachedInputTokens` **must** be ≤ `inputTokens` (it is a subset of gross input).
 * - `thinkingTokens` **must** be ≤ `outputTokens` (it is a subset of gross output).
 *
 * **Policy (fail-open):** when a subset exceeds its parent we clamp it to the
 * parent value and emit a `Warning` so the anomaly is visible in the persisted
 * record.  We never throw — this runs inside the record-building path where
 * side-effect failures must not abort the call.
 *
 * `totalTokens` is sanity-checked (warn if below `input + output`) but is not
 * clamped because it is provider-reported and informational only.
 */
function sanitizeUsage(usage: Usage): SanitizeUsageResult {
  const warnings: Warning[] = []
  let needsRebuild = false

  // ------------------------------------------------------------------
  // Step A: Clamp non-finite or negative CORE token counts to 0.
  //
  // Defensive against malformed adapter output (NaN, Infinity, negative).
  // Policy (fail-open): clamp + warn, never throw.  The GROSS subset checks
  // below use the clamped values so that downstream cost math never sees NaN.
  // ------------------------------------------------------------------
  let inputTokens = usage.inputTokens
  let outputTokens = usage.outputTokens

  // `isFinite` coerces its argument to number; covers both NaN and ±Infinity.
  // We intentionally check the runtime value even though TypeScript says `number`
  // because malformed adapter output can sneak in undefined/NaN via a cast.
  if (!isFinite(inputTokens) || inputTokens < 0) {
    warnings.push({
      type: 'other',
      message: `inputTokens (${String(inputTokens)}) is non-finite or negative; clamped to 0`,
    })
    inputTokens = 0
    needsRebuild = true
  }

  if (!isFinite(outputTokens) || outputTokens < 0) {
    warnings.push({
      type: 'other',
      message: `outputTokens (${String(outputTokens)}) is non-finite or negative; clamped to 0`,
    })
    outputTokens = 0
    needsRebuild = true
  }

  let cachedInputTokens = usage.cachedInputTokens
  let thinkingTokens = usage.thinkingTokens

  // Clamp non-finite or negative SUBSET token counts to 0 before GROSS check.
  if (cachedInputTokens !== undefined && (!isFinite(cachedInputTokens) || cachedInputTokens < 0)) {
    warnings.push({
      type: 'other',
      message: `cachedInputTokens (${String(cachedInputTokens)}) is non-finite or negative; clamped to 0`,
    })
    cachedInputTokens = 0
    needsRebuild = true
  }

  if (thinkingTokens !== undefined && (!isFinite(thinkingTokens) || thinkingTokens < 0)) {
    warnings.push({
      type: 'other',
      message: `thinkingTokens (${String(thinkingTokens)}) is non-finite or negative; clamped to 0`,
    })
    thinkingTokens = 0
    needsRebuild = true
  }

  // ------------------------------------------------------------------
  // Step B: GROSS subset invariant checks (uses clamped values from Step A).
  // ------------------------------------------------------------------
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) {
    warnings.push({
      type: 'other',
      message:
        `cachedInputTokens (${cachedInputTokens}) exceeds inputTokens (${inputTokens}); ` +
        `clamped to ${inputTokens}`,
    })
    cachedInputTokens = inputTokens
    needsRebuild = true
  }

  if (thinkingTokens !== undefined && thinkingTokens > outputTokens) {
    warnings.push({
      type: 'other',
      message:
        `thinkingTokens (${thinkingTokens}) exceeds outputTokens (${outputTokens}); ` +
        `clamped to ${outputTokens}`,
    })
    thinkingTokens = outputTokens
    needsRebuild = true
  }

  if (usage.totalTokens !== undefined) {
    const expected = inputTokens + outputTokens
    if (usage.totalTokens < expected) {
      warnings.push({
        type: 'other',
        message:
          `totalTokens (${usage.totalTokens}) is less than ` +
          `inputTokens + outputTokens (${expected}); recorded as-is`,
      })
    }
  }

  // ------------------------------------------------------------------
  // Step C: Sanitize open details map and raw usage object.
  //
  // details (Record<string,number>): coerce non-finite / negative values to 0.
  // raw (JsonValue): recursively replace non-finite numbers with null so
  // the stored JSONB is always valid and round-trips without silent mutation.
  // ------------------------------------------------------------------
  const { sanitized: sanitizedDetails, hadFix: detailsFixed } =
    sanitizeDetails(usage.details, warnings)
  const { sanitized: sanitizedRaw, hadNonFinite: rawFixed } =
    sanitizeRawJson(usage.raw)

  if (detailsFixed || rawFixed) {
    needsRebuild = true
  }

  if (!needsRebuild) {
    return { usage, clampWarnings: warnings }
  }

  // Rebuild Usage with clamped values — exactOptionalPropertyTypes-safe.
  const clampedUsage: Usage = {
    inputTokens,
    outputTokens,
    details: sanitizedDetails,
    raw: sanitizedRaw,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  }

  return { usage: clampedUsage, clampWarnings: warnings }
}

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

/**
 * Assembles an `LlmCallRecord` from engine-internal inputs.
 *
 * **Pure function — no I/O.**  The caller is responsible for supplying all
 * fields; the engine calls this after the adapter returns (or throws).
 *
 * Token-usage invariants (`cachedInputTokens ≤ inputTokens`,
 * `thinkingTokens ≤ outputTokens`) are enforced by clamping any violations
 * and appending a `Warning` to the record rather than throwing.  This is the
 * SPEC fail-open policy: persistence is always attempted.
 *
 * Rationale for co-locating mapping logic here: the engine and the drizzle
 * sink are decoupled.  The sink only calls `usageSink.record(r)` — it never
 * knows how the record was assembled.
 *
 * @param input - All fields needed to build the record.
 * @returns An immutable `LlmCallRecord` ready for persistence.
 */
export function buildRecord(input: BuildRecordInput): LlmCallRecord {
  // Derive status from the error kind when an error is present, overriding the
  // caller-supplied status only when it provides more specificity.
  const status: LlmCallRecord['status'] =
    input.error !== undefined
      ? errorKindToStatus(input.error.kind)
      : input.status

  // Validate and clamp usage subset invariants (fail-open: clamp + warn).
  const { usage, clampWarnings } = sanitizeUsage(input.usage)

  // Merge caller warnings with any clamp warnings.
  const allWarnings: Warning[] = [
    ...(input.warnings ?? []),
    ...clampWarnings,
  ]

  // Cast GenConfig → JsonValue.
  // GenConfig only contains JSON-serialisable values (numbers, strings, booleans,
  // string arrays, and Record<string, JsonValue>), so this is safe.
  const generationConfig = input.generationConfig as unknown as JsonValue

  // Cast Usage.details → JsonValue.
  // Record<string, number> is a valid JSON object when all values are numbers.
  const tokenDetails = usage.details as unknown as JsonValue

  // Build the record using conditional spreads for every optional property so
  // `exactOptionalPropertyTypes` is satisfied (we never assign `undefined`).
  const record: LlmCallRecord = {
    recordSchemaVersion: 1,
    callId: input.callId,
    attemptId: input.attemptId,
    ...(input.callSiteId !== undefined ? { callSiteId: input.callSiteId } : {}),
    provider: input.provider,
    model: input.model,
    ...(input.modelVersion !== undefined ? { modelVersion: input.modelVersion } : {}),
    ...(input.responseId !== undefined ? { responseId: input.responseId } : {}),
    ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
    status,
    ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
    latencyMs: input.latencyMs,
    // Usage hot fields — always present since Usage.inputTokens/outputTokens are required.
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.thinkingTokens !== undefined
      ? { thinkingTokens: usage.thinkingTokens }
      : {}),
    ...(usage.totalTokens !== undefined
      ? { totalTokens: usage.totalTokens }
      : {}),
    // Cost fields — only when a Cost object is present.
    ...(input.cost !== undefined
      ? { costMicroUsd: input.cost.microUsd, pricingVersion: input.cost.pricingVersion }
      : {}),
    // JSONB lanes.
    tokenDetails,
    rawUsage: usage.raw,
    ...(input.providerMetadata !== undefined
      ? { providerMetadata: input.providerMetadata }
      : {}),
    ...(allWarnings.length > 0
      ? { warnings: allWarnings as unknown as JsonValue }
      : {}),
    generationConfig,
    // Reasoning capture.
    ...(input.reasoningText !== undefined ? { reasoningText: input.reasoningText } : {}),
    // Postmortem — only on failure.
    ...(input.error !== undefined
      ? {
          errorKind: input.error.kind,
          errorMessage: input.error.message,
        }
      : {}),
    metadata: input.metadata,
    createdAt: input.createdAt,
  }

  return record
}
