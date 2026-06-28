/**
 * Core types for @gullabs/core.
 *
 * These types form the stable public surface of the library.  All other
 * packages depend on them; changing a type here is a breaking change.
 *
 * @module
 */

import type { ZodType } from 'zod'

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
 * The `kind` discriminant is kept so the union can be extended
 * (e.g. `image`, `file`, `audio`) without breaking existing consumers.
 */
export type TextPart = { kind: 'text'; text: string }

/**
 * A single message in the conversation history.
 * v1 supports only text parts; the `parts` union is open for future kinds.
 */
export type Message = { role: 'user' | 'assistant'; parts: TextPart[] }

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
 * @typeParam S - The Zod schema type for structured output.
 *   Defaults to `ZodType` (the base class) when unspecified.
 */
export interface LlmRequest<S extends ZodType = ZodType> {
  /**
   * Routing key — the engine maps this to a provider adapter.
   * v1 resolves `gemini-*`; unknown models throw `LlmError('bad_request')`.
   */
  model: string
  /** Optional system instruction prepended to the conversation. */
  system?: string
  /** Conversation history.  v1 supports text parts only. */
  messages: Message[]
  /**
   * When present, the adapter requests structured JSON output and the engine
   * Zod-validates the raw response against `schema`.
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
 * @typeParam T - The inferred output type from the Zod schema, if any.
 */
export interface LlmResult<T> {
  /**
   * Validated structured output.
   * Present only when `request.output.schema` was supplied and Zod validation
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
}
