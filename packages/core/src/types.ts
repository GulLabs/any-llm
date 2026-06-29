/**
 * Core types for @gullabs/core.
 *
 * These types form the stable public surface of the library.  All other
 * packages depend on them; changing a type here is a breaking change.
 *
 * @module
 */

import type { StandardSchemaV1 } from './standard-schema.js'

// ---------------------------------------------------------------------------
// Primitive JSON value (used throughout for open / forward-compat lanes)
// ---------------------------------------------------------------------------

/**
 * A type-safe representation of any value that is valid JSON.
 * Used for raw provider metadata, open token-detail maps, and persisted
 * blobs that must survive without schema migration.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue }

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Host-supplied key-value anchors attached to every call.
 * Examples: `tenantId`, `runId`, `callSiteId`, `traceId`.
 * Persisted verbatim in the `metadata` JSONB column.
 */
export type CallMetadata = Record<string, JsonValue>

/**
 * A single text part in a message.
 * The `kind` discriminant allows narrowing within the {@link Part} union.
 */
export type TextPart = { kind: 'text'; text: string }

/**
 * An inline binary media part, base64-encoded.
 *
 * `data` must be a **raw base64 string** with **no** `data:<mime>;base64,`
 * prefix — the prefix is stripped/rejected by most provider SDKs.
 *
 * `mediaResolution` is a normalised cross-provider hint for image/video
 * detail level (`'low'` reduces tokens; `'high'` maximises fidelity).
 * Adapters map this to the closest provider-specific setting and emit an
 * {@link Warning | unsupported-setting} warning when the model cannot honour it.
 */
export type InlineMediaPart = {
  kind: 'inline-media'
  /** IANA media type, e.g. `"image/png"`, `"video/mp4"`. */
  mimeType: string
  /**
   * Raw base64-encoded bytes — **no** `data:…;base64,` prefix.
   * Most provider SDKs expect bare base64.
   */
  data: string
  /**
   * Cross-provider media detail hint.
   * `'low'` → fewer tokens / lower cost.
   * `'medium'` → balanced (provider default when omitted).
   * `'high'` → highest fidelity / most tokens.
   * Adapters emit `unsupported-setting` when the model cannot honour the hint.
   */
  mediaResolution?: 'low' | 'medium' | 'high'
}

/**
 * A provider-hosted file reference part.
 *
 * Used when a file has already been uploaded to the provider's file-storage
 * service (e.g. Gemini File API).  The provider dereferences `uri` server-side,
 * so no binary payload is sent with the request.
 *
 * `mediaResolution` behaves identically to {@link InlineMediaPart.mediaResolution}.
 */
export type FileUriPart = {
  kind: 'file-uri'
  /** Provider-assigned URI, e.g. `"https://generativelanguage.googleapis.com/v1beta/files/…"`. */
  uri: string
  /** IANA media type of the referenced file, e.g. `"image/jpeg"`, `"video/mp4"`. */
  mimeType: string
  /**
   * Cross-provider media detail hint — see {@link InlineMediaPart.mediaResolution}.
   * Adapters emit `unsupported-setting` when the model cannot honour the hint.
   */
  mediaResolution?: 'low' | 'medium' | 'high'
}

/**
 * Discriminated union of all supported message part kinds.
 * Switch on `part.kind` for exhaustive narrowing.
 */
export type Part = TextPart | InlineMediaPart | FileUriPart

// ---------------------------------------------------------------------------
// Part type guards
// ---------------------------------------------------------------------------

/**
 * Narrows `part` to {@link TextPart}.
 * @example
 * ```ts
 * if (isTextPart(p)) console.log(p.text)
 * ```
 */
export function isTextPart(part: Part): part is TextPart {
  return part.kind === 'text'
}

/**
 * Narrows `part` to {@link InlineMediaPart}.
 * @example
 * ```ts
 * if (isInlineMediaPart(p)) sendBase64(p.mimeType, p.data)
 * ```
 */
export function isInlineMediaPart(part: Part): part is InlineMediaPart {
  return part.kind === 'inline-media'
}

/**
 * Narrows `part` to {@link FileUriPart}.
 * @example
 * ```ts
 * if (isFileUriPart(p)) useProviderUri(p.uri)
 * ```
 */
export function isFileUriPart(part: Part): part is FileUriPart {
  return part.kind === 'file-uri'
}

/**
 * A single message in the conversation history.
 * `parts` is a heterogeneous array of {@link Part} values — text, inline
 * media, and provider-hosted file references can be freely mixed.
 */
export type Message = { role: 'user' | 'assistant'; parts: Part[] }

/**
 * Intent for the model's internal reasoning / chain-of-thought capability.
 * Adapters map this to provider-specific knobs (e.g. Gemini `thinkingConfig`)
 * and emit a `reasoning-mapping` warning when the mapping is lossy.
 */
export interface ReasoningIntent {
  /**
   * Abstract effort level.
   * - Gemini 2.5 → maps to `thinkingBudget` tokens.
   * - Gemini 3.x → maps to `thinkingLevel`.
   */
  effort?: 'none' | 'low' | 'medium' | 'high'
  /** Explicit token budget for thinking (overrides `effort` when both present). */
  budgetTokens?: number
  /**
   * When `true`, the adapter requests the provider to return the thought-summary
   * text, which is then surfaced as `reasoningText` on the result and record.
   */
  includeThoughts?: boolean
}

/**
 * Common generation knobs plus a quarantined `providerOptions` escape-hatch.
 * Unknown knobs go in `providerOptions`; the adapter forwards them verbatim and
 * the engine logs a warning so nothing is silently dropped.
 */
export interface GenConfig {
  /** Sampling temperature (0–2 typical). */
  temperature?: number
  /** Nucleus sampling probability mass. */
  topP?: number
  /** Top-k sampling. */
  topK?: number
  /** Hard cap on generated tokens. */
  maxOutputTokens?: number
  /** Stop sequences — generation halts when any string is produced. */
  stopSequences?: string[]
  /** Reasoning / thinking intent; adapter maps best-effort (may warn). */
  reasoning?: ReasoningIntent
  /**
   * Service tier.  Defaults to `'flex'` in v1.
   * `'flex'` enables Gemini Flex pricing tier; `'standard'` uses standard pricing.
   */
  serviceTier?: 'flex' | 'standard'
  /** Per-call timeout in milliseconds; the engine wraps the adapter in AbortSignal. */
  timeoutMs?: number
  /**
   * Verbatim provider-specific options forwarded to the raw SDK.
   * Logged when used so operators can audit non-standard settings.
   */
  providerOptions?: Record<string, JsonValue>
}

/**
 * A request to an LLM.
 *
 * @typeParam S - Standard Schema type for structured output.
 *   Defaults to `StandardSchemaV1` (the base interface) when unspecified.
 */
export interface LlmRequest<S extends StandardSchemaV1 = StandardSchemaV1> {
  /**
   * Routing key — the engine maps this to a provider adapter.
   * v1 resolves `gemini-*`; unknown models throw `LlmError('bad_request')`.
   */
  model: string
  /** Optional system instruction prepended to the conversation. */
  system?: string
  /**
   * Conversation history.
   * Parts may be text, inline media (base64), or provider-hosted file references.
   */
  messages: Message[]
  /**
   * When present, the adapter requests structured JSON output and the engine
   * validates the raw response against `schema` via the Standard Schema protocol.
   */
  output?: { schema: S }
  /** Generation configuration; merged over library defaults and call-site defaults. */
  config?: GenConfig
  /** Host-supplied metadata anchors persisted verbatim. */
  metadata?: CallMetadata
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Why the model stopped generating. */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other'

/**
 * A warning emitted when a requested setting could not be applied exactly.
 * Warnings are never silently dropped — they appear on the result and record.
 */
export type Warning =
  | {
      type: 'unsupported-setting'
      /** The name of the setting that was not applied. */
      setting: string
      /** Human-readable explanation. */
      details?: string
    }
  | {
      type: 'reasoning-mapping'
      /** How lossy the mapping was. */
      quality: 'approximate' | 'unsupported'
      details?: string
    }
  | {
      type: 'other'
      /** Free-form message for any other advisory. */
      message: string
    }

/**
 * Per-call token usage.
 *
 * **GROSS convention:**
 * - `cachedInputTokens` is a *subset* of `inputTokens` (not additive).
 * - `thinkingTokens` is a *subset* of `outputTokens` (not additive).
 * Cost math must account for this to avoid double-counting.
 */
export interface Usage {
  /** Total input tokens billed (includes cached tokens). */
  inputTokens: number
  /** Total output tokens billed (includes thinking tokens). */
  outputTokens: number
  /** Tokens served from the KV cache (subset of `inputTokens`). */
  cachedInputTokens?: number
  /** Internal reasoning tokens (subset of `outputTokens`). */
  thinkingTokens?: number
  /** `inputTokens + outputTokens` if returned by the provider. */
  totalTokens?: number
  /**
   * Open token-type map for forward compatibility.
   * New token kinds added by providers land here without requiring a schema
   * migration; each key is eligible for cost calculation.
   */
  details: Record<string, number>
  /**
   * The provider's complete raw usage object, stored verbatim.
   * Allows post-hoc cost recalculation when the pricing table changes.
   */
  raw: JsonValue
}

/**
 * Cost in micro-USD, frozen at write time.
 *
 * The `details` breakdown **must** satisfy:
 * ```
 * details.input + details.cached + details.output === microUsd
 * ```
 * Thinking tokens are billed at the output rate and are folded into
 * `details.output` — there is no separate `thinking` lane.
 */
export interface Cost {
  /**
   * Total cost in micro-USD (1 USD = 1,000,000 µUSD).
   * `null` when the model is not in the pricing table; tokens are still
   * captured for later backfill.
   */
  microUsd: number | null
  /** Identifies the pricing snapshot used (e.g. `"gemini-2026-06-27"`). */
  pricingVersion: string
  /**
   * `'exact'` when all priced fields came directly from the provider.
   * `'estimated'` when any field had to be inferred or defaulted.
   */
  confidence: 'exact' | 'estimated'
  /**
   * Per-category cost breakdown in micro-USD.
   * Must sum to `microUsd`.
   */
  details: {
    /** Cost of non-cached input tokens. */
    input: number
    /** Cost of cached input tokens (usually discounted). */
    cached: number
    /** Cost of output tokens (thinking is billed here, not separately). */
    output: number
  }
}

/**
 * The value returned by a successful (or partially-successful) LLM call.
 *
 * @typeParam T - The inferred output type from the Standard Schema, if any.
 */
export interface LlmResult<T = unknown> {
  /**
   * Validated structured output.
   * Present only when `request.output.schema` was supplied and schema validation
   * succeeded.  Absent on plain-text or failed-parse calls.
   */
  output?: T
  /** Raw text content from the model. */
  text?: string
  /**
   * Provider-returned thought-summary text.
   * Present only when `config.reasoning.includeThoughts` was `true` and the
   * provider returned a thought summary.
   */
  reasoningText?: string
  /** Token usage for this call (always present). */
  usage: Usage
  /**
   * Cost in micro-USD.
   * Absent when the model is not in the pricing table.
   */
  cost?: Cost
  /** The model identifier as returned by the provider (may differ from requested). */
  model: string
  /** Provider-specific model version string (e.g. `"gemini-2.5-pro-001"`). */
  modelVersion?: string
  /** Why the model stopped generating. */
  finishReason?: FinishReason
  /** Provider-assigned response ID for deduplication and support queries. */
  responseId?: string
  /** Wall-clock time from request dispatch to response ready, in milliseconds. */
  latencyMs: number
  /**
   * Warnings emitted during the call.
   * Always an array (possibly empty); never `undefined`.
   */
  warnings: Warning[]
  /**
   * Raw provider metadata (grounding citations, safety ratings, etc.).
   * Stored as JsonValue to avoid a hard coupling to provider-specific types.
   */
  providerMetadata?: JsonValue
  /**
   * Library-assigned stable identifier for this logical call.
   * Use this to correlate the result with the persisted `LlmCallRecord`
   * (same `callId` on the record) and with provider logs.
   */
  callId: string
  /**
   * Library-assigned identifier for the specific attempt that produced this
   * result.  With retries, this is the SUCCESSFUL attempt's id — distinct
   * from earlier attempts that failed.  Matches the persisted record's
   * `attemptId` when the sink write succeeds (the sink is fail-open).
   */
  attemptId: string
}
