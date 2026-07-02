---
'@gullabs/core': patch
'@gullabs/google': minor
'@gullabs/quota': patch
---

Fix bugs found in an independent adversarial audit of the adoption-backlog implementation:

- `@gullabs/core`: `resolveReasoning()` no longer throws for positive sub-tier `budgetTokens` values on level-api models (only an explicit `0` budget is rejected as "none"); the engine no longer double-counts rate-limiter queue wait as provider-dispatch `latencyMs` when a call fails before dispatch ever starts (`latencyMs` is now `0` in that case, matching the documented `queueDelayMs`/`latencyMs` split).
- `@gullabs/google`: add `normalizeGroundingCitations()` and the `Citation` type, a fail-open post-processing helper for deduplicating and normalizing Gemini grounding-chunk citations.
- `@gullabs/quota`: reject non-integer/negative `rpm`/`rpd` quota-rule config with a deterministic `LlmError` (`kind: "bad_request"`, `retryable: false`) instead of a plain `Error` or silently disabling enforcement.
