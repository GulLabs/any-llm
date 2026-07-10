/**
 * @gullabs/xai — xAI Grok provider adapter for any-llm (Responses API).
 *
 * Client + provider-options augmentation + adapter (request/response
 * mapping, error classification, usage accounting) + model descriptor +
 * pricing + `xaiProvider` plugin factory.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { xaiProvider } from '@gullabs/xai'
 *
 * const client = createClient({
 *   ...composeProviders([xaiProvider()]),
 * })
 *
 * const result = await client.generate(
 *   { provider: 'xai', model: 'grok-4.5', messages: [...] },
 *   { auth: { apiKey: process.env.XAI_API_KEY! } },
 * )
 * ```
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
export {
  Grok45ConfigSchema,
  grok45ModelDescriptor,
  xaiModelDescriptors,
  xaiRegistry,
} from './models.js'
export {
  XAI_PRICING,
  xaiPricingVersion,
  computeXaiCost,
  xaiPricingSource,
} from './pricing.js'
export type { XaiModelRates } from './pricing.js'
export { xaiProvider } from './provider.js'
