---
'@gullabs/any-llm': patch
---

Updates the `any-llm` skill (`packages/any-llm/skills/any-llm/SKILL.md`) with a new section documenting the 2026-07-09 live-verified finding that xAI's structured-output `strict: true` performs no OpenAI-style compile-time schema validation, and describing `@gullabs/codex-cli`'s opt-in `toOpenAiStrictOutputSchema` transformer and local `assertOpenAiStrictOutputSchema` preflight for its own `--output-schema` backend contract — making clear that contract is specific to codex-cli and not applied to xai.
