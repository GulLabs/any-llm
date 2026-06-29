/**
 * @gullabs/core — public surface re-exports.
 *
 * Import from `@gullabs/core` to access types, errors, port interfaces, and
 * the record builder.  Nothing else is exported; internal helpers are kept
 * module-private.
 *
 * @module
 */

// Standard Schema
import type { StandardSchemaV1 } from './standard-schema.js'
export type { StandardSchemaV1 }
/** Infer the output type of a Standard Schema. */
export type InferOutput<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

// Core types
export type {
  JsonValue,
  CallMetadata,
  TextPart,
  InlineMediaPart,
  FileUriPart,
  Part,
  Message,
  ReasoningIntent,
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
  AuthProvider,
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
  geminiModelDescriptors,
  defaultGeminiRegistry,
} from './registry.js'

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

// Auth helpers
export { envAuth } from './auth.js'

/** Library version — kept in sync with `package.json`. */
export const VERSION = '0.0.0'
