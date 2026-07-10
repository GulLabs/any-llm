# Backlog

`BACKLOG.md` tracks concrete, actionable work items with status and priority.
Design-seam deferrals (streaming, tool calling, Vertex, the `Redactor` port, etc.) live
in `ROADMAP.md` and are deliberately not duplicated here — this file is for work that is
scoped enough to plan and build, not for placeholders.

Every item that touches code requires a written plan with codex signoff before
implementation (repo process).

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

## Recently completed

- OpenAI-strict output-schema preflight + `toOpenAiStrictOutputSchema` helper shipped
  2026-07-10 (PR #28, `codex-cli@0.5.0`, `xai@0.2.1`).
- Provider-plugin architecture + `@gullabs/xai` shipped (PR #26, `0.8.0` line).
