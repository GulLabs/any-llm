# Backlog

`BACKLOG.md` tracks concrete, actionable work items with status and priority.
Design-seam deferrals (streaming, tool calling, Vertex, the `Redactor` port, etc.) live
in `ROADMAP.md` and are deliberately not duplicated here — this file is for work that is
scoped enough to plan and build, not for placeholders.

Every item that touches code requires a written plan with codex signoff before
implementation (repo process).

---

## B-002 — `@gullabs/xai` Files store (`XaiFileStore`) + generate attach

- **Priority:** P0 (RED LINE production Grok corpus path)
- **Status:** shipped (`@gullabs/xai@0.3.0`, `@gullabs/core@0.11.0`).
- **Plan:** [`docs/PLAN-xai-files-store.md`](./docs/PLAN-xai-files-store.md)
- **Origin:** RED LINE audit pipeline — stop inline ~200k matter tokens × N modules;
  provider-scoped Files upload/`file_id`/TTL/idempotent delete; parity with
  `@gullabs/google` `GoogleFileStore`.
- **Scope:** `XaiFileStore` (upload with `expires_after`, get, list, idempotent delete);
  core `FileRefPart` + Responses `input_file.file_id` attach; tests; no Collections
  in v1; no ambient env auth.
- **Consumer defaults (RED LINE):** TTL **24h**; storage ~$0.025/GiB/day; permanent
  matter files forbidden; cleanup idempotent + sweep.
- **Next step:** RED LINE bumps dependency; follow-on **B-005** for fail-closed delete.

---

## B-005 — File-store fail-closed delete (`XaiFileStore` + `GoogleFileStore`)

- **Priority:** P0 (RED LINE Temporal release / orphan sweep must not mark DB released on 5xx)
- **Status:** implementing (P0 + P1s from plan §6 in same ship).
- **Plan:** [`docs/PLAN-file-store-fail-closed-delete.md`](./docs/PLAN-file-store-fail-closed-delete.md)
- **Origin:** RED LINE feedback after xAI Files 0.3.0 — fail-open-only delete cannot gate
  durable `released_at`; empty `fileId` should throw.
- **Scope (P0):** per-call `delete(id, { failClosed?: boolean })` on xAI + Google; 404 success
  both modes; empty id → `bad_request`; tests/README/changeset. Default remains fail-open (P5).
- **P1 in same ship:** attachment_search counters on `usage.details`; `FakeXaiFileStore`;
  multi-provider install docs.
- **Next step:** merge + Release.

---

## B-001 — `@gullabs/anthropic` provider package

- **Priority:** P1
- **Status:** proposed, awaiting owner approval; plan not yet written.
- **Origin:** `docs/POSTBUZZ-APP-V2-0.8-ADOPTION-GAPS.md` §1 — PostBuzz's
  campaign-content-generation feature
  (`apps/worker/src/temporal/activities/llm-anthropic.activities.ts`) calls
  `@anthropic-ai/sdk` directly, live in production, bypassing the library's cost
  ledger/retry/structured-output contract. This is the one concrete blocker to "all LLM
  calls go through `@gullabs/*`" for that host.
- **Scope:** a Claude Messages API adapter mirroring `@gullabs/xai`'s plugin shape —
  adapter, model descriptors (start with `claude-haiku-4-5`, the host's live default),
  pricing source, `ProviderOptionsMap` augmentation, and an `anthropicProvider()`
  `ProviderPlugin` factory. Live verification probes before shipping, same discipline
  as the `@gullabs/xai` rollout.

  Explicitly includes the multi-provider composition integration test from the gaps doc
  §2: `composeProviders([googleProvider(), anthropicProvider()])` combining two
  live-API-backed providers into one client — exercising multi-provider
  `Middleware`/`RateLimiter` interaction and `pricingSources` keyed per adapter id.
  Rationale for folding §2 in here rather than shipping it standalone: composition's
  value only materializes when one runtime actually mixes two providers, and zero
  consumers do today. PostBuzz becomes the first real multi-provider consumer the
  moment the anthropic package exists, so the test earns its keep as part of this item
  rather than as speculative standalone work.

- **Next step:** owner approval, then a written plan (adapter shape, descriptor list,
  pricing source, live-probe checklist) with codex signoff before any code lands.

## B-002 — `@gullabs/testing` host-owned-factory documentation

- **Priority:** P2
- **Status:** in progress on branch `docs/backlog-and-testing-factory-example` (this
  branch), deliberately unmerged pending further requirements.
- **Origin:** gaps doc §3 — three-for-three consumers (redline, ai-studio, postbuzz)
  hand-roll `vi.mock` fakes instead of using `@gullabs/testing`; all three inject
  adapters via their own factory function, not a bare `createClient()` call site, so the
  README's only example doesn't match the shape hosts actually have.
- **Scope:** a README section showing fake wiring through a host-owned factory (see
  `packages/testing/README.md` § "Wiring fakes through a host-owned factory") plus a
  `SKILL.md` pointer in `packages/any-llm/skills/any-llm/SKILL.md`.
- **Next step:** none — docs land in this branch; merge is pending further requirements
  from the owner.

## B-003 — Input-validation middleware (pre-dispatch input contracts)

- **Priority:** P2
- **Status:** IMPLEMENTED as ADR-025 (PR #30, 2026-07-10) — strict interpolation
  default, `CallSite.inputSchema`, `LlmRequest.inputContract`, `requireInputContract`,
  callId⇒ledger-row rule. See `docs/input-contracts-plan.md`.
- **Origin:** `docs/input-validation-middleware-proposal.md` (ai-studio pipeline team,
  live incident 2026-07-10: null-saturated template fill produced schema-valid but
  empty outputs across `grok-4.5` and `gpt-5.4` with no `LlmError` raised).
- **Scope:** per the proposal doc — a pre-dispatch input-validation `Middleware` on the
  same seam `@gullabs/quota` uses.
- **Next step:** none — done.

---

## B-004 — Dependency review: pending dependabot PRs, notably `@google/genai` 2.x major

- **Priority:** P3
- **Status:** parked by owner (2026-07-10) — explicitly deprioritized.
- **Origin:** open dependabot PRs (#14, #21–#25). Most are routine dev-dep patches;
  the one requiring deliberate review is `@google/genai` 1.52.0 → 2.11.0 (#24), a
  major bump of the `@gullabs/google` peer SDK. Known context: our adapter carries
  mitigations for upstream bugs #1277/#1468 and depends on live-verified 1.x
  behavior; a 2.x upgrade needs its own verification pass, not an auto-merge.
- **Scope:** triage the routine dev-dep bumps (merge when green), then a scoped
  `@google/genai` 2.x review — changelog read, adapter compile/tests against 2.x,
  re-check the bug mitigations still apply, live smoke verification per the usual
  discipline.
- **Next step:** none until the owner reprioritizes.

## B-005 — Response chaining (`previous_response_id` passthrough) — proposal triage

- **Priority:** P3
- **Status:** proposal dropped by owner, awaiting triage.
- **Origin:** `docs/response-chaining-enhancement.md` — opt-in xAI Responses-API
  server-side conversation chaining.
- **Next step:** owner triage decision.

---

## Recently completed

- OpenAI-strict output-schema preflight + `toOpenAiStrictOutputSchema` helper shipped
  2026-07-10 (PR #28, `codex-cli@0.5.0`, `xai@0.2.1`).
- Provider-plugin architecture + `@gullabs/xai` shipped (PR #26, `0.8.0` line).
