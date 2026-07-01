# PostBuzz Migration Blockers

Last updated: 2026-07-01.

This note records the library-side features currently blocking the PostBuzz migration to
`@gullabs/any-llm`. It is based on PostBuzz's published package/API gate, which checks npm registry
versions and published tarball contents only.

## Current Published Package Set

PostBuzz is gating against these exact published versions:

- `@gullabs/any-llm@0.4.0`
- `@gullabs/core@0.4.0`
- `@gullabs/google@0.4.0`
- `@gullabs/drizzle@0.3.0`
- `@gullabs/quota@0.2.0`
- `@gullabs/testing@0.2.0`

## Blocking Missing Features

### 1. Runtime Client Factory

Blocking PostBuzz phase: `P1-T1`.

Expected public identifiers:

- `createRuntimeClientFactory`
- `buildCallMetadata`

Expected package location:

- `@gullabs/core` or `@gullabs/any-llm`

Current status:

- Missing from the published package tarballs.
- This blocks PostBuzz from starting Phase 1's runtime client factory work.
- PostBuzz must not create a host-side workaround for these helpers.

Why PostBuzz needs it:

- Build one clean runtime boundary for web and worker.
- Keep per-call auth explicit.
- Standardize metadata construction for `llm_calls`.
- Avoid rebuilding app-specific client factory logic in the host.

Useful existing building blocks:

- `createClient()`
- `buildGoogleClient()`
- `CallMetadata`
- `buildRecord()`

### 2. Grounded Structured Helper

Blocking PostBuzz phase: `P5-T1`.

Expected public identifier:

- `runGroundedStructured`

Expected package location:

- `@gullabs/core` or `@gullabs/any-llm`

Current status:

- Missing from the published package tarballs.
- This blocks PostBuzz's grounded call-site migration.
- PostBuzz must not hand-roll a parallel grounded-to-structured helper in the host.

Why PostBuzz needs it:

- Gemini rejects grounding plus native `jsonSchema` in one call.
- PostBuzz grounded call-sites need the library-owned two-step pattern:
  grounded research -> structured synthesis.
- Citation/grounding metadata must carry forward cleanly.

Useful existing building block:

- `packages/core/src/grounded-structured-convention.test.ts` already encodes the desired two-step
  convention as a test. The blocker is to promote that tested convention into an exported helper,
  not to design the pattern from scratch.

## Not Currently Blocking

### Provider Quota Middleware

Related PostBuzz phase: `P1-T1a`.

Public identifier:

- `providerQuotaMiddleware`

Current status:

- Present in `@gullabs/quota@0.2.0`.
- PostBuzz still cannot start `P1-T1a` until `P1-T1` is unblocked, because the plan sequences quota
  consumption after the runtime client factory gate.

## Gate Evidence

Current PostBuzz gate output:

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

PostBuzz gate command:

```sh
pnpm any-llm:gate
```

PostBuzz gate source:

- `/Volumes/SSD/code/work/postbuzz-app-v2/scripts/check-any-llm-gate.ts`
- `/Volumes/SSD/code/work/postbuzz-app-v2/docs/PLAN-any-llm-adoption.md`
