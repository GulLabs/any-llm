# Security Policy

Please report security issues privately through GitHub Security Advisories rather than opening a
public issue. We aim to acknowledge within a few business days.

Note: this library never logs or persists provider API keys. Hosts control what request/response
payloads are captured (capture is off by default); review your `UsageSink` before storing prompts.

`redactSecrets()` best-effort scrubbing is applied only to persisted error messages and a handful
of `generationConfig` fields (`providerOptions`, `httpOptions.headers`) before they reach the sink.
The free-form `metadata` bag on `CallMetadata` is never scanned or redacted — it is stored verbatim,
so callers are responsible for keeping secrets out of it.
