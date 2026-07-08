/**
 * @gullabs/codex-cli — real runner tests.
 *
 * Unlike adapter.test.ts (which always injects a fake `CodexCliRunner`),
 * this file exercises {@link createCodexCliRunner} itself — the one seam
 * that touches `node:child_process`. To stay CI-safe with no real `codex`
 * binary on PATH, the only case exercised here is the pre-aborted-signal
 * short-circuit, which must reject WITHOUT ever calling `spawn` — so an
 * intentionally nonexistent binary path is safe to use as a belt-and-
 * suspenders check that no process was launched.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createCodexCliRunner } from './runner.js'

describe('createCodexCliRunner: pre-aborted signal', () => {
  it('rejects immediately without spawning when the signal is already aborted', async () => {
    const runner = createCodexCliRunner(
      '/nonexistent/path/to/codex-binary-that-does-not-exist',
    )
    const controller = new AbortController()
    controller.abort()

    const start = Date.now()
    await expect(
      runner.run([], '', { cwd: process.cwd(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    const elapsedMs = Date.now() - start

    // If `spawn` had actually been called against a nonexistent binary, the
    // rejection would instead surface asynchronously as an ENOENT `'error'`
    // event, which takes a tick (or more, if the OS is slow to resolve the
    // path) and would carry `code: 'ENOENT'`, not an AbortError. Settling
    // near-synchronously with an AbortError is our signal that `spawn` was
    // never reached.
    expect(elapsedMs).toBeLessThan(50)
  })
})
