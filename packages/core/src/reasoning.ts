import { LlmError } from './errors.js'
import type { ModelRegistry } from './registry.js'
import type { ReasoningEffort } from './types.js'

/**
 * Reasoning-effort → thinkingBudget token mapping. Single source of truth for
 * both the Gemini adapter's 'budget'-API mapping and resolveReasoning's
 * bucket boundaries for 'level'-API models.
 */
export const EFFORT_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
}

const TIER_ORDER = ['none', 'low', 'medium', 'high'] as const
type Tier = (typeof TIER_ORDER)[number]

function floorBucket(budgetTokens: number): Tier {
  if (budgetTokens >= EFFORT_BUDGET.high) return 'high'
  if (budgetTokens >= EFFORT_BUDGET.medium) return 'medium'
  if (budgetTokens >= EFFORT_BUDGET.low) return 'low'
  return 'none'
}

export interface ResolveReasoningInput {
  model: string
  budgetTokens: number | undefined
  registry: ModelRegistry
}

export interface ResolvedReasoning {
  budgetTokens?: number
  effort?: ReasoningEffort
}

export function resolveReasoning(
  input: ResolveReasoningInput,
): ResolvedReasoning | undefined {
  if (input.budgetTokens === undefined) return undefined

  const descriptor = input.registry.resolve(input.model)
  const reasoningApi = descriptor?.capabilities?.reasoningApi
  if (reasoningApi === undefined) {
    throw new LlmError(
      `Model "${input.model}" does not support reasoning/thinkingConfig.`,
      { kind: 'bad_request', retryable: false },
    )
  }

  if (reasoningApi === 'budget') {
    return { budgetTokens: input.budgetTokens }
  }

  const admitted = descriptor?.capabilities?.admittedReasoningEfforts ?? TIER_ORDER
  const bucket = floorBucket(input.budgetTokens)

  if (admitted.includes(bucket)) {
    return { effort: bucket }
  }

  if (bucket === 'none' && input.budgetTokens === 0) {
    throw new LlmError(
      `Model "${input.model}" requires reasoning; budgetTokens: ${
        input.budgetTokens
      } requests no reasoning ("none"), but this model only admits: ${admitted.join(
        ', ',
      )}.`,
      { kind: 'bad_request', retryable: false },
    )
  }

  const startIdx = TIER_ORDER.indexOf(bucket)
  for (let i = startIdx + 1; i < TIER_ORDER.length; i++) {
    const candidate = TIER_ORDER[i]
    if (candidate !== undefined && admitted.includes(candidate)) {
      return { effort: candidate }
    }
  }

  throw new LlmError(
    `Model "${
      input.model
    }" has no admitted reasoning effort at or above bucket "${bucket}"; admitted efforts: ${admitted.join(
      ', ',
    )}.`,
    { kind: 'bad_request', retryable: false },
  )
}
