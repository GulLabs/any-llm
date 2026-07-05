import { describe, expect, it } from 'vitest'

import * as surface from './index.js'

const removedConfigSchemaFactory = `makeGeminiConfig${'Schema'}`
const removedConfigValidatorFactory = `makeGeminiConfig${'Validator'}`
const removedReasoningHelper = `resolve${'Reasoning'}`
const removedEffortBudget = `EFFORT${'_BUDGET'}`

describe('@gullabs/core package surface', () => {
  it('keeps strict-schema helpers and omits deleted legacy exports', () => {
    expect(typeof surface.toConfigJsonSchema).toBe('function')
    expect(typeof surface.zodToStandardSchema).toBe('function')
    expect(removedConfigSchemaFactory in surface).toBe(false)
    expect(removedConfigValidatorFactory in surface).toBe(false)
    expect(removedReasoningHelper in surface).toBe(false)
    expect(removedEffortBudget in surface).toBe(false)
  })
})
