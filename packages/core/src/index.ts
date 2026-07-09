/**
 * @gullabs/core — public surface re-exports.
 *
 * Import from `@gullabs/core` to access types, errors, port interfaces, and
 * the record builder.  Nothing else is exported; internal helpers are kept
 * module-private.
 *
 * @module
 */

export type { StandardSchemaV1 } from './standard-schema.js'

// Core types
export type {
  JsonValue,
  CallMetadata,
  TextPart,
  InlineMediaPart,
  FileUriPart,
  Part,
  Message,
  ReasoningEffort,
  ReasoningIntent,
  ProviderOptions,
  ProviderOptionsMap,
  GenConfig,
  LlmRequest,
  FinishReason,
  Warning,
  Usage,
  Cost,
  LlmResult,
} from './types.js'
export { isTextPart, isInlineMediaPart, isFileUriPart } from './types.js'

// Errors
export type { LlmErrorKind, LlmErrorOptions, HttpClassification } from './errors.js'
export { LlmError, classifyHttpStatus, classifyError } from './errors.js'

// Ports
export type {
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  ProviderAdapter,
  UsageSink,
  PricingSource,
  AuthMaterial,
  ApiKeyAuth,
  CliSessionAuth,
  Clock,
  IdGenerator,
  Logger,
  Telemetry,
  // Telemetry event types
  CallStartEvent,
  CallSuccessEvent,
  CallErrorEvent,
  RateLimiter,
  Release,
  // Middleware seam
  EngineCtx,
  Handler,
  Middleware,
} from './ports.js'

// Record
export type { LlmCallRecord, BuildRecordInput } from './record.js'
export { buildRecord, errorKindToStatus, normalizeUsage } from './record.js'

// Pricing snapshot
export { GEMINI_PRICING, pricingVersion } from './pricing.js'
export type { ModelRates } from './pricing.js'

// Cost computation
export { computeCost, geminiPricingSource } from './cost.js'

// Engine
export type {
  ClientConfig,
  GenerateOptions,
  RunStructuredOptions,
  Client,
} from './engine.js'
export { createClient } from './engine.js'

// Model registry
export type { ModelDescriptor, ModelRegistry } from './registry.js'
export {
  createModelRegistry,
  gemmaModelDescriptors,
  geminiModelDescriptors,
  defaultGeminiRegistry,
} from './registry.js'
export { toConfigJsonSchema, zodToStandardSchema } from './model-config/index.js'

// Call site
export type { CallSite } from './callsite.js'
export { defineCallSite } from './callsite.js'

// In-memory rate limiter (production-ready, dependency-free)
export { inMemoryRateLimiter } from './rate-limiter.js'
export type { InMemoryRateLimiterOptions } from './rate-limiter.js'

// Retry middleware
export type { RetryPolicy } from './retry.js'
export { retryMiddleware, computeBackoffMs } from './retry.js'

// Utilities
export { assertNever } from './assert.js'

// Secret redaction (best-effort; for persisted/logged error text)
export { redactSecrets } from './redact.js'

/** Library version — kept in sync with `package.json`. */
export const VERSION = '0.0.0'
