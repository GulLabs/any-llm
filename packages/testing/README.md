# @gullabs/testing

Reusable test fakes for any-llm. Lets you drive the full engine pipeline — including the Gemini adapter — without any network calls or mocking frameworks.

## Key exports

| Export | What it is |
|---|---|
| `FakeClock` | Deterministic `Clock` — `advance(ms)` / `set(ms)` for latency assertions |
| `FakeIds` | Sequential `IdGenerator` — returns `call_1`, `attempt_1`, etc. |
| `RecordingSink` | In-memory `UsageSink` — accumulates records; inspect via `sink.records` / `sink.last()` |
| `makeFakeGemini(script)` | Creates a fake `@google/genai`-compatible client from a scripted response |
| `fakeGeminiResponse(opts)` | Builds a `GeminiResponseLike` with usage metadata, thought parts, and JSON output |
| `fakeGeminiBlocked(opts)` | Builds a safety-blocked `GeminiResponseLike` (no candidates, `promptFeedback.blockReason` set) |
| `FakeAdapter` | Scriptable `ProviderAdapter` — use at the port level (bypasses Gemini SDK entirely) |
| `fakeAuth(material)` | Returns an `AuthProvider` that always resolves to the given credentials |

## Quick example — end-to-end with fake Gemini client

```ts
import { z } from 'zod'
import { createClient, geminiPricingSource, defineCallSite } from '@gullabs/core'
import { geminiAdapter } from '@gullabs/google'
import {
  FakeClock, FakeIds, RecordingSink,
  fakeAuth, fakeGeminiResponse, makeFakeGemini,
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
  adapters: [geminiAdapter({ client: fakeClient })],
  auth: fakeAuth({ apiKey: 'fake' }),
  pricing: geminiPricingSource(),
  sink,
  clock: new FakeClock(0),
  ids: new FakeIds(),
})

const callSite = defineCallSite({
  id: 'test',
  model: 'gemini-2.5-flash',
  schema: z.object({ ok: z.boolean() }),
  userTemplate: 'Hello',
  config: { reasoning: { includeThoughts: true } },
})

const result = await client.runStructured(callSite, {})

// Assertions
console.assert(result.output?.ok === true)
console.assert(result.usage.thinkingTokens === 20)
console.assert(sink.last()?.status === 'ok')
```
