/**
 * @gullabs/xai — xAI Grok provider adapter for any-llm (Responses API).
 *
 * Client + provider-options augmentation + adapter (request/response
 * mapping, error classification, usage accounting). Model descriptors and
 * pricing land in a later commit.
 *
 * @module
 */

export type { XaiProviderOptions } from './types.js'
export type {
  XaiClientLike,
  XaiInputTextPart,
  XaiInputImagePart,
  XaiInputContentPart,
  XaiInputItem,
  XaiTextFormat,
  XaiResponseCreateParams,
  XaiReasoningSummaryPart,
  XaiReasoningOutputItem,
  XaiOutputTextPart,
  XaiMessageOutputItem,
  XaiOutputItem,
  XaiUsageShape,
  XaiResponseShape,
} from './client.js'
export { buildXaiClient, requireApiKey } from './client.js'
export { xaiAdapter, classifyXaiError } from './adapter.js'
export type { XaiAdapterOptions } from './adapter.js'
