import { describe, expect, it, expectTypeOf } from 'vitest'

import * as surface from './index.js'
import type { TokenCountRequest, TokenCount, Client } from './index.js'

const removedConfigSchemaFactory = `makeGeminiConfig${'Schema'}`
const removedConfigValidatorFactory = `makeGeminiConfig${'Validator'}`
const removedReasoningHelper = `resolve${'Reasoning'}`
const removedEffortBudget = `EFFORT${'_BUDGET'}`
const removedGoogleProviderOptions = `Google${'ProviderOptions'}`
const removedGoogleSafetySetting = `Google${'SafetySetting'}`
const removedGoogleSearchTool = `Google${'SearchTool'}`

describe('@gullabs/core package surface', () => {
  it('keeps strict-schema helpers and omits deleted legacy exports', () => {
    expect(typeof surface.toConfigJsonSchema).toBe('function')
    expect(typeof surface.zodToStandardSchema).toBe('function')
    expect(removedConfigSchemaFactory in surface).toBe(false)
    expect(removedConfigValidatorFactory in surface).toBe(false)
    expect(removedReasoningHelper in surface).toBe(false)
    expect(removedEffortBudget in surface).toBe(false)
  })

  it('exports composeProviders for assembling ProviderPlugins', () => {
    expect(typeof surface.composeProviders).toBe('function')
  })

  it('no longer exports the Google-specific provider option types (moved to @gullabs/google)', () => {
    // These were only ever type exports, so this `in` check cannot catch a
    // stray `export type`; it only guards against someone reintroducing them
    // as runtime values. `packages/google/src/dist-augmentation.test.ts` is
    // the actual enforcement mechanism for the published-artifact contract
    // (it type-checks fixtures against the *built* `dist/index.d.ts` files).
    // `packages/google/src/provider-options.test.ts` is documentation-grade:
    // it demonstrates source-level type inference within the monorepo's
    // shared tsconfig program, but the root tsconfig compiles all
    // `packages/*/src` together, so a `declare module` augmentation is
    // globally in scope there regardless of which package's `index.ts`
    // actually imports the declaring module — it does not prove the
    // augmentation survives the package boundary.
    expect(removedGoogleProviderOptions in surface).toBe(false)
    expect(removedGoogleSafetySetting in surface).toBe(false)
    expect(removedGoogleSearchTool in surface).toBe(false)
  })

  it('exports TokenCountRequest/TokenCount types and Client.countTokens', () => {
    expectTypeOf<TokenCountRequest>().toEqualTypeOf<{
      provider: string
      model: string
      system?: string
      messages: import('./types.js').Message[]
    }>()
    expectTypeOf<TokenCount>().toEqualTypeOf<{
      totalTokens: number
      details?: Record<string, number>
      raw: import('./types.js').JsonValue
    }>()
    expectTypeOf<Client['countTokens']>().toEqualTypeOf<
      (
        request: TokenCountRequest,
        opts: import('./engine.js').GenerateOptions,
      ) => Promise<TokenCount>
    >()
  })
})
