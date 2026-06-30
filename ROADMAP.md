# Roadmap

Items here are designed seams — the ports or type-system placeholders exist, but the
implementation is deferred until the Gemini-only, non-streaming foundation is stable.

---

## Future / Deferred

### Deep lint-policy audit

The repo will start with a deliberately minimal ESLint stack: core ESLint, `@eslint/js`,
`typescript-eslint`, and `globals`, scoped tightly to real library source with lighter handling for
tests/examples/config.

Defer a deeper lint audit until this baseline is stable in day-to-day use. That later pass should
re-evaluate:
- whether any additional correctness rules are worth the noise,
- whether docs/examples need their own stricter gate,
- whether the repo should stay on ESLint or switch part of the surface to another tool,
- and whether any plugin additions are justified by real recurring defects rather than fashion.

### Vertex AI support

Removed in v0.2.x because it depended on Google Application Default Credentials (ADC): ambient
discovery from `GOOGLE_APPLICATION_CREDENTIALS`, well-known credential files, or the GCE metadata
service. That contradicts the library's no-ambient-reads guarantee (see ADR-019 in DECISIONS.md).

Will return with an explicit credential shape — a plain object containing the fields needed to
authenticate (service account key material or a short-lived access token), with no ambient
discovery. ADC is not in scope.

### Streaming

A `stream()` method that returns an async iterable of normalized `StreamEvent` objects plus a
`final: Promise<LlmResult>`. The `ProviderAdapter` interface is designed to accommodate a
`runStream` method. Records are written on every terminal stream outcome including abort.

### Tool / function calling

The `Part` union's `kind` discriminant is reserved for future `tool-call` and `tool-result`
variants. `LlmRequest` does not yet carry a `tools` field.

### Multimodal output

Model-generated images, audio, and structured files as output parts. The `Part` union is extensible;
no output-part variants are defined yet.

### Additional providers

The `ProviderAdapter` port and routing infrastructure are ready. `AuthMaterial` is currently
`{ apiKey: string }` only. Extending to OAuth tokens, bearer tokens, or provider-specific shapes
is additive and non-breaking for the port itself, though each new `AuthMaterial` variant is a
union extension that may require host-code updates.

Refreshable credentials (OAuth/STS short-lived tokens): resolve at the engine entrypoint via a
resolver function; primary design work is the long-lived cache/file stores that currently memoize
a client from a single auth snapshot (see ADR-020 in DECISIONS.md).

### Standard Schema structured output

Accept any Standard Schema v1 validator (Valibot, ArkType, etc.) as `LlmRequest.output.schema`,
not only Zod. Zod would remain supported as a Standard Schema implementation rather than a
first-class type parameter. This is a non-breaking additive change.

### `Redactor` port

A port for scrubbing sensitive content from messages and results before persistence. Currently only
`redactSecrets` (regex-based, applied to `errorMessage`) exists. A proper `Redactor` port would
allow host-supplied DLP logic and would be fail-closed to prevent accidental persistence of
unredacted content.

### `ResultCache` port

An optional cache keyed on a deterministic hash of the request, enabling idempotent re-runs
without hitting the provider.
