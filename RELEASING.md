# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing to npm. npm provenance attestation is currently disabled (see note below) because it requires a public source repo; it will be re-enabled once this repo goes public.

## How it works

1. **Add a changeset** while you work — describe _what changed_ and _which packages_ are affected and at what semver bump level (major / minor / patch).
2. **Merge to `main`** — the `Release` GitHub Actions workflow detects pending changesets and opens a "Version Packages" PR that bumps versions and updates CHANGELOG files.
3. **Merge the "Version Packages" PR** — the same workflow publishes all bumped packages to npm using the `NPM_TOKEN` secret. Provenance attestation is not currently enabled (see note below).

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
         changesets/action publishes to npm (provenance disabled — see note below)
         GitHub Release tags are created automatically
```

**Note on provenance:** npm rejects provenance attestation (`E422`) for packages built from a
private source repo. The release workflow (`.github/workflows/release.yml`) currently omits
`id-token: write` and `NPM_CONFIG_PROVENANCE`, publishing with the `NPM_TOKEN` secret only.
Re-enable both once this repo goes public.

## Packages published

All packages are published to the `@gullabs` scope and already have `publishConfig.access = "public"`:

| Package            | npm                                            |
| ------------------ | ---------------------------------------------- |
| `@gullabs/any-llm` | https://www.npmjs.com/package/@gullabs/any-llm |
| `@gullabs/core`    | https://www.npmjs.com/package/@gullabs/core    |
| `@gullabs/google`  | https://www.npmjs.com/package/@gullabs/google  |
| `@gullabs/drizzle` | https://www.npmjs.com/package/@gullabs/drizzle |
| `@gullabs/testing` | https://www.npmjs.com/package/@gullabs/testing |

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

# Publish (requires npm login)
changeset publish
```

## Snapshot / pre-releases

For a pre-release (e.g. alpha):

```bash
pnpm changeset pre enter alpha
# ... commit changesets as normal ...
pnpm changeset pre exit   # when ready to graduate to stable
```
