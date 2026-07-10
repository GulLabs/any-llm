# @gullabs/xai

xAI Grok provider adapter for any-llm. A thin mapping layer over the `openai` npm SDK's Responses API pointed at xAI's `https://api.x.ai/v1` base URL — converts `ResolvedRequest` → xAI Responses API params and maps the response back to `AdapterResult`. Never persists, never computes cost itself outside the pricing port, never loops — pure request/response.

## Install

```bash
pnpm add @gullabs/xai @gullabs/core openai
```

**Peer dependency:** `openai ^6`

xAI has no first-party TypeScript SDK. xAI's own quickstart recommends using the `openai` npm package with a `baseURL` override pointed at xAI's endpoint — that is the path this adapter takes. `buildXaiClient` is the only place in `packages/xai/src` that imports `openai`, so the rest of the adapter (and its tests) stay decoupled from the real SDK via the structural `XaiClientLike` interface.

## Key exports

| Export                  | What it is                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `xaiProvider(opts?)`    | `ProviderPlugin` factory — bundles the adapter, `grok-4.5` model descriptor, and pricing source |
| `xaiAdapter(opts?)`     | Creates the `ProviderAdapter` for xAI                                                           |
| `XaiAdapterOptions`     | `{ client?: XaiClientLike }` — inject a pre-built or fake client                                |
| `XaiClientLike`         | Structural interface the adapter depends on (satisfied by real SDK and fakes)                   |
| `buildXaiClient(auth)`  | Builds the real `openai`-SDK-backed client from `AuthMaterial`, pointed at xAI's base URL       |
| `classifyXaiError(err)` | Classifies a raw thrown error into a typed `LlmError`, including xAI's 400-for-auth quirk       |
| `grok45ModelDescriptor` | The `grok-4.5` `ModelDescriptor`                                                                |
| `xaiModelDescriptors`   | Every model descriptor this package contributes (v1: just `grok45ModelDescriptor`)              |
| `xaiRegistry`           | Pre-built `ModelRegistry` over `xaiModelDescriptors`                                            |
| `xaiPricingSource()`    | Built-in xAI `PricingSource` port implementation, backed by `XAI_PRICING`                       |
| `XAI_PRICING`           | Frozen xAI pricing snapshot (µUSD per million tokens)                                           |
| `XaiModelRates`         | Per-model rate entry type (`inputPerM`, `cachedPerM`, `outputPerM`, optional `gt200k`)          |
| `Grok45ConfigSchema`    | Strict Zod config schema for `grok-4.5`                                                         |
| `XaiProviderOptions`    | `{ promptCacheKey? }` — typed `providerOptions.xai` extension shape                             |

## Quick example

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { xaiProvider } from '@gullabs/xai'

const client = createClient({
  ...composeProviders([xaiProvider()]),
})

// Auth is required per call — the library never reads environment variables.
const result = await client.generate(
  {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { apiKey: 'YOUR_XAI_API_KEY' } },
)
```

## grok-4.5

The default registry ships exactly one model: `grok-4.5` (500k token context window). It routes through this adapter and supports:

- **Reasoning** — level-api (`reasoningApi: 'level'`), mapped to the Responses API `reasoning.effort` field. `admittedReasoningEfforts: ['low', 'high']` — this is deliberately narrower than Gemini's effort vocabulary: `'none'` and `'medium'` are **rejected by the live xAI API**, not merely unsupported by this library. The config schema (`Grok45ConfigSchema`) enforces `reasoning.effort` as `'low' | 'high'` only, and there is no `budgetTokens` field at all (xAI uses level-style reasoning, not token budgets) — passing it throws `bad_request`. The schema does not set a default effort; if `reasoning` is omitted, no `reasoning` field is sent and xAI's own server-side default applies.
- **Structured output** — native. `output.jsonSchema` maps to the Responses API's `text.format` field with `{ type: 'json_schema', name, schema, strict: true }`, **not** `response_format` — this differs from OpenAI's own convention for the same underlying concept.
- **`strict: true` performs no OpenAI-style compile-time schema validation, as of the 2026-07-09 live probes.** 2026-07-09 live verification against the real xAI Responses API — 13 single-variant probes plus 1 combined probe (14 calls total, all accepted HTTP 200; the combined probe is recorded as fixture `10-non-strict-schema-accepted.json`) — verified that `text.format` with `strict: true` accepted every one of the following schema shapes that OpenAI's own strict mode rejects at compile time: schemas (root and nested) missing `additionalProperties: false`; properties omitted from `required` (optional properties); `format`, `minLength`, `pattern`, and `default` keywords; `anyOf`; `$defs`/`$ref`; `enum`/`const`; and nullable unions (`type: [T, 'null']`). `strict: false` on the same surface showed no observed behavioral divergence from `strict: true`. This adapter forwards schemas to xAI verbatim — no rewriting, no preflight validation, and no injection of `additionalProperties: false` or `required` completion — so OpenAI-strict schema rewriting (including `@gullabs/codex-cli`'s `toOpenAiStrictOutputSchema` helper) is unnecessary for xai as of that verification date. (Reject-don't-map still applies to genuinely invalid input the xai schema/types layer itself rejects; this note is only about strict-mode compile-time schema-shape enforcement.) `packages/xai/src/__fixtures__/10-non-strict-schema-accepted.json` records one live example combining three of these — missing root `additionalProperties: false`, an optional property, and a `format` keyword — in a single accepted call.
- **Sampling** — `temperature` and `topP` are forwarded verbatim. No `topK`.
- **No penalties/stop** — `presence_penalty`, `frequency_penalty`, and `stop` are not in the config schema at all; xAI hard-rejects these on reasoning models, so the schema never admits them (reject-don't-map).
- **No service tiers** — xAI has no service-tier concept for `grok-4.5`; setting `serviceTier` on the request throws `bad_request`.

## Vision constraints

`grok-4.5` accepts image input as an `inline-media` or `file-uri` `Part`:

- **`inline-media`** — only `image/jpeg` and `image/png` are accepted; anything else throws `bad_request`. The decoded payload must be at most 20 MiB (xAI's documented inline-image ceiling); larger images throw `bad_request` before the request is sent.
- **`file-uri`** — only accepted when the URI is a public `http(s)://` URL **and** the declared `mimeType` is jpg/png. A provider-hosted URI from another provider — for example a Gemini Files API URI (`https://generativelanguage.googleapis.com/...`) — is technically `https://` but is not dereferenceable by xAI and is not portable across providers. The adapter rejects it rather than trying to map or proxy it (reject-don't-map).
- **Undocumented minimum size** — xAI enforces an undocumented server-side minimum image size (observed ~8px/side, ~512 total px). This adapter does **not** pre-validate pixel dimensions; a too-small image surfaces as a live `bad_request` error from the xAI API itself, classified normally by `classifyXaiError`, not rejected client-side.

## Caching

xAI caching is automatic — there is no explicit cache-create/cache-store API comparable to Gemini's Context Cache. `providerOptions.xai.promptCacheKey` maps to the Responses API's `prompt_cache_key` field and is strongly recommended for reliable cache routing across calls to the same conversation/context.

## Pricing

`XAI_PRICING` is a frozen, versioned snapshot (`xaiPricingVersion: 'xai-2026-07-09'`) — a point-in-time capture, not a live lookup, following the same frozen-snapshot precedent as Gemini pricing (ADR-005). Rates are in µUSD per million tokens:

| Model      | Tier                         | Input   | Cached input | Output   |
| ---------- | ---------------------------- | ------- | ------------ | -------- |
| `grok-4.5` | standard (≤200k gross input) | $2.00/M | $0.50/M      | $6.00/M  |
| `grok-4.5` | `gt200k` (>200k gross input) | $4.00/M | $1.00/M      | $12.00/M |

The `gt200k` long-context tier is selected by **gross** `inputTokens` (including cached), not billable input — strictly greater than 200,000 tokens, mirroring core's `selectRates` convention. `grok-4.5` has no service-tier concept; a defined `tier` argument to `xaiPricingSource().price()` always resolves to unpriced (`microUsd: null`) rather than guessing a multiplier.

## EU unavailability

xAI has no EU region at launch — its documented regions are `us-east-1` and `us-west-2` only. This is a hosting/deployment concern for callers, not something this library can route around; it is documented here so consumers are not surprised by data-residency constraints.

## Aliases are not registered

xAI's own `/v1/models` listing surfaces `grok-4.5-latest` and `grok-build-latest` as aliases of `grok-4.5`. Neither is registered as a separate `ModelDescriptor` or `XAI_PRICING` key. Callers must use the canonical id `grok-4.5` verbatim — passing an alias resolves to "model not found" in the registry, not to `grok-4.5`'s config or pricing (reject-don't-map).

## Explicitly deferred (not built in v1)

- Server-side agentic tools (`web_search`, `x_search`, `code_interpreter`, file/collections search, remote MCP) and their per-invocation billing (e.g. `web_search` at $5/1k) — no `Cost` lane exists for these yet.
- `/v1/chat/completions` (documented by xAI as legacy) and `/v1/messages` (the Anthropic-compatible migration shim) — this adapter only targets `/v1/responses`.
- Batch API (`grok-4.5` is not eligible at launch) and image generation models.
- Stateful conversations — `store` is always sent as `false`, and `previous_response_id` is not supported.
- Streaming — core has no streaming seam at all yet; this is a library-wide gap, not specific to xai.

## What it maps

- `providerOptions.xai.promptCacheKey` → `prompt_cache_key`
- `reasoning.effort` → `reasoning.effort` (`'low' | 'high'` only)
- `output.jsonSchema` → `text.format: { type: 'json_schema', name, schema, strict: true }`
- Usage: `usage.input_tokens` → `inputTokens`, `usage.output_tokens` → `outputTokens` (both already GROSS on xAI, unlike Gemini's sub-field summation); numeric extras (`num_sources_used`, `cost_in_usd_ticks`, etc.) surface into `usage.details` under their raw names, and the full raw payload is always in `usage.raw`
- Errors: xAI's Responses API returns **HTTP 400 (not 401) for an invalid API key**. `classifyXaiError` special-cases the exact structured error-body signature (`code: 'invalid-argument'` with message prefix `"Incorrect API key provided"`, taken verbatim from a recorded live fixture) and reclassifies it as `invalid_auth`. It only inspects the STRUCTURED parsed error body — never free-form `Error.message` text — so a 400 that merely _mentions_ an API key (e.g. a schema-validation error echoing user content) stays `bad_request`. Any other 400, `429`→`rate_limited`, `5xx`→`server`, and timeouts fall through to `@gullabs/core`'s generic `classifyError`.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — engine, ports, and the `LlmError` contract
