---
'@gullabs/any-llm': minor
'@gullabs/core': patch
'@gullabs/google': patch
'@gullabs/drizzle': patch
'@gullabs/quota': patch
'@gullabs/testing': patch
---

Open-source documentation pass: rewrote the root README and all package READMEs for
accuracy and consistency, fixed stale content in DESIGN.md/SPEC.md/docs/architecture.md
left over from the forward-only structured-output migration, restructured the root
CHANGELOG.md to point at each package's own changelog, archived internal planning docs
into `docs/archive/`, and scrubbed a private host name from a `@gullabs/core` source
comment (no behavior change).

`@gullabs/any-llm` also ships a new Agent Skill at `skills/any-llm/SKILL.md` teaching AI
coding assistants (e.g. Claude Code) how to use this library correctly — per-call auth,
the forward-only structured-output contract, error handling, and common mistakes.
