/**
 * @anyllm/core — public surface re-exports.
 *
 * Import from `@anyllm/core` to access types, errors, port interfaces, and
 * the record builder.  Nothing else is exported; internal helpers are kept
 * module-private.
 *
 * @module
 */

// Core types
export type {
  JsonValue,
  CallMetadata,
  TextPart,
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
} from './ports.js'

// Record
export type { LlmCallRecord, BuildRecordInput } from './record.js'
export { buildRecord, errorKindToStatus } from './record.js'

// Pricing snapshot
export { GEMINI_PRICING, pricingVersion } from './pricing.js'
export type { ModelRates } from './pricing.js'

// Cost computation
export { computeCost, geminiPricingSource } from './cost.js'

/** Library version — kept in sync with `package.json`. */
export const VERSION = '0.0.0'
