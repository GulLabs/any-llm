# @gullabs/core

The provider-agnostic heart of any-llm. Contains all types, port interfaces, the engine pipeline, call-site definitions, cost computation, and the persisted record builder. Has no provider dependencies.

## Key exports

| Export                  | What it is                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `createClient(config)`  | Wires ports into a `{ generate, runStructured }` client                  |
| `defineCallSite(opts)`  | Defines a typed, reusable prompt template bound to a model               |
| `geminiPricingSource()` | Returns a `PricingSource` backed by the built-in Gemini pricing snapshot |
| `resolveReasoning()`    | Resolves numeric reasoning budgets into provider effort/budget settings  |
| `LlmError`              | Typed error class — always thrown on call failure                        |
| `buildRecord(input)`    | Assembles an `LlmCallRecord` from engine state (used internally)         |

Port interfaces you implement: `ProviderAdapter`, `UsageSink`, `PricingSource`, `RateLimiter`, `Clock`, `IdGenerator`, `Logger`, `Telemetry`.

## Quick example

```ts
import { createClient, geminiPricingSource, defineCallSite } from '@gullabs/core'

const client = createClient({
  adapters: [myAdapter],
  pricing: geminiPricingSource(),
  sink: mySink,
})

const callSite = defineCallSite({
  id: 'summarise',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  userTemplate: 'Summarise: {{text}}',
  config: { reasoning: { includeThoughts: true } },
})

// Auth is required per call — never read from the environment.
const result = await client.runStructured(
  callSite,
  { text: 'hello world' },
  {
    auth: { apiKey: 'YOUR_KEY' },
  },
)
// result.output   — JSON-parsed; caller validates
// result.outputParsed — true when JSON.parse succeeded
// result.usage    — { inputTokens, outputTokens, thinkingTokens, cachedInputTokens }
// result.cost     — { microUsd, pricingVersion, details: { input, cached, output } }
// result.reasoningText — thought summary if includeThoughts was set
// result.queueDelayMs — wait inside RateLimiter.acquire, separate from latencyMs
```

`createClient({ strictPricing: true, ... })` performs an opt-in construction-time check that every
registered model resolves to a priced entry. Runtime pricing remains fail-open: pricing failures do
not fail LLM calls.

## Logging & Observability

### Logger

Inject a pino-compatible structured logger via `ClientConfig.logger`. The `Logger` port uses an
object-first `(o, m)` signature:

```ts
import pino from 'pino'

const client = createClient({
  adapters: [myAdapter],
  pricing: geminiPricingSource(),
  logger: pino(),
})
```

Four levels: `debug`, `info`, `warn`, `error`. Engine events:

| Event                    | Level                                                                   |
| ------------------------ | ----------------------------------------------------------------------- |
| `llm.call.start`         | `info`                                                                  |
| `llm.call.attempt.start` | `debug`                                                                 |
| `llm.call.retry`         | `debug` — includes `attemptNumber`, `delayMs`, `errorKind`, `retryable` |
| `llm.call.success`       | `info`                                                                  |
| `llm.call.error`         | `error`                                                                 |
| `llm.call.cost.failed`   | `warn`                                                                  |
| `llm.call.sink.success`  | `debug`                                                                 |
| `llm.call.sink.failed`   | `error` (redacted)                                                      |

Host logger exceptions are swallowed by `makeSafeLogger` — fail-open; a bad logger never breaks a
call.

### Telemetry

Inject a `Telemetry` hook via `ClientConfig.telemetry` for OTel / Sentry / PostHog integration.
All three methods (`onStart`, `onSuccess`, `onError`) are optional and fire once per logical call
(not per attempt). The opaque value returned by `onStart` is forwarded as `span` to `onSuccess`
and `onError`. Hook failures are swallowed fail-open.

### LlmCallRecord and UsageSink

Every call attempt is persisted via `UsageSink.record(r: LlmCallRecord)`. The sink must be
idempotent on `r.attemptId`. Key traceability fields: `callId` (stable across retries),
`attemptId`, `attemptNumber` (1-based), `latencyMs`, token counts, `costMicroUsd`, `errorKind`,
`queueDelayMs`, and `metadata` (host-supplied, stored verbatim). `latencyMs` measures provider
dispatch only; `queueDelayMs` measures pre-send wait inside `RateLimiter.acquire`.

If a request includes `idempotencyKey`, attempt 1 uses that exact value as `attemptId`. In-process
library retries suffix later attempts (`key:2`, `key:3`, ...), so callers should correlate the final
outcome from `result.attemptId` or `LlmError.attemptId`. Temporal-owned activity retries that call
the library fresh each time keep the pre-minted key on attempt 1 and deduplicate only at the ledger
sink.

### Redaction

`redactSecrets` runs automatically on `errorMessage`, `generationConfig.providerOptions`, and
`generationConfig.httpOptions.headers` before persistence. Standard knobs and `metadata` are not
scanned — do **not** put secrets in `metadata`.

## Token convention

**GROSS**: `cachedInputTokens` is a subset of `inputTokens`; `thinkingTokens` is a subset of `outputTokens`. Cost math never double-counts. See `SPEC.md` for the full invariant.
