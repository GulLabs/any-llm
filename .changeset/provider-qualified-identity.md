---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/testing': minor
'@gullabs/quota': minor
'@gullabs/any-llm': minor
'@gullabs/drizzle': patch
---

Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

- `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
- `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
- Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
- Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
- Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).
