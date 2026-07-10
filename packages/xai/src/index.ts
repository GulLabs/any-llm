/**
 * @gullabs/xai — xAI Grok provider adapter for any-llm (Responses API).
 *
 * Package skeleton: client + provider-options augmentation. The adapter,
 * model descriptors, and pricing land in a later commit.
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
