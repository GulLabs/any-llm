/**
 * Model descriptor + registry for @gullabs/xai.
 *
 * v1 ships exactly one model: `grok-4.5` (canonical id only — the
 * `grok-4.5-latest` / `grok-build-latest` aliases visible in xAI's
 * `/v1/models` listing are intentionally NOT registered as separate
 * descriptors; reject-don't-map, callers must use `grok-4.5` verbatim).
 *
 * @module
 */

import type { ModelDescriptor, ModelRegistry } from '@gullabs/core'
import {
  createModelRegistry,
  toConfigJsonSchema,
  zodToStandardSchema,
} from '@gullabs/core'

import { Grok45ConfigSchema } from './model-config/grok-4-5.js'

export { Grok45ConfigSchema } from './model-config/grok-4-5.js'

export const grok45ModelDescriptor: ModelDescriptor = {
  model: 'grok-4.5',
  provider: 'xai',
  pricingFamily: 'grok-4.5',
  capabilities: {
    reasoning: true,
    reasoningApi: 'level',
    admittedReasoningEfforts: ['low', 'high'],
    structuredOutput: true,
    nativeStructuredOutput: true,
    vision: true,
    audioInput: false,
    sampling: 'tunable',
    caching: { explicit: false, minTokens: 0 },
    grounding: false,
    // No serviceTiers key — xai has no service-tier concept.
  },
  configSchema: Grok45ConfigSchema,
  configJsonSchema: toConfigJsonSchema(Grok45ConfigSchema),
  validateConfig: zodToStandardSchema(Grok45ConfigSchema),
}

/** Every model descriptor `@gullabs/xai` contributes. v1 ships only grok-4.5. */
export const xaiModelDescriptors: ModelDescriptor[] = [grok45ModelDescriptor]

export const xaiRegistry: ModelRegistry = createModelRegistry(xaiModelDescriptors)
