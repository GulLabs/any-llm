/**
 * codexCliAdapter — @gullabs/codex-cli provider adapter.
 *
 * Pure request⇄response mapping over a locally-authenticated `codex` CLI
 * session (via {@link CodexCliRunner}).  Never persists, never computes
 * cost, never loops, never validates structured output.
 *
 * DEV-ONLY: this adapter requires `ctx.auth = { cliSession: true }` and
 * shells out to the `codex` binary on `PATH`.  It has no API-key code path
 * whatsoever — see `packages/core/src/ports.ts` for the `AuthMaterial`
 * union this narrows against.
 *
 * @module
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmError, classifyError, classifyHttpStatus } from '@gullabs/core'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Usage,
  Warning,
  JsonValue,
  Message,
  Part,
} from '@gullabs/core'
import { createCodexCliRunner } from './runner.js'
import type { CodexCliRunner } from './runner.js'

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface CodexCliAdapterOptions {
  /**
   * Inject a runner (real or fake).  When omitted, the real
   * `node:child_process`-backed runner from {@link createCodexCliRunner} is
   * used.  Committed tests ALWAYS inject a fake here — the real runner is
   * never exercised by the test suite.
   */
  runner?: CodexCliRunner
  /** Path (or bare command name resolved via `PATH`) to the `codex` binary. */
  codexPath?: string
  /** Maximum number of concurrent `runner.run` invocations. Defaults to 2. */
  maxConcurrency?: number
}

// ---------------------------------------------------------------------------
// In-file concurrency semaphore — no external dep, no core RateLimiter port.
// ---------------------------------------------------------------------------

function createSemaphore(maxConcurrency: number): {
  acquire: () => Promise<() => void>
} {
  let active = 0
  const queue: Array<() => void> = []

  const release = (): void => {
    active -= 1
    const next = queue.shift()
    if (next !== undefined) {
      active += 1
      next()
    }
  }

  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        if (active < maxConcurrency) {
          active += 1
          resolve(release)
        } else {
          queue.push(() => {
            resolve(release)
          })
        }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Invariant argv — adapter-owned, never caller-configurable.
// ---------------------------------------------------------------------------

const INVARIANT_ARGS = [
  'exec',
  '--json',
  '--ephemeral',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--ignore-rules',
  '--sandbox',
  'read-only',
]

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

/** Extracts the single text string from a text-only part list, else throws. */
function requireTextOnly(parts: Part[]): string[] {
  return parts.map((p) => {
    if (p.kind !== 'text') {
      throw new LlmError(
        'codex-cli is text-only; non-text message parts (inline media, file URIs) are not supported — do not use -i images in v1',
        { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
      )
    }
    return p.text
  })
}

/**
 * Serialize the conversation into a single prompt string.
 *
 * A single user message with a single text part is passed verbatim (matches
 * the captured smoke-test invocation shape). Otherwise, messages are
 * rendered as role-labelled `User:`/`Assistant:` blocks separated by blank
 * lines.
 */
function serializeMessages(messages: Message[]): string {
  if (messages.length === 1 && messages[0]?.role === 'user') {
    const [text] = requireTextOnly(messages[0].parts)
    if (messages[0].parts.length === 1 && text !== undefined) {
      return text
    }
  }

  return messages
    .map((msg) => {
      const label = msg.role === 'assistant' ? 'Assistant' : 'User'
      const text = requireTextOnly(msg.parts).join('')
      return `${label}:\n${text}`
    })
    .join('\n\n')
}

/**
 * Fold the optional system instruction into the prompt as a delimited
 * preamble block.
 *
 * This is TRANSPORT ENCODING, not capability mapping — `codex exec` has no
 * system-prompt flag, so the content reaches the model verbatim as part of
 * the user turn.  It is not a distinct system-role message the way
 * Gemini/Claude support natively.  See the README for the same caveat.
 */
function buildPrompt(system: string | undefined, messages: Message[]): string {
  const body = serializeMessages(messages)
  if (system === undefined) return body
  return `<system>\n${system}\n</system>\n\n${body}`
}

// ---------------------------------------------------------------------------
// JSONL event shapes (structural — only the fields we read)
// ---------------------------------------------------------------------------

interface ThreadStartedEvent {
  type: 'thread.started'
  thread_id: string
}

interface ItemCompletedEvent {
  type: 'item.completed'
  item: { id: string; type: string; text?: string; message?: string }
}

interface TurnUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

interface TurnCompletedEvent {
  type: 'turn.completed'
  usage?: TurnUsage
}

interface StreamErrorEvent {
  type: 'error'
  message: string
}

interface TurnFailedEvent {
  type: 'turn.failed'
  error?: { message?: string }
}

type CodexJsonlEvent =
  | ThreadStartedEvent
  | ItemCompletedEvent
  | TurnCompletedEvent
  | StreamErrorEvent
  | TurnFailedEvent
  | { type: string; [k: string]: unknown }

/** Defensively parse a JSONL stdout stream, skipping lines that fail to parse. */
function parseJsonlEvents(stdout: string): CodexJsonlEvent[] {
  const events: CodexJsonlEvent[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { type?: unknown }).type === 'string'
      ) {
        events.push(parsed as CodexJsonlEvent)
      }
    } catch {
      // Stray non-JSON stdout is possible — skip rather than throw.
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Nested error envelope (captured 400 shape)
// ---------------------------------------------------------------------------

interface NestedCodexErrorBody {
  type?: string
  error?: { type?: string; code?: string; message?: string; param?: string }
  status?: number
}

/**
 * Classify a fatal codex stream error message into an `LlmError`.
 *
 * `rawMessage` is either:
 * - A JSON-encoded string (parse again) containing `{error:{...}, status}`.
 * - A raw non-JSON string (stderr tail, or an unparseable error line).
 */
function classifyCodexStreamError(rawMessage: string): LlmError {
  let nested: NestedCodexErrorBody | undefined
  try {
    const parsed: unknown = JSON.parse(rawMessage)
    if (parsed !== null && typeof parsed === 'object') {
      nested = parsed
    }
  } catch {
    // Not JSON — fall through to text-based heuristics below.
  }

  if (nested?.status !== undefined) {
    const cls = classifyHttpStatus(nested.status)
    const message = nested.error?.message ?? rawMessage
    return new LlmError(message, {
      kind: cls.kind,
      retryable: cls.retryable,
      httpStatus: nested.status,
      ...(cls.retryAfterMs !== undefined ? { retryAfterMs: cls.retryAfterMs } : {}),
      provider: 'codex-cli',
    })
  }

  // Text-based fallback — no numeric status found.
  const lower = rawMessage.toLowerCase()
  if (
    lower.includes('login') ||
    lower.includes('auth') ||
    lower.includes('unauthorized')
  ) {
    return new LlmError(rawMessage, {
      kind: 'invalid_auth',
      retryable: false,
      provider: 'codex-cli',
    })
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return new LlmError(rawMessage, {
      kind: 'rate_limited',
      retryable: true,
      provider: 'codex-cli',
    })
  }

  // Generic non-classified bucket — deliberately non-retryable per spec,
  // even though `server` is usually retryable.
  return new LlmError(rawMessage, {
    kind: 'server',
    retryable: false,
    provider: 'codex-cli',
  })
}

// ---------------------------------------------------------------------------
// Usage mapping
// ---------------------------------------------------------------------------

/**
 * Map codex's `turn.completed.usage` to our `Usage` type.
 *
 * **GROSS convention enforced here:**
 * `reasoning_output_tokens` is a SUBSET of `output_tokens` per OpenAI's
 * Responses API token accounting (mirrors Gemini's `thoughtsTokenCount`
 * being a subset of `candidatesTokenCount` + `thoughtsTokenCount` GROSS
 * total) — it is surfaced as `thinkingTokens` / `details.thinking` but is
 * NOT added on top of `outputTokens`, since it is already inside
 * `output_tokens`. Likewise `cached_input_tokens` is a subset of
 * `input_tokens`. No `totalTokens` field is present in the captured
 * envelope — omitted here rather than derived.
 */
function mapUsage(usage: TurnUsage | undefined): Usage {
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cachedInputTokens = usage?.cached_input_tokens
  const thinkingTokens = usage?.reasoning_output_tokens

  const details: Record<string, number> = {
    input: inputTokens,
    output: outputTokens,
    ...(cachedInputTokens !== undefined ? { cached: cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinking: thinkingTokens } : {}),
  }

  const raw: JsonValue = usage !== undefined ? (usage as unknown as JsonValue) : null

  return {
    inputTokens,
    outputTokens,
    details,
    raw,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
  }
}

// ---------------------------------------------------------------------------
// Structured-output schema shallow injection
// ---------------------------------------------------------------------------

/**
 * codex's Responses-API-backed schema mode REQUIRES `additionalProperties:
 * false` on every object level or it 400s.  We inject `additionalProperties:
 * false` into the TOP LEVEL of whatever JSON Schema object `req.
 * outputJsonSchema` is, when writing the temp schema file, if the caller's
 * schema doesn't already specify it.
 *
 * LIMITATION (documented, out of scope for v1): this is a SHALLOW,
 * top-level-only injection.  We do NOT deep-recurse into nested `properties`
 * / `items` / `$defs` rewriting every nested object schema — deep
 * JSON-Schema rewriting is a much larger surface and is deliberately out of
 * scope. Callers with nested object schemas must set `additionalProperties:
 * false` themselves at every nested level, or codex will 400 on those
 * nested schemas.
 */
function withTopLevelAdditionalPropertiesFalse(schema: JsonValue): JsonValue {
  if (
    schema !== null &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    !('additionalProperties' in schema)
  ) {
    return { ...schema, additionalProperties: false }
  }
  return schema
}

// ---------------------------------------------------------------------------
// codexCliAdapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Codex CLI provider adapter.
 *
 * @param opts.runner - Optional injected runner (fakes in tests; real
 *   `createCodexCliRunner()` output in production dev usage).
 */
export function codexCliAdapter(opts?: CodexCliAdapterOptions): ProviderAdapter {
  const runner = opts?.runner ?? createCodexCliRunner(opts?.codexPath)
  const maxConcurrency = opts?.maxConcurrency ?? 2
  const semaphore = createSemaphore(maxConcurrency)

  return {
    id: 'codex-cli',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      // ------------------------------------------------------------------
      // 0. Auth — these providers only ever accept a CLI session opt-in.
      // ------------------------------------------------------------------
      const hasCliSession = 'cliSession' in ctx.auth && ctx.auth.cliSession
      if (!hasCliSession) {
        throw new LlmError(
          '@gullabs/codex-cli requires auth: { cliSession: true } — these dev-only providers route through a locally-authenticated `codex` CLI session, not an API key',
          { kind: 'invalid_auth', retryable: false, provider: 'codex-cli' },
        )
      }

      const warnings: Warning[] = []
      const model = req.model

      // ------------------------------------------------------------------
      // 1. Validate + serialize the prompt (throws bad_request on non-text
      //    parts BEFORE invoking the runner).
      // ------------------------------------------------------------------
      const prompt = buildPrompt(req.system, req.messages)

      // ------------------------------------------------------------------
      // 2. Scratch dir — adapter-owned per call. Serves double duty: it is
      //    both the runner's `cwd` AND the `-C <scratchDir>` argv value,
      //    and it holds the --output-schema / -o temp files.
      // ------------------------------------------------------------------
      const scratchDir = await mkdtemp(join(tmpdir(), 'codex-cli-'))

      try {
        const release = await semaphore.acquire()
        try {
          // ----------------------------------------------------------------
          // 3. Build argv.
          // ----------------------------------------------------------------
          const args: string[] = [
            ...INVARIANT_ARGS,
            '-C',
            scratchDir,
            '-c',
            'approval_policy=never',
            '--color',
            'never',
            '-m',
            model,
          ]

          const effort = req.config.reasoning?.effort
          if (effort !== undefined) {
            args.push('-c', `model_reasoning_effort=${effort}`)
          }

          const structuredOutputRequested = req.outputJsonSchema !== undefined
          if (structuredOutputRequested) {
            const schemaPath = join(scratchDir, 'schema.json')
            const schemaWithAdditionalProps = withTopLevelAdditionalPropertiesFalse(
              req.outputJsonSchema as JsonValue,
            )
            await writeFile(
              schemaPath,
              JSON.stringify(schemaWithAdditionalProps),
              'utf-8',
            )
            args.push('--output-schema', schemaPath)
          }

          // -o is ALWAYS passed — plain-text calls also get a reliable
          // final-text capture path, per spec.
          const outputPath = join(scratchDir, 'output.json')
          args.push('-o', outputPath)

          // The fully-serialized prompt (with the optional <system> preamble
          // folded in) is the FINAL POSITIONAL ARGUMENT — matching the
          // captured smoke-test invocation shape (`codex exec ... 'Say
          // exactly: hi'`). We still pass an empty string as the runner's
          // `input` (stdin) to satisfy the shared CodexCliRunner interface
          // shape; codex never reads stdin in this invocation form.
          args.push(prompt)

          // ----------------------------------------------------------------
          // 4. Timeout — the adapter passes timeoutMs down to the runner
          //    (so it can SIGTERM/SIGKILL the subprocess) AND independently
          //    races its own timer against the runner's promise, so a
          //    misbehaving/fake runner that never settles still surfaces a
          //    clean kind:'timeout' error rather than hanging the caller.
          // ----------------------------------------------------------------
          const timeoutMs = req.attemptTimeoutMs ?? req.config.timeoutMs

          const runPromise = runner.run(args, '', {
            cwd: scratchDir,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(req.signal !== undefined ? { signal: req.signal } : {}),
          })

          let result: Awaited<ReturnType<CodexCliRunner['run']>>
          try {
            if (timeoutMs !== undefined) {
              result = await Promise.race([
                runPromise,
                new Promise<never>((_resolve, reject) => {
                  setTimeout(() => {
                    reject(
                      new DOMException(
                        `codex-cli call exceeded ${timeoutMs}ms timeout`,
                        'TimeoutError',
                      ),
                    )
                  }, timeoutMs)
                }),
              ])
            } else {
              result = await runPromise
            }
          } catch (rawErr) {
            if (
              rawErr !== null &&
              typeof rawErr === 'object' &&
              (rawErr as { code?: unknown }).code === 'ENOENT'
            ) {
              throw new LlmError(
                'codex CLI not found on PATH — install the OpenAI Codex CLI and authenticate (see `codex login`)',
                { kind: 'unknown', retryable: false, provider: 'codex-cli' },
              )
            }
            const classified = classifyError(rawErr)
            throw new LlmError(classified.message, {
              kind: classified.kind,
              retryable: classified.retryable,
              ...(classified.httpStatus !== undefined
                ? { httpStatus: classified.httpStatus }
                : {}),
              ...(classified.retryAfterMs !== undefined
                ? { retryAfterMs: classified.retryAfterMs }
                : {}),
              provider: 'codex-cli',
              cause: classified.cause ?? rawErr,
            })
          }

          const { stdout, exitCode } = result
          const events = parseJsonlEvents(stdout)

          // ----------------------------------------------------------------
          // 5. Fatal stream-level errors.
          // ----------------------------------------------------------------
          for (const event of events) {
            if (event.type === 'error') {
              const message = (event as StreamErrorEvent).message
              throw classifyCodexStreamError(message)
            }
            if (event.type === 'turn.failed') {
              const failed = event as TurnFailedEvent
              const message = failed.error?.message ?? 'codex turn failed'
              throw classifyCodexStreamError(message)
            }
          }

          if (exitCode !== 0 && exitCode !== null) {
            const stderrTail = result.stderr.slice(-2000)
            throw new LlmError(`codex exec exited with code ${exitCode}: ${stderrTail}`, {
              kind: 'server',
              retryable: false,
              provider: 'codex-cli',
            })
          }

          // ----------------------------------------------------------------
          // 6. Final text/structured payload — PREFER the -o tmpfile,
          //    FALLBACK to the last agent_message item.text.
          // ----------------------------------------------------------------
          let preferredText: string | undefined
          try {
            const fileContent = await readFile(outputPath, 'utf-8')
            if (fileContent.trim().length > 0) {
              preferredText = fileContent
            }
          } catch {
            // -o file missing — fall through to the JSONL fallback.
          }

          if (preferredText === undefined) {
            let lastAgentMessage: string | undefined
            for (const event of events) {
              if (event.type === 'item.completed') {
                const item = (event as ItemCompletedEvent).item
                if (item.type === 'agent_message' && item.text !== undefined) {
                  lastAgentMessage = item.text
                }
              }
            }
            preferredText = lastAgentMessage
          }

          let rawStructured: unknown
          if (structuredOutputRequested && preferredText !== undefined) {
            try {
              rawStructured = JSON.parse(preferredText)
            } catch {
              warnings.push({
                type: 'other',
                message: 'codex-cli: failed to JSON-parse structured output payload',
              })
            }
          }

          // ----------------------------------------------------------------
          // 7. Usage + threadId.
          // ----------------------------------------------------------------
          let usageEvent: TurnUsage | undefined
          let threadId: string | undefined
          for (const event of events) {
            if (event.type === 'turn.completed') {
              usageEvent = (event as TurnCompletedEvent).usage
            }
            if (event.type === 'thread.started') {
              threadId = (event as ThreadStartedEvent).thread_id
            }
          }
          const usage = mapUsage(usageEvent)

          const adapterResult: AdapterResult = {
            model,
            usage,
            warnings,
            // No explicit finish-reason signal is present in the captured
            // envelope (no MAX_TOKENS/safety marker) — 'stop' is the only
            // supportable value on a successful turn.completed.
            finishReason: 'stop',
            ...(preferredText !== undefined && preferredText.length > 0
              ? { text: preferredText }
              : {}),
            ...(rawStructured !== undefined ? { rawStructured } : {}),
            ...(threadId !== undefined ? { providerMetadata: { threadId } } : {}),
          }

          return adapterResult
        } finally {
          release()
        }
      } finally {
        await rm(scratchDir, { recursive: true, force: true })
      }
    },
  }
}
