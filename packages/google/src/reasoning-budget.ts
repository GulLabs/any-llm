import type { ReasoningEffort } from '@gullabs/core'

export const GOOGLE_REASONING_EFFORT_BUDGET: Record<ReasoningEffort, number> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
}
