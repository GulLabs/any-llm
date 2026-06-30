---
'@gullabs/any-llm': minor
'@gullabs/google': patch
---

Add the batteries-included `@gullabs/any-llm` package as the default one-package install path for Gemini users.

The new aggregate package depends on the core engine, Google adapter, Google GenAI SDK, and Zod, then re-exports the common public API from one entrypoint. The Google adapter now also declares its runtime Zod peer dependency explicitly for modular installs.
