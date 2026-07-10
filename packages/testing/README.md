# @gullabs/testing

Reusable test fakes for any-llm. Lets you drive the full engine pipeline — including the Gemini adapter — without any network calls or mocking frameworks.

## Install

```bash
pnpm add -D @gullabs/testing @gullabs/core @gullabs/google
```

## Key exports

| Export                       | What it is                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `FakeClock`                  | Deterministic `Clock` — `advance(ms)` / `set(ms)` for latency assertions                       |
| `FakeIds`                    | Sequential `IdGenerator` — returns `call_1`, `attempt_1`, etc.                                 |
| `RecordingSink`              | In-memory `UsageSink` — accumulates records; inspect via `sink.records` / `sink.last()`        |
| `makeFakeGemini(script)`     | Creates a fake `@google/genai`-compatible client from a scripted response                      |
| `fakeGeminiResponse(opts)`   | Builds a `GeminiResponseLike` with usage metadata, thought parts, and JSON output              |
| `fakeGeminiBlocked(opts)`    | Builds a safety-blocked `GeminiResponseLike` (no candidates, `promptFeedback.blockReason` set) |
| `FakeAdapter`                | Scriptable `ProviderAdapter` — use at the port level (bypasses Gemini SDK entirely)            |
| `SignalAwareFakeAdapter`     | Like `FakeAdapter` but observes and honours `AbortSignal` from `AdapterCtx`                    |
| `scriptedRateLimiter(opts)`  | RateLimiter fake with injectable wait for deterministic `queueDelayMs` assertions              |
| `inMemoryRateLimiter(opts?)` | Convenience re-export of `@gullabs/core`'s in-process `RateLimiter` implementation             |

## Quick example — end-to-end with fake Gemini client

```ts
import { createClient, composeProviders, defineCallSite } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'

const fakeClient = makeFakeGemini(
  fakeGeminiResponse({
    structuredJson: '{"ok":true}',
    thoughtText: 'Thinking...',
    promptTokenCount: 100,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 20,
    finishReason: 'STOP',
  }),
)

const sink = new RecordingSink()
const client = createClient({
  ...composeProviders([googleProvider({ client: fakeClient })]),
  sink,
  clock: new FakeClock(0),
  ids: new FakeIds(),
})

const callSite = defineCallSite({
  id: 'test',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
  userTemplate: 'Hello',
  config: { reasoning: { includeThoughts: true } },
})

// Auth is required per call.
const result = await client.runStructured(callSite, {}, { auth: { apiKey: 'fake' } })

// Assertions
console.assert(result.output?.ok === true)
console.assert(result.outputParsed === true)
console.assert(result.usage.thinkingTokens === 20)
console.assert(sink.last()?.status === 'ok')
```

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — the ports (`Clock`, `IdGenerator`, `UsageSink`, `RateLimiter`) these fakes implement
- [`@gullabs/google` README](../google/README.md) — the real Gemini adapter these fakes stand in for
