# Backlog

`BACKLOG.md` tracks concrete, actionable work items with status and priority.
Design-seam deferrals (streaming, tool calling, Vertex, the `Redactor` port, etc.) live
in `ROADMAP.md` and are deliberately not duplicated here — this file is for work that is
scoped enough to plan and build, not for placeholders.

Every item that touches code requires a written plan and review signoff before
implementation (repo process).

**Open-source note:** describe needs in terms of library contracts and generic host
patterns. Do not name private consumer products, internal codenames, or absolute
paths to other repos.

---

## B-002 — `@gullabs/xai` Files store (`XaiFileStore`) + generate attach

- **Priority:** P0 (production document attach without re-sending full corpus tokens)
- **Status:** shipped (`@gullabs/xai@0.3.0+`, `@gullabs/core@0.11.0+` with `FileRefPart`).
- **Plan:** [`docs/PLAN-xai-files-store.md`](./docs/PLAN-xai-files-store.md)
- **Origin:** Hosts need provider-scoped Files upload / `file_id` attach / TTL / idempotent
  delete, parity with `@gullabs/google` `GoogleFileStore`.
- **Scope:** `XaiFileStore` (upload with `expires_after`, get, list, idempotent delete);
  core `FileRefPart` + Responses `input_file.file_id` attach; tests; no Collections in v1;
  no ambient env auth.
- **Host guidance:** prefer explicit TTL on ephemeral uploads; permanent files
  discouraged; cleanup idempotent (404 = success).
- **Next step:** none for library — hosts consume published packages. Follow-on **B-005**
  for fail-closed delete (shipped).

---

## B-005 — File-store fail-closed delete (`XaiFileStore` + `GoogleFileStore`)

- **Priority:** P0 (hosts that gate durable release state on known delete success)
- **Status:** shipped (`@gullabs/xai@0.4.0`, `@gullabs/google@0.9.0`, `@gullabs/testing@0.5.0`).
- **Plan:** [`docs/PLAN-file-store-fail-closed-delete.md`](./docs/PLAN-file-store-fail-closed-delete.md)
- **Origin:** Fail-open-only delete cannot gate host DB “released” markers on 5xx/network;
  empty `fileId` should throw.
- **Scope (P0):** per-call `delete(id, { failClosed?: boolean })` on xAI + Google; 404 success
  both modes; empty id → `bad_request`; tests/README. Default remains fail-open (P5).
- **Also shipped:** attachment_search counters on `usage.details`; `FakeXaiFileStore`;
  multi-provider install docs.
- **Next step:** none — shipped. Optional later: tool-fee Cost lane when pricing is stable.

---

## B-001 — `@gullabs/anthropic` provider package

- **Priority:** P1
- **Status:** proposed, awaiting owner approval; plan not yet written.
- **Origin:** hosts still calling Anthropic SDKs directly for production features want a
  first-class any-llm provider plugin (cost ledger / retry / structured output).
- **Scope:** a Claude Messages API adapter mirroring `@gullabs/xai`'s plugin shape —
  adapter, model descriptors (start with a current Haiku-class default), pricing source,
  `ProviderOptionsMap` augmentation, and an `anthropicProvider()` `ProviderPlugin` factory.
  Live verification probes before shipping.

  Explicitly includes a multi-provider composition integration test:
  `composeProviders([googleProvider(), anthropicProvider()])` combining two
  live-API-backed providers into one client — exercising multi-provider
  `Middleware`/`RateLimiter` interaction and `pricingSources` keyed per adapter id.

- **Next step:** owner approval, then a written plan (adapter shape, descriptor list,
  pricing source, live-probe checklist) with review signoff before any code lands.

---

## B-003 — `@gullabs/testing` host-owned-factory documentation

- **Priority:** P2
- **Status:** docs drafted on a docs branch; merge pending further requirements.
- **Origin:** several hosts hand-roll `vi.mock` fakes instead of `@gullabs/testing`; many
  inject adapters via a host-owned factory, not a bare `createClient()` call site.
- **Scope:** README section showing fake wiring through a host-owned factory plus a
  skill pointer in `packages/any-llm/skills/any-llm/SKILL.md` if applicable.
- **Next step:** merge when requirements are stable.

---

## B-004 — Input-validation middleware (pre-dispatch input contracts)

- **Priority:** P2
- **Status:** IMPLEMENTED as ADR-025 (PR #30, 2026-07-10) — strict interpolation
  default, `CallSite.inputSchema`, `LlmRequest.inputContract`, `requireInputContract`,
  callId⇒ledger-row rule. See `docs/input-contracts-plan.md`.
- **Origin:** host pipeline incident and proposal in
  `docs/input-validation-middleware-proposal.md`.
- **Next step:** none — done.

---

## B-006 — Dependency review: pending dependabot PRs, notably `@google/genai` 2.x major

- **Priority:** P3
- **Status:** largely done on branch `chore/dependabot-upgrades-careful` — routine
  devDeps + `openai@7` (peer `^6 || ^7`) + `@google/genai@2.16` (peer already `^1 || ^2`)
  - `actions/setup-node@v7` + pglite 0.5.4. `pnpm quality` green against new majors.
- **Origin:** open dependabot PRs.
- **Next step:** merge upgrade PR; close Dependabot PRs as superseded. Skipped
  `@changesets/cli@3` and TypeScript 7 / Vitest 4 (out of Dependabot scope; separate plan).

---

## B-007 — Response chaining (`previous_response_id` passthrough) — proposal triage

- **Priority:** TBD
- **Status:** proposal dropped by owner, awaiting triage.
- **Origin:** `docs/response-chaining-enhancement.md`.
- **Next step:** owner triage decision.

---

## Optional later (not ticketed)

- Tool-invocation fee Cost lane for xAI server tools (`attachment_search`, etc.) once
  public pricing is stable enough to freeze into `computeXaiCost`.
- Collections / chunked upload / public URL minting / xAI context-cache store — explicit
  non-goals unless a new plan opens them.
