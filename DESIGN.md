# any-llm — Design Notes

For the canonical engineering overview, see [`docs/architecture.md`](./docs/architecture.md).
For individual architecture decisions, see [`DECISIONS.md`](./DECISIONS.md).

This document contains supplementary design notes: deeper rationale, future-scope contracts, and
forward-compatibility decisions that don't fit cleanly in either of the above.

---

## Design Principles

**P1 — The host owns the world; the library owns the contract.**
Everything environmental (DB, logger, telemetry sink, clock, id generation, secrets) is a port
the host implements. The core is pure and deterministic given its ports.

**P2 — Typed core + raw passthrough + raw capture.**
Every place where providers diverge has three lanes:
- A **typed lane** for common, well-understood options and fields (first-class, validated).
- A **raw passthrough lane** (`providerOptions`) that adapters forward verbatim to the raw SDK —
  so a brand-new request parameter works the day a provider ships it with no core change.
- A **raw capture lane** — adapters copy the provider's entire raw usage object and response
  metadata into the result and persisted record so a new usage field is never lost even before
  the library models it.

Promotion is an optional later step: move a field from raw to typed when it proves broadly useful.

**P3 — Adapters are thin and dumb; the engine is smart.**
Provider adapters do exactly one thing: translate `ResolvedRequest ↔ raw SDK`. They contain no
costing, no logging, no persistence, no retries, no schema validation. The adapter returns raw
parsed structured output and normalized usage; the engine handles everything else.

**P4 — Cost is frozen at write time.**
A ledger must be reproducible. Cost is computed when the call happens and stored as an integer
(micro-USD) alongside the pricing snapshot version used. Historical rows never recompute. If the
pricing snapshot is later corrected, affected rows can be backfilled using `pricingVersion` as the
identification key.

**P5 — Fail-open on side effects; fail-closed on the call.**
A broken sink, telemetry callback, or cost computation must never fail the LLM call. A broken
call fails loudly with a typed `LlmError`. The rate-limiter is the deliberate exception: `acquire`
rejection propagates because the port's purpose is to gate calls.

**P6 — Forward-compatible persistence.**
The `LlmCallRecord` has typed columns for queryable hot fields and `JsonValue` columns for open
maps (`tokenDetails`, `rawUsage`, `providerMetadata`, `generationConfig`). New fields from a
provider land in the JSONB lanes immediately; typed columns are added only when aggregation or
indexing requires them.

**P7 — Routing is a function of `model`, not of code wiring.**
A call site's provider is derived from the resolved model's descriptor, not hard-coded in source.
This is what makes a model swap from a UI or DB flag actually work rather than requiring a code
change.

---

## Forward-Compatibility Design

### `providerOptions` Passthrough

`GenConfig.providerOptions` is a `Record<string, JsonValue>` forwarded to adapters verbatim. The
Gemini adapter applies `providerOptions['google']` last, after all typed-field mapping, so any
key the adapter does not know how to handle reaches the raw SDK call unchanged. This is the
intentional safety valve: a new SDK parameter available today in `@google/genai` does not require
a library release.

Adapters that implement `validateProviderOptions` (planned, not in v1) can emit `Warning` entries
for unknown keys rather than silently forwarding them.

### `Usage.details` and `Usage.raw`

`Usage.details` is an open `Record<string, number>` keyed by canonical token type (`input`,
`output`, `cached`, `thinking`). New token types from providers land here before they receive
typed fields on `Usage`. `Usage.raw` stores the provider's complete usage metadata as `JsonValue`
so cost can be recalculated from the original data if the field mapping is later found to be
incorrect.

`LlmCallRecord` mirrors this: `tokenDetails` (the details map as JSONB) and `rawUsage` (the full
raw object as JSONB) are always written, even when the hot typed fields (`inputTokens`,
`outputTokens`, etc.) are also present.

### `LlmCallRecord.recordSchemaVersion`

Always `1` in this release. Increment on any breaking schema change to the record shape. Sinks
should check this field before deserializing records written by an older or newer engine version.

---

## Gemini Adapter Design Notes

### Reasoning API Variants

Gemini 2.5 series models use `thinkingConfig.thinkingBudget` (a token budget integer). Gemini 3.x
series models use `thinkingConfig.thinkingLevel` (an enum: `MINIMAL | LOW | MEDIUM | HIGH`). The
adapter branches on `req.modelDescriptor?.capabilities?.reasoningApi`:
- `'budget'` → map `effort` to the `EFFORT_BUDGET` table (`none: 0, low: 1024, medium: 8192,
  high: 24576`); `budgetTokens` overrides `effort` directly.
- `'level'` → map `effort` to `MINIMAL / LOW / MEDIUM / HIGH`; `budgetTokens` is unsupported
  and emits a `reasoning-mapping` warning.
- `undefined` → emit an `unsupported` reasoning-mapping warning; do not set `thinkingConfig`.

When both `effort` and `budgetTokens` are set for a `'budget'` model, `budgetTokens` wins and an
`approximate` warning is emitted.

### Structured Output Path

The adapter sets `responseMimeType: 'application/json'` whenever `req.outputSchema` is present.
`zodToGeminiSchema` converts the Zod schema to a Gemini `responseSchema` object. When the
conversion returns `undefined` (a Zod construct that has no Gemini equivalent), the adapter
proceeds with `responseMimeType` alone and emits an `unsupported-setting` warning. The engine
performs the actual Zod `.safeParse` validation regardless of whether the adapter-level schema
was sent.

### Error Classification

The adapter wraps the entire SDK call (client construction + `generateContent`) in a single
try/catch. `classifyError` converts SDK errors; the adapter re-throws as `LlmError` tagged with
`provider: 'google'`. Blocked responses (`promptFeedback.blockReason` set, or no candidates)
are thrown as `LlmError('content_filter', retryable: false)` rather than returning a result.

### Thought Text Extraction

Response parts are filtered on `part.thought === true`. Thought parts are concatenated into
`reasoningText`; non-thought text parts are concatenated into `text`. Both are returned on
`AdapterResult`. The engine surfaces `reasoningText` on `LlmResult` and persists it on
`LlmCallRecord` when present.

---

## Config Resolution

`deepMergeConfig(...configs)` merges `GenConfig` objects left-to-right (later entries win for
scalar fields). Two object-valued sub-fields — `reasoning` and `providerOptions` — are merged
recursively so a per-call override can set a single sub-key without replacing the entire object.
Arrays and scalar values within those objects use last-write-wins.

Resolution order:
- `generate`: `libDefaults → request.config`
- `runStructured`: `libDefaults → callSite.config → opts.config`

`serviceTier` is defaulted to `'flex'` after the merge so the resolved config always has a tier.
This default is applied in the engine, not in merge logic, to keep the merge function pure.

---

## Planned Seams (not in v1)

The following capabilities have documented ports or type-system placeholders. They are excluded
from v1 because the Gemini-only, non-streaming foundation needs to be stable first.

**Streaming.** A `stream()` method that returns an async iterable of normalized `StreamEvent`
objects plus a `final: Promise<LlmResult>`. The `ProviderAdapter` interface is designed to
accommodate a `runStream` method. Records are written on every terminal stream outcome including
abort, with `usage.source = 'estimated'` when the provider did not return usage before the stream
ended.

**Additional providers.** The `ProviderAdapter` port and routing infrastructure are ready. The
`AuthMaterial` union already covers both `{ apiKey }` and `{ vertex }` auth forms; additional
forms (OAuth token, bearer token) would extend the union.

**Function calling.** `Message.parts` is typed as `TextPart[]` in v1 but the `kind` discriminant
is reserved for future `tool-call` and `tool-result` part variants.

**`Redactor` port.** A planned port for scrubbing sensitive content from messages and results
before persistence. Absent in v1; the port name is reserved. If added, it would be fail-closed
(not fail-open) to prevent accidental persistence of unredacted content.

**`ResultCache` port.** An optional cache keyed on a deterministic hash of the request, enabling
idempotent re-runs without hitting the provider. Absent in v1.

---

## Package Scope

The `@gullabs` npm scope is used throughout. The GitHub org is `GulLabs`. Provider SDK packages
(`@google/genai`, `@anthropic-ai/sdk`, `openai`) and `zod` are peer dependencies, not bundled
dependencies, to avoid duplicate instances in the host's dependency tree.

Packages:

| Package | Role |
|---|---|
| `@gullabs/core` | Engine, types, ports, retry middleware, model registry, record builder, pricing. No provider SDK imports. |
| `@gullabs/google` | Gemini adapter over `@google/genai`. |
| `@gullabs/drizzle` | Reference Postgres schema (`llm_calls` table) and `drizzleUsageSink`. |
| `@gullabs/testing` | `FakeClock`, `FakeIds`, `RecordingSink`, `makeFakeGemini`. No network in tests. |
