# Adoption Backlog Implementation Plan — `@gullabs/any-llm`

> **Archived.** This is a historical planning/execution record from internal development, kept for
> project history. It is not maintained documentation and may not reflect the current state of the
> library — see the [root README](../../README.md) and [docs/](../) for current, maintained docs.

> **Status:** Draft — pending codex signoff.

---

**There are ZERO clients of this library today. Backward compatibility and breaking changes are
explicitly NOT a concern anywhere in this plan.** Every decision below — every phase, every API
shape, every type change — must be evaluated purely against what produces the cleanest,
highest-quality, forward-facing design. Do not hedge, layer, or soften any change for the sake of
compatibility with something that does not exist.

## Summary

`./ADOPTION-FEEDBACK.md` is the source-checked backlog derived from two host adoption passes
(PostBuzz, RED LINE) plus five independent expert reviews (backend-craft, db-craft, infra-craft,
security-craft, observability-craft, testing-craft) run against the _current_ code, not against
host prose. This plan turns that backlog into an execution-ready, phase-ordered sequence of work.

Three items are already fully shipped and are **not** re-opened by this plan: `@gullabs/quota`
0.1.0 exists (Phase 4 only _hardens_ it), and `docs/ledger.md` / `docs/grounded-structured.md` /
`docs/multi-runtime.md` already exist and are linked from `README.md:537-539` (Phases 3/5/6 only
_amend_ them with specific, reviewer-identified gaps — they are not greenfield doc-writing tasks).
Everything else — reasoning resolution, the `priority` tier decision, a live `serviceTier`
validation-bypass bug, pricing-integrity introspection, the quota package's missing `deny` decision
kind, a caller-owned validation helper, and rate-limiter wait attribution — is new work.

**This is a greenfield library with zero external clients.** Backward compatibility is not a
constraint anywhere in this plan; every design below takes the cleanest breaking shape available
rather than an additive one.

The five expert reviews already reached final conclusions against the current code. **This plan
encodes those conclusions as Owner decisions — implementers must not re-derive, re-argue, or
re-litigate them.** Every file:line citation below was re-verified against the current working tree
while writing this plan (dates/lines may drift slightly by the time you implement; if a citation is
materially wrong, that is a Phase 0 finding, not licence to redesign).

---

## Owner decisions (final — do not re-litigate)

These are binding conclusions from the five expert reviews, cited against the verified current
code. Implementers execute these; they do not re-open the design question.

1. **`resolveReasoning` lives in `@gullabs/core`, next to `registry.ts`.** Consistent with ADR-006
   (`DECISIONS.md:166-197`) and the existing precedent that all Gemini generation-knowledge
   (registry, pricing, config schema) lives in core, not in the Google adapter package.

2. **`admittedReasoningEfforts` becomes a first-class typed field** on
   `ModelDescriptor.capabilities` (`packages/core/src/registry.ts`), populated for every built-in
   descriptor. Today this exists only implicitly as a closure argument to
   `makeGeminiConfigSchema` / `makeGeminiConfigValidator` (verified: `gemini-3.1-pro-preview`'s
   `reasoningEfforts: ['low', 'medium', 'high']` at `registry.ts:425-433`; Gemma 4's
   `reasoningEfforts: ['none', 'high']` at `registry.ts:491-498` and `registry.ts:512-519`). Both
   the config schema/validator AND the new field must read from one shared literal per descriptor —
   no second, independently-maintained list.

3. **`EFFORT_BUDGET` moves from `@gullabs/google` to `@gullabs/core`** and becomes the single
   source of truth for reasoning-effort bucket boundaries. Today it is a private, unexported const
   at `packages/google/src/adapter.ts:48-53` (`none: 0, low: 1024, medium: 8192, high: 24576`).
   `resolveReasoning` in core needs these exact boundaries; core cannot import from `@gullabs/google`
   (the dependency only runs the other way), so the table moves to core and the adapter imports it
   back. **Do not invent a second threshold table in core** — that was explicitly rejected.

4. **Reasoning-effort resolution edge cases — pick ONE rule per case, both final:**

   - **Floor-bucket not admitted, but a higher admitted tier exists** (e.g. Gemma 4 requesting a
     budget that floor-buckets to `'low'` or `'medium'`, neither admitted): **round up** to the
     next-higher admitted tier and return normally. This is a documented, tested, monotonic
     mapping — not a silent behavior.
   - **Floor-bucket is `'none'`, but `'none'` is not admitted** (e.g. `budgetTokens: 0` against
     `gemini-3.1-pro-preview`, which excludes `effort: 'none'`): **throw `LlmError('bad_request',
{ retryable: false })`.** Do not silently escalate a caller's explicit "no reasoning" request
     into a paid reasoning effort. This mirrors how the adapter already throws for models with no
     `reasoningApi` at all (`adapter.ts:360-364`).
   - **Model cannot reason at all** (`capabilities.reasoningApi` undefined): throw
     `LlmError('bad_request')`, mirroring `adapter.ts:360-364` exactly.
   - **`undefined` return value is reserved exclusively for "caller passed nothing to resolve"**
     (`budgetTokens === undefined`). It must never mean "the model rejected this."

5. **Priority service tier: stays UNSUPPORTED.** No `GenConfig.serviceTier` type change, no
   registry `serviceTiers` change. Add an explicit doc comment near `registry.ts:77-81`
   (`capabilities.serviceTiers?: ('flex' | 'standard')[]`) and one line in README's Flex section
   (`README.md:299-324`) stating priority was evaluated and excluded because Gemini Developer API
   pricing/availability for `priority` is unverified.

6. **Independent live bug — fix regardless of the priority decision.** `adapter.ts:272-296`
   validates `serviceTier` against `capabilities.serviceTiers` _before_ `providerOptions.google` is
   merged into `config` via `Object.assign(config, googleOpts)` at `adapter.ts:392`. There is
   currently **no re-validation of `serviceTier` after that merge** — contrast with the sampling
   parameters, which already get a post-merge re-assertion at `adapter.ts:395-420`. A caller can set
   `providerOptions.google.serviceTier` to any string (`'priority'`, a typo, anything) and it
   silently bypasses validation, flows through to `servedServiceTier`, and lands on
   `cost.ts:135`'s `TIER_FACTOR[tier ?? 'standard'] ?? 1`, which falls back to the standard-price
   factor for any unrecognized tier. **This is live billing-drift risk today**, independent of the
   priority-tier decision. Fix: re-validate `config.serviceTier` against
   `capabilities.serviceTiers` immediately after the `providerOptions.google` merge, throwing
   `bad_request` if not admitted — same pattern as the existing fixed-sampling re-assertion.

7. **Ledger sidecar pattern needs NO schema change** to `packages/drizzle/src/schema.ts`. This is
   documentation-only work. The single most important fact to document: because `UsageSink.record()`
   is one call wrapped by the engine's fail-open try/catch (`recordToSink`, `engine.ts:713-730`),
   atomic sidecar+canonical consistency requires the **host** to compose its own `UsageSink` that
   opens one `db.transaction()` wrapping both inserts — and if that transaction fails, **both
   writes roll back together and the LLM call still succeeds** (fail-open), meaning sink failure
   means zero rows exist for that attempt, canonical and sidecar alike.

8. **Pricing strict mode is construction-time, not call-time.** The originally-proposed
   `geminiPricingSource({ strict: true })` throwing from `price()` is broken given current engine
   wiring: `engine.ts:1112-1130` wraps every `pricing.price()` call in a fail-open try/catch that
   downgrades any thrown error to a `Warning` + log — a per-call throw collapses to the same low
   visibility the proposal is trying to fix. Correct fail mode: **at `createClient()`**, mirroring
   the existing duplicate-adapter-id check (`engine.ts:842-852`) and duplicate-middleware-id check
   (`engine.ts:854-866`), both of which throw synchronously at construction. Strict pricing walks
   the resolved `ModelRegistry` at construction time and asserts every registered model's pricing
   resolution satisfies `pricing.hasModel(...)`, throwing there.

9. **`hasModel()` / `listModels()` must use the exact same exact-then-longest-prefix
   resolution** that `computeCost()` already uses (`cost.ts:52-67`, `lookupRates`), not a
   re-implementation, or a boot-time strict-mode pass and a runtime `price()` call can disagree.

10. **An always-on `Warning` fires whenever `cost?.microUsd === null`**, regardless of whether
    strict mode is configured. Today this path (`cost.ts:121-129` returning `{ microUsd: null }`)
    produces zero signal anywhere in the engine (confirmed: no warning is pushed in the success
    path around `engine.ts:1112-1130` when `pricing.price()` _returns_ a null-cost object rather
    than throwing). This is a stronger, independent gap from strict mode and must ship regardless
    of whether a host opts into strict mode.

11. **Default pricing stays fail-open.** ADR-005 (`DECISIONS.md:154-163`) deliberately allows
    `microUsd: null` for Gemma-4 and other unpriced-but-callable models. Strict mode is opt-in only,
    at `createClient()` construction.

12. **This same phase must also call out the new structured-output silence gap** documented in
    `ADOPTION-FEEDBACK.md`'s "New gap: silent structured-output parse failures" section: malformed
    structured output records `status: 'ok'` + `outputParsed: false` with zero other signal
    (`engine.ts:1100-1110`). It is the same class of problem as unpriced-model silence — a host
    alerting only on `status`/`errorKind` misses both. Phase 2's acceptance tests must cover this
    explicitly as the motivating driver alongside strict pricing, even though the code fix for it is
    the caller-owned validation helper in Phase 7.

13. **Quota package boundary (`@gullabs/quota`, not core) is correct — no change.** Consistent with
    the `RateLimiter` port doc already describing an Upstash-backed distributed implementation as a
    separate package (`ports.ts:207-223`).

14. **`QuotaDecision` needs a third `kind: 'deny'` variant**, separate from `kind: 'defer'`.
    Today `packages/quota/src/index.ts:40-47` folds `provider_disabled` into `defer`'s `reason`
    string, conflating "come back in N ms" with "this is permanently off" — a caller has to
    string-match `reason` to know whether to reschedule quietly or escalate. This mirrors the
    repo's existing convention of discriminated unions for severity distinctions (`LlmErrorKind`).

15. **`createClient()`'s fail-open-by-default rate limiting is a conscious decision, not an
    oversight** — must be stated plainly in both `@gullabs/quota`'s docs and cross-referenced from
    `ports.ts`'s `RateLimiter` doc comment (`ports.ts:207-223`). `createClient()` defaults to
    `NOOP_RATE_LIMITER` (`engine.ts:260-264`, wired at `engine.ts:838`) when no `rateLimiter` is
    configured. Production Gemini traffic must wire at minimum `inMemoryRateLimiter` (single-node)
    or `@gullabs/quota` (multi-instance).

16. **The quota package's docs must name a known limitation**: `classifyError` maps every HTTP 429
    uniformly to `kind: 'rate_limited'` (`errors.ts:188-193`); the only capacity-vs-quota
    distinguishing signal in the whole codebase is regex matching on error message text in
    `packages/google/src/flex-fallback.ts`'s `CAPACITY_PATTERNS` / `QUOTA_PATTERNS` — an
    unversioned prose contract with Google's API. A false positive there converts a
    quota-exhausted 429 into an actual **paid** standard-tier call — asymmetric risk (false
    negative loses availability; false positive spends money). Additionally, `RateLimiter.acquire`
    is keyed `"${provider}:${model}"` with no tier component (`ports.ts:185-187`) and runs once per
    logical call _before_ the adapter — so the in-adapter flex→standard fallback
    (`adapter.ts:605-641`) has no seam for any future tier-aware quota policy to gate it. Document
    this as a named limitation, not a TODO to silently fix later.

17. **Grounded-to-structured correlation: mandate ONE field.** `docs/grounded-structured.md`
    currently names two options (`metadata` and `externalId`) with no single mandated convention
    (verified: `docs/grounded-structured.md:35-41` and `:127-134` use both `externalId: reportId`
    and ad-hoc `metadata` keys with no canonical linking key). Fix: mandate
    `metadata.operationId`, set identically on both the grounded-research call and the
    structured-synthesis call, as the canonical link. A test must assert
    `sink.records[0].metadata.operationId === sink.records[1].metadata.operationId` with distinct
    `attemptId`s. This convention is reused by the multi-runtime example (Phase 6) — one shared
    convention, not two.

18. **`docs/multi-runtime.md` must state explicitly that `RecordingSink` does not dedupe on
    `attemptId`.** Verified: `packages/testing/src/recording-sink.ts:44-48` — `record()`
    unconditionally does `this.records.push(r)`; the `onConflictDoNothing` dedup behavior is
    `drizzleUsageSink`-specific (`packages/drizzle/src/sink.ts:60-63`). A reader simulating
    "Temporal retries the whole activity with the same `idempotencyKey`" against `RecordingSink` in
    tests will see two rows, not one, and must not assume in-memory dedup during local testing.

19. **Caller-owned validation helper: pure post-processing, zero core changes.** `output: unknown` +
    `outputParsed: boolean` is sufficient signal (`types.ts:369-374`). Both required failure-mode
    test cases — wrong-shape-but-parsed, and malformed-JSON-unparsed — are already reachable via
    existing `@gullabs/testing` fakes (`FakeAdapter`, `fakeGeminiResponse({ structuredJson: 'not
valid json' })` at `packages/testing/src/fake-gemini.ts:114`). No new fake is needed for this
    item. The helper aligns with the `'~standard'` Standard-Schema convention already used
    internally (`engine.ts:1021-1024`, `packages/core/src/standard-schema.ts`) rather than
    inventing a second validation convention.

20. **Rate-limiter wait attribution: fix a latent `latencyMs` bug in the same pass, not as a
    separate future task.** `attemptStartMs` is captured at `engine.ts:969`, _before_
    config-validation, routing, rate-limiter acquire, and adapter dispatch. Both `latencyMs`
    computations (success at `engine.ts:1140`, error at `engine.ts:1209`) currently measure from
    that point — meaning today's `latencyMs` silently includes rate-limiter queue wait under a name
    that implies pure provider round-trip time. This must be corrected in the same change that adds
    `queueDelayMs`, so `latencyMs` becomes provider-dispatch-only time.

21. **`queueDelayMs` ships as BOTH a structured log field AND a numeric column** on
    `LlmResult` / `LlmCallRecord` / drizzle — not log-only. It is a low-cardinality numeric fact of
    the same shape as `latencyMs` / `costMicroUsd`, and quota-cost attribution needs it in the
    ledger hosts already trust for billing.

22. **A new `@gullabs/testing` fake is required**: `packages/testing/src/rate-limiter.ts` today
    only re-exports `inMemoryRateLimiter` (a concurrency cap with no injectable wait) — there is
    currently no way to test `queueDelayMs` without hand-rolling a fake. Ship `scriptedRateLimiter`.

---

## Execution handoff

### Execution rules for subagents

- **Do not re-litigate the 22 Owner decisions above.** Report only implementation blockers, source
  drift discovered in Phase 0, or test failures.
- **No backward-compatibility shims, deprecated aliases, "just in case" additive fields, feature
  flags, or migration/compat code paths in any phase.** There are no existing clients to preserve
  compatibility for — every phase ships the cleanest shape directly, not an additive or
  transitional one.
- **Keep phases ordered where file overlap exists.** Phase 1 and Phase 2 both touch
  `packages/core/src/registry.ts` — Phase 2 must not start until Phase 1's registry changes have
  landed in the working branch. See the per-phase "File overlap" note for every other phase.
- **No live network in tests.** Use `FakeAdapter`, `SignalAwareFakeAdapter`, `RecordingSink`,
  `FakeIds`, `FakeClock`, and Gemini fakes from `packages/testing/src/` exactly as the existing
  suite does.
- **Do not touch SPEC.md, docs/architecture.md, or CHANGELOG.md content that was already fixed** in
  the prior validation pass (confirmed clean by the ADOPTION-FEEDBACK.md validation pass) — only
  the Final phase's specific, listed doc updates below are in scope.
- **Preserve the strict-input / fail-closed-call / fail-open-side-effects boundary** from
  `PLAN-integration-fixes.md` and SPEC.md's non-negotiable invariants. None of the 8 phases below
  loosen it: bad input still fails before network I/O; sink/telemetry/cost failures still never
  fail the call.
- **Prefer narrow commits by phase.** Each phase should compile and pass its focused tests before
  the next phase starts. If agents work concurrently in separate worktrees, they must merge through
  the phase order below and hand-reconcile any shared-file conflicts noted per phase.

### Parallelization matrix

| Phase | Can start in parallel with | Must wait for                                                                       | Shared-file conflict risk                                                 |
| ----- | -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0     | — (runs first, alone)      | —                                                                                   | —                                                                         |
| 1     | 3, 5, 7                    | 0                                                                                   | `registry.ts`, `index.ts`, `types.ts` shared with Phase 8 (low: additive) |
| 2     | 5, 7                       | 0, **1** (same file: `registry.ts`)                                                 | `ports.ts` shared with Phase 4 (see below)                                |
| 3     | 1, 2, 4, 5, 6, 7, 8        | 0                                                                                   | `README.md` touched by Phases 1, 5, Final — different sections, low risk  |
| 4     | 3, 5, 7                    | 0, **2** (same file: `ports.ts` doc comment)                                        | —                                                                         |
| 5     | 1, 2, 3, 4, 7              | 0                                                                                   | new test file only; no code overlap                                       |
| 6     | 3, 4, 7                    | 0, **5** (reuses `operationId` convention)                                          | `docs/multi-runtime.md` only                                              |
| 7     | 1, 2, 3, 4, 5, 6           | 0                                                                                   | new doc + new test file; no code overlap                                  |
| 8     | 3, 4, 6, 7                 | 0, **1** (shares `types.ts`/`index.ts`), recommend after **2** (shares `engine.ts`) | `engine.ts`, `record.ts`, `schema.ts`                                     |
| Final | —                          | all of 1-8                                                                          | touches every doc                                                         |

---

## Phase 0 — baseline seam check

**Owner:** one reviewer/agent before any implementation starts.

**Objective:** confirm every file:line anchor cited in this plan still matches the working tree.
This phase does not implement anything.

**Files to inspect:**

- `packages/core/src/registry.ts`, `types.ts`, `ports.ts`, `cost.ts`, `pricing.ts`, `engine.ts`,
  `retry.ts`, `record.ts`, `errors.ts`, `standard-schema.ts`, `index.ts`
- `packages/google/src/adapter.ts`, `client.ts`, `flex-fallback.ts`
- `packages/drizzle/src/schema.ts`, `sink.ts`
- `packages/quota/src/index.ts`, `index.test.ts`, `README.md`
- `packages/testing/src/rate-limiter.ts`, `recording-sink.ts`, `fake-gemini.ts`
- `docs/ledger.md`, `docs/grounded-structured.md`, `docs/multi-runtime.md`
- `README.md`, `ROADMAP.md`, `DECISIONS.md`

**Required checks:**

- Confirm `EFFORT_BUDGET` is still a private const at `adapter.ts:48-53` with values
  `{ none: 0, low: 1024, medium: 8192, high: 24576 }`.
- Confirm `adapter.ts:392`'s `Object.assign(config, googleOpts)` still has no post-merge
  `serviceTier` re-check (the live bug from Owner decision 6).
- Confirm `PricingSource` (`ports.ts:263-274`) still has only `version` + `price()`.
- Confirm `cost.ts`'s success path (`engine.ts:1112-1130`) still pushes no warning when
  `cost.microUsd === null`.
- Confirm `packages/quota/src/index.ts:40-47`'s `QuotaDecision` still folds `provider_disabled`
  into `defer`.
- Confirm `docs/grounded-structured.md` still lacks an `operationId` convention and
  `docs/multi-runtime.md` still lacks the `RecordingSink` non-dedupe caveat.
- Confirm `engine.ts:969`'s `attemptStartMs` is still captured before rate-limiter acquire, and
  that `latencyMs` at both `engine.ts:1140` and `:1209` is still computed from it.
- Confirm all test fakes named throughout this plan (`FakeAdapter`, `RecordingSink`, `FakeIds`,
  `FakeClock`, `fakeGeminiResponse`, `SignalAwareFakeAdapter`) still exist with the signatures used
  below.

**Deliverable:** `BASELINE OK`, or an itemized list of drift with the corrected line numbers, before
Phase 1 starts.

---

## Phase 1 — Reasoning resolution + priority tier decision + serviceTier bypass fix

**Owner:** core/google types-and-adapter agent (backend-craft lineage).

**Objective:** ship `resolveReasoning()` in core with an exported, tested edge-case policy; encode
the priority-tier exclusion as a documented decision; fix the live `providerOptions.google`
serviceTier validation bypass.

**Files likely touched:**

- `packages/core/src/registry.ts`
- `packages/core/src/reasoning.ts` (new)
- `packages/core/src/types.ts`
- `packages/core/src/index.ts`
- `packages/core/src/reasoning.test.ts` (new)
- `packages/google/src/adapter.ts`
- `packages/google/src/adapter.test.ts`
- `README.md` (Flex/service-tier section only)

**File overlap:** `registry.ts` and `index.ts` are also touched by Phase 2 (Phase 2 must wait) and
Phase 8 (additive only, low risk).

**Concrete tasks:**

1. Add `admittedReasoningEfforts?: ReadonlyArray<'none' | 'low' | 'medium' | 'high'>` to
   `ModelDescriptor['capabilities']` in `registry.ts`, next to `reasoningApi` (near
   `registry.ts:52-58`).
2. For every entry in `geminiModelDescriptors` and `gemmaModelDescriptors`, populate
   `admittedReasoningEfforts` from the SAME literal already passed (or defaulted) to
   `makeGeminiConfigSchema` / `makeGeminiConfigValidator` for that descriptor — do not introduce a
   second list. Concretely:
   - All Gemini 2.5 entries, `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`:
     `admittedReasoningEfforts: ['none', 'low', 'medium', 'high']` (the schema/validator default).
   - `gemini-3.1-pro-preview`: `admittedReasoningEfforts: ['low', 'medium', 'high']` (matches the
     existing `reasoningEfforts` argument at `registry.ts:427` / `:431`).
   - Both Gemma 4 descriptors: `admittedReasoningEfforts: ['none', 'high']` (matches
     `registry.ts:493` / `:497` and `:514` / `:518`).
3. Create `packages/core/src/reasoning.ts` and move `EFFORT_BUDGET` there as an exported const:

   ```ts
   // packages/core/src/reasoning.ts
   /**
    * Reasoning-effort → thinkingBudget token mapping. Single source of truth for
    * both the Gemini adapter's 'budget'-API mapping and resolveReasoning's
    * bucket boundaries for 'level'-API models.
    */
   export const EFFORT_BUDGET: Record<'none' | 'low' | 'medium' | 'high', number> = {
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

     // reasoningApi === 'level': map the numeric budget into an admitted effort tier.
     const admitted = descriptor?.capabilities?.admittedReasoningEfforts ?? TIER_ORDER
     const bucket = floorBucket(input.budgetTokens)

     if (admitted.includes(bucket)) {
       return { effort: bucket }
     }

     // Special case: caller asked for NO reasoning (bucket === 'none') but the model
     // requires some. Never silently escalate a "none" request into a paid effort.
     if (bucket === 'none') {
       throw new LlmError(
         `Model "${input.model}" requires reasoning; budgetTokens: ${input.budgetTokens} ` +
           `requests no reasoning ("none"), but this model only admits: ${admitted.join(
             ', ',
           )}.`,
         { kind: 'bad_request', retryable: false },
       )
     }

     // General case: round UP to the next-higher admitted tier (documented, tested,
     // monotonic — e.g. Gemma 4's binary none/high admission).
     const startIdx = TIER_ORDER.indexOf(bucket)
     for (let i = startIdx + 1; i < TIER_ORDER.length; i++) {
       const candidate = TIER_ORDER[i]
       if (candidate !== undefined && admitted.includes(candidate)) {
         return { effort: candidate }
       }
     }

     throw new LlmError(
       `Model "${input.model}" has no admitted reasoning effort at or above bucket "${bucket}"; ` +
         `admitted efforts: ${admitted.join(', ')}.`,
       { kind: 'bad_request', retryable: false },
     )
   }
   ```

   (Imports of `LlmError`, `ModelRegistry`, `ReasoningEffort` omitted above for brevity — wire them
   from `./errors.js` and `./registry.js` / `./types.js` respectively.)

4. Add `export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high'` to `types.ts` near
   `ReasoningIntent` (`types.ts:151-165`), and change `ReasoningIntent.effort` to
   `effort?: ReasoningEffort` (same union, now named).
5. Update `packages/google/src/adapter.ts` to import `EFFORT_BUDGET` from `@gullabs/core` instead
   of defining it locally; delete the local const at `adapter.ts:48-53`. No behavior change — same
   values, single source.
6. Export `resolveReasoning`, `ResolveReasoningInput`, `ResolvedReasoning`, `EFFORT_BUDGET`, and the
   new `ReasoningEffort` type from `packages/core/src/index.ts`.
7. Add a doc comment directly above `capabilities.serviceTiers` (`registry.ts:77-81`):
   ```ts
   /**
    * Provider service tiers safe to send to the SDK for this model.
    * Omit when the adapter should not emit serviceTier at all.
    *
    * `priority` is intentionally NOT a member of this union. It was evaluated
    * and excluded: Gemini Developer API pricing and availability semantics for
    * `priority` are unverified. Revisit only after confirming both with Google.
    */
   serviceTiers?: ('flex' | 'standard')[]
   ```
   Add one corresponding sentence to README's Flex section (`README.md:299-324`): state that
   `priority` was evaluated and intentionally excluded pending verified Google pricing/availability.
8. Fix the live bypass bug (Owner decision 6). Immediately after the `providerOptions.google` merge
   block (`adapter.ts:386-393`) and before the existing fixed-sampling re-assertion
   (`adapter.ts:395-420`), add:
   ```ts
   // ------------------------------------------------------------------
   // 5a. Re-assert serviceTier validity AFTER providerOptions merge.
   //     providerOptions.google is a last-write-wins escape hatch; without this
   //     re-check a caller can inject an arbitrary serviceTier string (e.g.
   //     'priority') that bypasses the step-2 validation, reaches
   //     servedServiceTier, and silently falls back to the standard-rate
   //     TIER_FACTOR in cost.ts — a billing-drift risk.
   // ------------------------------------------------------------------
   const mergedServiceTier = (config as { serviceTier?: string }).serviceTier
   if (mergedServiceTier !== undefined && req.modelDescriptor !== undefined) {
     const supportedAfterMerge = req.modelDescriptor.capabilities?.serviceTiers
     if (
       supportedAfterMerge === undefined ||
       !supportedAfterMerge.includes(mergedServiceTier as 'flex' | 'standard')
     ) {
       throw new LlmError(
         `serviceTier "${mergedServiceTier}" is not supported for model "${model}".`,
         { kind: 'bad_request', retryable: false },
       )
     }
   }
   ```

**Focused acceptance tests:**

- `resolveReasoning({ budgetTokens: undefined, ... })` returns `undefined`.
- `resolveReasoning` against `gemini-2.5-pro` (reasoningApi `'budget'`) passes `budgetTokens`
  through unchanged for any value, including `0`.
- `resolveReasoning` against `gemini-3.1-flash-lite` maps `0 → 'none'`, `1024 → 'low'`,
  `8192 → 'medium'`, `24576 → 'high'`, and in-between values floor correctly (e.g. `4000 → 'low'`).
- `resolveReasoning` against `gemini-3.1-pro-preview` with `budgetTokens: 0` **throws
  `bad_request`** (never returns `effort: 'none'` or escalates silently).
- `resolveReasoning` against `gemini-3.1-pro-preview` with `budgetTokens: 500` (floor bucket
  `'none'`, not admitted, but this is NOT the zero-floor special case since the request maps to a
  non-`'none'` intent only if... — assert precisely: any `budgetTokens` value that floor-buckets to
  `'none'` always throws for this model, since `'none'` is never admitted here.
- `resolveReasoning` against both Gemma 4 descriptors: `budgetTokens: 0 → 'none'` (admitted
  directly); `budgetTokens: 2000` (floor bucket `'low'`, not admitted) → rounds up to `'high'`;
  `budgetTokens: 10000` (floor bucket `'medium'`, not admitted) → rounds up to `'high'`.
- `resolveReasoning` against a model with no `reasoningApi` (construct a test descriptor with
  `capabilities: {}`) throws `bad_request`.
- Adapter test: `EFFORT_BUDGET` values used by the adapter's `'budget'`-API mapping are identical
  to the ones imported from `@gullabs/core` (no drift possible — same object).
- Adapter test: explicit `config.serviceTier: 'flex'` on a `flex`-only-unsupported model still
  throws pre-merge (unchanged behavior).
- **New** adapter test: `providerOptions.google.serviceTier: 'priority'` (or any unsupported
  string) on a model whose `capabilities.serviceTiers` is `['flex', 'standard']` throws
  `bad_request` — this test MUST fail against the pre-fix adapter (proves the bug existed and is
  now closed).
- **New** adapter test: `providerOptions.google.serviceTier: 'standard'` (an admitted tier) still
  succeeds after the fix — proves the re-check isn't overly strict.

**Phase gate:** all Phase 1 tests pass; `rg "EFFORT_BUDGET" packages/google/src/adapter.ts` shows
only the import, not a redeclaration; `pnpm --filter @gullabs/core --filter @gullabs/google build`
succeeds.

---

## Phase 2 — Pricing integrity: introspection, construction-time strict mode, always-on warning

**Owner:** core pricing/engine agent (infra-craft + security-craft lineage).

**Objective:** add `hasModel()` / `listModels()` to `PricingSource`; add opt-in construction-time
strict pricing to `createClient()`; add an always-on `Warning` whenever a call's cost is unpriced;
explicitly call out the structured-output silent-parse-failure gap as a co-driver.

**Files likely touched:**

- `packages/core/src/ports.ts`
- `packages/core/src/cost.ts`
- `packages/core/src/registry.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/cost.test.ts`
- `packages/core/src/engine.test.ts`

**File overlap:** `registry.ts` was touched by Phase 1 (must have landed first). `ports.ts` is also
touched by Phase 4 (doc-comment only) — sequence Phase 4 after this phase, or hand-merge.

**Concrete tasks:**

1. Add `hasModel(model: string): boolean` and `listModels(): readonly string[]` to `PricingSource`
   in `ports.ts:263-274`:
   ```ts
   export interface PricingSource {
     version: string
     price(model: string, usage: Usage, tier?: string): Cost
     /** True when `model` resolves to a priced entry via the same exact/prefix rules as `price()`. */
     hasModel(model: string): boolean
     /** All model keys this source can price (exact-match keys only, not derived prefixes). */
     listModels(): readonly string[]
   }
   ```
2. Implement both in `geminiPricingSource()` (`cost.ts:183-190`) by reusing the exact SAME
   `lookupRates()` helper `computeCost()` already calls (`cost.ts:52-67`) — do not re-implement
   prefix matching:
   ```ts
   export function geminiPricingSource(): PricingSource {
     return {
       version: pricingVersion,
       price(model: string, usage: Usage, tier?: string): Cost {
         return computeCost(model, usage, tier)
       },
       hasModel(model: string): boolean {
         return lookupRates(model) !== undefined
       },
       listModels(): readonly string[] {
         return Object.keys(GEMINI_PRICING)
       },
     }
   }
   ```
3. Add an optional enumeration method to `ModelRegistry` (`registry.ts:105-107`) so strict mode can
   walk every registered descriptor:
   ```ts
   export interface ModelRegistry {
     resolve(model: string): ModelDescriptor | undefined
     /**
      * Optional: enumerate every descriptor this registry knows about. Required
      * for `ClientConfig.strictPricing` to walk the full registered model set at
      * construction time. Custom registries that omit this cannot use strict mode.
      */
     listDescriptors?(): readonly ModelDescriptor[]
   }
   ```
   Implement it on the object returned by `createModelRegistry` (`registry.ts:134-151`):
   ```ts
   return {
     resolve(model: string): ModelDescriptor | undefined {
       /* unchanged */
     },
     listDescriptors(): readonly ModelDescriptor[] {
       return descriptors.slice()
     },
   }
   ```
4. Add `strictPricing?: boolean` to `ClientConfig` in `engine.ts` (near the `pricing` field,
   `engine.ts:66-73`), documented as opt-in and construction-time only.
5. In `createClient()`, immediately after the duplicate-middleware-id check
   (`engine.ts:854-866`) and before building `routeFn`, add the strict-pricing walk:
   ```ts
   if (config.strictPricing === true) {
     const descriptors = registry.listDescriptors?.()
     if (descriptors === undefined) {
       throw new LlmError(
         'strictPricing requires a ModelRegistry that implements listDescriptors(); ' +
           'the configured custom registry does not.',
         { kind: 'bad_request', retryable: false },
       )
     }
     for (const d of descriptors) {
       const pricingKey = d.pricingFamily ?? d.id
       if (!pricing.hasModel(pricingKey)) {
         throw new LlmError(
           `strictPricing: model "${d.id}" (pricing key "${pricingKey}") has no entry in the ` +
             `configured PricingSource.`,
           { kind: 'bad_request', retryable: false },
         )
       }
     }
   }
   ```
6. Add the always-on unpriced `Warning` inside `runAttempt`'s cost try/catch
   (`engine.ts:1112-1130`), immediately after a successful `pricing.price()` call and before the
   warnings are collected at `engine.ts:1132-1137`:
   ```ts
   if (cost !== undefined && cost.microUsd === null) {
     costWarnings.push({
       type: 'other',
       message: `Model "${req.model}" is unpriced (cost.microUsd is null); usage was recorded but not costed.`,
     })
   }
   ```
   This fires unconditionally — independent of `strictPricing` — since strict mode only prevents
   the call from ever routing to an unpriced model; the warning covers hosts that don't opt in.

**Focused acceptance tests:**

- `geminiPricingSource().hasModel('gemini-2.5-pro')` → `true`; `.hasModel('gemini-2.5-pro-001')` →
  `true` (prefix match); `.hasModel('gemma-4-31b-it')` → `false` (intentionally unpriced).
- `geminiPricingSource().listModels()` returns exactly `Object.keys(GEMINI_PRICING)`.
- `createClient({ strictPricing: true, ... })` with the default registry (which includes Gemma 4,
  unpriced) throws synchronously at construction — never reaches a call.
- `createClient({ strictPricing: true, ... })` with a custom registry containing only priced
  Gemini models constructs successfully.
- `createClient({ strictPricing: true, modelRegistry: someCustomRegistryWithoutListDescriptors,
... })` throws a clear `bad_request` naming the missing `listDescriptors()` requirement.
- `createClient({ /* strictPricing omitted */ })` calling Gemma 4 still succeeds with
  `cost.microUsd: null` (fail-open default preserved — ADR-005 unchanged) AND the result/record now
  carries a `Warning` with `type: 'other'` mentioning "unpriced".
- Regression: a priced-model call produces no unpriced warning.
- Regression test explicitly citing the "New gap" motivation: a `FakeAdapter` scripted to return no
  `rawStructured` for an `output.jsonSchema` request still returns `status: 'ok'` +
  `outputParsed: false` with **no thrown error** — confirming this phase does not change that
  behavior (the fix for the silent-parse gap is the Phase 7 validation helper, not this phase); this
  test exists here only to document the boundary between the two fixes.

**Phase gate:** all Phase 2 tests pass; `pnpm --filter @gullabs/core build && pnpm --filter
@gullabs/core test` green; no existing cost/engine test asserting `warnings: []` for an unpriced
call remains unmodified (those must be updated to expect the new warning).

---

## Phase 3 — Ledger sidecar documentation (docs-only)

**Owner:** docs agent (db-craft lineage). No source changes.

**Objective:** amend the already-shipped `docs/ledger.md` with the transaction-composition recipe,
index-coverage-honest query examples, explicit retention/deletion language, and the
`callId`→`attemptId` 1:many clarification. This phase does not create a new document.

**Files likely touched:**

- `docs/ledger.md`
- `packages/drizzle/README.md` (cross-reference only, if it exists and mentions ledger patterns)

**File overlap:** none with code phases. Shares `README.md`'s doc-links section with other phases
only if that section needs a wording tweak (it does not — the existing links at `README.md:537-539`
already point at `docs/ledger.md`).

**Concrete tasks:**

1. Insert a new `## Atomic sidecar writes (transaction composition)` section into
   `docs/ledger.md`, immediately after the existing `## Recommended sidecar pattern` section
   (currently ending at `docs/ledger.md:69`, right before `## Query examples`). Reproduce this
   example verbatim:
   ```ts
   function hostUsageSink(db: NodePgDatabase): UsageSink {
     return {
       async record(r: LlmCallRecord): Promise<void> {
         await db.transaction(async (tx) => {
           await tx.insert(llmCalls).values(mapRecord(r)).onConflictDoNothing({ target: llmCalls.attemptId })
           const ctx = r.metadata as { matterId?: string; auditRunId?: string }
           if (ctx?.matterId) {
             await tx.insert(llmCallContext).values({ attemptId: r.attemptId, matterId: ctx.matterId, ... })
               .onConflictDoNothing({ target: llmCallContext.attemptId })
           }
         })
       },
     }
   }
   ```
   State explicitly, right below the snippet: **the engine's `recordToSink` wraps this whole
   `UsageSink.record()` call in a fail-open try/catch (`engine.ts:713-730`). If the transaction
   above fails, both writes roll back together and the LLM call still succeeds — meaning a sink
   failure means zero rows exist for that attempt, canonical and sidecar alike.** This is the
   single most important correctness fact in this document.
2. Add the example sidecar schema with domain anchors (matches this repo's schema conventions),
   as an alternative/richer version of the existing minimal example at `docs/ledger.md:56-68`:
   ```ts
   export const llmCallContext = pgTable(
     'llm_call_context',
     {
       attemptId: text('attempt_id')
         .primaryKey()
         .references(() => llmCalls.attemptId, { onDelete: 'cascade' }),
       matterId: text('matter_id').notNull(),
       auditRunId: text('audit_run_id'),
       documentId: text('document_id'),
       moduleId: text('module_id'),
       inputR2Key: text('input_r2_key'),
       debugPayload: jsonb('debug_payload'),
       createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
     },
     (table) => [
       index('llm_call_context_matter_id_idx').on(table.matterId),
       index('llm_call_context_audit_run_id_idx').on(table.auditRunId),
       index('llm_call_context_document_id_idx').on(table.documentId),
     ],
   )
   ```
   Note that `attemptId` as PK+FK (no surrogate id) is correct for a 1:1 extension, and `ON DELETE
CASCADE` is the right default even though `llm_calls` has no delete path today (append-only) —
   it is correct for whenever retention/deletion ships.
3. Rewrite the `## Query examples` section (`docs/ledger.md:80-144`) to be index-coverage-honest.
   Annotate each existing query with which index backs it:
   - Spend by day (`docs/ledger.md:82-92`): note this is a **seq-scan today** — `created_at` has no
     index; call out `date_trunc` aggregation cost at scale, measure before relying on it.
   - Failures by call-site (`docs/ledger.md:94-105`): note `call_site_id` has **no index today**
     (`schema.ts` only indexes `call_id` and `external_id`) — seq-scan, measure-later.
   - Retries by model (`docs/ledger.md:107-117`): no index needed (full-table aggregation by
     design) — but add the explicit clarification from task 4 below.
   - Grounded-call audit (`docs/ledger.md:119-129`): note the `provider_metadata ? 'groundingMetadata'`
     JSONB containment query has **no GIN index today** — seq-scan; a GIN index on
     `provider_metadata` is a future addition if this query becomes hot.
   - Host-domain join (`docs/ledger.md:131-144`): this one IS index-backed on both sides — join key
     `attempt_id` is the PK on `llm_calls` (via `attemptId: text('attempt_id').primaryKey()`,
     `schema.ts:16`) and the PK on the sidecar (`attemptId` in task 2's example) — flag this as the
     one query in the set that's efficient without further work.
4. Add an explicit clarification near the retries-by-model example: **`callId` → `attemptId` is
   1:many.** In-process retries (via `retryMiddleware`) suffix later attempts' ids as `key:2`,
   `key:3`, etc. (or generate fresh UUIDs when no `idempotencyKey` was supplied) — so
   `count(*) filter (where attempt_number > 1)` correctly counts retry attempts across all logical
   calls, and `count(distinct call_id)` correctly counts logical calls, not attempts.
5. Add one sentence stating retention/deletion is **entirely host-owned** — no TTL / `deleted_at`
   column ships today in `llm_calls`; the sidecar's `ON DELETE CASCADE` only matters once a host
   builds its own deletion path.

**Focused acceptance tests:** none (docs-only phase). Acceptance is a manual read-through checklist:

- The transaction-composition snippet matches the verbatim block above exactly.
- Every query example states its index-coverage status explicitly (no query is silently presented
  as free).
- The fail-open sink rollback fact appears prominently, not buried in a footnote.
- The 1:many `callId`→`attemptId` clarification is present and correctly worded.

**Phase gate:** `docs/ledger.md` renders correctly (markdown lint if configured); no other doc or
source file changed.

---

## Phase 4 — Quota package hardening: `deny` kind, fail-open cross-reference, known limitations

**Owner:** infra-craft + security-craft lineage agent.

**Objective:** add the missing `kind: 'deny'` variant to `QuotaDecision`; make the
`NOOP_RATE_LIMITER` fail-open default an explicit, cross-referenced decision; document the
429-classification and no-tier-component known limitations.

**Files likely touched:**

- `packages/quota/src/index.ts`
- `packages/quota/src/index.test.ts`
- `packages/quota/README.md`
- `packages/core/src/ports.ts` (doc comment only)

**File overlap:** `ports.ts` was touched by Phase 2 (interface change) — this phase only edits a
doc comment on a different interface (`RateLimiter`, not `PricingSource`); sequence after Phase 2 to
avoid merge noise, but there is no type-level conflict.

**Concrete tasks:**

1. Split `QuotaDecision` (`packages/quota/src/index.ts:40-47`) into three kinds:

   ```ts
   export type QuotaDeferReason = 'rpm_exhausted' | 'rpd_exhausted'
   export type QuotaDenyReason = 'provider_disabled'

   export type QuotaDecision =
     | { kind: 'allow' }
     | { kind: 'defer'; retryAfterMs: number; scope: string; reason: QuotaDeferReason }
     | { kind: 'deny'; scope: string; reason: QuotaDenyReason }
   ```

2. Update `QuotaEvent` (`index.ts:49-68`) to add a `type: 'deny'` variant carrying
   `Extract<QuotaDecision, { kind: 'deny' }>`, mirroring the existing `type: 'defer'` variant.
3. Update `checkProviderQuota()`'s `rpd === 0` branch (currently `index.ts:171-178`, returning
   `{ kind: 'defer', scope, retryAfterMs: 0, reason: 'provider_disabled' }`) to return
   `{ kind: 'deny', scope, reason: 'provider_disabled' }` instead — no `retryAfterMs`, since deny is
   permanent, not a retry-later signal.
4. Update `enforceProviderQuota()` (`index.ts:216-253`) to branch on `decision.kind`:
   - `'allow'` — unchanged.
   - `'defer'` — emit `type: 'defer'`, throw `LlmError('rate_limited', { retryable: true,
retryAfterMs: decision.retryAfterMs })` (both defer reasons are now always retryable — the
     `!== 'provider_disabled'` conditional is removed since that reason no longer exists on
     `defer`).
   - `'deny'` — emit `type: 'deny'`, throw `LlmError('rate_limited', { retryable: false })` (no
     `retryAfterMs` — permanent).
5. Split `messageForDefer()` (`index.ts:357-373`) into `messageForDefer()` (rpm/rpd only) and
   `messageForDeny()` (provider_disabled only), each with an exhaustive switch so a future reason
   addition fails to compile until handled.
6. Update `packages/quota/src/index.test.ts:44-56` ("treats rpd=0 as provider-disabled") to assert
   `{ kind: 'deny', scope: '...', reason: 'provider_disabled' }` instead of the old `defer` shape,
   and add a new assertion that the thrown `LlmError` from `enforceProviderQuota` in this case has
   `retryable: false` and no `retryAfterMs`.
7. Update `packages/quota/README.md` to state plainly: `createClient()` defaults to
   `NOOP_RATE_LIMITER` when no `rateLimiter` is configured — this is a **conscious fail-open
   decision**, not an oversight, and production Gemini traffic must wire at minimum
   `inMemoryRateLimiter` (single-node) or `@gullabs/quota` (multi-instance).
8. Add a "Known limitations" section to `packages/quota/README.md` covering:
   - `classifyError` maps every 429 to `kind: 'rate_limited'` uniformly; the only capacity-vs-quota
     distinguishing signal anywhere in the codebase is regex text-matching in
     `@gullabs/google`'s `flex-fallback.ts` (`CAPACITY_PATTERNS` / `QUOTA_PATTERNS`) — an
     unversioned prose contract with Google's API, with asymmetric failure cost (a false positive
     there spends money on standard-tier traffic; a false negative only loses availability).
   - `RateLimiter.acquire` is keyed `"${provider}:${model}"` with no tier component and runs once
     per logical call _before_ the adapter; the in-adapter flex→standard fallback has no seam for a
     future tier-aware quota policy to gate the standard-tier leg specifically.
9. Cross-reference the same fail-open-default fact from `ports.ts`'s existing `RateLimiter` doc
   comment (`ports.ts:207-223`) — add one sentence pointing readers at `@gullabs/quota`'s README for
   the full known-limitations discussion.

**Focused acceptance tests:**

- `checkProviderQuota()` against a model with `rpd: 0` returns `{ kind: 'deny', scope, reason:
'provider_disabled' }` (no `retryAfterMs` field present at all, not merely `undefined`).
- `enforceProviderQuota()` on that same model throws `LlmError` with `kind: 'rate_limited'`,
  `retryable: false`, and `retryAfterMs` absent.
- `enforceProviderQuota()` on rpm/rpd exhaustion (non-disabled model) still throws `retryable: true`
  with a `retryAfterMs` present — unchanged from current behavior other than the type split.
- `onEvent` receives a `{ type: 'deny', ... }` event (not `{ type: 'defer', ... }`) for the
  disabled-model case.
- Exhaustiveness: `messageForDeny` and `messageForDefer` both have a `default: { const exhaustive:
never = ...; }` pattern so adding a new reason without updating the message function fails
  typecheck.

**Phase gate:** `pnpm --filter @gullabs/quota build && pnpm --filter @gullabs/quota test` green; no
remaining reference to `provider_disabled` inside a `kind: 'defer'` literal anywhere in
`packages/quota/src`.

---

## Phase 5 — Grounded-to-structured correlation convention

**Owner:** observability-craft + testing-craft lineage agent.

**Objective:** amend the already-shipped `docs/grounded-structured.md` to mandate a single
`metadata.operationId` correlation convention (replacing the current dual `metadata`/`externalId`
guidance), and add a runnable test proving it.

**Files likely touched:**

- `docs/grounded-structured.md`
- `packages/core/src/grounded-structured-convention.test.ts` (new)

**File overlap:** none with other phases (new test file; doc-only elsewhere).

**Concrete tasks:**

1. In `docs/grounded-structured.md`, add `operationId` to both calls' `metadata` objects
   (currently at `docs/grounded-structured.md:36-41` for the research call and `:129-134` for the
   synthesis call), set to the SAME caller-generated value on both:
   ```ts
   metadata: {
     operationId, // same value on both calls — THE canonical link between them
     workflowId,
     reportId,
     phase: 'research', // or 'synthesis' on the second call
   },
   ```
2. Rewrite the final `## What to correlate on` section (currently `docs/grounded-structured.md:
156-160`, which names both `externalId` and `metadata` with no priority) to state plainly:
   **use `metadata.operationId` as the canonical link between the two calls.** `externalId` may
   still carry a single caller-owned convenience id (e.g. the report id) for ledger filtering, and
   a sidecar table is still the right place for typed joins — but `operationId` is the one
   mandated field for "these two attempts are the same logical grounded-then-structured operation."
3. Add a short paragraph noting this convention is shared with the multi-runtime example (Phase 6)
   — hosts should not invent a second correlation key for Temporal-workflow-scoped call chains.
4. Add `packages/core/src/grounded-structured-convention.test.ts` using `FakeAdapter` and
   `RecordingSink` (no live network) to prove the convention is mechanically checkable:

   ```ts
   it('links a grounded-research call and a structured-synthesis call via metadata.operationId', async () => {
     const sink = new RecordingSink()
     const client = createClient({
       adapters: [new FakeAdapter([{ text: 'grounded findings' }, { rawStructured: { summary: 'ok' } }])],
       pricing: geminiPricingSource(),
       sink,
     })
     const operationId = 'op-123'

     await client.generate(
       { model: 'gemini-2.5-pro', messages: [...], metadata: { operationId, phase: 'research' } },
       { auth },
     )
     await client.generate(
       {
         model: 'gemini-2.5-flash',
         messages: [...],
         output: { jsonSchema: { type: 'object' } },
         metadata: { operationId, phase: 'synthesis' },
       },
       { auth },
     )

     expect(sink.records).toHaveLength(2)
     expect(sink.records[0]?.attemptId).not.toBe(sink.records[1]?.attemptId)
     expect((sink.records[0]?.metadata as { operationId: string }).operationId).toBe(operationId)
     expect((sink.records[1]?.metadata as { operationId: string }).operationId).toBe(operationId)
   })
   ```

**Focused acceptance tests:**

- The test above passes and specifically asserts distinct `attemptId`s alongside matching
  `metadata.operationId` — a test that only checked one or the other would not prove correlation.
- `docs/grounded-structured.md` no longer presents `externalId` and `metadata` as two equally-valid
  correlation options for linking the two calls; exactly one field (`metadata.operationId`) is
  mandated for that purpose.

**Phase gate:** new test passes under `pnpm --filter @gullabs/core test`; doc read-through confirms
single mandated convention language.

---

## Phase 6 — Multi-runtime / Temporal example: reuse the `operationId` convention

**Owner:** observability-craft + testing-craft lineage agent (same as Phase 5, or a fresh agent
briefed on Phase 5's outcome).

**Objective:** amend the already-shipped `docs/multi-runtime.md` to (a) state explicitly that
`RecordingSink` does not dedupe on `attemptId`, and (b) reuse `metadata.operationId` from Phase 5
rather than inventing a second correlation convention for workflow-scoped call chains.

**Files likely touched:**

- `docs/multi-runtime.md`

**File overlap:** none — depends on Phase 5 conceptually (reuses its convention) but touches a
different file.

**Concrete tasks:**

1. Add a new subsection under the existing `## Temporal worker client` section
   (`docs/multi-runtime.md:96-133`) titled `### Testing note: RecordingSink does not dedupe`,
   stating: **`RecordingSink` (the in-memory test fake) pushes every record unconditionally
   (`packages/testing/src/recording-sink.ts`) — it does not implement `onConflictDoNothing`
   deduplication. That behavior is `drizzleUsageSink`-specific (`packages/drizzle/src/sink.ts`).**
   A test that simulates "Temporal retries the whole activity with the same `idempotencyKey`"
   against `RecordingSink` will see two rows with the same `attemptId`, not one deduplicated row —
   readers must not assume in-memory dedup during local/unit testing; the dedup guarantee only
   holds against a real Postgres-backed sink honoring the `attempt_id` primary key.
2. In the `## Application-local metadata helper` example (`docs/multi-runtime.md:17-35`), add
   `operationId?: string` to the `AnyLlmMetadata` type, and note in prose that when a single
   workflow makes multiple correlated LLM calls (e.g. the grounded-then-structured pattern from
   Phase 5, or any other multi-call workflow phase), the SAME `operationId` value should be set on
   every call in that logical operation — reusing Phase 5's convention rather than defining a
   second one.
3. Add a short cross-reference sentence linking to `docs/grounded-structured.md`'s `## What to
correlate on` section.

**Focused acceptance tests:** docs-only phase; acceptance is manual read-through:

- The `RecordingSink` non-dedupe caveat is present, specific (names the exact behavior and the
  contrasting `drizzleUsageSink` behavior), and placed where a reader building a Temporal-retry test
  would see it before writing a wrong assertion.
- `operationId` appears in the shared metadata example and is described as reused from Phase 5's
  grounded-structured convention, not redefined.

**Phase gate:** doc read-through confirms both additions; no source files changed in this phase.

---

## Phase 7 — Caller-owned structured-output validation helper

**Owner:** testing-craft lineage agent. Zero core changes.

**Objective:** ship a documented, Standard-Schema-aligned pattern for validating `result.output`
after `outputParsed === true`, covering both documented failure modes, with zero changes to
`@gullabs/core` or `@gullabs/google`.

**Files likely touched:**

- `docs/structured-output-validation.md` (new)
- `packages/core/src/structured-output-validation.test.ts` (new) — proves the pattern against
  existing fakes; this is a documentation-support test, not a new core export.
- `README.md` (add one link in the docs list alongside `docs/ledger.md` etc., `README.md:537-539`)
- `ROADMAP.md` (remove the "Caller-owned structured output validation" deferred item,
  `ROADMAP.md:61-65`, since it has shipped)

**File overlap:** `README.md`'s doc-links section is also touched by nothing else structurally
(Phase 1 touches a different section of the same file) — low risk, additive line.

**Concrete tasks:**

1. Write `docs/structured-output-validation.md` documenting the pattern: after a call with
   `output.jsonSchema` set, check `result.outputParsed` first (cheap boolean gate for "did the
   model even return parseable JSON"), then, only when `true`, run a Standard-Schema-compatible
   validator (`'~standard'` convention, same as `packages/core/src/standard-schema.ts` and the
   internal config validators at `engine.ts:1021-1024`) against `result.output` for
   shape-correctness:

   ```ts
   import type { StandardSchemaV1 } from '@gullabs/core'

   async function validateStructuredResult<T>(
     result: { output?: unknown; outputParsed?: boolean },
     schema: StandardSchemaV1<unknown, T>,
   ): Promise<
     | { ok: true; value: T }
     | {
         ok: false
         reason: 'not_parsed' | 'shape_invalid'
         issues?: readonly StandardSchemaV1.Issue[]
       }
   > {
     if (result.outputParsed !== true) {
       return { ok: false, reason: 'not_parsed' }
     }
     const validation = await schema['~standard'].validate(result.output)
     if (validation.issues !== undefined) {
       return { ok: false, reason: 'shape_invalid', issues: validation.issues }
     }
     return { ok: true, value: validation.value }
   }
   ```

2. Document explicitly why core does not own this: `output.jsonSchema` is a generation _hint_ to
   the provider, not a validated contract; the library forwards it and parses JSON, but shape
   acceptance is business policy the caller owns (SPEC.md's forward-only invariant). Cross-link the
   "New gap: silent structured-output parse failures" section of `ADOPTION-FEEDBACK.md` as the
   motivating problem this pattern closes for hosts that adopt it.
3. Add `packages/core/src/structured-output-validation.test.ts` covering both required failure
   modes using existing fakes — no new fake needed:
   - **Wrong-shape-but-parsed**: `FakeAdapter` scripted to return `rawStructured: { unexpected:
'shape' }` for a request expecting `{ summary: string }`. Assert `outputParsed === true` but
     the validator returns `{ ok: false, reason: 'shape_invalid' }`.
   - **Malformed-JSON-unparsed**: use `fakeGeminiResponse({ structuredJson: 'not valid json' })`
     through the real Google adapter (or `FakeAdapter` returning `rawStructured: undefined`).
     Assert `outputParsed === false` and the validator short-circuits to `{ ok: false, reason:
'not_parsed' }` without even attempting shape validation.
4. Remove the now-shipped "Caller-owned structured output validation" item from `ROADMAP.md:61-65`.
5. Add one link line to `README.md`'s docs list (`README.md:537-539`):
   `- [\`docs/structured-output-validation.md\`](./docs/structured-output-validation.md) — validating result.output after outputParsed with a Standard-Schema-compatible helper`

**Focused acceptance tests:**

- Both scripted scenarios above pass and specifically distinguish `'not_parsed'` from
  `'shape_invalid'` — a test that only checked "validation failed" without checking `reason` would
  not prove the two failure modes are actually distinguishable.
- The pattern works against any `'~standard'`-compatible validator, not just one library — assert
  with at least two different hand-rolled `StandardSchemaV1` implementations (mirroring how
  `registry.ts`'s `makeGeminiConfigValidator` already hand-rolls one) to prove no vendor coupling.

**Phase gate:** new test passes under `pnpm --filter @gullabs/core test`; `ROADMAP.md` no longer
lists this item as deferred; README links resolve.

---

## Phase 8 — Rate-limiter wait attribution (`queueDelayMs`) + `latencyMs` fix + new testing fake

**Owner:** strongest core engine agent (observability-craft + testing-craft lineage). This phase
touches the hottest, most carefully-invariant-guarded file in the codebase (`engine.ts`) — assign
accordingly.

**Objective:** separate rate-limiter queue wait from provider-dispatch latency; expose
`queueDelayMs` as both a structured log field and a persisted numeric column; ship a
`scriptedRateLimiter` testing fake so this is actually testable without a live network or a
hand-rolled fake per test file.

**Files likely touched:**

- `packages/core/src/engine.ts`
- `packages/core/src/types.ts`
- `packages/core/src/record.ts`
- `packages/core/src/engine.test.ts`
- `packages/drizzle/src/schema.ts`
- `packages/drizzle/src/sink.ts`
- `packages/testing/src/rate-limiter.ts`
- `packages/testing/src/index.ts`

**File overlap:** `engine.ts`/`types.ts`/`index.ts` were touched by Phase 1 (must have landed) and
`engine.ts` by Phase 2 (recommend landing first to avoid conflicting edits inside `runAttempt`'s
cost/warnings block, even though this phase's edits are in the rate-limiter-acquire block a few
lines earlier in the same function).

**Concrete tasks:**

1. In `runAttempt` (`engine.ts`), declare two new per-attempt trackers alongside the existing
   `provider`, `normalizedResult`, `cost`, `release`, `cleanup` declarations (near
   `engine.ts:989-995`):
   ```ts
   let queueDelayMs: number | undefined
   let dispatchStartMs: number | undefined
   ```
2. Wrap the existing rate-limiter acquire call (`engine.ts:1058-1066`) with a before/after
   `ctx.clock.now()` pair to measure `queueDelayMs`:

   ```ts
   // Step 6b: Rate-limiter acquire — PRE-SEND backpressure. Measure wait time for
   // queueDelayMs attribution (separate from provider-dispatch latencyMs below).
   const acquireStartMs = ctx.clock.now()
   const acquirePromise = rateLimiter.acquire(`${provider}:${req.model}`, combinedSignal)
   release =
     raceParts.length > 0
       ? await Promise.race([acquirePromise, ...raceParts])
       : await acquirePromise
   queueDelayMs = ctx.clock.now() - acquireStartMs

   // A new debug log immediately after the wait is known — carries queueDelayMs
   // as soon as it exists (cannot be added to the earlier llm.call.attempt.start
   // log, which fires before the wait happens).
   ctx.logger.debug(
     { callId: ctx.callId, attemptNumber, queueDelayMs },
     'llm.call.attempt.dispatch',
   )
   ```

3. Capture `dispatchStartMs` immediately before the adapter dispatch (`engine.ts:1079-1084`,
   right before `const runPromise = adapter.run(...)`):
   ```ts
   // Step 7: Run adapter — raced against all cancellation promises.
   dispatchStartMs = ctx.clock.now()
   const runPromise = adapter.run(adapterReq, adapterCtx)
   ```
4. **Fix the `latencyMs` bug** at both computation sites:
   - Success path (`engine.ts:1140`): change
     `const latencyMs = ctx.clock.now() - attemptStartMs`
     to
     `const latencyMs = ctx.clock.now() - (dispatchStartMs ?? attemptStartMs)`.
   - Error path (`engine.ts:1209`): same change. `dispatchStartMs` will be `undefined` when the
     error occurred before dispatch started (config validation, routing, or rate-limiter
     acquire/timeout) — in that case the fallback to `attemptStartMs` preserves today's "total
     time to failure" semantics, since there is no provider round-trip to isolate.
5. Thread `queueDelayMs` through `buildSuccessRecord` / `buildErrorRecord` (both currently declared
   in `engine.ts:607-702`) as a new parameter, into `BuildRecordInput` / `LlmCallRecord`
   (`record.ts:142-197` / `:29-133`) as `queueDelayMs?: number`, and into `LlmResult`
   (`types.ts:363-425`) as `queueDelayMs?: number`, placed next to `latencyMs`.
6. Add the drizzle column: `queueDelayMs: integer('queue_delay_ms')` in `packages/drizzle/src/
schema.ts`, next to `latencyMs` (currently `schema.ts:28`). Add the corresponding mapping line
   in `packages/drizzle/src/sink.ts`'s row-builder (currently `sink.ts:26-59`).
7. Add `scriptedRateLimiter` to `packages/testing/src/rate-limiter.ts` (currently a 1-line
   re-export file):

   ```ts
   export { inMemoryRateLimiter, type InMemoryRateLimiterOptions } from '@gullabs/core'

   import type { RateLimiter, Release } from '@gullabs/core'

   export interface ScriptedRateLimiterOptions {
     /** Fixed delay (ms) the limiter waits before resolving `acquire`. */
     delayMs: number
   }

   /**
    * A RateLimiter test double with a deterministic, injectable wait — for
    * asserting `queueDelayMs` without a live network or a hand-rolled fake.
    */
   export function scriptedRateLimiter(opts: ScriptedRateLimiterOptions): RateLimiter {
     return {
       acquire(_key: string, signal?: AbortSignal): Promise<Release> {
         return new Promise((resolve, reject) => {
           if (signal?.aborted === true) {
             reject(new DOMException('Aborted', 'AbortError'))
             return
           }
           const timer = setTimeout(() => resolve(() => {}), opts.delayMs)
           signal?.addEventListener(
             'abort',
             () => {
               clearTimeout(timer)
               reject(new DOMException('Aborted', 'AbortError'))
             },
             { once: true },
           )
         })
       },
     }
   }
   ```

   Export it from `packages/testing/src/index.ts` alongside the existing `inMemoryRateLimiter`
   export.

**Focused acceptance tests:**

- Using `scriptedRateLimiter({ delayMs: 250 })` and `FakeClock`, a successful call's
  `result.queueDelayMs` is `250` (±0 with `FakeClock`'s deterministic advance) and
  `result.latencyMs` does **not** include the 250ms wait — assert `latencyMs` is computed only from
  `dispatchStartMs` onward.
- Same setup on the error path: an adapter that throws produces an error record with
  `queueDelayMs: 250` and `latencyMs` still excluding the queue wait.
- A call using the default `NOOP_RATE_LIMITER` (no configured limiter) produces `queueDelayMs`
  approximately `0` (or a very small, non-negative number), proving the instrumentation doesn't
  break the common case.
- **Regression test required**: this must be a test that FAILS against the pre-fix code (asserting
  `latencyMs < totalElapsed` when a non-trivial `queueDelayMs` is injected) so the fix is provably
  closing a real bug, not just adding a new field.
- `RecordingSink`/drizzle round-trip: `queueDelayMs` persists correctly on both the in-memory sink
  and (if integration tests run against a real Postgres) the drizzle sink's new column.
- `ctx.logger.debug` receives a `'llm.call.attempt.dispatch'` event carrying `queueDelayMs` — assert
  via a test `Logger` spy.

**Phase gate:** all Phase 8 tests pass; every existing test that asserted an exact `latencyMs`
value under a rate-limiter that introduces nonzero wait (search `engine.test.ts` for
`inMemoryRateLimiter` usage) is reviewed and updated if its expected `latencyMs` implicitly assumed
the pre-fix (wait-inclusive) behavior.

---

## Final phase — Documentation/public-surface cleanup + integration quality gate

**Owner:** final integrator/reviewer, after Phases 1-8 have all landed on the working branch.

**Objective:** verify the merged implementation behaves as one coherent release, not eight
independent patches; sweep stale public-API claims; run the full quality gate.

**Files likely touched:**

- `README.md` (consolidate: Flex/priority-tier note from Phase 1, docs-links from Phases 3/5/6/7)
- `SPEC.md` (only if any invariant wording needs a one-line update for `queueDelayMs` /
  `admittedReasoningEfforts` — check, do not assume)
- `docs/architecture.md` (add `queueDelayMs`/`servedServiceTier`-adjacent note if the pipeline-step
  table needs it; add `resolveReasoning` to the ports/registry description if that table lists
  registry capabilities)
- `ROADMAP.md` (remove the two now-shipped deferred items: caller-owned validation (Phase 7) and
  rate-limiter wait-time attribution (Phase 8), currently at `ROADMAP.md:61-65` and `:95-96`)
- `CHANGELOG.md` (one entry summarizing all 8 phases as a single dated release)
- `.changeset/*.md` (add a changeset covering the breaking/additive surface: new `PricingSource`
  methods, new `ClientConfig.strictPricing`, new `ModelDescriptor.capabilities
.admittedReasoningEfforts`, new `resolveReasoning`/`EFFORT_BUDGET`/`ReasoningEffort` exports, new
  `LlmResult.queueDelayMs` / drizzle column, `@gullabs/quota`'s `QuotaDecision` breaking shape
  change)

**Concrete tasks:**

1. Sweep for stale claims: `rg "provider_disabled" packages/quota` should show it only inside
   `kind: 'deny'` contexts, never `kind: 'defer'`. `rg "EFFORT_BUDGET" packages/google` should show
   only an import.
2. Confirm `ROADMAP.md` no longer lists caller-owned validation or rate-limiter wait attribution as
   deferred (both shipped in Phases 7-8).
3. Confirm README's Flex section states the `priority` exclusion (Phase 1, task 7) and the docs
   list includes `docs/structured-output-validation.md` (Phase 7, task 5).
4. Confirm `docs/architecture.md`'s ports table (`docs/architecture.md:45`) still accurately
   describes `RateLimiter` given the Phase 4 quota cross-reference — update the one-line
   description if it needs to point at `@gullabs/quota` alongside "Host app or companion package."
5. Write the changeset(s) covering every package with a public surface change:
   `@gullabs/core`, `@gullabs/google`, `@gullabs/drizzle`, `@gullabs/quota`, `@gullabs/testing`.

**Final review checklist:**

- `resolveReasoning` never returns `effort: 'none'` for `gemini-3.1-pro-preview` and never returns
  `effort: 'low'` or `'medium'` for Gemma 4 — both are structurally impossible given the admitted
  lists, not just tested-and-hoped.
- `providerOptions.google.serviceTier` cannot bypass validation after the Phase 1 fix — verified by
  the regression test that fails pre-fix.
- `strictPricing` is construction-time only; no `price()` call-site behavior changed.
- The always-on unpriced `Warning` fires independent of `strictPricing`.
- `docs/ledger.md`'s transaction-composition recipe and index-coverage honesty are both present.
- `@gullabs/quota`'s `QuotaDecision` has three kinds; `provider_disabled` is `deny`-only.
- `docs/grounded-structured.md` and `docs/multi-runtime.md` share exactly one correlation
  convention (`metadata.operationId`), not two.
- The structured-output validation helper is documented as caller-owned, Standard-Schema-aligned,
  with zero core changes.
- `latencyMs` no longer includes rate-limiter queue wait; `queueDelayMs` is separately available on
  result, record, and the drizzle column.
- Sink, telemetry, and cost failures are still fail-open; bad config/input still fails before
  network I/O (unchanged from `PLAN-integration-fixes.md`'s invariants — this plan does not touch
  that boundary).

**Commands (must all pass):**

```bash
pnpm -r build
pnpm typecheck
pnpm test
pnpm quality
```

**Done condition:** all four commands pass, Claude/codex review has no blocker findings, and the
final commit/PR description lists all 8 phases' behavior changes explicitly (this plan's phase
titles are a ready-made checklist for that description).
