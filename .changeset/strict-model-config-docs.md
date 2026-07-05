---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/any-llm': minor
---

Document the breaking strict model-config contract ahead of release.

Built-in descriptors are moving to a descriptor-owned schema boundary:
`descriptor.configSchema` is the runtime source of truth, `descriptor.configJsonSchema`
is derived from it for forms, and callers should stop depending on exported
repair helpers or broad JSON-schema-only config flows.

The docs now call out the related behavior changes that must be handled at the
same boundary:

- omit `serviceTier` to use the provider's standard tier, and set `flex`
  explicitly;
- use `reasoning.effort` for Gemini 3 and Gemma level-based models instead of
  `reasoning.budgetTokens`;
- remove `effort: 'none'` on models that cannot disable thinking, such as
  `gemini-3.1-pro-preview`;
- stop using `providerOptions.google` as an override lane for descriptor-owned
  fields;
- continue treating `priority` as rejected until the library ships verified
  pricing, served-tier recording, and tests for it.
