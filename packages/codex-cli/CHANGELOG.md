# @gullabs/codex-cli

## 0.2.0

### Minor Changes

- e3da339: Add dev-only `@gullabs/claude-cli` and `@gullabs/codex-cli` provider adapters. These route LLM calls through a locally-authenticated `claude` (Claude Code) or `codex` (OpenAI Codex) CLI session so iterating on long Temporal workflows (dozens of LLM-call activities) costs $0 in API spend. They are impossible to run in production by construction — both require an interactive CLI login on the machine — and are not fallbacks for API providers.

  Auth uses the new `{ cliSession: true }` variant of `AuthMaterial`; model descriptors and config schemas live inside each package (not `@gullabs/core`) since dev-only models must not enter the production core surface.

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0
