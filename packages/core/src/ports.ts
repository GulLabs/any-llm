/**
 * Port interfaces for @gullabs/core.
 *
 * These are the seams — every pluggable dependency the engine accepts is
 * expressed as an interface here.  Host applications implement whichever
 * ports they need; adapters implement {@link ProviderAdapter}.
 *
 * Deferred ports (not in v1 scope): `RateLimiter`, `Redactor`, `BlobStore`,
 * `ConfigSource`, `FileStore`, streaming `stream()`.
 *
 * @module
 */

import type { ZodType } from 'zod'
import type { JsonValue, Usage, FinishReason, Warning, Message, GenConfig } from './types.js'
import type { LlmCallRecord } from './record.js'
import type { LlmError } from './errors.js'

// ---------------------------------------------------------------------------
// Adapter seam
// ---------------------------------------------------------------------------

/**
 * The request handed to an adapter after the engine has resolved defaults,
 * rendered prompts, and merged config.
 */
export interface ResolvedRequest {
  /** Final model identifier (after any alias resolution). */
  model: string
  /** Rendered system instruction, if any. */
  system?: string
  /** Conversation history with rendered content. */
  messages: Message[]
  /**
   * Zod schema for structured output.
   * The adapter uses this to set the provider-specific response schema;
   * validation is performed by the engine, not the adapter.
   */
  outputSchema?: ZodType
  /**
   * Merged generation config.
   * `serviceTier` is always present (defaulted to `'flex'` by the engine).
   */
  config: Required<Pick<GenConfig, 'serviceTier'>> & GenConfig
  /** Propagated abort signal (timeout + caller cancel merged). */
  signal?: AbortSignal
}

/**
 * Context supplied to the adapter alongside the request.
 */
export interface AdapterCtx {
  /** Resolved credentials for the target provider. */
  auth: AuthMaterial
  /** Merged abort signal (same reference as `ResolvedRequest.signal`). */
  signal?: AbortSignal
  /** Structured logger for adapter-internal diagnostics. */
  logger: Logger
}

/**
 * The raw result returned by an adapter.
 *
 * **Adapters never validate, cost, or persist.**
 * Those responsibilities belong to the engine.
 */
export interface AdapterResult {
  /**
   * Raw structured output from the provider.
   * The engine will Zod-validate this against `request.outputSchema`.
   * `unknown` so the adapter is not coupled to any schema library.
   */
  rawStructured?: unknown
  /** Raw text content from the model. */
  text?: string
  /**
   * Provider-returned thought summary.
   * Present only when `config.reasoning.includeThoughts` was `true` and the
   * provider returned thought text.
   */
  reasoningText?: string
  /** Token usage for this call. */
  usage: Usage
  /** Model identifier as returned by the provider. */
  model: string
  /** Provider-specific version string. */
  modelVersion?: string
  /** Why the model stopped generating. */
  finishReason?: FinishReason
  /** Provider-assigned response ID. */
  responseId?: string
  /** Warnings about lossy setting mappings, unsupported options, etc. */
  warnings: Warning[]
  /** Raw provider metadata (grounding, safety ratings, etc.). */
  providerMetadata?: JsonValue
}

/**
 * A provider adapter — the only interface that must be implemented to add a
 * new LLM provider to the engine.
 *
 * Adapters are pure request→response mappers.  They must never:
 * - Validate the structured output.
 * - Compute or record cost.
 * - Persist anything.
 * - Retry on error.
 */
export interface ProviderAdapter {
  /**
   * Stable provider identifier used for routing and auth credential lookup.
   * Examples: `'google'`, `'openai'`, `'anthropic'`.
   */
  id: string
  /**
   * Execute a single LLM call and return the raw result.
   *
   * @param req - Engine-resolved request with merged config.
   * @param ctx - Auth material, abort signal, and logger.
   * @throws {@link LlmError} — adapters must classify SDK errors before throwing.
   */
  run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult>
}

// ---------------------------------------------------------------------------
// Side-effect ports (host implements; fail-open in the engine)
// ---------------------------------------------------------------------------

/**
 * Persists a completed call record to the host's own data store.
 *
 * Failures are logged and swallowed by the engine — a broken sink must never
 * fail the LLM call.
 */
export interface UsageSink {
  /**
   * Record a completed call.
   * Implementations should be idempotent on `attemptId` (e.g. `onConflictDoNothing`).
   */
  record(r: LlmCallRecord): Promise<void>
}

/**
 * Looks up cost for a given model and usage.
 *
 * v1 ships a built-in Gemini pricing table; hosts can supply a custom source
 * to override or extend it.
 */
export interface PricingSource {
  /** Identifies the pricing snapshot (e.g. `"gemini-2026-06-27"`). */
  version: string
  /**
   * Compute cost for a call.
   *
   * @param model - Model identifier.
   * @param usage - Token usage for the call (GROSS convention).
   * @param tier - Service tier (`'flex'` | `'standard'`), if relevant to pricing.
   */
  price(model: string, usage: Usage, tier?: string): import('./types.js').Cost
}

// ---------------------------------------------------------------------------
// Auth port
// ---------------------------------------------------------------------------

/**
 * Credential material passed to the adapter.
 *
 * One of:
 * - `{ apiKey }` — API-key authentication.
 * - `{ vertex }` — Vertex AI Workload Identity Federation.
 */
export type AuthMaterial =
  | { apiKey: string }
  | { vertex: { project: string; location: string } }

/**
 * Resolves credentials for a provider at call time.
 *
 * Implementations may fetch from environment variables, secret managers, or
 * token-exchange endpoints.
 */
export interface AuthProvider {
  /**
   * Return credentials for the named provider.
   * @param provider - Provider identifier (matches `ProviderAdapter.id`).
   */
  credentials(provider: string): Promise<AuthMaterial>
}

// ---------------------------------------------------------------------------
// Infrastructure ports
// ---------------------------------------------------------------------------

/**
 * Monotonic or wall-clock time source.
 * Injected so tests can use a `FakeClock` for deterministic latency assertions.
 */
export interface Clock {
  /** Returns the current time as milliseconds since the Unix epoch. */
  now(): number
}

/**
 * Generates unique identifiers for calls and attempts.
 * Injected so tests can use `FakeIds` for deterministic record assertions.
 */
export interface IdGenerator {
  /** Generate a new call-scoped ID. */
  callId(): string
  /** Generate a new attempt-scoped ID (unique within a call). */
  attemptId(): string
}

/**
 * Structured logger interface.
 *
 * Canonical event names: `llm.call.start`, `llm.call.success`, `llm.call.error`.
 * The engine emits these; adapters use `warn` / `error` for internal diagnostics.
 */
export interface Logger {
  /** Informational event (call start / success). */
  info(o: object, m: string): void
  /** Non-fatal advisory (unsupported setting, unknown token type, etc.). */
  warn(o: object, m: string): void
  /** Error event (call failed, sink error, etc.). */
  error(o: object, m: string): void
}

/**
 * Optional observability hook for Sentry / PostHog / OpenTelemetry integration.
 *
 * All methods are optional so hosts can implement only what they need.
 * Telemetry failures are swallowed by the engine (fail-open).
 */
export interface Telemetry {
  /**
   * Called immediately before the adapter is invoked.
   * May return an opaque span handle that is forwarded to `onSuccess` / `onError`.
   */
  onStart?(e: object): unknown
  /**
   * Called after a successful call (adapter returned, record persisted).
   * @param e - Summary event object.
   * @param span - The opaque span returned by `onStart`, if any.
   */
  onSuccess?(e: object, span?: unknown): void
  /**
   * Called when the call throws an `LlmError`.
   * @param e - Error event object including `kind` and `retryable`.
   * @param span - The opaque span returned by `onStart`, if any.
   */
  onError?(e: object, span?: unknown): void
}

// ---------------------------------------------------------------------------
// Re-export LlmError so consumers of ports.ts don't need a separate import
// ---------------------------------------------------------------------------
export type { LlmError }
