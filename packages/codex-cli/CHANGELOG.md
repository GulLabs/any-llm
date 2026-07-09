# @gullabs/codex-cli

## 0.3.0

### Minor Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

### Patch Changes

- Updated dependencies [ba21620]
  - @gullabs/core@0.7.0

## 0.2.0

### Minor Changes

- e3da339: Add dev-only `@gullabs/claude-cli` and `@gullabs/codex-cli` provider adapters. These route LLM calls through a locally-authenticated `claude` (Claude Code) or `codex` (OpenAI Codex) CLI session so iterating on long Temporal workflows (dozens of LLM-call activities) costs $0 in API spend. They are impossible to run in production by construction — both require an interactive CLI login on the machine — and are not fallbacks for API providers.

  Auth uses the new `{ cliSession: true }` variant of `AuthMaterial`; model descriptors and config schemas live inside each package (not `@gullabs/core`) since dev-only models must not enter the production core surface.

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0
