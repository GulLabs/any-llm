/**
 * @gullabs/codex-cli model config schemas + registry.
 *
 * Deliberate deviation from the rest of the monorepo: these schemas are
 * defined IN this package rather than under `packages/core/src/model-config/`.
 * `@gullabs/codex-cli` is a dev-only, $0-spend provider that shells out to a
 * locally-authenticated CLI session — it must never leak into the production
 * core surface that ships model config for real, billed API providers.
 *
 * @module
 */

import { z } from 'zod'

import {
  createModelRegistry,
  toConfigJsonSchema,
  zodToStandardSchema,
} from '@gullabs/core'
import type { ModelDescriptor, ModelRegistry } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

/** The exact set of Codex CLI model identifiers this package supports. */
export type CodexCliModelId =
  'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex-spark'

/** All supported {@link CodexCliModelId} values, in registry order. */
export const CODEX_CLI_MODEL_IDS: readonly CodexCliModelId[] = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
]

// ---------------------------------------------------------------------------
// Reasoning effort — deliberately NOT core's ReasoningEffort
// ---------------------------------------------------------------------------

/**
 * Codex CLI's `model_reasoning_effort` levels.
 *
 * Distinct from core's `ReasoningEffort` (`'none'|'low'|'medium'|'high'`):
 * codex admits `'xhigh'` instead of `'none'`, so we define our own enum here
 * rather than reusing core's type.
 */
export const CODEX_CLI_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

export type CodexCliReasoningEffort = (typeof CODEX_CLI_REASONING_EFFORTS)[number]

// ---------------------------------------------------------------------------
// Per-model config schema factory
// ---------------------------------------------------------------------------

/**
 * Build the strict per-model config schema shared by every Codex CLI model.
 *
 * No temperature/topP/topK/maxOutputTokens/stopSequences on any model — the
 * `codex exec` CLI does not expose sampling knobs, only a reasoning-effort
 * level and a logical timeout.
 */
function buildCodexCliConfigSchema(modelName: string, title: string) {
  return z
    .strictObject({
      reasoning: z
        .strictObject({
          effort: z.enum(CODEX_CLI_REASONING_EFFORTS).meta({
            title: 'Reasoning Effort',
            description: `Reasoning effort forwarded to codex exec's -c model_reasoning_effort for ${modelName}.`,
          }),
        })
        .optional()
        .meta({
          title: 'Reasoning',
          description: `Reasoning configuration for ${modelName}.`,
        }),
      timeoutMs: z.number().int().positive().max(1_800_000).optional().meta({
        title: 'Timeout',
        description:
          'Logical request timeout in milliseconds; forwarded to the CLI runner.',
      }),
    })
    .meta({
      title,
      description: `Strict codex exec config for model ${modelName}. Dev-only, text-only, $0 CLI-routed calls.`,
      examples: [{ reasoning: { effort: 'medium' } }],
    })
}

export const Gpt55ConfigSchema = buildCodexCliConfigSchema('gpt-5.5', 'Gpt55Config')
export const Gpt54ConfigSchema = buildCodexCliConfigSchema('gpt-5.4', 'Gpt54Config')
export const Gpt54MiniConfigSchema = buildCodexCliConfigSchema(
  'gpt-5.4-mini',
  'Gpt54MiniConfig',
)
export const Gpt53CodexSparkConfigSchema = buildCodexCliConfigSchema(
  'gpt-5.3-codex-spark',
  'Gpt53CodexSparkConfig',
)

const CONFIG_SCHEMA_BY_ID: Record<CodexCliModelId, z.ZodType> = {
  'gpt-5.5': Gpt55ConfigSchema,
  'gpt-5.4': Gpt54ConfigSchema,
  'gpt-5.4-mini': Gpt54MiniConfigSchema,
  'gpt-5.3-codex-spark': Gpt53CodexSparkConfigSchema,
}

// ---------------------------------------------------------------------------
// Model descriptors
// ---------------------------------------------------------------------------

/**
 * `ModelDescriptor[]` for every Codex CLI model.
 *
 * `admittedReasoningEfforts` is deliberately omitted from `capabilities`:
 * core's `ReasoningEffort` type (`'none'|'low'|'medium'|'high'`) does not
 * admit `'xhigh'`, and `createModelRegistry`'s invariant only checks for the
 * presence of `configSchema`/`configJsonSchema`/`validateConfig` — not the
 * contents of `capabilities` — so omitting the field is the clean way out
 * rather than an unsafe cast.
 */
export const codexCliModelDescriptors: ModelDescriptor[] = CODEX_CLI_MODEL_IDS.map(
  (id): ModelDescriptor => {
    const configSchema = CONFIG_SCHEMA_BY_ID[id]
    return {
      id,
      provider: 'codex-cli',
      capabilities: {
        structuredOutput: true,
        nativeStructuredOutput: true,
        reasoningApi: 'level',
        sampling: 'fixed',
        vision: false,
      },
      configSchema,
      configJsonSchema: toConfigJsonSchema(configSchema),
      validateConfig: zodToStandardSchema(configSchema),
    }
  },
)

/** Registry over every {@link codexCliModelDescriptors} entry. */
export const codexCliRegistry: ModelRegistry = createModelRegistry(
  codexCliModelDescriptors,
)
