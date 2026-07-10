# Proposal: Input-Validation Middleware (Pre-Dispatch Input Contracts)

## Status

Triaged — reshaped per maintainer review (see Consumer response). Not yet
implemented; no ADR number assigned. If accepted, this should become an ADR in
`DECISIONS.md` following the pattern of ADR-023/ADR-024; if rejected or
deferred, it stays here as a record of the incident and the design space that was
considered.

Attribution: proposed by the ai-studio pipeline team, from a live incident during
the V2 pipeline (2026-07-10). Owner will triage with the any-llm team.

## Purpose

`any-llm` enforces OUTPUT contracts thoroughly: response schemas
(`outputJsonSchema`), structured-output retry and OpenAI-strict preflight at the
tool-call layer (`docs/openai-strict-output-schema-plan.md`), and — as of
ADR-009/ADR-010 and the model-config work in
`docs/model-config-strict-schema-design.md` — strict per-model config contracts.
It enforces zero INPUT contracts. Nothing in `packages/core` checks whether the
_business_ content of a request — the values a consumer's prompt template was
filled from — is complete or sane before the request is dispatched to a provider.

Consumers can and do dispatch requests whose business inputs are malformed or
degenerate: null-saturated template fills, missing required context fields, empty
required sections. Today that failure is invisible until _after_ tokens are
spent, and it then surfaces as one of two things, both expensive to diagnose:

- An output-schema violation (`outputJsonSchema` rejects the response) — at least
  loud, but blames the wrong layer.
- Worse: a schema-_valid_ but empty or degenerate response. The provider
  faithfully answers the malformed prompt it was given, the response satisfies
  `outputJsonSchema` because emptiness is a legal shape, and nothing in the
  engine, the adapter, or the sink has any way to know the call was doomed before
  it started.

This document proposes closing that gap with a pre-dispatch input-validation
middleware — the same middleware seam `@gullabs/quota`
(`packages/quota/src/index.ts`) already proves out for a different cross-cutting
concern (rate/quota enforcement via `Middleware` from `packages/core/src/ports.ts`).

## Concrete Incident (2026-07-10, PostBuzz AI Studio V2 pipeline)

A concept-generation call was dispatched with a prompt template filled from a
request object that carried only 2 of the ~9 context fields the template
expected. The rendered prompt reached the provider containing literal blank
template labels — `**Photographer**:  (virtual alias: )` — and a runtime-context
JSON block with 7 `null` values sitting where the missing fields should have
been.

Two providers were exercised against this malformed input, with two different
and equally unhelpful failure modes:

- `grok-4.5` (via `@gullabs/xai`) reliably returned schema-valid but **empty**
  output — `chapters: []` — at every reasoning effort level tried. Thinking-token
  usage was the tell in hindsight: ~500–700 thinking tokens for the degenerate
  input, versus 4,500–10,000 for a populated one. `outputJsonSchema` validation
  passed every time; there was no `LlmError` for anything downstream to catch.
- `gpt-5.4` (via `codex-cli`) went lazy on the first attempt too — a shallower,
  minimal-effort response consistent with the model having little real content
  to work with, though it did not empty-array on retry the way grok did.

Three LLM calls were wasted per pipeline attempt before the _output_-side Zod
validation in the consuming app caught the shape was wrong. Diagnosing the root
cause cost a multi-hour bisect, because the failure presented as a model bug, an
adapter bug, or an output-schema bug — every layer any-llm actually validates —
when the real defect was two layers upstream, in the caller's own request
construction, which any-llm never looks at.

An input-validation pass at the point of dispatch would have failed this call in
microseconds, with an exact list of the 7 missing/null fields, before a single
token was spent on any provider.

## Proposed Solution

A validation middleware in `@gullabs/core`, using the existing middleware seam
(`Middleware` in `packages/core/src/ports.ts`, proven by
`packages/quota/src/index.ts`'s `ProviderQuotaMiddleware`) rather than a new
mechanism.

1. **`LlmRequest` gains an optional input contract.** `LlmRequest`
   (`packages/core/src/types.ts`) gains an optional field carrying a schema and
   the value to check it against, e.g.:

   ```ts
   inputContract?: {
     schema: StandardSchemaV1 | JsonValue // JSON Schema
     value: unknown
   }
   ```

   This is deliberately open to design at triage: the alternative is validating
   parts of the request itself (rendered `system`/`messages`, or a
   caller-supplied subset) against a caller-supplied schema, rather than an
   opaque `value` bag the caller assembled before templating. See Open
   Questions.

2. **Middleware runs pre-dispatch, first in the chain.** On violation, it refuses
   the call with a typed error — a new `LlmErrorKind` taxonomy member (working
   name: `input_contract_violation`), classified `retryable: false` per the same
   reasoning ADR-024 item 4 uses for other caller-fault classifications: this is
   a caller defect, not a transient provider condition, and retrying an
   unmodified request will fail identically. The error lists every failing path
   (e.g. `context.photographer`, `context.virtualAlias`, 5 more), mirroring the
   exact-field-list precision Zod's `.strict()` mode already gives the
   model-config contract (`docs/model-config-contract-audit.md`). Zero tokens
   are spent: the middleware sits outside `runAttempt`, so the provider adapter
   is never reached.

3. **Refusals are recorded on the ledger, not silently dropped.** Per ADR-021
   (leveled fail-open logging, per-attempt records), an `input_contract_violation`
   refusal should still produce a `UsageSink` record so it is visible in
   `llm_calls` with `error_kind: 'input_contract_violation'` and `cost: 0` —
   observability for how often this fires, and for which consumers/templates,
   is the whole point of building this instead of leaving it to app-level
   dead-reckoning.

4. **Optional strict mode at client construction.** `createClient({
requireInputContract: true, ... })` refuses any request dispatched _without_
   an `inputContract` at all. This is the fleet-wide hard rule consumers like
   ai-studio actually want: not "validate the contracts callers remember to
   attach," but "no call leaves this client without one." Left off by default —
   this is opt-in per the library's existing posture of shipping strict
   contracts but not forcing every consumer into every contract's ceremony
   (e.g. `outputJsonSchema` is likewise optional).

5. **Consumer story (ai-studio, not part of this proposal's scope).** ai-studio
   plans to store `agents.input_schema` beside the existing `response_schema`
   column, seeded from `pipelines/*/INPUT_SCHEMA.json`, and thread it per call.
   This middleware is the enforcement point that story needs; it does not exist
   without library-level support, because today every consumer that wants this
   has to hand-roll it before calling `generate()`, with no shared taxonomy, no
   shared ledger visibility, and no shared strict-mode toggle.

## Alternatives Considered

- **App-level-only enforcement (status quo).** Each consumer validates its own
  request objects before calling `generate()`. Rejected as the default answer:
  it is exactly the per-consumer duplication the library's other contracts
  (output schema, model config) already exist to eliminate, and it is exactly
  what failed here — ai-studio's pipeline _could_ have validated this input, and
  didn't, because there is no shared seam that makes "validate before you spend
  tokens" the path of least resistance. App-level validation remains valid as a
  belt-and-suspenders layer on top of this middleware (the same relationship
  ADR-024's cache-store preflight has to `Client.countTokens`), not as a
  replacement for it.
- **Baking validation into each provider adapter.** Rejected: wrong layer, by
  the same logic ADR-001 already applies to every other cross-cutting concern.
  Adapters translate valid requests into provider SDK payloads; they should not
  know about a consumer's business input shape any more than they know about
  quota policy or retry budgets. An adapter-level check would also run too late
  by definition — it is inside the provider round-trip this proposal exists to
  avoid paying for.

## Open Questions For Triage

- **Schema format:** Standard Schema (`StandardSchemaV1`, matching how
  `outputJsonSchema` and model-config schemas are increasingly expressed) vs.
  JSON Schema (matching `outputJsonSchema`'s existing wire format) vs. accepting
  both. Precedent exists on both sides elsewhere in the codebase; pick one and
  don't let `inputContract` become a third format nothing else uses.
- **Validate what, exactly?** Pre-template inputs (the raw `value` bag a
  consumer assembled before rendering a prompt — closest to what actually broke
  in the incident) vs. the already-rendered `ResolvedRequest` parts (`system`,
  `messages`) themselves. Pre-template is more useful for catching this incident
  class early but requires the caller to hand the middleware something outside
  `LlmRequest`'s existing shape; rendered-parts validation fits the existing
  request shape more cleanly but can only catch what survives templating (e.g.
  it would catch the blank labels, but might not catch which upstream field was
  null).
- **Should refusals count against quota?** `@gullabs/quota`
  (`packages/quota/src/index.ts`) consumes RPM/RPD budget on `allow` decisions.
  An `input_contract_violation` refusal never reaches the provider — should it
  still consume quota (conservative: caller retries burn budget too) or bypass
  it entirely (permissive: it's a caller bug, not provider traffic)? This also
  interacts with middleware ordering — input validation should almost certainly
  run _before_ quota consumption, so a malformed request doesn't spend RPM/RPD
  budget it was never going to use productively.
- **Error taxonomy naming.** `input_contract_violation` is a working name only.
  It should read unambiguously next to the existing `LlmErrorKind` union
  (`packages/core/src/errors.ts`): `invalid_auth`, `rate_limited`, `server`,
  `timeout`, `aborted`, `bad_request`, `content_filter`, `unknown`. Note
  `bad_request` already exists and arguably overlaps — triage should decide
  whether this is a new kind or a documented sub-case of `bad_request` with a
  richer `LlmErrorOptions` payload (field list) attached.
- **`requireInputContract` interaction with existing consumers.** If accepted,
  turning strict mode on for an existing client is a breaking change for any
  in-flight request that doesn't supply a contract — same class of breaking
  change ADR-023/ADR-024 already accept freely under the P0 no-legacy rule, but
  worth flagging explicitly since, unlike those ADRs, this one is opt-in at the
  call site rather than a straight registry/API replacement.

## Effort Estimate

Small-to-medium, contained to `@gullabs/core`:

- New `LlmErrorKind` member + `LlmError` construction site: trivial.
- Middleware implementation (`packages/core/src/input-validation.ts` or similar,
  mirroring `packages/core/src/retry.ts`'s shape as a `Middleware` factory):
  half a day including tests, once the schema-format question above is settled.
- `LlmRequest.inputContract` field + engine wiring to pass it through to the
  middleware: half a day.
- `requireInputContract` client-construction option: small, follows the same
  pattern as other `createClient` options.
- Ledger/`UsageSink` wiring for refused-call records: should be near-free if it
  reuses the existing fail-open record path (ADR-021); needs a fixture proving
  `cost: 0` and `error_kind` land correctly.
- Docs: update `docs/architecture.md` and add this as an ADR if accepted.

Total: roughly 2–3 days including tests and docs, most of it gated on resolving
the open questions above rather than on implementation complexity.

## Consumer response (ai-studio, 2026-07-10)

The any-llm team's review correctly identified that the proposal's seam was
wrong on all three counts: middleware sees the post-render `ResolvedRequest`,
not the raw fields that were actually malformed; ai-studio calls `generate()`
with already-rendered strings, so the library never sees the pre-template
value bag middleware would need; and ledger rows for refusals require new
engine wiring, since sink writes live inside `runAttempt` and quota refusals
today produce no row at all. They also surfaced a latent reject-don't-map
violation of their own in the process — `interpolate()` silently leaves
`{{placeholder}}` literals in place when a variable is missing or null, which
is the same failure class as the incident, just one layer downstream.

Responding to the reshaped four-piece design and the specific rulings:

1. **Agreed on all three seam facts — middleware shape withdrawn.** The
   reshaped design is better than the proposal: piece (3), engine-level
   `LlmRequest.inputContract`, is the one ai-studio will adopt — we render
   prompts ourselves and call `generate()`, so the contract has to ride the
   request, not sit in a pre-render middleware we'd never reach. Piece (1),
   strict template interpolation in `runStructured` throwing `bad_request` on
   an unresolved/null placeholder pre-render, doesn't touch our call path, but
   we endorse it as a default: it's the exact failure class we hit, living in
   the library's own default path, and greenfield P0 makes the break free.
   Piece (4), `createClient({ requireInputContract: true })`, is exactly the
   fleet-wide hard rule we asked for; we'll enable it once every pipeline call
   site carries a contract.

2. **Urgency framing accepted.** Our commit `3de25977` closed the incident
   app-side the same night; the library feature's value is standardization and
   enforcement going forward, not the incident itself. Our tracker item M6
   (`agents.input_schema`) stays gated on this design landing.

3. **One material consequence of the `StandardSchemaV1` ruling for M6 —
   flagging so the design lands eyes-open.** Our original plan stored input
   schemas as _data_: a jsonb `agents.input_schema` column beside
   `response_schema`, seeded from `pipelines/*/INPUT_SCHEMA.json` and rendered
   in the admin UI. `StandardSchemaV1` contracts are _code_ — runtime
   validator objects, not JSON. Two integration options on our side:
   - (a) Keep zod contracts in ai-studio code, keyed by `pipelineKey`, with the
     DB/UI storing only the contract's key+version plus a rendered JSON-Schema
     copy for display. Source of truth is code, git-versioned — this mirrors
     how our zod _output_ parse already lives in code even though
     `response_schema` jsonb is what actually goes to providers.
   - (b) A `jsonSchema → validator` compiler dependency app-side, to keep the
     DB as source of truth. Adds a dependency and a translation layer we'd
     rather not carry.

   We're leaning (a) and will note it on M6. If the team sees a reason to
   prefer (b), say so before we build.

4. **Ledger ruling endorsed, with an operator emphasis.** Tonight's entire
   debugging method was DB-first, via `llm_calls`. A refusal that leaves no
   ledger row is invisible to that method — we would have re-learned that the
   hard way if input contracts had shipped without the synthetic zero-usage
   row. The engine wiring is worth it. We'd also ask that quota refusals get
   routed through the same call-level catch once it exists — their current
   row-less behavior has the identical observability hole.

5. **`bad_request` + structured `issues` field: agreed.** This matches how we
   already classify caller faults into non-retryable `ApplicationFailure` in
   Temporal activities. A structured issues array also lets our postmortems
   record exact field paths instead of parsing message strings out of a free
   text error.
