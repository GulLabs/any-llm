# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing to npm. Publishing is done by GitHub Actions, not from a developer machine.

## Provenance

This repository is public. The Release workflow requests `id-token: write` and sets `NPM_CONFIG_PROVENANCE=true` so every `changeset publish` attaches [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

If the repository is ever made private again, npm will reject those provenance bundles (`E422 Unsupported GitHub Actions source repository visibility: "private"`). Disable both `id-token: write` and `NPM_CONFIG_PROVENANCE` in that case.

When `NPM_CONFIG_PROVENANCE=true`, npm compares the manifest `repository.url` against the provenance attestation's `sourceRepositoryURI` (derived from the Actions OIDC claims, which include `GITHUB_REPOSITORY`). The org/repo path must be exactly `gul-labs/any-llm`. The comparison is literal, so it is not satisfied by different casing, and **not** by a GitHub redirect from a former org name either — the org was renamed from `GulLabs` to `gul-labs`, and while `github.com/GulLabs/any-llm` still redirects in a browser, the old path in a manifest fails this check. A `git+https://….git` form is valid npm metadata; change the path only. The emergency laptop path does not attach this provenance bundle, so this is a CI-publish constraint.

Verbatim registry error from Release [31787709259](https://github.com/gul-labs/any-llm/actions/runs/31787709259), from the earlier lowercase-casing incident under the old org name (quoted as-is; the paths in it are historical):

```
E422 422 Unprocessable Entity - PUT https://registry.npmjs.org/@gullabs%2fxai
Error verifying sigstore provenance bundle: Failed to validate repository
information: package.json: "repository.url" is
"git+https://github.com/gullabs/any-llm.git", expected to match
"https://github.com/GulLabs/any-llm" from provenance
```

The Release workflow fails fast if any public package's `repository.url` path does not equal `GITHUB_REPOSITORY`, before `changeset publish` starts. `packages/core/src/package-metadata.test.ts` asserts the same path on every public package and that this file lists each one. After an org/repo rename, update that test's `repoPath` first.

Registry provenance validation is not exercised by `npm publish --dry-run`. A rejected publish does not consume that package's version, so retry by rolling the path fix forward — never revert to a stale path. `changeset publish` is sequential: if a later package fails after an earlier one succeeded, the published versions are immutable. Before merging a metadata-only fix, verify with `npm view @gullabs/<pkg> version` and `git ls-remote --tags origin` and add a patch changeset for any version already on the registry. If a later Release still returns E422 after the path matches, check that `NPM_CONFIG_PROVENANCE` actually attached a bundle rather than mutating the URL shape.

## How it works

1. **Add a changeset** while you work — which packages, which semver bump, what changed.
2. **Open and merge the feature PR to `main`.** Feature-branch CI does not publish.
3. **Let the `Release` workflow run after `main` CI succeeds.** `.github/workflows/release.yml` is triggered by a successful `CI` workflow run on `main`.
4. **Changesets decides whether to version or publish:**
   - Pending `.changeset/*.md` files → `changesets/action` opens a "Version Packages" PR.
   - Versions already bumped and no pending changesets → `changesets/action` runs `pnpm release` and publishes unpublished versions with the `NPM_TOKEN` secret.

Do not block a normal CI release on local `npm whoami`. Local npm auth is only for the emergency manual path.

## Day-to-day: adding a changeset

```bash
# From the repo root, on your feature branch:
pnpm changeset
```

The CLI asks which packages changed, the bump level, and a one-line summary. Commit the file under `.changeset/` with the code.

Docs-only, CI-only, and internal-chore PRs do not need a changeset.

## Release flow

```
feature branch  →  PR + changeset file merged to main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action opens "Version Packages" PR
         (bumps package.json versions + writes CHANGELOGs)
                        ↓
         Maintainer reviews & squash-merges "Version Packages" PR
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes to npm with provenance
         GitHub Release tags are created automatically
```

There is also a valid fast path when the feature branch already includes the version commit:

```
feature branch  →  PR with code + package.json/CHANGELOG version bumps merged to main
                        ↓
              GitHub Actions: CI succeeds on main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes the already-versioned unpublished packages
```

Use only one path per release:

- **Normal path:** commit `.changeset/*.md`, merge to `main`, then merge the generated "Version Packages" PR.
- **Pre-versioned path:** run `pnpm version-packages` on the feature branch, commit package/changelog updates, and merge that PR directly to `main`.

Do not keep both a pending changeset file and a committed version bump for the same change.

## Packages published

All packages are published to the `@gullabs` scope with `publishConfig.access = "public"`:

| Package               | npm                                               |
| --------------------- | ------------------------------------------------- |
| `@gullabs/any-llm`    | https://www.npmjs.com/package/@gullabs/any-llm    |
| `@gullabs/core`       | https://www.npmjs.com/package/@gullabs/core       |
| `@gullabs/google`     | https://www.npmjs.com/package/@gullabs/google     |
| `@gullabs/xai`        | https://www.npmjs.com/package/@gullabs/xai        |
| `@gullabs/drizzle`    | https://www.npmjs.com/package/@gullabs/drizzle    |
| `@gullabs/quota`      | https://www.npmjs.com/package/@gullabs/quota      |
| `@gullabs/testing`    | https://www.npmjs.com/package/@gullabs/testing    |
| `@gullabs/claude-cli` | https://www.npmjs.com/package/@gullabs/claude-cli |
| `@gullabs/codex-cli`  | https://www.npmjs.com/package/@gullabs/codex-cli  |

## Required repository secret

| Secret      | Description                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | npm automation token with publish access to the `@gullabs` scope. Generate at https://www.npmjs.com/settings → Access Tokens → Generate New Token → Automation. |

`GITHUB_TOKEN` is provided by GitHub Actions.

## Manual release (emergency)

```bash
pnpm -r build
pnpm version-packages
changeset publish   # requires npm login on this machine
```

Prefer CI. A laptop publish will not attach the same provenance as the Actions OIDC identity.

Some pre-open-source CHANGELOG entries were later anonymized in-repo. The repo CHANGELOG is canonical; older GitHub Releases and already-published npm tarballs are historical snapshots.

## Snapshot / pre-releases

```bash
pnpm changeset pre enter alpha
# ... commit changesets as normal ...
pnpm changeset pre exit   # when ready to graduate
```
