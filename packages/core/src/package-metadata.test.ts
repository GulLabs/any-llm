/**
 * Permanence guard: published package.json repository metadata must keep the
 * `GulLabs/any-llm` org/repo path. Lowercase `gullabs` fails npm provenance
 * (Release run 31787709259). The Release workflow compares the same path to
 * `GITHUB_REPOSITORY` immediately before publish. After an org/repo rename,
 * update `repoPath` here first so CI and the Release gate stay aligned.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const packagesRoot = join(workspaceRoot, 'packages')
const repoPath = 'GulLabs/any-llm'
const hostedUrl = `https://github.com/${repoPath}`

type Manifest = {
  name?: string
  private?: boolean
  repository?: { type?: string; url?: string; directory?: string }
  homepage?: string
  bugs?: string
}

function publishedManifests(): { dir: string; pkg: Manifest }[] {
  const out: { dir: string; pkg: Manifest }[] = []
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let pkg: Manifest
    try {
      pkg = JSON.parse(
        readFileSync(join(packagesRoot, entry.name, 'package.json'), 'utf8'),
      ) as Manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (pkg.private === true || typeof pkg.name !== 'string') continue
    out.push({ dir: entry.name, pkg })
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

describe('published package metadata', () => {
  it('discovers public workspace packages', () => {
    expect(publishedManifests().length).toBeGreaterThan(0)
  })

  it.each(publishedManifests())(
    '$dir repository path uses GulLabs/any-llm casing',
    ({ dir, pkg }) => {
      expect(pkg.repository?.type).toBe('git')
      expect(pkg.repository?.directory).toBe(`packages/${dir}`)
      expect(pkg.repository?.url).toMatch(
        new RegExp(`^(?:git\\+)?https://github\\.com/${repoPath}(?:\\.git)?$`),
      )
      expect(pkg.homepage).toBe(`${hostedUrl}/tree/main/packages/${dir}#readme`)
      expect(pkg.bugs).toBe(`${hostedUrl}/issues`)
    },
  )
})
