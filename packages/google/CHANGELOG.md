# @gullabs/google

## 0.2.0

### Minor Changes

- 8f1bf61: Simplify auth and harden production readiness.

  Streamline provider authentication so callers no longer need to manage credential objects directly — ADC and explicit key paths both work without boilerplate. Add structured error types, retry-on-transient-failure logic, and cost-accounting helpers to the core pipeline. The Google adapter gains first-class Gemini 1.5 / 2.0 model support with token-level cost computation.

### Patch Changes

- 6e246d2: Add the batteries-included `@gullabs/any-llm` package as the default one-package install path for Gemini users.

  The new aggregate package depends on the core engine, Google adapter, Google GenAI SDK, and Zod, then re-exports the common public API from one entrypoint. The Google adapter now also declares its runtime Zod peer dependency explicitly for modular installs.

- Updated dependencies [8f1bf61]
  - @gullabs/core@0.2.0
