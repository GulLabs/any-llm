---
'@gullabs/core': minor
'@gullabs/google': minor
---

Simplify auth and harden production readiness.

Streamline provider authentication so callers no longer need to manage credential objects directly — ADC and explicit key paths both work without boilerplate. Add structured error types, retry-on-transient-failure logic, and cost-accounting helpers to the core pipeline. The Google adapter gains first-class Gemini 1.5 / 2.0 model support with token-level cost computation.
