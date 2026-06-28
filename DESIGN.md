# any-llm — Design

A house standard for making LLM calls across all projects. One in-process TypeScript
library, provider-agnostic by **owning a thin adapter port over the raw provider SDKs**
(`@google/genai`, `@anthropic-ai/sdk`, `openai`). The library never owns a database,
a logger, a Sentry client, or a pricing service — it owns the *contract* and *orchestration*;
each host project plugs in the rest.

This document is written goals-first. It is deliberately not modeled on any existing
implementation, though it converges on a similar shape because the problem is the same.

> **Naming note (OSS):** the working title "any-llm" collides head-on with the existing
> `mozilla-ai/any-llm` project — a discoverability, SEO, and trademark-confusion risk. A distinct
> product name + reserved npm org/scope + GitHub org MUST be chosen before any public code lands
> (see §18 *OSS release policy*). The `@gullabs/*` scope is used throughout this doc as a
> **placeholder**; treat it as `@<scope>/*`.

---

## 0. Changelog (design panel)

This revision integrates an eight-expert review panel (API/contract, TypeScript DX, extensibility,
provider-reality, observability/cost, OSS/packaging, config UX, security). Major changes:

**Contracts pinned (were underspecified / missing).**
- Defined the three load-bearing port types that the whole design hinged on but never specified:
  `ResolvedRequest`, `AdapterCtx`, `AdapterResult` (§7). Added **streaming to the port**
  (`runStream`) — the engine cannot synthesize stream events without it.
- Made the division of labor explicit: **adapter returns RAW parsed output** (`rawStructured`),
  the **engine validates** against the schema; adapter returns `usage` but **no cost** and does
  **no persistence**.
- Typed the loose strings: `finishReason` is now a union; added a concrete **`LlmError` object**
  with machine-readable `retryable`, `httpStatus`, `retryAfterMs`, and an expanded `kind` union
  (`network`, `overloaded`, `quota_exceeded`, `not_found`, `aborted`, `unsupported_capability`).
- Resolved the throw-vs-return ambiguity for `content_filter`/`parse_error` (§13).

**One-line / UI-configurable model swap is now first-class (the headline goal).**
- **`model` is the single source of truth for routing.** The engine builds a provider→adapter map
  and resolves the adapter from the resolved model's descriptor. Call sites reference adapters by
  **string `adapterId`** (optional escape hatch), never by an embedded factory function — so a
  DB/flag/UX can repoint a call site cross-provider with zero code change (§5, §12).
- Defined a **JSON-serializable `CallSiteConfigPatch`** as the currency a UI/DB stores and emits,
  plus a versioned `StoredCallSiteConfig` envelope, `describeConfigForModel()` (descriptor→form
  projection), and `validateConfig()` pre-flight (§12).
- Split `ConfigSource` into **`defaults` (overridable)** and **`constraints` (clamps/ceilings
  enforced last)** with a resolution **context** (tenant/env/user) — closes the multi-tenant
  cost/abuse hole where per-call code could override a tenant policy (§12).

**Provider-reality fixes (was `needs-rework`).**
- **Round-trippable reasoning**: added a `reasoning` Part carrying `signature`/encrypted payload
  and a `reasoning-signature` stream event. Without this, Anthropic extended-thinking-with-tools,
  Gemini 3 `thoughtSignature`, and OpenAI Responses reasoning items all break on multi-turn (§4).
- **Pinned token-accounting conventions** (gross/inclusive, with subset invariants) so cost math
  does not double-count cache/reasoning across the three incompatible provider conventions (§4, §10).
- **Server-side / provider tools** (googleSearch, web_search, code_execution…) modeled as a
  `ToolDef` variant; richer tool results (parts, `isError`); typed citations + the Gemini
  ToS-mandatory `groundingDisplay` lifted out of the raw blob (§4).
- Per-part cache markers + a real `CacheIntent` (Anthropic positional breakpoints vs Gemini
  cachedContent vs OpenAI implicit); corrected `serviceTier` enum to real provider values;
  tier-aware pricing; provider-tagged `FileRef`; `video` Part; OpenAI **Responses API** declared
  as the target (§4, §6, §9, §10).

**Type-system / DX.**
- `ModelId` is an **augmentable registry** (`keyof KnownModels | (string & {})`) for autocomplete
  without closing the set; `providerOptions` is an augmentable typed registry; structured-output
  generics parametrize on the **schema** (not the value) for zero-cast inference (§4).

**Observability / cost / data modeling.**
- Closed **canonical token-type vocabulary** (`CanonicalTokenType`) replacing the dangerous
  substring heuristic; raw keys retained in `rawDetails` (§4).
- **Spend-completeness**: ledger rows dedupe on `attemptId`, NOT `idempotencyKey`, so a retried
  billed call is never silently dropped (§11).
- Telemetry payload split into low-cardinality **`dimensions`** (safe as metric labels) vs
  high-cardinality **`attributes`** (spans/logs) — prevents metric-series explosion (§14).
- `Cost` computed in nano-USD internally, rounded once to micro-USD; `confidence` assignment
  rules pinned; `Usage.source` added; ledger row written on **every terminal stream outcome
  including abort** (§5, §10).
- Reference Drizzle table no longer silently drops record fields; `assertSinkConformance` and
  `runAdapterConformance` ship in `@gullabs/testing` (§11, §18).

**Security / privacy.**
- `providerOptions` transport/auth keys (`apiKey`, `baseURL`, headers…) are **stripped before
  forwarding** and **scrubbed before persistence**, unconditionally (§7, §17).
- `Redactor` is **async + fail-closed**: capture > `metrics-only` with no Redactor downgrades to
  `metrics-only` and warns; ships a non-trivial default redactor (§7, §17).
- `AuthMaterial` defined with explicit expiry (Vertex WIF/STS rotation); `BlobStore` gains
  `get`/`delete` + encryption/retention for GDPR erasure; `region` flows end-to-end; tool-call
  args validated with an `argsValid` signal; explicit untrusted-output trust boundary (§7, §17).

**OSS / packaging.**
- Adapter contract extracted into a slow-moving **`@gullabs/protocol`** package so community
  adapters don't re-release on every core minor. Provider SDKs + Zod are **peerDependencies**.
  ESM-first dual build, audience-split entrypoints, `@experimental` markers, Apache-2.0, runnable
  conformance kits, contribution model (§18).

**Notable rejected / modified expert proposals (with rationale).**
- **Standard Schema vs raw Zod.** *Adopted Standard Schema v1 as the public contract type*
  (decouples the public surface from any one validator's major version) **but kept the DX
  expert's schema-generic inference** by parametrizing on `S extends StandardSchemaV1` and
  deriving `T = StandardSchemaV1.InferOutput<S>`. Rejected embedding `z.ZodType` directly in the
  semver-stable surface (largest dependency liability) and rejected pure value-generic
  `OutputSpec<T>` (collapses to `unknown`). Zod stays the blessed, documented impl + peerDep.
- **Compile-time capability gating (`ConfigFor<M>` making `topK` on OpenAI a type error).**
  *Adopted only for the STATIC path* (literal model at the call site). Explicitly **rejected as a
  global guarantee**: it is fundamentally incompatible with the locked goal of runtime/UI-driven
  model swap (you cannot statically gate config against a model that arrives at runtime). The
  honest answer is two tiers — static gating where the model is a literal, runtime
  validation+`Warning`/clamp where it is dynamic.
- **`ModelDescriptor.pricing` as authority.** *Rejected* having pricing live authoritatively in
  the adapter-bundled descriptor (it would force an adapter release to fix a price). `PricingSource`
  is the single authority (owns `version`, frozen on the record); `descriptor.pricing` is demoted
  to an OPTIONAL seed used only to generate the snapshot and as a last-resort fallback.
- **Auto-scanning `node_modules` for adapters.** *Rejected* (anti-pattern for a library);
  registration stays explicit, discovery is via npm naming convention + docs.
- **Dropping the stream `done` event in favor of only the `final` promise.** *Adopted* for the
  consumer-facing union (the `final` promise is the single authoritative result); an internal
  terminal signal remains but is not in the public event union.

### Lead-architect final pass (this revision)

Applied two critics' valid findings; the design is now internally consistent and the type sketches
compile in principle. Changes by theme:

**Type system made coherent (phantom generics removed; load-bearing generics actually threaded).**
- Dropped the phantom `<T>` from `ResolvedRequest`, `AdapterResult`, `ProviderAdapter.run/runStream`,
  `Handler`, `Middleware`, and `StreamEvent` — the adapter never produces the validated type
  (`rawStructured: unknown`), so `T` conveyed nothing and was a semver trap. The engine validates
  `rawStructured` against `output.schema` at the caller boundary (§7).
- **Static capability gating is now real.** `CallSite`/`defineCallSite`/`runStructured`/`stream`
  capture the model literal `M` (via `const` type params) and type `config` as `ConfigFor<M>`, so a
  one-line swap to a model lacking `topK`/`reasoning` is a COMPILE error. Documented the two honest
  limits (dynamic/unknown `ModelId`, runtime path) (§5).
- **Tools-as-data typed args delivered end-to-end.** Defined `Tool<N,S>`, threaded a `Tools` generic
  through the call path, and `LlmResult.toolCalls` is now `ToolCallFor<Tools>[]` (zero-cast
  `switch(call.name)` narrowing). Added `runText`/`runImage` signatures (§4, §5).
- Renamed `Blob` → `BinarySource` (stop shadowing the global `Blob`) (§4).

**Provider-reality / FinOps correctness.**
- Per-modality INPUT pricing: added `inputAudioTokens`/`inputImageTokens` (pinned as subsets of
  `inputTokens`) + `inputAudioPerM`/`inputImagePerM`; the §10 formula now bills them at their own
  rate (closes multimodal-input mis-billing). Output-modality token rates added too.
- Long-context/volume `tiers` are now APPLIED in the §10 rate-selection step (were typed but never
  billed → undercosting large-context calls).
- `Cost.confidence='exact'` is now implementable via the adapter-set `Usage.categorization`
  (`complete`/`partial`) signal — the engine no longer needs to (and cannot) distinguish billable
  from informational raw keys itself (§4, §10).

**Routing / extensibility contracts pinned.**
- Provider-fallback middleware is now POSSIBLE: routing moved INSIDE the innermost handler and
  `EngineCtx.reresolve(...)` lets middleware re-route to a different provider on error (§7, §8).
- Unknown-model routing contradiction resolved: a provider must be determinable (single adapter,
  `adapterId`, or pre-registration); ambiguous unknown models fail closed with `not_found` — the
  "any new model string just works" claim is corrected to that conditional (§9).
- Defined registry conflict resolution (host override wins; cross-adapter model collisions throw at
  `createClient` unless `adapterId` disambiguates) (§7).
- `specVersion` "adapts when an adapter lags" is now defined: additive deltas handled by pure upcast
  shims; non-synthesizable changes major `@gullabs/protocol` and force adapter re-release (§7).
- `@gullabs/protocol` single-instance hazard addressed (single-major peer range + runtime singleton
  guard), matching the Zod treatment (§18).

**Config UX / multi-tenant.**
- `describeConfigForModel`/`validateConfig` are now CLIENT METHODS (async) that read this client's
  registry + tenant `ConfigSource.constraints` instead of adapter defaults; TOCTOU caveat documented
  and the engine always re-clamps at call time (§12).
- `ConfigSource` got a caching/latency contract (etag + `expiresAt` + TTL + invalidation), mirroring
  `AuthProvider` (§7).

**Security / correctness gaps filled.**
- `Redactor` now operates over `RedactableValue` (JSON + a binary placeholder), resolving the
  `Blob`-vs-`JsonValue` incompatibility for inline media (§7).
- Region/residency fail-closed now has backing data: `ModelDescriptor.availableRegions` + a pipeline
  region check (§9, §17).
- Template interpolation semantics defined: single non-recursive pass, no re-expansion (anti-prompt-
  injection), missing-var fail-closed, host owns downstream escaping (§8a).
- `idempotencyKey` now has a consumer: optional `ResultCache` port + a determinism contract on
  `IdGenerator.idempotencyKey` (§7, §11).
- Async Standard Schema validators supported (pipeline awaits `~standard.validate`) (§8).
- `ModelDescriptor.mode` reduced to `'chat' | 'image'`; `embedding`/`video` removed as out-of-v1-scope
  (no call path) rather than declared-but-unimplemented (§9).

*Declined / deferred (with rationale):* none outright declined — every unresolved/regression item was
addressed. The pre-existing §16 open questions (reconciliation cadence, live contract-test budget,
supply-chain owner, number of regions to certify) remain owner decisions, not contract gaps.

---

## 1. Goals & non-goals

### Goals
1. **One clean call interface** for any model (Gemini / OpenAI / Anthropic / future).
2. **Structured output** via a validator (Zod as blessed impl, Standard Schema as the contract)
   as the single source of truth.
3. **Dynamic per-call config** (temperature, topP, topK, reasoning/thinking, etc.) with a
   **fallback chain** down to library defaults, AND a **JSON-serializable config contract a UI/DB
   can drive** (per-environment / per-tenant) with safety **constraints** (§12).
4. **One-line OR UI-configurable model swap**: changing a single `model` value (in code, DB, flag,
   or UX) re-routes provider + config safely, because `model` is the single source of routing truth.
5. **Observability**: normalized usage (input/output/reasoning/cached tokens), latency,
   cost, errors — emitted to whatever the host wires (Sentry / PostHog / OTel).
6. **Consistent structured logging** with a canonical event vocabulary.
7. **Ergonomic system/user instructions, prompt caching, and file/media** support.
8. **Costing** from public pricing data, computed **at call time** and **frozen** per record.
9. **Persistence into the host project's own database tables** via a port; an optional
   Drizzle companion ships a reference schema.
10. **Extensibility above all**: a new model launching tomorrow with new request options
    and new usage fields must be **captured and persisted with zero core changes**, registrable
    at runtime, and promotable to first-class fields later. Third parties write adapters/sinks
    without forking.
11. **Released open source**: a minimized, versioned public API surface; semver discipline;
    docs; a contribution model; a stated dependency policy (§18).

### v1 scope (decided)
**In scope:** text + structured output, **tools-as-data** (surface tool-call requests / accept
tool results — the lib never executes a tool), **streaming**, **multimodal input** (image/file/
audio/video), **multimodal output** (image/audio generation), **multi-turn** message state
(including round-trippable reasoning), **grounding/citations**, usage/cost, observability,
persistence — across Gemini, then Anthropic, OpenAI. Everything is a **single deterministic call**.

**The one hard line — NO autonomous agent loop.** The library is the one-call primitive
(request → response). It never auto-executes tools and never re-calls the model in a loop.
Sequencing / "keep going until done" / branching is the **host's** control flow (Temporal
workflows, route handlers) calling the primitive in a loop the host owns and can inspect. This
is exactly how redline/postbuzz already work, and it's what keeps the thin adapters thin.

> **Accepted trade-off (per adversarial review #1):** taking streaming + tools + grounding +
> multimodal first-class means provider response-shape/stream-semantics divergence is now the
> library's permanent maintenance burden. We accept this deliberately. The spine that absorbs it:
> a normalized core surface + per-provider **raw capture** + structured **warnings** on anything
> not faithfully representable (no silent leakage). Where a feature genuinely can't be normalized,
> it surfaces via `providerMetadata`/`providerOptions` rather than a fake-portable abstraction.
> A published **fidelity matrix** (§18) documents exactly where the normalized surface degrades.

### Non-goals
- Not a gateway/proxy. No network hop, no separate process. Loads in-process.
- **Not an agent framework, not a tool-loop runner.** No autonomous loop, ever (see scope above).
- Does not own the DB connection, migrations, tenant scoping, or the Sentry/PostHog client.
- Not a pricing service — it consumes a pinned pricing snapshot.

---

## 2. Design principles

**P1 — The host owns the world; the library owns the contract.**
Everything environmental (DB, logger, telemetry sink, clock, id generation, blob store,
secrets) is a *port* the host implements. The core is pure and deterministic given its ports.

**P2 — Typed core + raw passthrough + raw capture (the extensibility spine).**
Every place where providers differ has three lanes:
- a **typed lane** for the common, well-understood options/fields (first-class, validated);
- a **raw passthrough lane** (`providerOptions`) that adapters forward *verbatim* to the
  raw SDK — so a brand-new request param works the day the provider ships it, no core change;
- a **raw capture lane** — adapters always copy the provider's *entire* raw usage object and
  response metadata into the result and the persisted record, so a brand-new *usage field* is
  never lost even before we model it.
Promotion is a later, optional, non-breaking step: move a field from raw → typed when it
proves broadly useful. The same forward-compat escape hatch exists on the INPUT side
(`{ kind: 'provider' }` Part) and the STREAM side (`raw` event), so input modalities and stream
events are as forward-compatible as output.

**P3 — Adapters are thin and dumb; the engine is smart.**
Provider adapters do exactly one thing: translate `ResolvedRequest ⇄ raw SDK`. They contain no
costing, no logging, no persistence, no retries, no Zod validation. The adapter returns RAW parsed
structured output + normalized usage; the engine validates, costs, logs, persists, retries.

**P4 — Cost is frozen at write time.**
A ledger must be reproducible. Cost is computed when the call happens, stored as an integer
(micro-USD) alongside the **pricing snapshot version** used. Historical rows never recompute.

**P5 — Fail-open on side effects, fail-closed on the call (and fail-closed on privacy).**
A broken sink/telemetry/cost computation must never fail the LLM call. A broken call fails
loudly with a typed `LlmError`. Privacy is the exception to fail-open: when capture is requested
but the safety machinery (Redactor) is absent, the engine **downgrades capture** rather than
leaking — never persist unredacted by accident (§17).

**P6 — Forward-compatible persistence.**
The record has typed columns for the hot/queryable fields and `jsonb` columns for the raw
lanes. New fields land in `jsonb` immediately; we add typed columns only when we want to
index/aggregate on them.

**P7 — Routing is a function of `model`, not of code wiring.**
A call site's provider is derived from the resolved model's descriptor, not bound in source. This
is what makes the "swap model from a UI" goal real rather than aspirational.

---

## 3. Architecture (hexagonal / ports & adapters)

```
                ┌─────────────────────────────────────────────┐
   host code →  │  Call-site registry  (defineCallSite)        │   ergonomic surface
                │  client.runStructured / runText / runImage   │
                │  client.stream                               │
                └───────────────────────┬─────────────────────┘
                                        │  LlmRequest
                ┌───────────────────────▼─────────────────────┐
                │            Core engine (pure)                │
                │  config resolve+clamp · route · middleware   │
                │  invoke · time · normalize usage · validate  │
                │  cost · telemetry · log · persist · retries  │
                │  error taxonomy · idempotency · attempts     │
                └───┬──────┬──────┬──────┬──────┬──────┬───────┘
       ProviderAdapter PricingSource UsageSink Telemetry Logger Clock/Id/Blob/FileStore/Auth/ConfigSource/RateLimiter/Redactor/ModelRegistry/Middleware
            │  (ports — host or companion packages implement)
   ┌────────┼─────────┬──────────────┐
   ▼        ▼         ▼              ▼
 google   anthropic  openai     (future provider)     ← raw-SDK adapters, owned by us
```

### Package layout
```
@gullabs/protocol        # SLOW-MOVING contract: ProviderAdapter, ResolvedRequest, AdapterCtx,
                        #   AdapterResult, ModelDescriptor, port interfaces, wire/spec versions.
                        #   Core + every adapter depend on THIS, not on each other's cadence.
@gullabs/core            # engine, call-site registry, config resolution, reasoning/cache
                        #   unification, error taxonomy. Depends on @gullabs/protocol.
@gullabs/google          # ProviderAdapter over @google/genai (+ Gemini cache manager, Files API, Imagen)
@gullabs/anthropic       # ProviderAdapter over @anthropic-ai/sdk
@gullabs/openai          # ProviderAdapter over openai (Responses API target; Chat fallback)
@gullabs/pricing         # pinned pricing snapshot + refresh script (data via tokenlens/LiteLLM-style)
@gullabs/drizzle         # reference llm_calls schema + drizzleUsageSink(db, table)
@gullabs/testing         # in-memory fakes + runnable conformance kits for every port
```
Core depends on **none** of the provider packages. Provider SDKs (`@google/genai`,
`@anthropic-ai/sdk`, `openai`) and `zod` are **peerDependencies** (§18), never bundled deps, to
avoid duplicate/version-skewed instances in the host tree. Image generation is a capability of the
relevant provider packages (`@gullabs/google` exposes Imagen), not a separate concern.

**Audience-split entrypoints** (so the app surface and the adapter/sink-author surface evolve
independently): `@gullabs/core` (app), `@gullabs/core/adapter`, `@gullabs/core/sink`,
`@gullabs/core/internal` (excluded from semver). See §18.

---

## 4. Core domain types

`JsonValue` is defined once in `@gullabs/protocol` and exported:
```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }
```

### Model identity (augmentable, still open)
```ts
// Empty in core; provider packages augment it via `declare module '@gullabs/protocol'`.
interface KnownModels {}
type ModelId = keyof KnownModels | (string & {})   // literal autocomplete, but ANY string compiles
type ModelCaps<M extends ModelId> = M extends keyof KnownModels ? KnownModels[M] : Record<string, unknown>
// provider pkg example:
// declare module '@gullabs/protocol' {
//   interface KnownModels { 'gemini-3.1-flash-lite': { provider:'google'; reasoning:'level'; responseSchema:true; topK:true } }
// }
```

### The request (provider-agnostic)
```ts
interface LlmRequest<S extends StandardSchemaV1 = StandardSchemaV1> {
  model: ModelId                       // SINGLE source of provider routing (resolved → descriptor.provider)
  adapterId?: string                   // optional escape hatch ONLY when model→provider is ambiguous
  system?: string
  messages: Message[]                  // multi-turn; multimodal + tool-call/result + reasoning parts
  output?: OutputSpec<S>               // structured-output intent (validator-driven)
  tools?: ToolDef[]                    // tools-as-data — declared for the model, never executed by the lib
  toolChoice?: ToolChoice
  toolControls?: ToolControls          // parallel / allowedTools (rest → providerOptions)
  config?: GenConfig                   // typed common knobs + raw passthrough
  cache?: CacheIntent                  // provider-agnostic caching intent
  region?: string                      // data-residency / endpoint selection; flows to Auth+Blob+Sink
  metadata?: CallMetadata              // host anchors: tenantId, runId, callSiteId, traceId…
}
```
Routing is NOT done by string-prefix guessing (fragile, collides across providers). The engine
resolves the model's `ModelDescriptor` (§9), reads `descriptor.provider`, and looks up the adapter
in the provider→adapter map built at `createClient`. `adapterId` overrides only when needed.

### Messages & multimodal parts (multi-turn, in scope)
```ts
type Message = { role: 'user' | 'assistant' | 'tool'; parts: Part[] }

// Unambiguous binary encoding — a discriminated union, so adapters branch precisely
// (bytes → upload-or-inline by size; base64 → inline; uri → passthrough). No more "string /*b64*/".
// NOTE: named `BinarySource`, NOT `Blob`, to avoid shadowing the global `Blob` (DOM lib + Node ≥18
// globals; our Node floor is >=20). A public core type must never silently override a global.
type BinarySource = { bytes: Uint8Array } | { base64: string } | { uri: string }

type Part =
  | { kind: 'text'; text: string }
  // Round-trippable reasoning — CRITICAL for multi-turn on Anthropic (extended thinking +
  // tools requires resending thinking blocks WITH signatures or the API 400s), Gemini 3
  // (thoughtSignature on function-call parts), OpenAI Responses (reasoning items / encrypted_content).
  // Adapters MUST emit these in results and accept them back unmodified. providerData is verbatim.
  | { kind: 'reasoning'; text?: string; signature?: string; redacted?: boolean; providerData?: JsonValue }
  | { kind: 'image'; mimeType: string; source: BinarySource; ref?: FileRef; cache?: PartCache }
  | { kind: 'audio'; mimeType: string; source: BinarySource; ref?: FileRef }
  | { kind: 'video'; mimeType: string; source: BinarySource; ref?: FileRef; meta?: { startOffsetSec?: number; endOffsetSec?: number; fps?: number } }
  | { kind: 'file';  mimeType: string; source: BinarySource; ref?: FileRef; cache?: PartCache }
  | { kind: 'media'; mimeType: string; ref: FileRef }   // already-uploaded (Files API URI)
  // tools-as-data — the lib MAPS these to/from each provider's wire format; it NEVER executes:
  | { kind: 'tool-call';        id: string; name: string; args: JsonValue; argsValid?: boolean }
  | { kind: 'tool-result';      id: string; name: string; result: JsonValue | Part[]; isError?: boolean }
  | { kind: 'server-tool-result'; tool: string; data: JsonValue }   // inline server-side tool output
  // INPUT-side forward-compat escape hatch (mirrors the StreamEvent `raw` case): provider-specific
  // input block we don't model yet. Adapters forward verbatim ONLY when provider === this.id, else Warning+drop.
  | { kind: 'provider'; provider: string; data: JsonValue }

type PartCache = { ttl?: '5m' | '1h' }   // Anthropic cache_control breakpoint marker
```

### Tool definitions (declared, not executed)
Tools come in two flavors. **Function** (client-side, host executes) and **provider/server-side**
(the model runs them itself: Gemini `googleSearch`/`urlContext`/`codeExecution`; Anthropic
`web_search`/`code_execution`/`computer`/`bash`/`text_editor`; OpenAI `web_search`/`file_search`/
`code_interpreter`/`image_generation`). Server tools have no schema and emit results/citations inline.
```ts
type ToolDef =
  | { kind?: 'function'; name: string; description?: string; parameters: StandardSchemaV1 }
  | { kind: 'provider';  name: string; config?: JsonValue }
type ToolChoice = 'auto' | 'none' | 'required' | { tool: string }
interface ToolControls { parallel?: boolean; allowedTools?: string[] }

// Typed tool helper for zero-cast tool-call narrowing on the host side. `Tool<N,S>` is a
// `ToolDef` refined with literal name + schema generics so the result path can narrow `args`.
interface Tool<N extends string, S extends StandardSchemaV1> {
  kind?: 'function'; name: N; description?: string; parameters: S
}
function defineTool<N extends string, S extends StandardSchemaV1>(t: { name: N; description?: string; parameters: S }): Tool<N, S>
// A discriminated union over the call site's declared tools, so `switch(call.name)` narrows
// `call.args` with ZERO casts. This is the type surfaced on `LlmResult.toolCalls` when a call
// site / `runStructured` captures a tools tuple (see §5). Untyped/low-level `generate` falls back
// to the open `ToolCall` (args: JsonValue).
type ToolCallFor<T extends readonly Tool<any, any>[]> =
  T extends readonly [] ? ToolCall
  : { [I in keyof T]: T[I] extends Tool<infer N, infer S>
      ? { id: string; name: N; args: StandardSchemaV1.InferOutput<S>; argsValid?: boolean } : never }[number]
```

### Structured output
The public contract type is **Standard Schema v1** (supported by Zod ≥3.24, Valibot, ArkType),
which decouples the semver-stable surface from any one validator's major version. We parametrize on
the **schema generic `S`** (not the value) so the output type is inferred with zero caller-side type
args and zero casts; Zod remains the blessed, documented implementation (peerDependency).
```ts
interface OutputSpec<S extends StandardSchemaV1 = StandardSchemaV1> {
  schema: S
  mode?: 'native' | 'json' | 'tool'   // native = provider-enforced schema; json = parse text + validate;
                                       // tool = Anthropic tool-based structured output.
                                       // engine auto-falls-back native→json when a feature (e.g. grounding)
                                       // is incompatible with native schema on that provider (→ Warning).
}
type OutputOf<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>
```

### Generation config (typed core + escape hatch)
```ts
interface GenConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  reasoning?: ReasoningIntent            // UNIFIED across providers (see §6) — INTENT, not a guarantee
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority' | 'batch'   // real provider values (§6)
  timeoutMs?: number
  // ↓↓ the raw passthrough lane — typed via an AUGMENTABLE registry, still open for novel providers.
  providerOptions?: Partial<ProviderOptionsRegistry> & { [provider: string]: Record<string, unknown> | undefined }
}

// Augmentable typed registry — provider packages contribute their option surface, so well-known
// keys get autocomplete + typo-protection while unknown providers still compile via the index sig.
interface ProviderOptionsRegistry {
  google: GoogleProviderOptions
  anthropic: AnthropicProviderOptions
  openai: OpenAIProviderOptions
}
```

> **providerOptions precedence & safety (engine-enforced).** Typed `GenConfig` fields are applied
> first; `providerOptions` overlays them LAST and wins. ANY passthrough key that overrides a typed
> field or collides with an engine-managed field (output schema, tools) MUST emit a `Warning`
> (mandatory in the conformance suite). **Transport/auth keys** (`apiKey`, `authToken`, `baseURL`,
> `baseUrl`, `httpAgent`, `fetch`, `defaultHeaders`, `organization`, `project`) are **stripped
> before forwarding** (credentials come only from `AuthProvider`) and **scrubbed before
> persistence** unconditionally (§17). Adapters declare a `forwardableKeys` allowlist.

### Reasoning INTENT (§6) — explicitly best-effort, NOT a portable guarantee
Callers over-trust a "unified reasoning" knob because `'high'` on OpenAI ≠ a fixed budget on
Anthropic ≠ `thinkingLevel` on Gemini. So we name it *intent*; the adapter reports mapping fidelity
and a lossy mapping emits a `Warning`.
```ts
interface ReasoningIntent {
  effort?: 'none' | 'low' | 'medium' | 'high'   // portable INTENT, mapped per provider
  budgetTokens?: number                          // explicit budget (Gemini 2.5 / Anthropic)
  includeThoughts?: boolean                      // return reasoning summary if supported
}
// adapters report mappingQuality: 'exact' | 'approximate' | 'unsupported' (Warning on the latter two).
// Advanced callers bypass via providerOptions.
```

### The result
```ts
// `T` = validated structured-output type (from the schema generic). `TC` = the tool-call shape:
// `ToolCallFor<Tools>` when the call site declared a typed tools tuple (zero-cast `switch(call.name)`
// narrowing of `args`), else the open `ToolCall` (`args: JsonValue`) for the low-level path.
interface LlmResult<T = unknown, TC extends { id: string; name: string } = ToolCall> {
  output?: T                      // validated structured output (absent when the turn ended in
                                  //   tool-calls or pure media — see finishReason)
  text?: string                   // raw text (when not pure-structured)
  content?: Part[]                // ORDERED interleaved output (text, image, text… for nano-banana /
                                  //   Gemini image+text turns). `text`/`media` are convenience projections.
  toolCalls?: TC[]                // tools-as-data: model requested these; HOST executes + feeds back
                                  //   (typed as ToolCallFor<Tools> when the call site declared tools)
  media?: GeneratedMedia[]        // multimodal OUTPUT: generated images/audio (Imagen, etc.)
  citations?: Citation[]          // grounding/citation spans, normalized where possible (raw in providerMetadata)
  groundingDisplay?: { provider: string; renderedHtml?: string; searchQueries?: string[] }
                                  // Gemini Search-Suggestion chips are ToS-MANDATORY to display —
                                  //   surfaced explicitly, never buried in providerMetadata (§17 compliance).
  usage: Usage                    // normalized + raw (see below)
  model: ModelId
  modelVersion?: string           // resolved SKU (used for pricing when present)
  finishReason?: FinishReason
  responseId?: string
  latencyMs: number
  cost?: Cost                     // null-able; tokens still captured if model unpriced
  providerMetadata?: JsonValue    // raw provider metadata blob (grounding, safety, etc.)
  // NEVER silently drop a setting (lesson from Vercel's LanguageModelV2). When an adapter can't
  // honor a requested option it MUST emit a structured warning, persisted on the record — the
  // antidote to "providerOptions passthrough drifts silently".
  warnings: Warning[]             // non-optional: empty array, never undefined
}

type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'media' | (string & {})

type Warning =
  | { type: 'unsupported-setting'; setting: string; details?: string }
  | { type: 'unsupported-model-feature'; feature: string; details?: string }
  | { type: 'fallback'; from: string; to: string; details?: string }   // e.g. native→json schema
  | { type: 'other'; message: string }

interface ToolCall { id: string; name: string; args: JsonValue; argsValid?: boolean }
interface GeneratedMedia { mimeType: string; data?: BinarySource; ref?: FileRef }

// Provider-scoped file handle: a Gemini Files URI is unusable on OpenAI/Anthropic; Anthropic Files
// is beta-gated. Engine warns when a ref's provider != the call's provider.
interface FileRef { uri: string; provider: string; mimeType?: string; expiresAt?: string }

// Citations: a discriminated, lossless-enough shape across three incompatible provider models.
interface Citation {
  kind: 'char' | 'page' | 'block' | 'url'
  start?: number; end?: number; page?: number
  uri?: string; title?: string; citedText?: string
  confidence?: number; sourceIndices?: number[]
  raw?: JsonValue
}
```

### Usage — typed core + canonical token map + raw capture
Token types are an open set that grows per provider, AND the inclusion conventions differ
incompatibly (OpenAI `prompt_tokens` INCLUDES cached; Anthropic `input_tokens` EXCLUDES cache
read/write; Gemini reports `cachedContentTokenCount` separately). We pin a **single canonical
convention** and enforce it in adapters + conformance tests, so cost math never double-counts.
```ts
interface Usage {
  // (a) typed hot fields — GROSS/inclusive totals (the pinned convention)
  inputTokens: number             // GROSS: INCLUDES cachedInputTokens + cacheWriteTokens AND the
                                  //   per-modality input subsets (inputAudioTokens / inputImageTokens)
  outputTokens: number            // GROSS: INCLUDES reasoningTokens + per-modality output subsets
  reasoningTokens?: number        // subset of outputTokens
  cachedInputTokens?: number      // cache-READ subset of inputTokens
  cacheWriteTokens?: number       // cache-CREATION subset of inputTokens
  // per-modality INPUT subsets of inputTokens (providers price audio/image input differently from
  //   text). PINNED: these are SUBSETS of inputTokens, never additive. Text-input tokens are the
  //   remainder: inputTokens − cachedInputTokens − cacheWriteTokens − inputAudioTokens − inputImageTokens.
  inputAudioTokens?: number       // subset of inputTokens
  inputImageTokens?: number       // subset of inputTokens
  // per-modality OUTPUT subsets of outputTokens (audio/image generation token billing)
  outputAudioTokens?: number      // subset of outputTokens
  outputImageTokens?: number      // subset of outputTokens
  totalTokens?: number
  // (b) canonical token-type MAP — a CLOSED vocabulary so cross-provider GROUP BY is deterministic.
  //     The old substring heuristic ("keys containing 'input' summarize") is REMOVED: it
  //     double-counted subsets like cached_input. New provider keys land in rawDetails until promoted.
  details: Partial<Record<CanonicalTokenType, number>>
  rawDetails?: Record<string, number>   // verbatim provider keys, pre-promotion (queryable)
  // (c) raw capture — the provider's ENTIRE usage object verbatim
  raw: JsonValue
  // provenance for cost confidence + abort/stream handling
  source: 'provider-reported' | 'partial' | 'estimated' | 'absent'
  // (d) categorization completeness — set by the adapter, NOT inferred by the engine. This is the
  //     missing signal that makes `Cost.confidence='exact'` implementable: the engine cannot tell
  //     a billable raw category from an informational one. 'complete' ⇒ the adapter mapped EVERY
  //     billable token category into the typed/canonical fields and any remaining `rawDetails` keys
  //     are KNOWN-informational (e.g. provider-internal counters) → safe for 'exact'. 'partial' ⇒
  //     at least one unrecognized category that MIGHT be billable remained in rawDetails → cost
  //     confidence downgrades to 'estimated'. Conformance fixtures assert this per adapter.
  categorization: 'complete' | 'partial'
}

type CanonicalTokenType =
  | 'input_text' | 'input_cached' | 'input_audio' | 'input_image'
  | 'cache_write'
  | 'output_text' | 'output_reasoning' | 'output_audio' | 'output_image'
  | 'tool_use'
```

The `raw` lanes (`Usage.raw`, `LlmResult.providerMetadata`) are the heart of the extensibility
guarantee: **whatever a provider returns that we haven't modeled yet is still captured and persisted.**

### Cache intent (three incompatible provider mechanisms)
```ts
// Anthropic: positional cache_control breakpoints (≤4), per-block, TTL '5m' (default) or '1h' (2× write).
//   → expressed via Part.cache markers above.
// Gemini: explicit cachedContent object (create → name → reference), min-token thresholds.
// OpenAI: fully implicit (no control) → adapter emits Warning on explicit breakpoint requests.
interface CacheIntent { mode?: 'auto' | 'explicit'; ttl?: '5m' | '1h'; ref?: FileRef /* Gemini cachedContent name */ }
```

---

## 5. The clean caller surface — call-site registry

Hosts don't hand-build `LlmRequest`s at every site. They register named **call sites** with
defaults, then call by name. This is the ergonomic interface and the unit of config override.

```ts
const SummarySchema = z.object({ title: z.string(), bullets: z.array(z.string()) })

const summarize = defineCallSite({
  id: 'doc.summarize',
  // NO embedded adapter factory. `model` routes; adapterId is an optional disambiguator only.
  model: 'gemini-3.1-flash-lite',
  schema: SummarySchema,                          // Standard Schema (Zod here)
  system: 'You are a precise summarizer…',
  userTemplate: '{{document}}',
  config: { maxOutputTokens: 4096, reasoning: { effort: 'none' } },
})
// returns CallSite<typeof SummarySchema, { document: string }> — schema + vars generics captured.

// at the call site (vars typed; output inferred — zero type args, zero casts):
const { output, usage, cost } = await client.runStructured(summarize, { document: text }, {
  config: { reasoning: { effort: 'high' }, providerOptions: { google: { someBrandNewKnob: 1 } } },
  metadata: { tenantId, runId },
  origin: 'code',   // 'code' → passthrough drift warns; 'ui' → validation failures throw (§12)
})
```

Type-level signatures (inference parametrizes on the **schema** `S`, the **model literal** `M`, and
the **tools tuple** `Tools` — so config is statically gated by `M` and tool-call `args` narrow on the
result with zero casts). `defineCallSite` uses `const` type parameters so `model` and the tools tuple
are captured as literals, not widened to `ModelId`/`Tool[]`:
```ts
interface CallSite<
  S extends StandardSchemaV1 = StandardSchemaV1,
  V extends Record<string, unknown> = Record<string, never>,
  M extends ModelId = ModelId,
  const Tools extends readonly Tool<any, any>[] = readonly []
> {
  id: string; model: M; adapterId?: string; schema?: S
  system?: string; userTemplate?: string; tools?: Tools
  config?: ConfigFor<M>          // ← config is GATED by the captured model literal M (see below)
}
function defineCallSite<
  S extends StandardSchemaV1,
  V extends Record<string, unknown> = Record<string, never>,
  const M extends ModelId = ModelId,
  const Tools extends readonly Tool<any, any>[] = readonly []
>(cfg: CallSiteConfig<S, V, M, Tools>): CallSite<S, V, M, Tools>

function runStructured<S extends StandardSchemaV1, V extends Record<string, unknown>,
  M extends ModelId, const Tools extends readonly Tool<any, any>[]>(
  site: CallSite<S, V, M, Tools>, vars: V, opts?: RunOptions
): Promise<LlmResult<OutputOf<S>, ToolCallFor<Tools>>>

// text-only (no schema) and image-output entrypoints — same gating + tools threading:
function runText<V extends Record<string, unknown>, M extends ModelId,
  const Tools extends readonly Tool<any, any>[]>(
  site: CallSite<never, V, M, Tools>, vars: V, opts?: RunOptions
): Promise<LlmResult<never, ToolCallFor<Tools>>>      // .text / .toolCalls populated, no .output
function runImage<V extends Record<string, unknown>, M extends ModelId>(
  site: CallSite<never, V, M>, vars: V, opts?: RunOptions
): Promise<LlmResult<never>>                            // .media populated (Imagen / image mode)
```
`RunOptions.config` is also typed `ConfigFor<M>` so a per-call override is gated identically.
Template var typing offers two tiers: (1) explicit `defineCallSite<typeof Schema, { document: string }>(…)`
as the contract, and (2) best-effort template-literal extraction of `{{name}}` tokens into
`Record<name, string>` as a convenience (deeply nested/conditional templates exceed what TLT can model).

**STATIC capability gating (literal-model path only) — now actually wired.** `CallSite.config` and
`RunOptions.config` are typed `ConfigFor<M>`, and `M` is captured as a literal by the `const` type
parameter on `defineCallSite`. So when `model` is a compile-time literal that is a key of the
augmented `KnownModels`, swapping the literal re-checks config at compile time:
```ts
type ConfigFor<M extends ModelId> = Omit<GenConfig, 'topK' | 'reasoning'>
  & (ModelCaps<M> extends { topK: true } ? { topK?: number } : { topK?: never })
  & (ModelCaps<M> extends { reasoning: 'none' } ? { reasoning?: never } : { reasoning?: ReasoningIntent })
```
Worked example of the guarantee: a call site on `'gemini-3.1-flash-lite'` (which declares `topK:true`
in `KnownModels`) accepts `config.topK`; changing that one literal to an OpenAI model whose
`KnownModels` entry omits `topK` makes `topK?: never`, so the previously-valid `config.topK` becomes
a **compile error** — the headline "safe one-line swap" backed at the type level.

Two honest limits of static gating (both by design, not gaps):
- **Unknown/dynamic `ModelId` (`string & {}`)** resolves `ModelCaps<M>` to `Record<string, unknown>`,
  which matches neither `{ topK: true }` nor `{ reasoning: 'none' }`, so `ConfigFor` falls to its
  conservative branch (`topK?: never`, `reasoning?: ReasoningIntent`). A model string not present in
  `KnownModels` therefore cannot statically set `topK`; such call sites use the runtime-validated path
  (below) or `client.generate(...)`.
- **The DYNAMIC path** (config from `ConfigSource`/UX, model arriving at runtime) is validated against
  the resolved `ModelDescriptor` at runtime with a `Warning`/clamp instead (§12).

This split is the honest resolution of the intrinsic tension between "compile-error on unsupported
option" and "model arrives at runtime from a UI" — you cannot statically gate a runtime value.

Low-level escape hatch for ad-hoc calls: `client.generate(request: LlmRequest)`.

**Streaming (in scope).** `client.stream(...)` returns `{ events, final }`: an async iterable of
normalized `StreamEvent`s and a `final` promise resolving to the same `LlmResult<T>` (so usage/cost/
persistence work identically — the engine accumulates and writes one record on completion). The
`final` promise is the **single authoritative result**; the internal terminal signal is not part of
the public event union. Provider stream-event divergence is normalized; anything unmappable passes
through as a `raw` event rather than being dropped.
`StreamEvent` is intentionally NOT generic: no event carries the validated structured output (the
schema is validated once, on completion, against the accumulated text). The validated `output` is
delivered only via the `final` promise. The tools generic flows to `final` so the terminal result's
`toolCalls` narrow:
```ts
type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }              // when includeThoughts + provider supports it
  | { type: 'reasoning-signature'; signature: string }     // so the assistant turn is reconstructable for replay
  | { type: 'tool-call-delta'; id: string; name?: string; argsDelta: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'media'; media: GeneratedMedia }
  | { type: 'warning'; warning: Warning }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'raw'; provider: string; event: JsonValue }    // forward-compat: unmapped provider events

function stream<S extends StandardSchemaV1, V extends Record<string, unknown>,
  M extends ModelId, const Tools extends readonly Tool<any, any>[]>(
  site: CallSite<S, V, M, Tools>, vars: V, opts?: RunOptions
): { events: AsyncIterable<StreamEvent>; final: Promise<LlmResult<OutputOf<S>, ToolCallFor<Tools>>> }
```

> **Stream usage & abort (FinOps safety).** OpenAI only returns usage when
> `stream_options.include_usage` is set — adapters MUST request usage by default. The engine writes
> a ledger row on **every terminal stream outcome including abort/error**, with whatever usage
> accumulated. On abort with no usage, output tokens are estimated from accumulated text deltas,
> `usage.source = 'estimated'`, `cost.confidence = 'estimated'`; on absent usage, `cost.confidence
> = 'unknown'` but the row is still persisted (pay-without-record is the worst FinOps outcome).

---

## 6. Unifying provider-specific concepts

The engine exposes **one** portable concept; each adapter maps it to its provider, and the
`providerOptions` lane is always available for exact control.

| Portable concept | Gemini 3/3.1 | Gemini 2.5 | Anthropic | OpenAI (o-series/GPT-5) |
|---|---|---|---|---|
| `reasoning.effort` | `thinkingLevel: low/high` | mapped→`thinkingBudget` | mapped→`thinking.budget_tokens` | `reasoning_effort` |
| `reasoning.budgetTokens` | (n/a→effort) | `thinkingConfig.thinkingBudget` | `thinking.budget_tokens` | (n/a→effort) |
| `reasoning.includeThoughts` | `includeThoughts` (+`thoughtSignature`) | `includeThoughts` | thinking blocks (+`signature`) | reasoning items (+`encrypted_content`) |
| `cache` (intent) | `cachedContent` + cache manager | same | positional `cache_control` breakpoints (`5m`/`1h`) | implicit (automatic) |
| `serviceTier` | n/a (use Batch API) | n/a (use Batch API) | `service_tier: auto/standard_only` + batch | `service_tier: auto/default/flex/priority` |
| `output.schema` | `responseSchema` (schema→Gemini) | same | tool / json schema (`mode:'tool'`) | `response_format: json_schema` |
| API surface | `generateContent` / `generateImages` (Imagen) | same | Messages | **Responses API** (Chat = fallback) |

Mapping tables live **inside each adapter**, not the core. A model's capabilities are declared
in a **capability descriptor** (§9) so the engine knows, e.g., that a model uses `thinkingLevel`
vs `thinkingBudget`, can't combine native-schema with grounding (auto-fallback to `json`), which
API surface it targets (`responses` vs `chat`), which provider tools it supports, and whether
reasoning signatures must round-trip.

**OpenAI API target.** The **Responses API** is the default target (reasoning items +
`encrypted_content` + `previous_response_id`, built-in tools, structured output). The engine resends
prior `reasoning`/tool parts by default (stateless); optional server-side continuity is exposed via
`providerOptions.openai.previous_response_id`. `responseId` maps to the Responses `id`. Chat
Completions is a fallback adapter for models lacking Responses support (`descriptor.apiSurface`).

---

## 7. The ports (interfaces the host/companions implement)

The adapter contract and its three load-bearing types live in **`@gullabs/protocol`** (slow-moving,
so community adapters don't re-release on every core minor).

```ts
// ── @gullabs/protocol ──
// SpecVersion is the ADDITIVE-compatible revision of the port within a single `@gullabs/protocol`
// major. Bumping it (1 → 2) means "new OPTIONAL surface an adapter MAY implement"; an older adapter
// (lower specVersion) is still valid and the engine fills the gap via a documented upcast shim
// (see "Spec-version compatibility" below). A change that an old adapter CANNOT satisfy (a new
// REQUIRED field on AdapterResult, a changed invariant) is NOT a specVersion bump — it MAJORS
// `@gullabs/protocol`, and adapters must re-release. "Adapts when an adapter lags" is therefore
// only ever defined for additive specVersion deltas; the hard case is handled by the package major.
type SpecVersion = number                         // numeric monotonic within a protocol major

interface ProviderAdapter {
  readonly id: string                            // 'google' | 'anthropic' | 'openai' | …
  readonly specVersion: SpecVersion              // additive port revision implemented (see note above)
  readonly forwardableKeys?: ReadonlySet<string> // providerOptions allowlist; unknown/transport keys stripped + Warning
  capabilities(model: ModelId): ModelDescriptor  // §9 — CAPABILITIES only (pricing is a separate port)
  defaultDescriptors(): ReadonlyArray<ModelDescriptor & { model: ModelId }>  // SEED the ModelRegistry (§9)
  run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult>
  runStream?(req: ResolvedRequest, ctx: AdapterCtx): AsyncIterable<AdapterStreamEvent>
  validateProviderOptions?(opts: Record<string, unknown>): Warning[]
  // Adapters MUST: forward config.providerOptions[this.id] verbatim (minus stripped transport keys);
  //   populate usage.details (canonical map) obeying the GROSS/subset invariants + copy full raw usage;
  //   copy raw response metadata → providerMetadata; emit reasoning parts WITH signatures and accept
  //   them back unmodified; return RAW structured output (no validation); compute NO cost; do NO persistence;
  //   push a Warning for every requested setting they could not honor; propagate ctx.signal into the SDK call.
}

// The three types the previous draft referenced but never defined — now pinned:
interface AdapterCtx {
  signal?: AbortSignal            // cancellation propagated INTO the raw SDK call (not just stop-awaiting)
  auth: AuthMaterial
  clock: Clock
  logger: Logger
  fileStore?: FileStore
  descriptor: ModelDescriptor     // resolved capabilities for this model
  region?: string
}
// NOTE: ResolvedRequest / AdapterResult are intentionally NON-generic. The adapter never produces
// the validated output type — it returns `rawStructured: unknown` and the ENGINE validates against
// `output.schema` to obtain `OutputOf<S>` at the caller boundary. A phantom `<T>` here (the old
// draft) conveyed nothing and was a semver trap, so it is removed.
interface ResolvedRequest {
  model: ModelId; provider: string
  system?: string; messages: Message[]
  output?: OutputSpec; tools?: ToolDef[]; toolChoice?: ToolChoice; toolControls?: ToolControls
  config: GenConfig               // FULLY merged + clamped (§12), no root optionals on resolved config
  cache?: CacheIntent
}
interface AdapterResult {
  text?: string
  rawStructured?: unknown         // engine validates against OutputSpec.schema (adapter does NOT validate)
  content?: Part[]
  toolCalls?: ToolCall[]
  media?: GeneratedMedia[]
  citations?: Citation[]
  groundingDisplay?: { provider: string; renderedHtml?: string; searchQueries?: string[] }
  usage: Usage                    // adapter fills canonical map + raw; NO cost
  finishReason?: FinishReason
  responseId?: string; modelVersion?: string
  providerMetadata?: JsonValue
  warnings: Warning[]             // non-optional: empty array
}
type AdapterStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'reasoning-signature'; signature: string }
  | { type: 'tool-call-delta'; id: string; name?: string; argsDelta: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'media'; media: GeneratedMedia }
  | { type: 'warning'; warning: Warning }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'raw'; event: JsonValue }
// The engine accumulates AdapterStreamEvents into an AdapterResult, then into LlmResult/the record.
```

**Spec-version compatibility (what "adapts when an adapter lags" means, precisely).** The engine
holds the current `SpecVersion` it understands. At registration it compares each adapter's
`specVersion`:
- adapter `specVersion` **==** engine: no shim.
- adapter `specVersion` **<** engine (lagging, additive delta): the engine wraps the adapter in a
  documented **upcast shim** that supplies defaults for surface added since the adapter's version
  (e.g. a field added at spec N is synthesized for an N-1 adapter — `usage.categorization` defaults
  to `'partial'`, a newly-added optional result field defaults to absent). Every shim is a pure
  function `upcastResult_{from}_{to}` shipped in `@gullabs/protocol`; the chain of upcasts is applied
  in order. A `Warning{type:'fallback'}` records that a shim ran.
- adapter `specVersion` **>** engine: the engine rejects registration with a clear error (upgrade
  core) — it must never silently ignore surface it doesn't understand.
- A change an old adapter **cannot** synthesize (new REQUIRED field, changed invariant) is by
  definition NOT an additive specVersion bump; it majors `@gullabs/protocol` (§18) and the adapter
  must re-release. There is no silent "adapt" in that case — the protocol major + the peer-range is
  the mechanism, so the hand-wave is removed.

```ts
// ── runtime registry (closes the "add a model with zero release" gap) ──
interface ModelRegistry {
  get(model: ModelId): ModelDescriptor | undefined
  register(d: ModelDescriptor & { model: ModelId; provider: string }): void
  list(provider?: string): ModelDescriptor[]
}
// Engine (NOT the adapter) owns resolution. Order (highest first):
//   host-registered override → ConfigSource-supplied descriptor → adapter defaultDescriptors() → conservative fallback.
// A host adds/patches a model at runtime with one registry.register(...) — no release.
//
// CONFLICT RESOLUTION (defined, not left to chance):
//  (1) defaultDescriptors() vs host register(...) disagree on `provider` for the same ModelId:
//      host register WINS (it is strictly higher precedence). The override is recorded with a
//      Warning{type:'other'} naming both providers so the divergence is visible, never silent.
//  (2) Two registered adapters' defaultDescriptors() claim the SAME ModelId with DIFFERENT providers
//      (genuine collision): `createClient` detects it at construction and throws unless the call site
//      disambiguates with `adapterId` (the precise reason `adapterId` exists). The error names the
//      colliding adapters. A call site that supplies `adapterId` resolves directly to that adapter's
//      descriptor, bypassing the collision.
//  (3) Same ModelId + same provider from two adapters: harmless duplicate; first registration wins,
//      a debug log notes the shadow. (adapter.id uniqueness is already enforced — §18.)

interface UsageSink {                          // §11 — host writes to ITS OWN db/table
  record(record: LlmCallRecord): Promise<void> // fail-open; engine swallows + logs errors
}

interface PricingSource {                      // §10 — SINGLE authority for cost + reproducibility
  readonly version: string                     // snapshot id, frozen on every record
  price(input: {
    model: ModelId; resolvedModel?: ModelId    // prefer resolved SKU/modelVersion when present
    descriptor: ModelDescriptor
    usage: Usage
    media?: GeneratedMedia[]                    // per-image / per-second pricing for multimodal OUTPUT
    tier?: string
  }): Cost | null
}

interface Telemetry {                          // host wires Sentry/PostHog/OTel
  onStart?(e: CallEvent): SpanHandle | void
  onSuccess?(e: CallEvent, span?: SpanHandle): void
  onError?(e: CallEvent & { error: LlmError }, span?: SpanHandle): void
}

interface Logger { info(o: object, msg: string): void; warn(o: object, msg: string): void; error(o: object, msg: string): void }
interface Clock { now(): number }              // injectable → deterministic tests
interface IdGenerator {
  callId(): string                 // fresh per logical call (may be random)
  attemptId(): string              // fresh per REAL provider attempt (may be random)
  // idempotencyKey MUST be a PURE, deterministic function of the normalized request (same normalized
  // request ⇒ same key, in any process), because cross-process result dedup (ResultCache, §7) depends
  // on it. The default impl hashes (model, system, messages, output schema id, resolved config minus
  // volatile fields, metadata.idempotencyScope). A non-deterministic override breaks dedup — the
  // conformance kit asserts determinism. Callers wanting a custom dedup boundary set
  // `metadata.idempotencyScope`.
  idempotencyKey(req: LlmRequest): string
}

// Auth: explicit expiry for short-lived creds (Vertex WIF / STS ~1h), region + tenant keying for
// residency and BYOK. AuthMaterial values are NEVER logged, put in Warnings, or persisted (§17).
type AuthMaterial =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'bearer'; token: string; expiresAt: number }
  | { kind: 'vertex'; projectId: string; location: string; token: string; expiresAt: number }
interface AuthRequest { provider: string; model?: ModelId; region?: string; tenantId?: string }
interface AuthProvider { credentials(req: AuthRequest): Promise<AuthMaterial> }
// Engine caches by (provider, region, tenant) and refreshes when expiresAt - skewMs <= clock.now().

interface FileStore {                          // large media: upload once, reference by URI
  upload(data: Uint8Array, mimeType: string, opts?: { provider?: string; region?: string }): Promise<FileRef>
  delete(ref: FileRef): Promise<void>
}
// BlobStore: deletable (GDPR/DSAR erasure), encrypted, scoped. Engine generates OPAQUE random keys
// (never derived from prompt). Blobs are private (no public/presigned-public ACL), encrypted at rest,
// lifecycle-expired per retentionClass.
interface BlobPutOptions { contentType: string; retentionClass: string; encryption: 'sse' | 'cmk'; tenantId?: string }
interface BlobStore {
  put(key: string, body: Uint8Array | string, opts: BlobPutOptions): Promise<string>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

// Config: split defaults (overridable) vs constraints (clamps enforced last); resolution context (§12).
interface ConfigResolutionContext { callSiteId: string; environment?: string; tenantId?: string; userId?: string; traceId?: string }
interface ConfigResolution<P> {
  value: P
  version: string                 // etag of THIS tenant/env config; stamped as configSourceVersion (§11)
  expiresAt?: number              // clock ms; engine caches until then (mirrors AuthProvider's contract)
}
interface ConfigSource {
  // Returns value + etag + expiry so the engine can CACHE instead of a DB/network round-trip per call.
  defaults?(ctx: ConfigResolutionContext): Promise<ConfigResolution<CallSiteConfigPatch> | undefined>
  constraints?(ctx: ConfigResolutionContext): Promise<ConfigResolution<OverridePolicy> | undefined>
}
// CACHING CONTRACT (explicit, was missing): the engine caches both results keyed by the resolution
// context (callSiteId, environment, tenantId, userId) until `expiresAt` (default TTL when absent:
// `createClient({ configSourceTtlMs })`, default 30s). Invalidation is by expiry or by a changed
// `version` observed on the next post-TTL fetch; hosts needing instant invalidation lower the TTL or
// push via `client.invalidateConfig(ctx)`. The frozen `version` is stamped on the record as
// `configSourceVersion` for reproducibility. This closes the per-call latency hole multi-tenant
// hosts would otherwise hit (one round-trip per LLM call).

// Optional caller-result dedup (the contract behind `idempotencyKey`). See §11/§13 for semantics.
interface ResultCache {
  get(idempotencyKey: string): Promise<LlmResult | undefined>
  set(idempotencyKey: string, result: LlmResult, ttlMs: number): Promise<void>
}

interface RateLimiter {                        // per-provider/per-model concurrency, quota + backpressure
  acquire(key: string, signal?: AbortSignal): Promise<Release>
}
type Release = () => void

// Redactor: ASYNC + FAIL-CLOSED; covers error + tool surfaces (highest injection/PII risk).
// A request/response carries BinarySource parts (Uint8Array/base64) that are NOT JsonValue, so the
// redactor operates over `RedactableValue`: JSON plus an explicit binary PLACEHOLDER. The engine
// replaces every inline binary part with a `{ kind:'binary', … }` placeholder (the bytes themselves
// are never handed to a text redactor — large media offloads to BlobStore and bypasses text redaction
// by definition, §17) so the BinarySource-bearing Message[] and the redactor contract are type-compatible.
type RedactableValue =
  | null | boolean | number | string
  | RedactableValue[]
  | { [k: string]: RedactableValue }
  | { kind: 'binary'; mimeType: string; byteLength: number; sha256?: string }   // placeholder, never raw bytes
interface RedactionContext {
  kind: 'request' | 'response' | 'metadata' | 'error' | 'tool-args' | 'tool-result'
  callSiteId?: string; tenantId?: string; retentionClass?: string
}
interface Redactor { redact(payload: RedactableValue, ctx: RedactionContext): Promise<RedactableValue> }

// EngineCtx — the per-call context handed to middleware/handlers.
interface EngineCtx {
  callId: string; attemptId: string
  descriptor: ModelDescriptor       // resolved capabilities for the CURRENT req.model
  clock: Clock; logger: Logger
  signal?: AbortSignal
  metadata: CallMetadata
  // Re-resolution hook — THIS is what makes provider-fallback middleware possible (see below).
  // Given a patch (typically a different `model`), it re-runs routing + config merge/clamp and
  // returns a fresh ResolvedRequest bound to the NEW provider/descriptor, which the middleware then
  // passes to `next`. Without this, `next` is pre-bound to one adapter and cannot re-route.
  reresolve(patch: { model?: ModelId; adapterId?: string; config?: GenConfig }): Promise<ResolvedRequest>
}

// Behavioral interception (cross-cutting: semantic caching, injection scanning, provider fallback,
// shadow/canary, budget guards) without forking core. Separate streaming variant — wrapping a stream
// is not wrapping a promise. Built-in retry/cost/persist are the innermost handlers.
//
// ROUTING vs MIDDLEWARE ORDER (fixes "provider fallback is impossible"): the innermost built-in
// handler resolves the adapter from `req.model`/`req.provider` AT INVOCATION time — adapter binding
// is NOT done before the chain. So a middleware can catch a failure from `next(req)` and retry on a
// different provider by calling `next(await ctx.reresolve({ model: otherModel }))`; the innermost
// handler re-routes to the new adapter. Short-circuiting middleware (semantic cache, budget guard)
// still simply returns before calling `next`.
type Handler = (req: ResolvedRequest, ctx: EngineCtx) => Promise<LlmResult>
interface Middleware {
  id: string
  intercept?(req: ResolvedRequest, ctx: EngineCtx, next: Handler): Promise<LlmResult>
  interceptStream?(req: ResolvedRequest, ctx: EngineCtx,
    next: (r: ResolvedRequest, c: EngineCtx) => AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent>
}
```

Every port has an in-memory fake in `@gullabs/testing`. The engine is constructed with a context
object holding the chosen implementations:

```ts
const client = createClient({
  adapters: [google(), anthropic(), openai()],   // throws on duplicate adapter.id; builds provider→adapter map
  pricing: pinnedPricing(),                       // @gullabs/pricing
  sink: drizzleUsageSink(db, llmCalls),           // @gullabs/drizzle, or a custom one
  telemetry: sentryTelemetry(Sentry),
  logger: pinoLogger,
  middleware: [/* ordered outermost-first */],
  redactor,                                       // REQUIRED if any call-site capture !== 'metrics-only'
  resultCache,                                     // OPTIONAL — enables idempotencyKey result dedup (§11)
  configSourceTtlMs: 30_000,                       // default TTL for ConfigSource caching (§7)
  // clock/id/auth/fileStore/blobStore/configSource/rateLimiter/modelRegistry: defaults, overridable
})
```

---

## 8. The engine pipeline (written once, for every call)

```
runStructured(callSite, vars, options)
  1. resolve config (§12)  → fetch ConfigSource.defaults/constraints (CACHED by ctx+etag, §7) →
                             merge precedence, then CLAMP/REJECT against constraints
  1a. region fail-closed   if region set & descriptor.availableRegions excludes it → throw bad_request (§17)
  2. render prompts        (template interpolation; fixed-point single pass, no re-expansion, §8a)
  3. build callId + deterministic idempotencyKey(req) + first attemptId
  3a. result dedup         if ResultCache configured & hit on idempotencyKey → return cached LlmResult
  4. middleware chain (outermost-first) wraps steps 5–13 (built-ins innermost)
  5. telemetry.onStart + logger 'llm.call.start'  (dimensions vs attributes split, §14)
  6. ROUTE (inside the innermost handler, so middleware can reroute via ctx.reresolve):
                           resolve ModelDescriptor (ModelRegistry) → provider → adapter from req.model
  7. rateLimiter.acquire  (per provider/model key)
  8. strip transport keys from providerOptions; (optional) offload oversized payloads via BlobStore
  9. adapter.run/runStream(ResolvedRequest, AdapterCtx)  with timeout + retry policy (§13); new attemptId per real attempt
 10. normalize usage      (canonical map + raw; enforce GROSS/subset invariants; set categorization)
 11. validate output      (Standard Schema `~standard.validate`, AWAITED — may be sync or async;
                           on failure → status=parse_error per §13 throw-vs-return rule)
 12. validate tool-call args against ToolDef schemas → set argsValid (§17 trust boundary)
 13. pricing.price(...)   → Cost in nano-USD, round once to micro-USD (frozen) — fail-open to null
 14. assemble LlmCallRecord (§11)  — scrub config + redact payloads BEFORE the sink sees them
 15. sink.record(...)     fail-open; one row PER ATTEMPT (dedupe on attemptId, §11)
 15a. result cache set    if ResultCache configured → store under idempotencyKey (TTL)
 16. telemetry.onSuccess + logger 'llm.call.success'
 17. return LlmResult
  (errors → classify to LlmError + telemetry.onError + logger 'llm.call.error' + record status)
  (streams → write a row on EVERY terminal outcome including abort, §5)
```

### 8a. Template interpolation semantics (security-relevant; was undefined)
`userTemplate` + `vars` use a deliberately minimal, NON-recursive engine — chosen to remove the
prompt-injection / template-injection surface a richer engine would create:
- Syntax: `{{ name }}` (optional surrounding whitespace). Names are `[A-Za-z0-9_.]+`; dotted paths
  index into nested `vars`.
- **Single fixed-point pass.** Substitution happens ONCE; a substituted value is inserted as a
  **literal string** and is **never re-scanned**. So a `vars` value of `'{{system}}'` is emitted
  verbatim as the eight characters `{{system}}` and CANNOT inject another variable or the system
  prompt. (This is the explicit anti-injection guarantee.)
- No code execution, no conditionals, no helpers/filters. Hosts needing logic build the string
  themselves and pass it as a single var.
- Missing var → `bad_request` (fail-closed) unless the var is declared optional in `CallSiteConfig`.
- Values are inserted as plain text; the library does NOT HTML/shell/SQL-escape (it has no such
  sink) — escaping for downstream sinks is the host's responsibility, documented in the README.

---

## 9. Model descriptor registry (capabilities; pricing is a SEPARATE authority)

Lesson from **LiteLLM's `model_prices_and_context_window.json`**: adopt its proven `supports_*`
vocabulary for easy import. But we **separate the two registries** (resolving the §9/§10 conflict
two experts flagged): **capabilities** are bundled in the adapter (change only when the SDK does)
and resolved through the runtime `ModelRegistry`; **pricing** lives solely in `@gullabs/pricing`,
injected via the `PricingSource` port (pricing churns weekly; adapters should not). `descriptor.pricing`
is an OPTIONAL seed only — used to generate the snapshot and as a last-resort fallback (then
`Cost.confidence = 'estimated'`). `PricingSource` is the single authority frozen on each record.

```ts
interface ModelDescriptor {
  provider: string
  // v1 generation modes ONLY. `embedding` and `video` generation are OUT of v1 scope (no
  // runEmbedding/runVideo call path, no embedding Usage/Cost handling) and are therefore NOT in the
  // enum — a declared capability with no contract behind it is a footgun. (Video/audio/image as
  // INPUT remain supported via Part; this enum is the model's OUTPUT mode.) Adding `embedding`/
  // `video` is a future minor that ships with its own call path + usage/cost handling.
  mode: 'chat' | 'image'
  availableRegions?: string[]                   // residency: if set, the model is routable ONLY in
                                                //   these regions; the engine fails closed otherwise (§17).
                                                //   Absent ⇒ no region constraint (global).
  apiSurface?: 'responses' | 'chat'             // OpenAI: Responses is the default target
  // capabilities — LiteLLM's supports_* vocabulary:
  reasoning: 'none' | 'budget' | 'level'        // which thinking mechanism this model uses
  reasoningSignatureRequired?: boolean          // Anthropic+tools / Gemini 3 → must round-trip
  supportsResponseSchema: boolean               // drives native-vs-json output mode (§4)
  supportsResponseSchemaWithTools: boolean      // false for Gemini grounding → auto json fallback
  supportsPromptCaching: boolean
  cachingStyle: 'none' | 'explicit' | 'implicit' | 'breakpoint'
  supportsVision: boolean
  supportsPdfInput: boolean
  supportsAudioInput: boolean
  supportsFunctionCalling: boolean
  supportedProviderTools?: string[]             // googleSearch, web_search, code_execution, …
  maxInputTokens: number
  maxOutputTokens: number
  serviceTiers: string[]
  // OPTIONAL pricing SEED only (authority is PricingSource):
  pricing?: ModelPricing
}

interface ModelPricing {
  inputPerM: number; outputPerM: number                       // text input / output base rates
  cacheReadPerM?: number
  cacheWritePerM?: number | { '5m': number; '1h': number }   // Anthropic 1h write premium
  reasoningPerM?: number                                       // default: bill at outputPerM
  // per-modality INPUT rates — providers price audio/image input tokens differently from text.
  //   Applied to the Usage subsets (inputAudioTokens / inputImageTokens); fall back to inputPerM.
  inputAudioPerM?: number; inputImagePerM?: number
  // per-modality OUTPUT token rates (distinct from per-unit image / per-second audio below).
  outputAudioPerM?: number; outputImagePerM?: number
  tierPricing?: Record<'flex' | 'priority' | 'batch' | string, { inputPerM: number; outputPerM: number }>
  // long-context / volume breakpoints (e.g. Gemini >200k premium). Selected by total inputTokens;
  //   the HIGHEST breakpoint whose `aboveInputTokens` is met applies (see §10 formula).
  tiers?: Array<{ aboveInputTokens: number; inputPerM: number; outputPerM: number }>
  imagePerUnit?: number; audioPerSecond?: number              // multimodal OUTPUT (per generated image / per second)
}
```
Resolution uses the runtime `ModelRegistry` (§7).

**Unknown model — the routing prerequisite, stated honestly (was self-contradictory).** Routing is a
function of `descriptor.provider`, so an unknown model can only succeed if a PROVIDER can still be
determined. The conservative fallback fills in *capabilities*, NOT a provider — a provider cannot be
guessed. Precisely:
- If the model string is unknown **but the call site / config supplies `adapterId`** (or exactly ONE
  adapter is registered, so the provider is unambiguous), the engine routes to that adapter and
  applies **conservative capability defaults** (`supportsResponseSchema:false` → `json` mode; no
  pricing → `cost=null`). The call SUCCEEDS and usage is captured for later backfill.
- If the model string is unknown **and** the provider is ambiguous (≥2 adapters, no `adapterId`), the
  engine **fails closed** with `not_found` — it cannot invent a provider. This is the honest cost of
  "one-line swap to a brand-new model string": either the model is in some adapter's
  `defaultDescriptors()`, OR it is pre-registered via `registry.register({...provider})`, OR the call
  carries `adapterId`. The earlier blanket "call still succeeds for any model" claim is corrected to
  this conditional guarantee.

A descriptor→UI-form projection is exposed for client UX as a **client method** (NOT a free function),
so it reads THIS client's registry + tenant policy: `client.describeConfigForModel(model, ctx?)` (§12).

---

## 10. Costing

- **Source of data:** a pinned snapshot in `@gullabs/pricing`, seeded/refreshed from a LiteLLM-style
  combined registry / `tokenlens` (TS-native) — not hand-maintained. The snapshot carries a
  `version` and is vendored + checksummed (§18). `PricingSource` is the single cost authority.
- **When:** computed at call time inside the engine.
- **What's stored:** integer **micro-USD** + `pricingVersion`. Historical rows never recompute.
- **Precision:** compute internally in **nano-USD** (or integer numerator/denominator) and round
  **once** to micro-USD at the end — line items like cache-read at \$0.075/M = 0.075 micro-USD/token
  otherwise accumulate rounding error on high-volume rows.
- **Token-accounting invariant (pinned, conformance-tested).** Given the GROSS/subset convention
  from §4 (cached, cacheWrite, inputAudio, inputImage are ALL subsets of `inputTokens`; reasoning,
  outputAudio, outputImage are subsets of `outputTokens`), the cost function first selects effective
  input/output base rates (see "rate selection" below), then bills:
  `textInput = inputTokens − cachedInputTokens − cacheWriteTokens − inputAudioTokens − inputImageTokens`
  `billable  = textInput × inputPerM*`
  `+ inputAudioTokens × (inputAudioPerM ?? inputPerM*)`
  `+ inputImageTokens × (inputImagePerM ?? inputPerM*)`
  `+ cachedInputTokens × cacheReadPerM`
  `+ cacheWriteTokens × cacheWritePerM[ttl]`
  `+ (outputTokens − outputAudioTokens − outputImageTokens) × outputPerM*`  (text+reasoning output)
  `+ outputAudioTokens × (outputAudioPerM ?? outputPerM*)`
  `+ outputImageTokens × (outputImagePerM ?? outputPerM*)`
  ` (reasoning is inside outputTokens; add a delta only if reasoningPerM != outputPerM*, on reasoningTokens)`
  `+ media per-unit/per-second terms (imagePerUnit × images, audioPerSecond × seconds)`.
  This closes the multimodal-input mis-billing hole: audio/image input tokens are now priced at
  their own rate instead of flat `inputPerM`. Each adapter has a `normalizeUsage` conformance test
  asserting the subset relations against fixture SDK payloads, so OpenAI (cache/reasoning folded in)
  and Anthropic (separated) both produce the same canonical `Usage`.
- **Rate selection (`inputPerM*`/`outputPerM*`) — applies BOTH tier dimensions, in order:**
  1. **service tier:** if `tierPricing[resolvedTier]` exists (flex ≈ 50% cheaper, priority more,
     batch ≈ 50% off), it supplies the base input/output rates instead of standard.
  2. **long-context/volume tier:** then, if `ModelPricing.tiers` is set, pick the highest breakpoint
     whose `aboveInputTokens ≤ inputTokens` and OVERRIDE input/output rates with that breakpoint's
     rates (e.g. Gemini >200k premium). This was typed but never applied before — large-context calls
     were undercosted; the formula now selects it. (If a provider ever combines both dimensions
     multiplicatively, that is modeled in the pricing snapshot, not hard-coded here.)
- **Pricing on resolved SKU:** prefer `resolvedModel`/`modelVersion` (providers resolve aliases to
  dated SKUs that may price differently); fall back to the requested alias with confidence
  downgraded to `estimated`.
- **Unknown model:** `cost = null`, all tokens + `usage.raw` still persisted → backfillable later.

```ts
interface Cost {
  microUsd: number | null         // frozen total; null if model unpriced
  computedNanoUsd?: number         // higher-precision internal; rounded once to microUsd
  currency: 'USD'                  // explicit currency tag (no hard-coded assumption in field name)
  pricingVersion: string           // snapshot id, frozen for reproducibility
  resolvedModel?: ModelId          // SKU actually priced (may differ from requested alias)
  // Confidence rules (pinned, now implementable via Usage.categorization): 'exact' iff
  //   usage.source='provider-reported' AND usage.categorization='complete' (adapter mapped every
  //   BILLABLE category; any rawDetails left over are known-informational) AND a pinned price exists
  //   for the resolved model. 'estimated' if usage.source='estimated'/'partial', OR
  //   usage.categorization='partial' (an unrecognized possibly-billable category remained), OR a
  //   tier/modality/alias fell back. 'unknown' if price missing OR usage absent.
  //   This replaces the unimplementable "no provider category was uncategorizable" rule, which the
  //   engine could not evaluate because it cannot tell a billable raw key from an informational one —
  //   only the adapter can, and it now signals it via Usage.categorization.
  confidence: 'exact' | 'estimated' | 'unknown'
  details: Partial<Record<CanonicalTokenType, number>>   // per-canonical-type breakdown
  providerCategories?: JsonValue   // retain provider-native billing categories for reconciliation
}

// Reconciliation as a measurable data contract (not a vibe): a sampled job compares the ledger to
// provider invoice/export data, mapping canonical token types → provider invoice line items.
interface ReconciliationSample {
  pricingVersion: string
  billingWindow: { start: string; end: string }
  ledgerMicroUsd: number; invoiceMicroUsd: number; varianceMicroUsd: number
  byCategory: Record<string, { ledger: number; invoice: number }>
}
```

---

## 11. Persistence — the host's own table, via a port

The library defines the record; the host writes it. Two host styles both satisfy `UsageSink`:
a normalized `llm_calls` table, or a `jsonb` append onto a domain row.

> **Spend-completeness vs result-idempotency (critical FinOps fix).** A cost ledger must capture
> every dollar actually spent. If attempt 1 succeeds at the provider (you are billed) but the
> response is lost on the wire, the engine retries → a SECOND billed call. Deduping on
> `idempotencyKey` (`ON CONFLICT DO NOTHING`) would discard the second row and undercount real
> spend. So: keep `idempotencyKey` for **caller result dedup**, but persist **every provider
> attempt** with a unique `attemptId` and dedupe ledger rows on **`attemptId`**. Only attempts that
> demonstrably never reached the provider (connect-time failures) may be omitted; any call that may
> have been billed lands a row (with `confidence='unknown'` if needed).

> **What actually fulfills `idempotencyKey` (was a stored field nothing in core consumed).** Caller
> result dedup is implemented by the optional **`ResultCache` port** (§7): when wired, pipeline step
> 3a returns a cached result on a key hit and step 15a stores it — both keyed on `idempotencyKey`,
> which is a **pure deterministic function of the normalized request** (`IdGenerator` contract, §7),
> the precondition for cross-process dedup to be meaningful. When no `ResultCache` is configured,
> dedup is a documented no-op and `idempotencyKey` is retained purely as a correlation field (group a
> logical call's attempts in queries). It is NEVER the ledger dedupe key — that is always `attemptId`.

```ts
interface LlmCallRecord {
  recordSchemaVersion: number     // versioned contract; additive-only within a major (§18)
  wireVersion: number             // stamped on serialized payloads + idempotency inputs
  // identity / anchors (host-queryable)
  callId: string
  idempotencyKey: string          // caller-facing RESULT dedup (composed centrally by the lib)
  attemptId: string               // unique per REAL provider call; ledger dedupe key
  attemptNumber: number
  supersedesAttemptId?: string
  callSiteId?: string
  promptHash?: string             // resolved system+template STRUCTURE hash (eval/regression lineage)
  inputHash?: string              // rendered-inputs hash
  provider: string
  model: ModelId
  modelVersion?: string
  region?: string
  // host tenant/run anchors (opaque to the lib; MUST be opaque IDs only — logged + stored plaintext)
  metadata: CallMetadata
  // outcome
  status: 'ok' | 'parse_error' | 'api_error' | 'timeout' | 'content_filter' | 'aborted'
  finishReason?: FinishReason
  latencyMs: number
  // usage — typed hot fields (GROSS convention) …
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  usageSource?: Usage['source']
  // cost (frozen)
  costMicroUsd?: number | null
  currency?: 'USD'
  pricingVersion?: string
  costConfidence?: Cost['confidence']
  // config snapshot + provenance (what we actually sent, and WHERE each value came from)
  generationConfig: JsonValue     // SCRUBBED of transport/secret keys before persistence (§17)
  serviceTier?: string
  configProvenance?: JsonValue     // { key: { value, source: 'library'|'callSite'|'configSource'|'perCall'|'clamp' } }
  configSourceVersion?: string     // etag of the resolving tenant config, for reproducibility
  origin?: 'ui' | 'code'
  // ── forward-compat lanes (jsonb) ──
  tokenDetails: JsonValue          // usage.details (canonical map) — queryable
  rawTokenDetails?: JsonValue      // usage.rawDetails (verbatim provider keys)
  costDetails?: JsonValue          // cost.details map
  rawUsage: JsonValue              // provider's full usage object
  providerMetadata?: JsonValue     // grounding/safety/etc. — GATED by capturePolicy (§17)
  warnings?: JsonValue             // structured dropped-setting warnings (§4) — the drift tripwire
  // payloads — SPLIT by sensitivity. Usage metrics are always safe; full request/response + provider
  // metadata may contain prompts, citations, file refs, user data → capture is DEFAULT-OFF, gated
  // per call-site, passed through the Redactor, size-capped, retention-classed. The ENGINE enforces
  // this BEFORE the sink, so even a naive sink cannot over-persist (§17).
  capturePolicy: 'metrics-only' | 'redacted' | 'full'   // default 'metrics-only'
  retentionClass?: string
  requestBlobKey?: string
  responseBlobKey?: string
  rawOutput?: string               // gated
  errorMessage?: string            // routed through Redactor (kind:'error'), not merely truncated (§17)
  createdAt: string                // host/Clock-stamped
}
```

### `@gullabs/drizzle` reference schema (typed columns + jsonb forward-compat)
The reference table persists the **full** record contract (no silent field-dropping — that was the
exact drift the design claims to eliminate):
```ts
export const llmCalls = pgTable('llm_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  recordSchemaVersion: integer('record_schema_version').notNull(),
  callId: text('call_id').notNull(),
  idempotencyKey: text('idempotency_key'),
  attemptId: text('attempt_id').notNull(),
  attemptNumber: integer('attempt_number'),
  callSiteId: text('call_site_id'),
  promptHash: text('prompt_hash'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  modelVersion: text('model_version'),
  region: text('region'),
  status: text('status').notNull(),
  finishReason: text('finish_reason'),
  latencyMs: integer('latency_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  cachedInputTokens: integer('cached_input_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  totalTokens: integer('total_tokens'),
  costMicroUsd: integer('cost_micro_usd'),
  currency: text('currency'),
  pricingVersion: text('pricing_version'),
  costConfidence: text('cost_confidence'),
  serviceTier: text('service_tier'),
  capturePolicy: text('capture_policy').notNull(),
  retentionClass: text('retention_class'),
  origin: text('origin'),
  generationConfig: jsonb('generation_config'),
  configProvenance: jsonb('config_provenance'),
  tokenDetails: jsonb('token_details'),            // canonical map
  rawTokenDetails: jsonb('raw_token_details'),
  costDetails: jsonb('cost_details'),
  rawUsage: jsonb('raw_usage'),                     // ← new usage fields persist here, no migration
  providerMetadata: jsonb('provider_metadata'),
  warnings: jsonb('warnings'),
  metadata: jsonb('metadata'),                      // tenant/run anchors
  requestBlobKey: text('request_blob_key'),
  responseBlobKey: text('response_blob_key'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ attemptUnique: uniqueIndex('llm_calls_attempt_uq').on(t.callId, t.attemptId) }))

export const drizzleUsageSink = (db, table = llmCalls): UsageSink => ({
  record: (r) => db.insert(table).values(mapRecord(r)).onConflictDoNothing({ target: [table.callId, table.attemptId] }),
})
```

### Conformance (turns "standardize" from aspiration into enforcement)
```ts
interface SinkConformance {
  requiredFields: ReadonlyArray<keyof LlmCallRecord>
  // minimum: callId, attemptId, provider, model, status, costMicroUsd, pricingVersion,
  //          inputTokens, outputTokens, recordSchemaVersion, createdAt
  readBack(callId: string): Promise<Partial<LlmCallRecord>>
}
declare function assertSinkConformance(sink: UsageSink & SinkConformance): Promise<void>  // @gullabs/testing
```

**Temporal note:** the sink write happens inside the activity (workflow code can't do I/O); the
`attemptId` guarantees retried activities don't double-insert, while still capturing each real
provider attempt's spend.

**Companion ORMs:** core never imports Drizzle, so projects on different Drizzle versions (or
Prisma, or a `jsonb` append onto a domain row) each implement `UsageSink` their own way and prove it
with `assertSinkConformance`.

---

## 12. Config resolution, routing & the UI-driveable contract

### Precedence (the most semver-sensitive behavioral contract)
Resolved per call, lowest → highest precedence (deep-merged), THEN clamped:
```
library defaults → call-site defaults → ConfigSource.defaults(ctx) → per-call options
                 → THEN clamp/reject against ConfigSource.constraints(ctx)   (highest authority)
```
Splitting `defaults` (overridable) from `constraints` (enforced last) closes the multi-tenant hole:
a tenant policy (max tokens, model allow-list, no `priority` tier) can no longer be silently
overridden by per-call code or a UI value — a single override layer can only express a default, not
a ceiling. `reasoning`/`providerOptions` merge deeply so a per-call override sets one knob without
dropping call-site defaults. The fully resolved `generationConfig` + `configProvenance` are
snapshotted onto the record.

### Routing follows `model` (the headline goal made real)
The engine derives the adapter from the resolved model's `descriptor.provider` via the
provider→adapter map. So a single `model` value — from the call site, `ConfigSource.defaults`, or a
per-call option — re-routes provider AND config safely. `ConfigSource` can therefore repoint a call
site cross-provider with zero code change. `adapterId` is only an escape hatch for genuine ambiguity.

### The JSON-serializable contract a UI/DB drives
`LlmRequest`/`OutputSpec`/`ToolDef` carry schemas and binary — not JSON-safe. The currency a UI form
or DB row stores is a precisely-bounded, provably-serializable patch:
```ts
type CallSiteConfigPatch = {
  model?: ModelId
  adapterId?: string
  config?: Pick<GenConfig, 'temperature' | 'topP' | 'topK' | 'maxOutputTokens' | 'stopSequences' | 'serviceTier' | 'timeoutMs'>
    & { reasoning?: ReasoningIntent; providerOptions?: Record<string, Record<string, unknown>> }
}
// Guaranteed JSON-round-trippable (no schema, no binary) — enforced by a type-level test in @gullabs/testing.
type StoredCallSiteConfig = { configSchemaVersion: number; patch: CallSiteConfigPatch }  // versioned envelope

interface OverridePolicy {
  allowModels?: ModelId[]
  clamp?: { maxOutputTokens?: { min?: number; max?: number }; temperature?: { min?: number; max?: number }; topP?: { min?: number; max?: number } }
  allowProviderOptions?: boolean | string[]
  allowedReasoningEfforts?: Array<'none' | 'low' | 'medium' | 'high'>
}
```

### Guardrails for client UX (render only valid controls; fail-closed on UI input)
These are **client methods**, NOT free functions — that was a real bug: a free sync function cannot
see a specific client's `ModelRegistry` (host-registered/ConfigSource-supplied descriptors) or a
tenant's ASYNC `ConfigSource.constraints(ctx)`, so it could only validate against adapter defaults
and would diverge from what the engine actually clamps. As client methods they read THIS client's
resolved descriptor and (given a context) fetch the tenant's constraints, so the UI projects/validates
against the same data the call path will use:
```ts
interface AnyLlmClient {
  // descriptor → form projection, so a UI renders only supported controls with valid ranges.
  // Resolves the descriptor via THIS client's ModelRegistry (incl. host patches / ConfigSource).
  describeConfigForModel(model: ModelId, ctx?: ConfigResolutionContext): Promise<ConfigConstraintSchema>
  // pre-flight a host calls BEFORE save/submit. ASYNC because it folds in the tenant's
  // ConfigSource.constraints(ctx) (clamp ranges, allowModels, allowedReasoningEfforts), not just
  // static capabilities. Pass the SAME ctx the call will use.
  validateConfig(model: ModelId, patch: CallSiteConfigPatch, ctx?: ConfigResolutionContext): Promise<
    | { ok: true; effectiveConstraints: ConfigConstraintSchema }
    | { ok: false; errors: Array<{ path: string; code: 'unsupported' | 'out-of-range' | 'not-allowed'; message: string }> }>
}
interface ConfigConstraintSchema {
  model: ModelId
  configSourceVersion?: string    // etag of the constraints folded in — lets the UI detect staleness
  fields: Array<{ key: string; type: 'number' | 'integer' | 'enum' | 'boolean'; min?: number; max?: number; step?: number; options?: string[]; supported: boolean; default?: unknown }>
  unsupported: string[]
}
```
`RunOptions.origin` decides fail-mode: `origin:'ui'` → validation failures **throw** a typed
`bad_request` (the user sees an error); `origin:'code'` → current warn-and-drop for passthrough drift.
`origin` is persisted on the record.

> **TOCTOU caveat (documented, not silently ignored).** `validateConfig` reflects constraints at
> validation time; the engine re-clamps against FRESH `ConfigSource.constraints(ctx)` at call time, so
> a UI "valid" can still be clamped later if the tenant policy changed in between. `validateConfig`
> returns the `configSourceVersion` it used so a UI can warn on drift, and the engine ALWAYS re-clamps
> at call time (constraints are authority) — the guardrail is advisory, the engine is enforcing.

These two client methods are the supported public guardrail API so hosts don't reach into
`ModelDescriptor` internals (which would make the descriptor shape a de-facto contract).

---

## 13. Errors & retries

A concrete error OBJECT with machine-readable retryability (so a Temporal host can read it
programmatically), classified by adapters from raw SDK errors:
```ts
interface LlmError extends Error {
  kind: LlmErrorKind
  retryable: boolean          // a FIELD, not prose — Temporal/retry policies read this directly
  provider: string
  httpStatus?: number
  retryAfterMs?: number       // honor Retry-After
  cause?: unknown
  raw?: JsonValue
}
type LlmErrorKind =
  | 'invalid_auth'            // 401/403 — not retryable
  | 'rate_limited'           // 429 — retryable w/ backoff (respect Retry-After)
  | 'quota_exceeded'         // 402 / insufficient credits — NOT retryable (opposite of rate_limited)
  | 'overloaded'             // Anthropic 529 — retryable, distinct from generic 5xx
  | 'server'                 // 5xx — retryable
  | 'network'                // ECONNRESET/DNS — retryable, distinct from server 5xx
  | 'timeout'                // retryable
  | 'aborted'                // AbortSignal cancellation — NOT retryable (don't retry a user cancel)
  | 'bad_request'            // 400 — not retryable (schema/param)
  | 'not_found'              // 404 — unknown model/deployment
  | 'content_filter'         // safety
  | 'unsupported_capability' // requested a capability the model lacks
  | 'parse_error'            // output failed validation
  | (string & {})
```

> **Throw-vs-return contract (resolves the double-modeling).** `content_filter` and `parse_error`
> are **RESULT outcomes** (a `status` + `finishReason` on a persisted `LlmResult`/record, with
> usage) when the turn completed and produced something usable/billable; they are **thrown
> `LlmError`s** only when nothing usable was produced. This rule is normative and documented in the
> README so cross-team consumers don't rely on undocumented behavior.

Retry policy is engine-level (configurable: max attempts, backoff; each real attempt gets a fresh
`attemptId`, §11). In Temporal hosts, the engine surfaces `retryable` so the activity/workflow retry
policy can own it instead.

---

## 14. Observability & logging — canonical vocabulary

The event payload is split into **low-cardinality `dimensions`** (safe as metric labels) vs
**high-cardinality `attributes`** (spans/logs only) — so wiring `tenantId`/`runId` into a dimensional
metrics backend (PostHog/OTel/Prometheus) can't blow up series count (ironic for a FinOps lib):
```ts
interface CallEvent {
  dimensions: { provider: string; model: string; callSiteId?: string; status: string; finishReason?: string }
  attributes: { callId: string; attemptId: string; tenantId?: string; runId?: string; traceId?: string; idempotencyKey: string }
  measures: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number; costMicroUsd?: number | null; latencyMs: number }
}
```
Engine emits exactly three structured events, identical across every project:
```
llm.call.start    { dimensions, attributes }
llm.call.success  { dimensions, attributes, measures, status:'ok' }
llm.call.error    { dimensions, attributes, measures, error:{ kind, retryable, httpStatus } }
```
Telemetry-port contract: `onSuccess`/`onError` implementations MUST map only `dimensions` to metric
labels; `attributes` go to spans/logs. `onStart` may open a span returned to `onSuccess`/`onError`.
The *event shape never varies between projects* — that is the "consistent logging/observability"
goal delivered. `CallMetadata` MUST contain only opaque IDs (no PII/secrets) because it is logged
and stored plaintext; a dev-mode assertion scans metadata values for high-entropy/PII patterns and
warns (§17).

---

## 15. Forward-compatibility — concrete walkthroughs

**A new request param ships (e.g. Gemini adds `mediaResolutionTier`).**
Caller: `config.providerOptions.google.mediaResolutionTier = 'high'`. Adapter forwards it verbatim.
Zero core/adapter change. Later, promote it to a typed `GenConfig` field + map it — non-breaking.

**A new input modality / per-part provider block ships.**
Use `{ kind: 'provider'; provider: 'google'; data: {…} }` in the message; the adapter forwards it
verbatim when `provider === this.id`, else warns and drops. Input path is now as forward-compatible
as output.

**A new usage field ships (e.g. provider returns `toolUseTokenCount`).**
Adapter copies the entire raw usage → `Usage.raw` → `rawUsage`, and the unrecognized key lands in
`rawDetails` (queryable). Captured from day zero with **no migration**. Promote to a canonical
`CanonicalTokenType` + cost rule later, backfilling from `rawUsage`/`rawDetails`.

**A new provider (e.g. xAI/Mistral).**
Write `@gullabs/grok` implementing `ProviderAdapter` from `@gullabs/protocol` (map request, forward
passthrough, capture raw, obey usage invariants), peer-depend on `@gullabs/protocol` + the raw SDK,
assert `specVersion` compatibility at registration, prove it with `runAdapterConformance`. Register
it. Core, registry, costing, persistence untouched.

**A brand-new model on an existing provider.**
`registry.register({ model, provider, …descriptor })` at runtime — or rely on the adapter's
`defaultDescriptors()`. Pricing comes from the snapshot (or `null` until refreshed — tokens still
captured). A host can also PATCH a wrong capability flag at runtime via `register`, no fork.

---

## 16. Open decisions (post-adversarial-review)

### 16.0 Scope — DECIDED
v1 includes **everything except the autonomous agent loop**: text, structured output, tools-as-data
(incl. server/provider tools), streaming, multimodal in/out, multi-turn (incl. round-trippable
reasoning), grounding/citations, usage/cost, observability, persistence. Transport is **own adapters
over raw SDKs — not Vercel**. The accepted cost is permanent provider-divergence maintenance; the
normalized-core + raw-capture + warnings spine + published fidelity matrix is what makes it
sustainable. Agent loops live in the host.

### Decided (folded into the design above)
- **Streaming IS in v1** (`client.stream` → `{ events, final }`; one record per terminal outcome incl. abort).
- **Routing by `model`** via descriptor→provider→adapter map; `adapterId` escape hatch only.
- **Standard Schema v1 is the contract**, Zod the blessed peerDependency impl.
- **Pricing source:** `tokenlens`/LiteLLM-style snapshot, vendored + checksummed; `PricingSource` is the sole authority.
- **Capabilities (adapter/registry) and pricing (`PricingSource`) are separate registries.**
- **Payload capture default-OFF**, redacted + size-capped + retention-classed, engine-enforced before the sink.
- **Idempotency (result dedup) and attemptId (spend completeness) are separate keys.**
- **Canonical sink contract** with `recordSchemaVersion`; conformance kits ship in `@gullabs/testing`.
- **Reasoning is *intent*, not a guarantee**; lossy mappings warn; reasoning round-trips with signatures.
- **Cost carries `confidence` + currency + nano-precision** + provider-native categories for reconciliation.
- **providerOptions is a quarantined escape hatch:** typed registry, transport keys stripped, Warning on collision.
- **Middleware chain** for cross-cutting behavior (caching/fallback/canary/budget) without forking.
- **Config split** into `defaults` (overridable) vs `constraints` (clamps), with a resolution context.

### Still needs your input
1. **Reconciliation:** sampled-invoice cost-reconciliation job (`ReconciliationSample`) in v1, or later?
2. **Live contract tests:** budget for canary tests hitting real provider APIs per model family
   (fakes won't catch SDK/API/stream/tool/reasoning shape drift) — in v1 CI, or a separate cadence?
3. **Supply-chain policy ownership:** pin + Renovate cadence + adapter/SDK compatibility matrix owner
   (promoted to a hard policy in §18; assign an owner).
4. **Region/residency depth:** `region` flows end-to-end now; how many regional endpoints to certify in v1?

---

## 17. Security & privacy

**Trust boundary (documented contract; some items are doc-only obligations).** Model-produced
output — generated text, `tool-call` names/args, `tool-result` content fed back next turn, and
`citation.uri` — is **UNTRUSTED**. Hosts MUST validate/authorize before executing tools and MUST NOT
auto-fetch citation URIs (SSRF/phishing). The engine validates each returned tool-call's args against
the matching `ToolDef.parameters` and sets `ToolCall.argsValid` (raw args still returned) + a Warning
on failure, so the host has a signal to refuse.

**Credentials & transport.** `providerOptions` transport/auth keys (`apiKey`, `authToken`,
`baseURL`/`baseUrl`, `httpAgent`, `fetch`, `defaultHeaders`, `organization`, `project`) are
**stripped before forwarding** (a passthrough `baseURL` would silently exfiltrate prompts) and a
`Warning{type:'unsupported-setting'}` is emitted; credentials come only from `AuthProvider`.
`scrubConfigForPersistence(cfg)` runs **unconditionally** before the config snapshot (denylist +
entropy/regex on values) regardless of `capturePolicy`. `AuthMaterial` (and any secret) is NEVER
written to logs, telemetry, `Warning.details`, or any record. `AuthMaterial` carries `expiresAt` for
WIF/STS rotation; the engine caches by `(provider, region, tenant)` and refreshes before expiry.

**Redaction (fail-closed).** `Redactor.redact` is **async** (so Presidio/DLP/cloud DLP plug in) and
covers `request|response|metadata|error|tool-args|tool-result`. In `createClient`, if any call-site
requests capture `!== 'metrics-only'` and no Redactor is configured, the engine **downgrades that
capture to `metrics-only`** and emits a startup + per-call Warning (never persist unredacted by
accident). Core ships a non-trivial default redactor (email/phone/credit-card/JWT/api-key regexes),
not identity. `errorMessage` is routed through the Redactor (`kind:'error'`), not merely truncated —
provider 400/safety errors routinely echo the offending prompt verbatim.

**Persistence safety is engine-enforced (not sink-trusted).** ALL non-metric jsonb
(`providerMetadata`, `rawOutput`, raw usage that may contain text, warning details) is gated behind
`capturePolicy` in the engine BEFORE the sink, so even a naive sink cannot over-persist. Binary
multimodal parts offloaded to `BlobStore` bypass text redaction by definition → they are stored only
under explicit capture, with opaque random keys, private ACLs, encryption at rest, and lifecycle
expiry per `retentionClass`.
```ts
interface PersistencePolicy {
  capture: 'metrics-only' | 'redacted' | 'full'
  redactor?: Redactor                 // REQUIRED when capture !== 'metrics-only'; else engine downgrades + warns
  maxPayloadBytes: number
  retentionClass: string
  allowFullCaptureInProduction?: boolean   // must be explicitly true for 'full'
}
declare function scrubConfigForPersistence(cfg: JsonValue): JsonValue   // applied unconditionally
```

**Erasure (GDPR/CCPA).** `BlobStore` has `get`/`delete`; an `eraseByTenant(tenantId)` helper pairs
`BlobStore.delete` with a `UsageSink` deletion hook so hosts can satisfy DSAR/erasure requests.

**Data residency.** `LlmRequest.region` flows into `AuthRequest.region` (endpoint selection),
`BlobPutOptions`, and the sink context, so a tenant's call, credentials, blobs, and record stay
in-region. The fail-closed guarantee now has BACKING DATA: `ModelDescriptor.availableRegions` (§9)
declares where a model SKU is routable. Pipeline step 1a checks `region` against it — if `region` is
set and `availableRegions` is non-empty and excludes it, the engine throws a typed `bad_request`
BEFORE any provider call, rather than falling back to a default region. When `availableRegions` is
absent the model is treated as global (no constraint). Hosts patch regional availability at runtime
via `registry.register(...)` exactly like any other capability, so residency rules need no core
release. (Per-region SKU *pricing* differences, if any, are modeled in the pricing snapshot keyed by
resolved SKU.)

**Compliance footgun surfaced, not buried.** Gemini's Search-Suggestion chips
(`searchEntryPoint.renderedContent`) are ToS-MANDATORY to display — surfaced via
`LlmResult.groundingDisplay` and called out in the README, never left only in `providerMetadata`.

**Supply chain.** Provider SDKs are peerDependencies (host pins/dedupes → smaller attack surface).
`npm audit`/Socket gate in CI, lockfile pinning, npm provenance (sigstore) on publish, an SBOM, a
`SECURITY.md` with coordinated disclosure, and a stated patch cadence (§18).

---

## 18. OSS release policy (public API, semver, packaging, contribution)

**Name & ownership.** "any-llm" collides with `mozilla-ai/any-llm`. Choose a distinct product name;
reserve the npm org/scope (publish a `0.0.0` placeholder to `@<scope>/core`) and the GitHub org
before any code lands. Add the chosen name as a NAMING decision.

**License.** **Apache-2.0** (explicit patent grant, preferred for company-backed OSS wrapping vendor
SDKs) + `LICENSE` + SPDX headers. Verify and attribute the LiteLLM/tokenlens pricing-data license in
`@gullabs/pricing`.

**Versioning (one scheme: numeric monotonic).** `specVersion: 1` (port), `recordSchemaVersion: 1`
(record), `wireVersion: 1` (serialized payloads/idempotency inputs), `configSchemaVersion: 1`
(stored UI config). The adapter contract lives in slow-moving **`@gullabs/protocol`**; core declares
it a peerDependency, so community adapters re-release only when the protocol majors, not when core
does.

> **`@gullabs/protocol` MUST resolve to a single instance (the same hazard §18 fixes for Zod).**
> Protocol owns the `declare module` augmentation targets (`KnownModels`, `ProviderOptionsRegistry`)
> and any brand/`instanceof` identity checks (e.g. `Tool`/error brands). Module augmentation and
> brand checks require ONE resolved copy: if core resolves `protocol@1` and an adapter resolves
> `protocol@2` in the host tree, augmentation merges and identity checks silently break. Therefore
> protocol is NOT a wide-range peer: it is peer-ranged to a **single major** (`"@gullabs/protocol":
> "^1"`), and a protocol MAJOR is a coordinated ecosystem bump (core + all first-party adapters
> released together). Core installs a runtime singleton guard — a `Symbol.for('anyllm.protocol')`
> stamped with the resolved version on `globalThis`; a second, version-skewed copy logs a loud
> startup warning. The slow-moving promise is kept by additive `specVersion` deltas (handled via
> upcast shims, §7) WITHIN a protocol major; the major boundary is the rare, coordinated event.

**Public API minimization & audience split.** Exports are split by audience via the `exports` map:
```jsonc
{
  "exports": {
    ".":         { "types": "./dist/index.d.ts",    "import": "./dist/index.js",    "require": "./dist/index.cjs" },
    "./adapter": { "types": "./dist/adapter.d.ts",  "import": "./dist/adapter.js",  "require": "./dist/adapter.cjs" },
    "./sink":    { "types": "./dist/sink.d.ts",     "import": "./dist/sink.js",     "require": "./dist/sink.cjs" },
    "./internal":{ "types": "./dist/internal.d.ts", "import": "./dist/internal.js" }   // EXCLUDED from semver
  }
}
```
`@gullabs/core` (app surface) / `@gullabs/core/adapter` (`ResolvedRequest`, `AdapterCtx`,
`AdapterResult`) / `@gullabs/core/sink` (`LlmCallRecord`, `UsageSink`). Adopt API Extractor with
`@public`/`@internal` tags and gate releases on an api-report diff.

**Closed unions are the riskiest semver liability.** `Part`, `StreamEvent`, `Warning`,
`LlmErrorKind`, `FinishReason`, `CanonicalTokenType` — adding a member is a minor for producers but a
breaking exhaustiveness change for consumers' `switch`. CONTRIBUTING mandates an "always include a
default case" policy and treats union additions as minors.

**Data-semantics are semver-governed, not just types.** The GROSS/subset `Usage` convention, the
`CanonicalTokenType` meanings, `Cost.confidence` rules, and the config precedence chain are public
contracts (consumers write SQL/dashboards against them). Changing whether `inputTokens` is gross/net,
or the precedence order, is a **breaking change even with no type change**. `recordSchemaVersion` /
`configSchemaVersion` follow an additive-only policy within a major.

**Dependency policy.** `zod` is a peerDependency everywhere it crosses a package boundary (instanceof
brand checks break under duplicate/skewed copies; Zod 3-vs-4 is a public decision — state the
supported range). Each raw SDK is a **required peerDependency** of its adapter package with a wide
caret range (e.g. `"openai": ">=4 <6"`) + a published compatibility matrix; CI smoke-tests the lowest
and highest supported SDK. Renovate cadence + a named matrix owner.

**Build.** ESM-first dual build (tsup/tshy): `"type":"module"`, `"sideEffects":false`, per-entrypoint
`types`/`import`/`require` conditions, Node floor `>=20`, publish with `--provenance`. CI runs
`tsd`/`expect-type` type-level tests (conditional/template-literal inference like `ConfigFor`,
`ToolCallFor` is part of the contract) and `attw` (Are The Types Wrong) for the multi-package
ESM/CJS surface. Docs require `exactOptionalPropertyTypes: true` (the `{ topK?: never }` gating only
behaves under it).

**Stability tiers.** Tag volatile surfaces `@experimental` and exclude them from the semver
guarantee until promoted: **Stable** = text/structured/usage/cost/persistence; **Experimental** =
streaming, citations, multimodal output, reasoning-intent. Publish a stability table + the per-provider
**fidelity matrix** (reasoning round-trip, positional cache, server tools, service tiers, multimodal
out) in the README.

**Community extensibility.** Ship runnable conformance kits from `@gullabs/testing` as first-class
exports: `runAdapterConformance(make)`, `runSinkConformance(make)`, `runPricingConformance(make)`,
plus per-adapter `normalizeUsage` fixtures (so xAI/Mistral/Bedrock authors can't corrupt cost
ledgers). Publish a `ProviderAdapterFactory` type, an npm keyword (`anyllm-adapter`) + naming
convention (`@scope/anyllm-<provider>` or unscoped `anyllm-adapter-*`), and an "Ecosystem" doc page.
Do NOT auto-scan `node_modules`. Enforce adapter `id` uniqueness at `createClient` (throw on
collision) and a `specVersion` handshake at registration (fail loudly, not at call time). Typed
`ProviderOptionsRegistry`/`KnownModels` augmentation may only ADD provider keys, never alter core
types; document a tested augmentation example (broken augmentation surfaces as confusing consumer-side
inference errors).

**Docs/contribution.** `CONTRIBUTING` (union-extension rules, conformance requirement), per-package
READMEs with the SDK compatibility matrix, runnable examples per capability, a changesets-based
monorepo release flow, `SECURITY.md`, SBOM, npm provenance.

---

## 19. Lessons harvested from existing implementations

Studied the recommended tools; folded the best ideas in (above) rather than adopting wholesale.

- **LiteLLM (`model_prices_and_context_window.json`)** — proven `supports_*` flag vocabulary +
  explicit cache keys + tiered breakpoints → adopted into `ModelDescriptor`/`ModelPricing` (§9). We
  *generate* `@gullabs/pricing` from a LiteLLM-style file rather than hand-curating. We **diverge**
  on one point: we split capabilities (adapter/registry) from pricing (`PricingSource`) because
  pricing churns weekly and adapters should not.
- **Langfuse (usageDetails / costDetails)** — token types are an open set. We adopted the *idea* but
  replaced the ambiguous substring-summing convention with a **closed `CanonicalTokenType` vocabulary
  + `rawDetails`** so cross-provider aggregation is deterministic and subsets aren't double-counted
  (§4, §10).
- **Vercel AI SDK (`LanguageModelV2` / `doGenerate`)** — validates the thin-adapter thesis; we steal
  the structured `warnings` "never silently drop a setting" pattern and `providerOptions` (input) vs
  `providerMetadata` (output) naming. Their biggest recurring pain — **port spec evolution
  (V1→V2→V3)** — drove two decisions here: version the port (`specVersion`) AND put it in a separate
  slow-moving `@gullabs/protocol` package so community adapters don't churn (§7, §18).
- **Standard Schema** — adopted as the public validator contract so the semver-stable surface isn't
  hard-coupled to a single validator's major version; Zod stays the blessed impl.

Sources: [LiteLLM pricing JSON](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) ·
[Langfuse token & cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) ·
[AI SDK custom providers / LanguageModelV2](https://ai-sdk.dev/providers/community-providers/custom-providers) ·
[Standard Schema](https://standardschema.dev)

---

## 20. Build order

1. `@gullabs/protocol` — port contract, `ResolvedRequest`/`AdapterCtx`/`AdapterResult`, descriptor, versions.
2. `@gullabs/core` — engine, ports, call-site registry, config resolution+clamp, routing, middleware, error taxonomy.
3. `@gullabs/testing` — fakes + conformance kits (lets us TDD the engine with no network).
4. `@gullabs/google` — first real adapter (raw `@google/genai`), incl. Imagen + Files + cache manager + reasoning signatures.
5. `@gullabs/pricing` + `@gullabs/drizzle` — costing (single authority) + reference sink.
6. Pilot migration: **OpenMontage** (lowest risk) end-to-end.
7. `@gullabs/anthropic`, `@gullabs/openai` (Responses API target).
8. Migrate postbuzz → ai-studio → redline (highest stakes last).
