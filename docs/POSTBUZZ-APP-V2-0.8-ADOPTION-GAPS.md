# PostBuzz-App-V2 — Adoption Gaps for the 0.8.0 Provider-Plugin Release

Host repo: `postbuzz-app-v2` (`/Volumes/SSD/code/work/postbuzz-app-v2`).

Adoption target: upgrade an already-live `@gullabs/any-llm` integration
(`any-llm@0.7.0`, `drizzle@0.3.6`, `quota@0.3.0`, no direct `core`/`google`/`xai`
deps) to the provider-plugin release (`any-llm@0.8.0`, `core@0.8.0`,
`google@0.8.0`, `xai@0.2.0`, `testing@0.4.0`, `drizzle@0.3.7`, `quota@0.3.1`),
and to route every LLM call in the host through these packages.

This supersedes the PostBuzz section of the archived
`docs/archive/ADOPTION-FEEDBACK.md` for the 0.7→0.8 window specifically — that
doc's PostBuzz findings (quota not yet consumed, custom rate-limit shim) are
now resolved: `packages/shared/src/ai/any-llm-quota.ts` wraps
`providerQuotaMiddleware`/`quotaPolicyForGemini`/`upstashQuotaStore` correctly,
matching this repo's own `@gullabs/quota` README example almost exactly. Source
validation for every claim below was done by reading the host's actual source,
not its docs/comments.

## Confirmed non-gaps (already satisfied by the host)

- **Per-call auth** — already the only auth path in both runtimes (Next routes
  and Temporal activities each resolve `AuthMaterial` fresh per call from a
  Zod-validated env var; no ambient/global key).
- **Forward-only structured output** — `run.ts` already gates on
  `result.outputParsed === true` before trusting `result.output`, then
  re-validates with the call site's own Zod schema.
- **Provider-qualified requests** — every `generate()`/`runStructured()` call
  already sends an explicit `provider: 'google'` (currently a hardcoded module
  constant, not per-call-site, but functionally present on the wire).
- **No raw `@google/genai` usage to convert** — `geminiContentToMessages` has
  nothing to migrate; every Gemini call already goes through the library.
- **`geminiAdapter`/`geminiPricingSource` still exist as raw exports** in
  0.8.0 (confirmed in `packages/google/src/index.ts`), so the host's current
  hand-assembled `createClient({ adapters: [geminiAdapter()], pricingSources: {...} })`
  is a near-drop-in for `composeProviders([googleProvider()])` — the only
  required field the host doesn't already supply is `modelRegistry`, now
  mandatory with no default.

## Real gaps

### 1. No production LLM-API provider package for Anthropic/Claude

The host's campaign-content-generation feature
(`apps/worker/src/temporal/activities/llm-anthropic.activities.ts`) calls
`@anthropic-ai/sdk` directly — its own error classification, its own usage
mapping, entirely outside `@gullabs/any-llm`'s cost tracking, retry policy,
structured-output contract, and ledger. This is not dead/legacy code: the
feature's config (`CONTENT_GENERATION_CONFIG.provider`) defaults to
`'anthropic'`, so this bypass path is live in production today, and it is the
**one concrete blocker** to the host's stated goal of "all LLM calls go
through `@gullabs/*`."

The library ships exactly two production API-backed providers (`google`,
`xai`) plus two dev-only CLI-session providers (`claude-cli`, `codex-cli`)
that are "impossible to run in production by construction" per their own
changelog — neither is a substitute for a real Anthropic Messages API
adapter. Closing this gap from the host side isn't possible without either
(a) the host hand-rolling its own `ProviderAdapter` for Anthropic against the
public `ProviderAdapter` port (viable today, zero core changes needed, but
duplicates adapter-lifecycle work every other provider gets for free), or (b)
a first-party `@gullabs/anthropic` package mirroring `@gullabs/xai`'s shape
(Responses-API-equivalent adapter, model descriptors, pricing source,
`ProviderOptionsMap` augmentation).

**Ask:** consider a `@gullabs/anthropic` package (Claude Messages API,
starting with `claude-haiku-4-5` since that's the host's live default model)
as a follow-on to the xAI addition, using the same `ProviderPlugin` seam
`composeProviders` already supports. This is additive, non-breaking, and the
host is a ready real-world consumer the moment it exists.

### 2. `composeProviders()` has zero real production exercise across all known consumers

Checked three codebases that depend on `any-llm@0.8.0`/`core@0.8.0`: this
library's own `provider.test.ts` (unit test only), `redline` (comments out
the intended `composeProviders` call as a TODO, actually ships a hand-built
`{ adapters: [geminiAdapter()], pricingSources: {...} }` object instead), and
`ai-studio` (a hand-rolled single-active-profile switch selecting exactly one
adapter per client construction — real and load-bearing, but never calls
`composeProviders` to combine more than one provider into a single client).
Zero of the three codebases that could prove multi-provider composition
actually do.

This isn't a code defect — the unit test in `provider.ts` covers the
single-plugin case correctly — but it means `composeProviders([googleProvider(), xaiProvider()])`
combining two _live, API-backed_ providers into one client and routing real
traffic through both is, as far as this survey found, untested outside
synthetic unit tests. If PostBuzz becomes the first consumer to route real
Gemini + Grok traffic through one composed client, treat that as a novel
integration to verify carefully (multi-provider `Middleware`/`RateLimiter`
interaction, `pricingSources` keyed correctly per adapter id, etc.), not as a
well-trodden path.

### 3. `@gullabs/testing` fakes: zero adoption across every known consumer

Both `redline` (`@gullabs/testing@0.2.0`) and `ai-studio`
(`@gullabs/testing@^0.3.0`) declare the package as a dependency but import
_nothing_ from it — both hand-roll `vi.mock()`-based fakes for
`@gullabs/google`/`@gullabs/claude-cli`/`@gullabs/codex-cli` instead of using
`FakeAdapter`, `makeFakeGemini`, `RecordingSink`, etc. `ai-studio`'s own test
file even leaves a comment explaining the hand-rolled choice explicitly
("matches the plan's 'no live network' test philosophy without requiring a
full `@gullabs/testing` `FakeAdapter` wiring"). PostBuzz doesn't depend on
`@gullabs/testing` at all today and also hand-rolls its own
`makeClient()`/`makeResult()` fakes in `packages/shared/src/ai/*.test.ts`.

Three-for-three consumers independently choosing not to use the package
suggests either a discoverability gap (its README/quickstart wasn't found
until this survey went looking) or an ergonomics mismatch with how real hosts
structure their adapter injection (all three hosts inject the adapter via
their own factory function, not directly via `createClient({ adapters })`,
so `FakeAdapter`/`makeFakeGemini` may not compose cleanly with a host's own
factory indirection layer without extra glue). Worth a docs/example pass
showing how to wire `@gullabs/testing` fakes through a **host-owned factory
function** (the realistic shape every consumer actually uses), not just
through a bare `createClient()` call.

## Non-gaps worth flagging as scope boundaries (not asks)

- Quota policies (`quotaPolicyForGemini`) are model-scoped only, not
  tenant/workspace-scoped. PostBuzz's own `any-llm-quota.ts` wiring is
  consistent with this (global per-model RPM/RPD, same as `ai-studio`'s
  DB-configurable version) — if PostBuzz later needs per-tenant/per-plan LLM
  quotas (e.g. free vs. paid tier limits), that is a product-level policy the
  host must build on top of `QuotaStore`/`checkProviderQuota`, not something
  `@gullabs/quota` should absorb.
