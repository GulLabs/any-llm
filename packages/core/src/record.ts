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
// buildRecord
// ---------------------------------------------------------------------------

/**
 * Assembles an `LlmCallRecord` from engine-internal inputs.
 *
 * **Pure function — no I/O.**  The caller is responsible for supplying all
 * fields; the engine calls this after the adapter returns (or throws).
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

  // Cast GenConfig → JsonValue.
  // GenConfig only contains JSON-serialisable values (numbers, strings, booleans,
  // string arrays, and Record<string, JsonValue>), so this is safe.
  const generationConfig = input.generationConfig as unknown as JsonValue

  // Cast Usage.details → JsonValue.
  // Record<string, number> is a valid JSON object when all values are numbers.
  const tokenDetails = input.usage.details as unknown as JsonValue

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
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    ...(input.usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: input.usage.cachedInputTokens }
      : {}),
    ...(input.usage.thinkingTokens !== undefined
      ? { thinkingTokens: input.usage.thinkingTokens }
      : {}),
    ...(input.usage.totalTokens !== undefined
      ? { totalTokens: input.usage.totalTokens }
      : {}),
    // Cost fields — only when a Cost object is present.
    ...(input.cost !== undefined
      ? { costMicroUsd: input.cost.microUsd, pricingVersion: input.cost.pricingVersion }
      : {}),
    // JSONB lanes.
    tokenDetails,
    rawUsage: input.usage.raw,
    ...(input.providerMetadata !== undefined
      ? { providerMetadata: input.providerMetadata }
      : {}),
    ...(input.warnings !== undefined && input.warnings.length > 0
      ? { warnings: input.warnings as unknown as JsonValue }
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
