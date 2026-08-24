/**
 * Strict Zod config schema for xAI's `grok-4.5` model.
 *
 * Mirrors `@gullabs/core`'s `packages/core/src/model-config/*.ts` doc-density
 * style, but is a single self-contained `z.strictObject` — unlike Gemini's
 * schemas, xai has no service-tier branching (no `z.union` of tier variants
 * needed), no `topK`, and a reasoning-effort union of `'low'|'medium'|'high'`
 * (live-verified 2026-08-24).
 *
 * @module
 */

import { z } from 'zod'

import { XaiProviderOptionsSchema } from './tools.js'

export const Grok45ConfigSchema = z
  .strictObject({
    temperature: z.number().optional().meta({
      title: 'Temperature',
      description: 'Sampling temperature forwarded verbatim to grok-4.5.',
    }),
    topP: z.number().optional().meta({
      title: 'Top P',
      description: 'Nucleus sampling parameter forwarded verbatim to grok-4.5.',
    }),
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Maximum output token cap for grok-4.5. No artificial ceiling — xAI ' +
          'accepts arbitrarily large values (live-verified); truncation surfaces ' +
          "as finishReason:'length', not an error.",
      }),
    reasoning: z
      .strictObject({
        effort: z.enum(['low', 'medium', 'high']).meta({
          title: 'Reasoning Effort',
          description:
            'Reasoning effort for grok-4.5. "low", "medium", and "high" are ' +
            'admitted (live-verified 2026-08-24); "none"/"xhigh" are rejected ' +
            'by the live API. Vendor default when omitted is "high".',
        }),
      })
      .optional()
      .meta({
        title: 'Reasoning',
        description:
          'grok-4.5 effort-level reasoning configuration. No budgetTokens field — ' +
          'xAI uses level-style reasoning, not token budgets.',
      }),
    timeoutMs: z.number().int().positive().optional().meta({
      title: 'Timeout',
      description: 'Logical request timeout in milliseconds.',
    }),
    providerOptions: z
      .strictObject({
        xai: XaiProviderOptionsSchema.optional(),
      })
      .optional()
      .meta({
        title: 'Provider Options',
        description: 'Provider-specific options accepted for grok-4.5.',
      }),
  })
  .meta({
    title: 'Grok45Config',
    description:
      'Strict Responses API config for model grok-4.5. Level reasoning ' +
      '(low/medium/high), tunable sampling, no service tiers, structured output, ' +
      'vision, Live Search tools, priced.',
    examples: [{ reasoning: { effort: 'high' } }],
  })
