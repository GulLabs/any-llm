/**
 * Compile-time type shape assertions for the `google` lane of
 * `ProviderOptionsMap`, established via the `declare module '@gullabs/core'`
 * augmentation in `./types.ts`.
 *
 * Uses vitest's `expectTypeOf` to assert that importing from `@gullabs/google`
 * (its package entrypoint) makes `GenConfig['providerOptions']['google']`
 * resolve to `GoogleProviderOptions | undefined`, and that an unknown
 * provider key is a compile error.
 *
 * IMPORTANT SCOPE LIMITATION: this test only asserts source-level type
 * inference within the monorepo's single shared tsconfig compilation. The
 * root `tsconfig.json` compiles all `packages/*\/src` together in one
 * program, via `paths` aliases that point `@gullabs/core` and
 * `@gullabs/google` straight at each package's `src/index.ts`. That means
 * the `declare module '@gullabs/core'` augmentation in `./types.ts` is
 * globally in scope for that program regardless of whether
 * `packages/google/src/index.ts` actually imports/re-exports the declaring
 * module — so this test would still pass even if that re-export were
 * accidentally removed. It is useful as fast-feedback documentation of the
 * intended shape, but it does NOT prove the augmentation survives into the
 * published/built package boundary.
 *
 * For the actual published-artifact guarantee — that a consumer who only
 * imports the *built* `@gullabs/google` package gets the augmentation, and
 * that it requires importing `@gullabs/google` (not just `@gullabs/core`) —
 * see `packages/google/src/dist-augmentation.test.ts`, which runs `tsc`
 * against the built `dist/index.d.ts` files.
 *
 * @module
 */

import { describe, it, expectTypeOf } from 'vitest'
import type { GenConfig } from '@gullabs/core'
import type { GoogleProviderOptions } from './index.js'

describe('ProviderOptionsMap augmentation (google)', () => {
  it('GenConfig.providerOptions.google infers as GoogleProviderOptions | undefined', () => {
    const cfg: GenConfig = { providerOptions: { google: { cachedContent: 'x' } } }
    expectTypeOf(cfg.providerOptions?.google).toEqualTypeOf<
      GoogleProviderOptions | undefined
    >()
  })

  it('rejects an unknown provider key', () => {
    // @ts-expect-error — `bogus` is not a key of ProviderOptionsMap.
    const bad: GenConfig = { providerOptions: { bogus: {} } }
    void bad
  })
})
