/**
 * CodexCliRunner — subprocess seam for shelling out to the `codex` CLI.
 *
 * This module defines the structural interface the adapter depends on.  The
 * real `node:child_process`-backed implementation is isolated in
 * {@link createCodexCliRunner} so committed tests can inject a fake runner
 * and NEVER spawn the real `codex` binary.
 *
 * @module
 */

import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// CodexCliRunner — structural interface
// ---------------------------------------------------------------------------

/** Result of a single `codex` CLI invocation. */
export interface CodexCliRunResult {
  /** Captured stdout (the JSONL event stream). */
  stdout: string
  /** Captured stderr. */
  stderr: string
  /** Process exit code, or `null` if the process was killed by a signal. */
  exitCode: number | null
}

/**
 * Structural seam over a `codex` CLI subprocess invocation.
 *
 * Satisfied by the real implementation returned from
 * {@link createCodexCliRunner}, or by a hand-rolled fake in tests.
 */
export interface CodexCliRunner {
  /**
   * Run the `codex` binary with the given argv and stdin, resolving with the
   * captured stdout/stderr/exitCode once the process exits.
   *
   * @param args - Full argv (excluding the binary path itself).
   * @param input - Data written to stdin, then the stream is closed. The
   *   codex-cli adapter always passes `''` here — see the adapter's argv
   *   construction comment for why the prompt travels via argv, not stdin.
   * @param opts.cwd - Working directory for the subprocess (also the
   *   directory passed as `-C` in the adapter's argv).
   * @param opts.timeoutMs - Optional wall-clock ceiling; the runner sends
   *   `SIGTERM` on expiry and follows up with `SIGKILL` if the process has
   *   not exited shortly after.
   * @param opts.signal - Optional caller abort signal; same
   *   SIGTERM→SIGKILL semantics as a timeout expiry.
   */
  run(
    args: string[],
    input: string,
    opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CodexCliRunResult>
}

// ---------------------------------------------------------------------------
// Real implementation — NEVER exercised by committed tests
// ---------------------------------------------------------------------------

/** Grace period between SIGTERM and the SIGKILL follow-up, in milliseconds. */
const SIGKILL_GRACE_MS = 5_000

/**
 * Build the real {@link CodexCliRunner}, backed by `node:child_process.spawn`.
 *
 * @param codexPath - Path (or bare command name resolved via `PATH`) to the
 *   `codex` binary. Defaults to `'codex'`.
 */
export function createCodexCliRunner(codexPath = 'codex'): CodexCliRunner {
  return {
    run(
      args: string[],
      input: string,
      opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
    ): Promise<CodexCliRunResult> {
      return new Promise((resolve, reject) => {
        // Mirror claude-cli's runner: never spawn a subprocess for a call
        // whose signal is already aborted.
        if (opts.signal?.aborted === true) {
          const err = new Error('codex-cli call aborted')
          err.name = 'AbortError'
          reject(err)
          return
        }

        const child = spawn(codexPath, args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        let settled = false
        // Set once a timeout/abort has begun killing the child. The
        // returned promise is NOT rejected with this until the child's
        // 'close' event actually fires — the caller (the adapter) must
        // never observe settlement while the OS process may still be
        // alive and writing to its scratch cwd.
        let pendingError: Error | undefined
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let hardKillTimer: ReturnType<typeof setTimeout> | undefined

        const cleanupTimers = (): void => {
          if (killTimer !== undefined) clearTimeout(killTimer)
          if (hardKillTimer !== undefined) clearTimeout(hardKillTimer)
        }

        const terminate = (): void => {
          if (settled) return
          child.kill('SIGTERM')
          hardKillTimer = setTimeout(() => {
            if (!settled) child.kill('SIGKILL')
          }, SIGKILL_GRACE_MS)
        }

        const beginReject = (err: Error): void => {
          if (settled || pendingError !== undefined) return
          pendingError = err
          cleanupTimers()
          terminate()
        }

        if (opts.timeoutMs !== undefined) {
          killTimer = setTimeout(() => {
            const err = new Error(`codex-cli call exceeded ${opts.timeoutMs}ms timeout`)
            err.name = 'TimeoutError'
            beginReject(err)
          }, opts.timeoutMs)
        }

        const onAbort = (): void => {
          const err = new Error('codex-cli call aborted')
          err.name = 'AbortError'
          beginReject(err)
        }
        if (opts.signal !== undefined) {
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf-8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8')
        })

        child.on('error', (err) => {
          if (settled) return
          settled = true
          cleanupTimers()
          if (opts.signal !== undefined) {
            opts.signal.removeEventListener('abort', onAbort)
          }
          reject(pendingError ?? err)
        })

        child.on('close', (code) => {
          if (settled) return
          settled = true
          cleanupTimers()
          if (opts.signal !== undefined) {
            opts.signal.removeEventListener('abort', onAbort)
          }
          if (pendingError !== undefined) {
            reject(pendingError)
          } else {
            resolve({ stdout, stderr, exitCode: code })
          }
        })

        child.stdin.write(input)
        child.stdin.end()
      })
    },
  }
}
