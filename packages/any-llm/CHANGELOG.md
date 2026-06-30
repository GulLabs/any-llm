# @gullabs/any-llm

## 0.2.0

### Minor Changes

- 6e246d2: Add the batteries-included `@gullabs/any-llm` package as the default one-package install path for Gemini users.

  The new aggregate package depends on the core engine, Google adapter, Google GenAI SDK, and Zod, then re-exports the common public API from one entrypoint. The Google adapter now also declares its runtime Zod peer dependency explicitly for modular installs.

### Patch Changes

- Updated dependencies [6e246d2]
- Updated dependencies [8f1bf61]
  - @gullabs/google@0.2.0
  - @gullabs/core@0.2.0
