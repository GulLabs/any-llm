/**
 * @gullabs/claude-cli — adapter contract tests.
 *
 * All tests use a hand-rolled fake implementing `ClaudeCliRunner` — NO real
 * subprocess is ever spawned.
 *
 * @module
 */

import { tmpdir } from 'node:os'
import { describe, it, expect, vi } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { claudeCliAdapter } from './adapter.js'
import type { ClaudeCliEnvelope } from './adapter.js'
import type {
  ClaudeCliRunner,
  ClaudeCliRunOptions,
  ClaudeCliRunResult,
} from './runner.js'

// ---------------------------------------------------------------------------
// Fixtures — captured verbatim from a real `claude -p ... --output-format json` run
// ---------------------------------------------------------------------------

const PLAIN_ENVELOPE: ClaudeCliEnvelope = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'hi',
  stop_reason: 'end_turn',
  session_id: 'dda3ede4-b359-47a8-9750-ebe867989e30',
  total_cost_usd: 0.003755,
  num_turns: 1,
  usage: {
    input_tokens: 3605,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 30,
  },
}

const STRUCTURED_ENVELOPE: ClaudeCliEnvelope = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"greeting":"hi"}',
  stop_reason: 'tool_use',
  session_id: '5660b6c8-636b-453e-9798-70daec48bb93',
  total_cost_usd: 0.010202,
  num_turns: 2,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 4321,
    cache_read_input_tokens: 0,
    output_tokens: 195,
  },
}

// ---------------------------------------------------------------------------
// Fake runner
// ---------------------------------------------------------------------------

type RunCall = { args: string[]; input: string; opts: ClaudeCliRunOptions }

function makeFakeRunner(
  handler: (call: RunCall) => Promise<ClaudeCliRunResult> | ClaudeCliRunResult,
): { runner: ClaudeCliRunner; calls: RunCall[] } {
  const calls: RunCall[] = []
  const runner: ClaudeCliRunner = {
    async run(args, input, opts) {
      const call = { args, input, opts }
      calls.push(call)
      return handler(call)
    },
  }
  return { runner, calls }
}

function envelopeResult(envelope: ClaudeCliEnvelope): ClaudeCliRunResult {
  return { stdout: JSON.stringify(envelope), stderr: '', exitCode: 0 }
}

function makeResolvedReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Say exactly: hi' }] }],
    config: {},
    ...overrides,
  }
}

const CLI_SESSION_CTX: AdapterCtx = {
  auth: { cliSession: true },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('rejects ApiKeyAuth with invalid_auth', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq(), {
        auth: { apiKey: 'sk-test' },
        logger: CLI_SESSION_CTX.logger,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_auth', retryable: false })
  })

  it('accepts CliSessionAuth', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)
    expect(result.text).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// Happy path — text
// ---------------------------------------------------------------------------

describe('happy path: text', () => {
  it('maps text, model, finishReason, providerMetadata', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(result.text).toBe('hi')
    expect(result.model).toBe('claude-haiku-4-5-20251001')
    expect(result.finishReason).toBe('stop')
    expect(result.providerMetadata).toMatchObject({
      totalCostUsd: 0.003755,
      sessionId: 'dda3ede4-b359-47a8-9750-ebe867989e30',
    })
    expect(result.rawStructured).toBeUndefined()
  })

  it('maps GROSS usage numbers from the fixture', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(result.usage.inputTokens).toBe(3605)
    expect(result.usage.outputTokens).toBe(30)
    expect(result.usage.cachedInputTokens).toBe(0)
    expect(result.usage.details).toEqual({ input: 3605, output: 30, cached: 0 })
    expect(result.usage.totalTokens).toBeUndefined()
    expect(result.usage.raw).toEqual(PLAIN_ENVELOPE.usage)
  })
})

// ---------------------------------------------------------------------------
// Happy path — structured output
// ---------------------------------------------------------------------------

describe('happy path: structured output', () => {
  it('parses rawStructured from envelope.result', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(STRUCTURED_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(
      makeResolvedReq({ outputJsonSchema: { type: 'object' } }),
      CLI_SESSION_CTX,
    )

    expect(result.rawStructured).toEqual({ greeting: 'hi' })
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(195)
    expect(result.usage.cachedInputTokens).toBe(0)
  })

  it('pushes a warning and leaves rawStructured undefined on parse failure', async () => {
    const badEnvelope: ClaudeCliEnvelope = { ...STRUCTURED_ENVELOPE, result: 'not json' }
    const { runner } = makeFakeRunner(() => envelopeResult(badEnvelope))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(
      makeResolvedReq({ outputJsonSchema: { type: 'object' } }),
      CLI_SESSION_CTX,
    )

    expect(result.rawStructured).toBeUndefined()
    expect(result.warnings).toContainEqual({
      type: 'other',
      message: 'claude-cli: failed to parse structured output as JSON',
    })
  })
})

// ---------------------------------------------------------------------------
// Argv construction
// ---------------------------------------------------------------------------

describe('argv construction', () => {
  it('builds the exact invariant + mapped argv in order', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(
      makeResolvedReq({
        system: 'be terse',
        config: { reasoning: { effort: 'high' } },
        outputJsonSchema: { type: 'object', properties: {} },
      }),
      CLI_SESSION_CTX,
    )

    expect(calls[0]?.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--safe-mode',
      '--tools',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--model',
      'claude-haiku-4-5-20251001',
      '--effort',
      'high',
      '--system-prompt',
      'be terse',
      '--json-schema',
      JSON.stringify({ type: 'object', properties: {} }),
    ])
  })

  it('never passes --bare', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(calls[0]?.args).not.toContain('--bare')
  })

  it('omits --effort, --system-prompt, --json-schema when unset', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(calls[0]?.args).not.toContain('--effort')
    expect(calls[0]?.args).not.toContain('--system-prompt')
    expect(calls[0]?.args).not.toContain('--json-schema')
  })
})

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

describe('prompt serialization', () => {
  it('passes a single user/single-text message verbatim', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(
      makeResolvedReq({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Say exactly: hi' }] }],
      }),
      CLI_SESSION_CTX,
    )

    expect(calls[0]?.input).toBe('Say exactly: hi')
  })

  it('builds a role-labelled transcript for multi-message requests', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(
      makeResolvedReq({
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Hi' }] },
          { role: 'assistant', parts: [{ kind: 'text', text: 'Hello' }] },
          { role: 'user', parts: [{ kind: 'text', text: 'How are you?' }] },
        ],
      }),
      CLI_SESSION_CTX,
    )

    expect(calls[0]?.input).toBe('User:\nHi\n\nAssistant:\nHello\n\nUser:\nHow are you?')
  })

  it('rejects non-text parts with bad_request before invoking the runner', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'AAAA' }],
            },
          ],
        }),
        CLI_SESSION_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })

    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('maps ENOENT (runner rejects with code ENOENT) to unknown', async () => {
    const { runner } = makeFakeRunner(() => {
      const err = new Error('spawn claude ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    })
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
  })

  it('maps an is_error envelope with auth-ish stderr to invalid_auth', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'error_auth', is_error: true }),
      stderr: 'Please run `claude auth login` — not authorized',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
  })

  it('maps an is_error envelope with rate-limit-ish stderr to rate_limited (retryable)', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'error_rate', is_error: true }),
      stderr: 'HTTP 429: rate limit exceeded',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    })
  })

  it('maps a generic is_error envelope to server, retryable false', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'error_other', is_error: true }),
      stderr: 'something went wrong',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'server',
      retryable: false,
    })
  })

  it('maps a non-zero exit with unparseable stdout to unknown', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: 'not json at all',
      stderr: 'boom',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Timeout / abort
// ---------------------------------------------------------------------------

describe('timeout and abort', () => {
  it('throws kind:timeout, retryable:true when the call exceeds timeoutMs', async () => {
    const { runner } = makeFakeRunner(
      () => new Promise<ClaudeCliRunResult>(() => {}), // never resolves
    )
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), CLI_SESSION_CTX),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('throws kind:aborted when the AbortSignal fires', async () => {
    const controller = new AbortController()
    const { runner } = makeFakeRunner(
      () =>
        new Promise<ClaudeCliRunResult>((_resolve, reject) => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          if (controller.signal.aborted) {
            reject(err)
            return
          }
          controller.signal.addEventListener('abort', () => reject(err))
        }),
    )
    const adapter = claudeCliAdapter({ runner })

    const runPromise = adapter.run(makeResolvedReq(), {
      ...CLI_SESSION_CTX,
      signal: controller.signal,
    })
    controller.abort()

    await expect(runPromise).rejects.toMatchObject({ kind: 'aborted' })
  })
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('concurrency semaphore', () => {
  it('with maxConcurrency:1, the second call waits for the first to resolve', async () => {
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const { runner } = makeFakeRunner(async (call) => {
      if (call.input === 'first') {
        order.push('first-start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        order.push('first-end')
        return envelopeResult(PLAIN_ENVELOPE)
      }
      order.push('second-start')
      return envelopeResult(PLAIN_ENVELOPE)
    })
    const adapter = claudeCliAdapter({ runner, maxConcurrency: 1 })

    const firstReq = makeResolvedReq({
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'first' }] }],
    })
    const secondReq = makeResolvedReq({
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'second' }] }],
    })

    const p1 = adapter.run(firstReq, CLI_SESSION_CTX)
    // Give the first call a tick to actually start and register as pending.
    await vi.waitFor(() => expect(order).toContain('first-start'))
    const p2 = adapter.run(secondReq, CLI_SESSION_CTX)

    // second must not have started yet
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['first-start'])

    releaseFirst?.()
    await Promise.all([p1, p2])

    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })
})

// ---------------------------------------------------------------------------
// Scratch dir
// ---------------------------------------------------------------------------

describe('scratch dir', () => {
  it('passes a cwd under os.tmpdir() that differs across calls', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)
    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(calls).toHaveLength(2)
    const cwd1 = calls[0]?.opts.cwd
    const cwd2 = calls[1]?.opts.cwd
    expect(cwd1).toBeDefined()
    expect(cwd2).toBeDefined()
    expect(cwd1?.startsWith(tmpdir())).toBe(true)
    expect(cwd1).toContain('claude-cli-')
    expect(cwd1).not.toBe(cwd2)
  })
})

// ---------------------------------------------------------------------------
// LlmError sanity
// ---------------------------------------------------------------------------

describe('LlmError shape', () => {
  it('auth rejection is an instance of LlmError with provider tag', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), {
        auth: { apiKey: 'x' },
        logger: CLI_SESSION_CTX.logger,
      })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).provider).toBe('claude-cli')
    }
  })
})
