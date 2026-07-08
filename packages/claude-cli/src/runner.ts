/**
 * ClaudeCliRunner — the process-execution seam for @gullabs/claude-cli.
 *
 * Adapters depend on the {@link ClaudeCliRunner} interface only.
 * {@link buildClaudeCliRunner} is the sole factory that touches
 * `node:child_process`; committed tests inject a hand-written fake instead of
 * exercising it, so no real `claude` subprocess is ever spawned in CI.
 *
 * @module
 */

import { spawn } from 'node:child_process'

/**
 * The result of a single `claude` CLI invocation.
 */
export interface ClaudeCliRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * Options accepted by {@link ClaudeCliRunner.run}.
 */
export interface ClaudeCliRunOptions {
  /** Working directory for the subprocess (the adapter owns tmpdir lifecycle). */
  cwd: string
  /** Kill the subprocess if it has not exited within this many milliseconds. */
  timeoutMs?: number
  /** Kill the subprocess if this signal fires. */
  signal?: AbortSignal
}

/**
 * The process-execution seam consumed by {@link claudeCliAdapter}.
 *
 * Implementations run the `claude` binary with `args`, write `input` to its
 * stdin (the rendered prompt), and resolve with captured stdout/stderr/exit
 * code. Implementations must never throw for a non-zero exit code — that is
 * the adapter's error-classification job; the one exception is a spawn-time
 * failure (e.g. `ENOENT` when the binary is missing), which should reject.
 */
export interface ClaudeCliRunner {
  run(
    args: string[],
    input: string,
    opts: ClaudeCliRunOptions,
  ): Promise<ClaudeCliRunResult>
}

/**
 * Build the real {@link ClaudeCliRunner}, backed by `node:child_process`.
 *
 * Never exercised by committed tests — only the real dev workflow invokes
 * this factory; tests inject a hand-written fake implementing
 * {@link ClaudeCliRunner} instead.
 *
 * @param claudePath - Path or bare command name for the `claude` binary.
 *   Defaults to `'claude'`, resolved via `PATH`.
 */
export function buildClaudeCliRunner(claudePath = 'claude'): ClaudeCliRunner {
  return {
    run(args, input, opts) {
      return new Promise((resolve, reject) => {
        // NOTE: the argv itself (including the `--safe-mode` vs `--bare`
        // choice) is owned by the adapter (see adapter.ts) — this runner is
        // a dumb pipe. We repeat the rule here only as a pointer: never pass
        // `--bare`, it disables OAuth/keychain auth.
        const child = spawn(claudePath, args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        let settled = false
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        let killTimeoutHandle: ReturnType<typeof setTimeout> | undefined

        const cleanup = (): void => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          if (killTimeoutHandle !== undefined) clearTimeout(killTimeoutHandle)
          if (opts.signal !== undefined) {
            opts.signal.removeEventListener('abort', onAbort)
          }
        }

        const killChild = (): void => {
          child.kill('SIGTERM')
          killTimeoutHandle = setTimeout(() => {
            child.kill('SIGKILL')
          }, 5_000)
        }

        const settleReject = (err: Error): void => {
          if (settled) return
          settled = true
          cleanup()
          killChild()
          reject(err)
        }

        const onAbort = (): void => {
          const err = new Error('claude-cli call aborted')
          err.name = 'AbortError'
          settleReject(err)
        }

        if (opts.signal !== undefined) {
          if (opts.signal.aborted) {
            onAbort()
          } else {
            opts.signal.addEventListener('abort', onAbort, { once: true })
          }
        }

        if (opts.timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            const err = new Error(`claude-cli call exceeded ${opts.timeoutMs}ms timeout`)
            err.name = 'TimeoutError'
            settleReject(err)
          }, opts.timeoutMs)
        }

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })

        child.once('error', (err) => {
          if (settled) return
          settled = true
          cleanup()
          reject(err)
        })

        child.once('close', (exitCode) => {
          if (settled) return
          settled = true
          cleanup()
          resolve({ stdout, stderr, exitCode })
        })

        child.stdin.end(input, 'utf8')
      })
    },
  }
}
