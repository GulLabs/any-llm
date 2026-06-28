# any-llm — Autonomous Decisions Log

Running log of decisions made while Atif is away (started 2026-06-27). Newest at top within each
section. Review on return; flag anything to revisit.

## How to read this
- **D-N** = a decision, with rationale + reversibility. **Q-N** = a question parked for Atif.
- Source of truth: `SPEC.md` (v1 build contract) and `DESIGN.md` (north-star vision).

---

## Parked questions for Atif (Q)
- **Q1 — npm name.** "any-llm" collides with mozilla-ai/any-llm. Using `@anyllm/*` scope as a
  working placeholder locally. Pick a real name before any publish. (Non-blocking for build.)
- **Q2 — Git remote.** Defaulting to **local commits only, no remote, no push** (pushing is
  outward-facing; you OSS later). Tell me the remote when you want it pushed.
- **Q3 — First host to adopt.** Defaulting to standalone package + fake sink first; you said
  "decide later." Likely redline (its `llm_calls` exists) or OpenMontage (clean) for the first real wiring.
- **Q4 — Open §16 items** (cost reconciliation job, live contract tests cadence, secrets rotation,
  multi-region) deferred OUT of v1 per "build the slice." Revisit when a host needs them.

## Core decisions (D)
- **D13 — Codex design sign-off (gpt-5.4) returned `blocking-issues`; all addressed in SPEC.**
  Fixes: (1) "capture thinking" made explicit — thinking-token usage always + thought-summary
  `reasoningText` when `includeThoughts` (added to result/adapter/record); (2) `Cost.details` =
  `{input,cached,output}`, MUST sum to `microUsd`, no separate thinking lane; (3) record `status`
  aligned to failure modes (+content_filter, +aborted; +`aborted` LlmErrorKind); (4) `responseId`
  persisted. Milestones reordered: **testing fakes pulled to M2** (needed by all later tests).
  Codex verified Gemini pricing math vs Google's live pricing page. Did NOT re-run sign-off — fixes
  are exactly as prescribed; M1 commit's `/codex:adversarial-review` will re-validate.
- **D12 — "Capture thinking" = usage + thought text.** v1 stores thinking token counts always and
  the provider thought-summary TEXT when `includeThoughts` is requested (`reasoningText`). Chose to
  capture text (not just counts) because you listed "capture thinking" separately from "record usage."
- **D11 — Commit-gate policy.** Every commit containing library LOGIC gets `/codex:adversarial-review`
  before moving on. Pure scaffold/config/docs commits (e.g. M0) are exempt — reviewing boilerplate
  wastes the gate. Reversible: say the word and I'll gate every commit. (M0 `bedf438` not gated.)
- **D10 — Delegate milestone breakdown + design sign-off to codex (gpt-5.4).** Utilizes your codex
  usage; gives an external senior-architect pass on SPEC before any code. Reversible.
- **D9 — Model routing for subagents (token economy + codex utilization):**
  - Hard reasoning (core engine, cost math, gemini adapter): **sonnet** subagents (your instruction).
  - Simpler packages (drizzle schema, pricing snapshot, testing fakes): **codex gpt-5.4-mini --write**.
  - Trivial scaffolding (package.json/tsconfig/tsup): I write directly (fastest) or **codex spark**.
  - Reviews / sign-offs: **codex `/codex:adversarial-review` (gpt-5.4)** — every commit.
- **D8 — Finalize design = DISTILL, not expand.** The expert panel ballooned DESIGN.md to 117KB and
  the critics found much of the new machinery broken/contradictory. Per your "stop over-engineering"
  rule, v1 builds the lean `SPEC.md`, not the 117KB design. Kept the cheap good bits (Resolved/Adapter
  contracts, typed LlmError, GROSS token convention, attemptId ledger, frozen micro-USD cost); cut the
  machinery (Standard Schema, middleware, ModelRegistry, @anyllm/protocol, compile-time ConfigFor<M>,
  reresolve, ResultCache, conformance kits, multi-provider/streaming/tools/multimodal).
- **D7 — v1 scope = 4 goals only:** Gemini Flex; record usage; capture thinking + postmortems; track
  cost. Everything else is a documented seam, not built.
- **D6 — Seams designed, machinery deferred:** adapter boundary, sink port, usage/cost open maps,
  config resolution, pricing-behind-function. Future providers/streaming/tools drop in without rewrite.
- **D5 — Transport: own thin adapters over raw SDKs (@google/genai), NOT Vercel AI SDK.** (Your call.)
- **D4 — Persistence: `UsageSink` port + `@anyllm/drizzle` reference `llm_calls` schema.** Core imports
  no ORM; hosts write to their own DB.
- **D3 — Costing: frozen micro-USD + `pricingVersion`; pricing snapshot seeded tokenlens-style.**
- **D2 — Stack: pnpm workspace monorepo, TypeScript strict, vitest, tsup (ESM+CJS+d.ts), Node ≥20.**
- **D1 — Tests never hit real Gemini.** Mock `@google/genai`; stress the surface with fakes/fuzz.

## Build status
- Design: SPEC.md written (lean v1). Awaiting codex sign-off (D10).
- Git: initialized, branch `main`, local only.
- Implementation: not started (pending sign-off).
