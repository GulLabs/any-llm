---
name: any-llm
description: >-
  Guidance for writing, reviewing, or debugging TypeScript code that calls
  @gullabs/any-llm, @gullabs/core, or @gullabs/google to talk to Gemini models.
  Applies when adding a new LLM call site, wiring createClient/generate/runStructured,
  defining a defineCallSite prompt template, requesting structured JSON output,
  catching or narrowing an LlmError, configuring reasoning/thinking budgets, or wiring
  a UsageSink for cost tracking. Also applies whenever the user mentions any-llm, the
  Gemini adapter, Gemini Flex tier, structured-output validation, or per-call auth for
  this library. Covers the mandatory per-call `{ auth: { apiKey } }` pattern (there is
  no env-var or ambient auth), the caller-owned output-validation contract, the
  descriptor-owned strict model-config boundary (`configSchema` / `configJsonSchema`),
  and the reject-don't-map error philosophy — the things a developer used to other
  LLM SDKs would otherwise get wrong by default.
---

# any-llm

Typed, provider-agnostic-by-design (currently Gemini-only) LLM call engine with cost
tracking, retries, rate limiting, structured output, and per-call observability.

Three packages:

- `@gullabs/core` — engine (`createClient`), types, errors, `defineCallSite`.
- `@gullabs/google` — Gemini adapter (`geminiAdapter`) over `@google/genai`.
- `@gullabs/any-llm` — batteries-included: re-exports both of the above plus `@google/genai` as a dependency.

Install `@gullabs/any-llm` for a one-package setup, or the two modular packages for
explicit dependency control. Import names are identical either way.

## #1 gotcha: auth is per-call, always

**There is no env-var auth, no ambient/singleton auth, no `AuthProvider` port.** Every
`generate()` and `runStructured()` call requires `opts.auth = { apiKey: string }`
explicitly. `createClient()` itself takes no credentials.

```ts
// WRONG — GenerateOptions.auth is a required field; this will not type-check, and if
// bypassed with `as any` it throws LlmError({ kind: 'invalid_auth' }) before any I/O.
const client = createClient({
  adapters: [geminiAdapter()],
  pricingSources: { google: geminiPricingSource() },
})
await client.generate(request, {} as GenerateOptions)

// RIGHT — bring the key from wherever your app resolves it, pass it on every call.
const auth = { apiKey: myResolvedGeminiKey }
await client.generate(request, { auth })
```

A missing, empty, or non-string `apiKey` throws `LlmError` with `kind: 'invalid_auth'`
before any network call is made. Vertex AI (ADC/service-account auth) is **not
supported** — it was removed and is a roadmap item only; do not write code assuming
`{ vertex: { project, location } }` works.

## #2 gotcha: identity is `(provider, model)`, not a bare `model` string

Every `generate()`/`runStructured()` request and every `defineCallSite()` requires an
explicit top-level `provider` (e.g. `'google'`, `'claude-cli'`, `'codex-cli'`) alongside
the bare, provider-native `model` string. The engine routes by `req.provider` directly
— it never derives, parses, or guesses a provider from `model`, and it never accepts a
slash-joined string like `'google/gemini-2.5-flash'`. A request with no `provider`, an
unconfigured `provider`, or a `(provider, model)` pair the registry doesn't recognize is
rejected with `LlmError({ kind: 'bad_request' })` before any I/O. This also means the
same bare model id can exist under multiple providers with different config schemas —
`resolve()` always takes both.

## Quickstart

```ts
import { createClient, geminiPricingSource, geminiAdapter } from '@gullabs/any-llm'
// (or: from '@gullabs/core' / '@gullabs/google' respectively, if using modular install)

const client = createClient({
  adapters: [geminiAdapter()],
  pricingSources: { google: geminiPricingSource() },
})

const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello!' }] }],
  },
  { auth: { apiKey: myResolvedGeminiKey } },
)

console.log(result.text) // raw text
console.log(result.usage) // { inputTokens, outputTokens, cachedInputTokens?, thinkingTokens?, details, raw }
console.log(result.cost?.microUsd) // integer micro-USD, or null if unpriced
```

`Message.parts` is `TextPart | InlineMediaPart | FileUriPart` — multimodal input mixes
`{ kind: 'text', text }`, `{ kind: 'inline-media', mimeType, data /* raw base64, no data: prefix */ }`,
and `{ kind: 'file-uri', uri, mimeType }` freely in one `parts` array.

## `defineCallSite` — reusable prompt templates

```ts
import { defineCallSite } from '@gullabs/core'

const summarize = defineCallSite({
  id: 'summarize-article', // persisted as callSiteId on every record
  provider: 'google',
  model: 'gemini-2.5-flash',
  system: 'You are a concise summarizer.',
  userTemplate: 'Summarize this article in 3 sentences:\n\n{{article}}',
  config: { temperature: 0.3 },
})

const result = await client.runStructured(summarize, { article: text }, { auth })
```

`{{var}}` interpolation is non-recursive (substituted values are never re-scanned for
further `{{...}}`, preventing template injection) and applies to both `system` and
`userTemplate`. A missing var is left as the literal `{{var}}` placeholder, not an
empty string. `runStructured` also accepts a two-arg form, `(callSite, opts)`, when the
template has no vars. Config resolution order everywhere is
`clientDefaults → callSite.config → opts.config`, and the merged config must still pass
the selected descriptor's strict runtime schema before dispatch.

## Strict model-config boundary

Treat model config as descriptor-owned:

```ts
import { defaultGeminiRegistry } from '@gullabs/core'

const descriptor = defaultGeminiRegistry.resolve('google', 'gemini-3.5-flash')
if (!descriptor) throw new Error('unknown model')

// UI/forms:
const formSchema = descriptor.configJsonSchema

// Persisted or user-supplied config:
const parsedConfig = descriptor.configSchema.parse({
  reasoning: { effort: 'medium' },
  serviceTier: 'flex',
})
```

Important distinctions:

- `descriptor.configSchema` is the runtime boundary for request config.
- `descriptor.configJsonSchema` is derived from that same schema for form generation.
- `request.output.jsonSchema` is only the output-format hint for structured responses.
- `providerOptions.google` is a typed provider-extension lane, not a caller-wins
  override lane for `serviceTier`, sampling, reasoning, or response schema.

## Structured output — auth + validation together

`request.output = { jsonSchema }` (or `callSite.jsonSchema`) is forwarded to the
provider as a **hint**, not enforced by the library. The engine JSON-parses the
response and sets `outputParsed`; `result.output` is always `unknown`. **The caller
owns shape validation** — this library does not validate output shape itself.

```ts
import { createClient, geminiPricingSource, geminiAdapter } from '@gullabs/any-llm'
import type { StandardSchemaV1 } from '@gullabs/core'

const client = createClient({
  adapters: [geminiAdapter()],
  pricingSources: { google: geminiPricingSource() },
})

const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Rate this PR 1-10.' }] }],
    output: {
      jsonSchema: {
        type: 'object',
        properties: { rating: { type: 'number' }, summary: { type: 'string' } },
        required: ['rating', 'summary'],
      },
    },
  },
  { auth: { apiKey: myResolvedGeminiKey } }, // auth is still required
)

// 1. Gate on outputParsed first — cheap boolean signal.
if (result.outputParsed !== true) {
  // provider didn't return parseable JSON — retry, escalate, or fall back
} else {
  // 2. Then validate shape with any Standard Schema v1 validator (zod, valibot, etc.
  //    all implement '~standard'). Do NOT trust result.output's shape without this.
  const validated = await mySchema['~standard'].validate(result.output)
  if ('issues' in validated && validated.issues !== undefined) {
    // shape invalid but JSON-parseable — inspect validated.issues
  } else {
    // validated.value is now typed
  }
}
```

Full caller-owned validation helper: `docs/structured-output-validation.md` in the
source repo (see "For more detail" below — this file may not ship in `node_modules`).

## Error handling

Every rejection from `generate()` / `runStructured()` is an `LlmError` with a `.kind`
discriminant (from `packages/core/src/errors.ts`):

| `kind`           | Meaning                                               | Retryable |
| ---------------- | ----------------------------------------------------- | --------- |
| `invalid_auth`   | 401/403, or missing/empty `apiKey`                    | No        |
| `rate_limited`   | 429 — provider quota exceeded                         | Yes       |
| `server`         | 5xx — transient provider error                        | Yes       |
| `timeout`        | exceeded `config.timeoutMs` or a network timeout      | Yes       |
| `aborted`        | caller's `AbortSignal` fired                          | No        |
| `bad_request`    | 400/422, or a request the library rejected before I/O | No        |
| `content_filter` | provider refused output for safety reasons            | No        |
| `unknown`        | uncategorized — inspect `.cause`                      | No        |

```ts
import { LlmError } from '@gullabs/core'

try {
  const result = await client.generate(request, { auth })
} catch (e) {
  if (e instanceof LlmError) {
    if (e.retryable) scheduleRetry(e.retryAfterMs)
    else if (e.kind === 'invalid_auth') /* surface a credentials error */
    else throw e
  } else {
    throw e // never expected — the engine always throws LlmError
  }
}
```

`LlmError` also carries `httpStatus?`, `retryAfterMs?`, `provider?`, `callId?`,
`attemptId?`, `servedServiceTier?`, and `cause` (the original thrown value).

## Reject, don't map

Bad input or config throws `bad_request` (or `invalid_auth`) **before any I/O** —
nothing is silently clamped, coerced, or defaulted around a typo. Examples already
enforced by the engine/adapter: a request or call site with no `provider`, a `provider`
that doesn't match any configured adapter, a `(provider, model)` pair absent from the
registry (including a bare model string with a slash, like `'google/gemini-2.5-flash'`
— slash strings are never parsed), a config value that fails the selected descriptor
schema, a `reasoning.budgetTokens` set on a model whose API only supports
`reasoning.effort`, duplicate adapter/middleware `id`s, and a grounding +
structured-output combination outside the exact documented Gemini support set.

**Do not add defensive fallback/clamping code around this library.** If a call throws
`bad_request`, fix the input — do not catch-and-retry with a "safer" guessed value; the
library is telling you the config is invalid, not transiently rejected.

## Reasoning / thinking budgets

```ts
config: {
  reasoning: { effort: 'medium', includeThoughts: true }
}
```

`ReasoningEffort` is `'none' | 'low' | 'medium' | 'high'`. Two provider APIs exist
under the hood: Gemini 2.5 models take a token `budgetTokens`; Gemini 3.x / Gemma 4
models take a discrete `effort` level (`thinkingLevel`).

Use the model-native boundary directly:

- Gemini 2.5: `reasoning.budgetTokens` or admitted `reasoning.effort`
- Gemini 3 / Gemma 4: `reasoning.effort`

Exact model reminders:

- `gemini-3.1-pro-preview` does **not** admit `effort: 'none'`
- Gemma 4 is binary: only `effort: 'none'` or `effort: 'high'`
- Omit `serviceTier` for provider-standard; set `flex` explicitly
- `priority` remains rejected by the library even though Google documents it

## Rate limiting and cost tracking

- Pre-send backpressure is a `RateLimiter` port (`ClientConfig.rateLimiter`); default
  is a no-op. `@gullabs/core` ships a dependency-free `inMemoryRateLimiter`, and the
  companion `@gullabs/quota` package provides shared/cross-process quota primitives —
  see that package's README for setup.
- Every call computes `result.cost` (micro-USD) via the configured `PricingSource`
  (`geminiPricingSource()`), and, when `sink` is configured on `createClient`, persists
  a full per-attempt record (usage, cost, warnings, error classification) — fail-open,
  so a broken sink never fails the LLM call. See `docs/ledger.md` for the record shape
  and the `@gullabs/drizzle` package for a ready-made Postgres `UsageSink`.

## Common mistakes

- Forgetting `opts.auth` on a `generate()`/`runStructured()` call — it is required on
  every call, not just once at `createClient()` time.
- Omitting `provider` (or writing a slash-joined `'provider/model'` string) on a request
  or call site — `provider` is a required top-level field; the engine never derives it.
- Assuming `process.env.GEMINI_API_KEY` (or similar) is read automatically — it is
  never read by this library; the host must resolve and pass the key itself.
- Assuming `result.output`'s shape is validated — it is `unknown`; validate it yourself
  (Standard Schema v1) after checking `result.outputParsed === true`.
- Assuming Vertex AI is a supported target — it currently is not (roadmap only); only
  the Gemini Developer API (API-key auth) is supported.
- Catching a `bad_request` `LlmError` and retrying with a clamped/guessed value instead
  of fixing the call — the library never silently coerces invalid config.
- Setting `reasoning.budgetTokens` on a `thinkingLevel`-API model (Gemini 3.x / Gemma 4) — use `reasoning.effort` instead; the descriptor schema should reject it.
- Assuming omitted `serviceTier` still means Flex — it now stays omitted and
  uses provider-default request behavior unless you explicitly opt into `flex`.

## For more detail

These docs live in the source repo and may not ship in the installed `node_modules`
copy — the auth + structured-output example above is intentionally self-contained.

- `README.md` — full quickstart, install options, Gemma 4 notes.
- `docs/structured-output-validation.md` — full caller-owned validation helper.
- `docs/multi-runtime.md` — client construction across request/response vs. worker code.
- `docs/ledger.md` — persisted record field reference.
- `docs/grounded-structured.md` — grounding + structured output two-call pattern.
