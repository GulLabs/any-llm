# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing to npm. Publishing is normally done by GitHub Actions, not by running `npm publish` from a developer machine.

## Private repo provenance rule

npm provenance is disabled while this GitHub repository is private. npm rejects provenance bundles from private GitHub Actions source repositories with `E422 Unsupported GitHub Actions source repository visibility: "private"`.

The release workflow must omit both `id-token: write` and `NPM_CONFIG_PROVENANCE` until the repo is public. Re-enable them only in the same change that makes the source repository public.

## How it works

1. **Add a changeset** while you work — describe _what changed_ and _which packages_ are affected and at what semver bump level (major / minor / patch).
2. **Open and merge the feature PR to `main`** — feature branches and PR CI do not publish packages.
3. **Let the `Release` workflow run after `main` CI succeeds** — `.github/workflows/release.yml` is triggered by a successful `CI` workflow run on `main`.
4. **Changesets decides whether to version or publish**:
   - If pending `.changeset/*.md` files are on `main`, `changesets/action` opens a "Version Packages" PR.
   - If package versions and changelogs are already bumped and no pending changesets remain, `changesets/action` runs `pnpm release` and publishes unpublished versions to npm using the repo `NPM_TOKEN` secret.

Do not block a normal CI release on local `npm whoami`. Local npm auth is only required for the emergency manual path.

## Day-to-day: adding a changeset

```bash
# From the repo root, on your feature branch:
pnpm changeset
```

The CLI will ask:

- Which packages are changed? (use space to select, enter to confirm)
- Is it a `major`, `minor`, or `patch` bump?
- Write a one-line summary of the change.

A markdown file is created under `.changeset/`. Commit it alongside your code changes.

## Release flow in detail

```
feature branch  →  PR + changeset file merged to main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action opens "Version Packages" PR
         (bumps package.json versions + writes CHANGELOGs)
                        ↓
         Team reviews & merges "Version Packages" PR
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes to npm (provenance disabled while repo is private)
         GitHub Release tags are created automatically
```

There is also a valid fast path when the feature branch intentionally includes the version commit:

```
feature branch  →  PR with code + package.json/CHANGELOG version bumps merged to main
                        ↓
              GitHub Actions: CI succeeds on main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes the already-versioned unpublished packages
         (provenance disabled while repo is private)
```

Use only one path per release:

- **Normal path:** commit `.changeset/*.md`, merge to `main`, then merge the generated "Version Packages" PR.
- **Pre-versioned path:** run `pnpm version-packages` on the feature branch, commit package/changelog updates, and merge that PR directly to `main`; CI publishes after merge.

Do not keep both a pending changeset file and a committed version bump for the same change.

## Packages published

All packages are published to the `@gullabs` scope and already have `publishConfig.access = "public"`:

| Package               | npm                                               |
| --------------------- | ------------------------------------------------- |
| `@gullabs/any-llm`    | https://www.npmjs.com/package/@gullabs/any-llm    |
| `@gullabs/core`       | https://www.npmjs.com/package/@gullabs/core       |
| `@gullabs/google`     | https://www.npmjs.com/package/@gullabs/google     |
| `@gullabs/drizzle`    | https://www.npmjs.com/package/@gullabs/drizzle    |
| `@gullabs/quota`      | https://www.npmjs.com/package/@gullabs/quota      |
| `@gullabs/testing`    | https://www.npmjs.com/package/@gullabs/testing    |
| `@gullabs/claude-cli` | https://www.npmjs.com/package/@gullabs/claude-cli |
| `@gullabs/codex-cli`  | https://www.npmjs.com/package/@gullabs/codex-cli  |

## Required repository secret

One secret must be set in the GitHub repository settings before the first publish:

| Secret      | Description                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | npm automation token with publish access to the `@gullabs` scope. Generate at https://www.npmjs.com/settings → Access Tokens → Generate New Token → Automation. |

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

## Manual release (emergency)

If you need to publish outside of CI:

```bash
# Build all packages
pnpm -r build

# Bump versions from pending changesets
pnpm version-packages

# Publish (requires npm login on the current machine)
changeset publish
```

## Snapshot / pre-releases

For a pre-release (e.g. alpha):

```bash
pnpm changeset pre enter alpha
# ... commit changesets as normal ...
pnpm changeset pre exit   # when ready to graduate to stable
```
