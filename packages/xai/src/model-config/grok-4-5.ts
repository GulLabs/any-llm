/**
 * Strict Zod config schema for xAI's `grok-4.5` model.
 *
 * Mirrors `@gullabs/core`'s `packages/core/src/model-config/*.ts` doc-density
 * style, but is a single self-contained `z.strictObject` — unlike Gemini's
 * schemas, xai has no service-tier branching (no `z.union` of tier variants
 * needed), no `topK`, and only a single reasoning-effort union (`'low'|'high'`).
 *
 * @module
 */

import { z } from 'zod'

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
        effort: z.enum(['low', 'high']).meta({
          title: 'Reasoning Effort',
          description:
            'Reasoning effort for grok-4.5. Only "low" and "high" are admitted ' +
            '(live-verified); "none"/"medium"/"xhigh" are rejected by the live API.',
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
        xai: z
          .strictObject({
            promptCacheKey: z
              .string()
              .min(1)
              .optional()
              .meta({
                title: 'Prompt Cache Key',
                description:
                  'xAI conversation-routing cache key — maps to Responses API ' +
                  '`prompt_cache_key`.',
              }),
          })
          .optional()
          .meta({
            title: 'xAI Provider Options',
            description: 'Allowlisted xAI provider options for grok-4.5.',
          }),
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
      '(low/high only), tunable sampling, no service tiers, structured output, ' +
      'vision, priced.',
    examples: [{ reasoning: { effort: 'high' } }],
  })
