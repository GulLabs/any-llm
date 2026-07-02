# PostBuzz Migration Blockers

Last updated: 2026-07-01.

**Status: RESOLVED.** This doc previously recorded three library-side features believed to be
blocking the PostBuzz migration to `@gullabs/any-llm`. That framing was wrong. A fresh, independent
two-part expert review re-examined all three asks against PostBuzz's actual source code (not just
plan-doc prose) and concluded that any-llm will **not** build any of them as library APIs. This is
now a status/evidence doc, not a "waiting for these to ship" doc.

## Resolution Summary

None of the three previously-listed items are library gaps. The real problems are host-specific to
PostBuzz:

1. **Runtime Client Factory** (`createRuntimeClientFactory` + `buildCallMetadata`) — not going to be
   built. PostBuzz's actual blocker is its own ambient-singleton auth architecture (`bootstrapAI` plus
   a global-singleton `EnvSource`), which is fundamentally incompatible with any-llm's per-call-auth
   contract. No factory function signature can paper over that; PostBuzz must migrate off the
   ambient-singleton pattern regardless of what any-llm ships. Separately, PostBuzz has zero shared
   metadata convention across call-sites today, so there is no common shape for `buildCallMetadata` to
   standardize. PostBuzz's actual client-construction duplication is trivial and already solved by the
   existing `createClient()` export.
2. **Grounded Structured Helper** (`runGroundedStructured`) — not going to be built. PostBuzz's 3
   grounded call-sites each have a genuinely different error/retry policy, and none does a two-step
   flow today. There is no repeatable shape to extract into a library API; forcing one would either
   fit none of the three call-sites or become a callback-configurable escape hatch that re-implements
   a host orchestrator inside the library. This is consistent with the existing decision recorded in
   `docs/grounded-structured.md`: Gemini rejects grounding and native `jsonSchema` in the same call, and
   the recommended pattern is two calls (grounded research, then structured synthesis) composed by the
   host, not a library helper.
3. **Provider Quota Middleware** (`providerQuotaMiddleware`) — already shipped, not blocking. See
   "Not Currently Blocking" below; this framing was already accurate and is unchanged.

The actual root-cause defect is PostBuzz's own gate script
(`postbuzz-app-v2/scripts/check-any-llm-gate.ts`), which does literal substring-matching for these
exact identifier names inside published tarballs. It is mechanically incapable of ever recognizing a
correct docs-plus-`createClient()`-based host-composition solution, regardless of technical merit.
That is a gate design defect on PostBuzz's side, not evidence of a missing any-llm feature.

A full resolution proposal — including this justification, the recommended gate-script fix, and
PostBuzz's recommended host-side implementation path — has already been written directly into
`postbuzz-app-v2/docs/ANY-LLM-RUNTIME-FACTORY-AND-GROUNDED-RESOLUTION.md` (status: resolved — these
three exports will not be built as `@gullabs/any-llm` library APIs). That is for PostBuzz's own team
to act on; this doc just records the outcome and points there.

## What any-llm Has Actually Shipped

Two smaller, genuinely useful gaps have been closed since the original gate run. Neither is a
prerequisite for PostBuzz's migration to start — they are upgrades PostBuzz can adopt independently,
on its own timeline:

- **Citation normalizer** — `normalizeGroundingCitations` (and a `Citation` type) is exported from
  `@gullabs/google`, re-exported via `packages/google/src/index.ts`.
- **Ambient-auth migration guidance** — `docs/multi-runtime.md` now has a
  `## Migrating off ambient/singleton auth` section covering exactly the pattern PostBuzz needs to
  move off of.

## Useful Existing Building Blocks

These were already available before this resolution and remain the recommended host-composition
primitives for PostBuzz:

- `createClient()`
- `buildGoogleClient()`
- `CallMetadata`
- `buildRecord()`

## Not Currently Blocking

### Provider Quota Middleware

Public identifier:

- `providerQuotaMiddleware`

Current status:

- Present in `@gullabs/quota@0.2.0`. Shipped, not blocking.

## Gate Evidence (Historical)

The following is the PostBuzz gate output that originally motivated this doc. It is preserved here as
evidence, not as current blocking status — see "Resolution Summary" above for why the two `FEATURE
MISSING` lines are resolved rather than pending.

Package versions below are still accurate as of this writing:

- `@gullabs/any-llm@0.4.0`
- `@gullabs/core@0.4.0`
- `@gullabs/google@0.4.0`
- `@gullabs/drizzle@0.3.0`
- `@gullabs/quota@0.2.0`
- `@gullabs/testing@0.2.0`

Original gate output:

```text
OK @gullabs/any-llm@0.4.0
OK @gullabs/core@0.4.0
OK @gullabs/google@0.4.0
OK @gullabs/drizzle@0.3.0
OK @gullabs/quota@0.2.0
OK @gullabs/testing@0.2.0
FEATURE MISSING runtime client factory (P1-T1) - expected createRuntimeClientFactory, buildCallMetadata - in @gullabs/core or @gullabs/any-llm
FEATURE OK provider quota middleware (P1-T1a)
FEATURE MISSING grounded structured helper (P5-T1) - expected runGroundedStructured - in @gullabs/core or @gullabs/any-llm
```

As explained above, the two `FEATURE MISSING` lines reflect the gate script's literal
substring-matching for exact identifier names, not an actual any-llm feature gap. The gate script
itself needs to change; see the resolution proposal referenced above.

PostBuzz gate command:

```sh
pnpm any-llm:gate
```

PostBuzz gate source:

- `/Volumes/SSD/code/work/postbuzz-app-v2/scripts/check-any-llm-gate.ts`
- `/Volumes/SSD/code/work/postbuzz-app-v2/docs/PLAN-any-llm-adoption.md`
