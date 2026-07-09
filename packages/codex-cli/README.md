# @gullabs/codex-cli

Dev-only provider adapter that routes `any-llm` calls through a
locally-authenticated `codex` (OpenAI Codex CLI) session instead of a billed
API.

> **DEV-ONLY.** This package shells out to a locally-authenticated `codex`
> CLI session. It is impossible to run in production by construction. Never
> use this as a fallback for an API provider — it exists purely to make
> iterating on long Temporal workflows free during development.

The adapter is text-only, pure (no cost computation, no schema validation of
structured output), and never invokes the real `codex` binary from the
committed test suite — tests inject a fake `CodexCliRunner`.

## Install

```sh
pnpm add -D @gullabs/codex-cli
```

Requires a locally-authenticated `codex` CLI on `PATH` (`codex login`) for
actual use; not required to build or test this package.

## Key exports

| Export                                          | Description                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `codexCliAdapter(opts?)`                        | Builds the `ProviderAdapter` (`id: 'codex-cli'`).                                          |
| `CodexCliAdapterOptions`                        | `{ runner?, codexPath?, maxConcurrency? }`.                                                |
| `createCodexCliRunner(codexPath?)`              | Real `node:child_process`-backed `CodexCliRunner`.                                         |
| `CodexCliRunner` / `CodexCliRunResult`          | The subprocess seam interface, for injecting fakes.                                        |
| `codexCliModelDescriptors` / `codexCliRegistry` | `ModelDescriptor[]` / `ModelRegistry` for the 4 supported models.                          |
| `CODEX_CLI_MODEL_IDS`                           | `'gpt-5.5' \| 'gpt-5.4' \| 'gpt-5.4-mini' \| 'gpt-5.3-codex-spark'`.                       |
| `CODEX_CLI_REASONING_EFFORTS`                   | `['low', 'medium', 'high', 'xhigh']` (note: no `'none'`, unlike core's `ReasoningEffort`). |

## Quick example

```ts
import { codexCliAdapter } from '@gullabs/codex-cli'
import { createClient } from '@gullabs/core'

const client = createClient({ adapters: [codexCliAdapter()] })

const result = await client.generate(
  {
    provider: 'codex-cli',
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { cliSession: true } },
)
```

## Notes

### System prompt is transport-encoded, not natively supported

`codex exec` has no system-prompt flag. When `request.system` is set, the
adapter folds it into the prompt as a delimited preamble:

```
<system>
...your system text...
</system>

...user/assistant transcript...
```

This is **transport encoding, not capability mapping** — the content reaches
the model verbatim as part of the user turn. It is not a distinct
system-role message the way Gemini/Claude support natively.

### `--output-schema` `additionalProperties: false` — shallow injection only

codex's Responses-API-backed schema mode requires `additionalProperties:
false` on every object level or it 400s. The adapter injects
`additionalProperties: false` into the **top level** of your JSON Schema if
it isn't already present there — but it does **not** deep-recurse into
nested `properties` / `items` / `$defs`. If your schema has nested object
subschemas, set `additionalProperties: false` on those yourself, or codex
will reject the request.

### Concurrency

The adapter runs an in-process semaphore around `runner.run`, defaulting to
`maxConcurrency: 2`. Override via `codexCliAdapter({ maxConcurrency: N })`.

### Argv is adapter-owned

The invariant flags (`--json --ephemeral --skip-git-repo-check
--ignore-user-config --ignore-rules --sandbox read-only -c
approval_policy=never --color never`) are never caller-configurable. Only
`-m <model>`, `-c model_reasoning_effort=<effort>`, `--output-schema`, `-o`,
`-C <scratchDir>`, and the final positional prompt argument vary per call.
