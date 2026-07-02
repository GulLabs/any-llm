# @gullabs/quota

## 0.2.2

### Patch Changes

- c1aa7ad: Open-source documentation pass: rewrote the root README and all package READMEs for
  accuracy and consistency, fixed stale content in DESIGN.md/SPEC.md/docs/architecture.md
  left over from the forward-only structured-output migration, restructured the root
  CHANGELOG.md to point at each package's own changelog, archived internal planning docs
  into `docs/archive/`, and scrubbed a private host name from a `@gullabs/core` source
  comment (no behavior change).

  `@gullabs/any-llm` also ships a new Agent Skill at `skills/any-llm/SKILL.md` teaching AI
  coding assistants (e.g. Claude Code) how to use this library correctly — per-call auth,
  the forward-only structured-output contract, error handling, and common mistakes.

- Updated dependencies [c1aa7ad]
  - @gullabs/core@0.4.2

## 0.2.1

### Patch Changes

- dab0792: Fix bugs found in an independent adversarial audit of the adoption-backlog implementation:

  - `@gullabs/core`: `resolveReasoning()` no longer throws for positive sub-tier `budgetTokens` values on level-api models (only an explicit `0` budget is rejected as "none"); the engine no longer double-counts rate-limiter queue wait as provider-dispatch `latencyMs` when a call fails before dispatch ever starts (`latencyMs` is now `0` in that case, matching the documented `queueDelayMs`/`latencyMs` split).
  - `@gullabs/google`: add `normalizeGroundingCitations()` and the `Citation` type, a fail-open post-processing helper for deduplicating and normalizing Gemini grounding-chunk citations.
  - `@gullabs/quota`: reject non-integer/negative `rpm`/`rpd` quota-rule config with a deterministic `LlmError` (`kind: "bad_request"`, `retryable: false`) instead of a plain `Error` or silently disabling enforcement.

- Updated dependencies [dab0792]
  - @gullabs/core@0.4.1

## 0.2.0

### Minor Changes

- Implement the adoption backlog: add core reasoning resolution exports, pricing-source introspection
  and construction-time strict pricing, unpriced-cost warnings, queue-delay attribution on results and
  records, Drizzle `queue_delay_ms`, hardened quota deny/defer decisions, service-tier re-validation
  after Google provider-options merge, and deterministic testing support for rate-limiter wait time.

  Docs now cover ledger sidecar transaction composition, `metadata.operationId` correlation for
  grounded-to-structured workflows, multi-runtime retry caveats, and caller-owned structured-output
  validation.

### Patch Changes

- Updated dependencies
  - @gullabs/core@0.4.0

## 0.1.0

### Minor Changes

- Add the provider-quota companion package for any-llm with typed allow/defer/deny decisions,
  middleware and `RateLimiter` adapters, and an Upstash-compatible distributed store.
