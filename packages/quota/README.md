# @gullabs/quota

Provider quota primitives for `any-llm`. This package keeps quota policy, durable deferral, and
distributed state out of `@gullabs/core` while still speaking the core `Middleware` and
`RateLimiter` seams directly.

## Install

```bash
pnpm add @gullabs/quota @gullabs/core
```

## Key exports

| Export                           | What it is                                                      |
| -------------------------------- | --------------------------------------------------------------- |
| `quotaPolicyForGemini(opts)`     | Builds a provider quota policy for Gemini/Google model IDs      |
| `checkProviderQuota(opts)`       | Returns a typed `QuotaDecision` (`allow` / `defer` / `deny`)    |
| `enforceProviderQuota(opts)`     | Turns a `QuotaDecision` into quota events and typed `LlmError`s |
| `providerQuotaMiddleware(opts)`  | Core `Middleware` that blocks before `next()`                   |
| `providerQuotaRateLimiter(opts)` | Core `RateLimiter` wrapper for non-middleware hosts             |
| `upstashQuotaStore(opts)`        | Distributed `QuotaStore` backed by the Upstash REST pipeline    |

## Quick example

```ts
import { createClient, geminiPricingSource } from '@gullabs/core'
import { geminiAdapter } from '@gullabs/google'
import {
  providerQuotaMiddleware,
  quotaPolicyForGemini,
  upstashQuotaStore,
} from '@gullabs/quota'

const quotaStore = upstashQuotaStore({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

const quotaPolicy = quotaPolicyForGemini({
  models: {
    'gemini-2.5-pro': { rpm: 60, rpd: 2_000 },
    'gemini-2.5-flash': { rpm: 120, rpd: 10_000 },
  },
})

const client = createClient({
  adapters: [geminiAdapter()],
  pricing: geminiPricingSource(),
  middleware: [
    providerQuotaMiddleware({
      provider: 'google',
      store: quotaStore,
      policy: quotaPolicy,
    }),
  ],
})
```

Hosts that prefer the lower-level core `rateLimiter` hook can wrap the same policy/store pair with
`providerQuotaRateLimiter(opts)` instead.

## Fail-open default in core

`createClient()` defaults to `NOOP_RATE_LIMITER` when no `rateLimiter` is configured. That is a
conscious fail-open decision, not an oversight. For production Gemini traffic, wire at minimum
`inMemoryRateLimiter` from `@gullabs/core` on a single node or `@gullabs/quota` for shared,
distributed enforcement.

This is the same default described in `packages/core/src/ports.ts` on the `RateLimiter` port. The
core doc comment points back here for the quota-specific tradeoffs and limitations.

## Decision model

- `allow`: proceed immediately.
- `defer`: quota is temporarily exhausted; `retryAfterMs` is present and the thrown `LlmError` is
  `retryable: true`.
- `deny`: quota policy permanently disables the model for this scope; today that means
  `reason: 'provider_disabled'` and `retryable: false`.

### The `rpd: 0` convention (deliberate, not incidental)

Setting `rpd: 0` on a model's `GeminiQuotaLimits` is a documented, intentional way to disable that
model/scope entirely: `evaluateQuotaDecision` checks `resolved.rpd === 0` before consulting the
`QuotaStore` at all and returns `{ kind: 'deny', reason: 'provider_disabled' }` immediately, with
no store round-trip. Use it to hard-turn-off a model (e.g. one that's over budget or deprecated)
without removing its `quotaPolicyForGemini` entry or touching `RateLimiter` wiring — every call
gets a non-retryable `LlmError` instead of quietly falling through to `allow`. This is distinct
from omitting `rpd` (which leaves the day-limit unenforced) or setting a positive `rpd` that the
store exhausts (which yields a retryable `defer`, not a `deny`).

## Known limitations

- `classifyError` in `@gullabs/core` maps every HTTP `429` to `kind: 'rate_limited'` uniformly.
  The only capacity-versus-quota split anywhere in this repo is regex text matching in
  `@gullabs/google`'s `flex-fallback.ts` (`CAPACITY_PATTERNS` / `QUOTA_PATTERNS`). That is an
  unversioned prose contract with Google's API. A false positive there spends money on
  standard-tier traffic; a false negative only loses availability.
- `RateLimiter.acquire` is keyed as `"${provider}:${model}"` and runs once per logical call before
  the adapter. The built-in Gemini flex-to-standard fallback happens later inside the adapter, so
  there is no tier key seam for a future policy to gate the standard-tier leg separately.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — `RateLimiter`, `Middleware`, and the `LlmError` contract
- [`@gullabs/google` README](../google/README.md) — the Gemini adapter this package's default policy targets
