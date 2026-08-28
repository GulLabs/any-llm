---
'@gullabs/any-llm': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/core': minor
'@gullabs/drizzle': minor
'@gullabs/google': minor
'@gullabs/quota': minor
'@gullabs/testing': minor
'@gullabs/xai': minor
---

Raise the supported runtime and narrow provider peer ranges.

- **Breaking:** `engines.node` is now `>=22.12.0` on every published package. Node 20
  reached end of life in April 2026 and is no longer supported.
- **Breaking:** `@gullabs/google` requires `@google/genai` `^2` (was `^1 || ^2`), and
  `@gullabs/any-llm` now depends on `@google/genai` `^2.19.0`.
- **Breaking:** `@gullabs/xai` requires `openai` `^7` (was `^6 || ^7`).

Development moves to Node 24 (`.nvmrc` pins 24.20.0) and pnpm 11.24.0; pnpm settings
now live in `pnpm-workspace.yaml` rather than `package.json` and `.npmrc`.
