# Contributing

Thanks for your interest. This is a small, opinionated library; see `SPEC.md` for the v1 contract
and `DESIGN.md` for the north-star.

## Dev setup

```bash
pnpm install
pnpm lint           # minimal ESLint flat config across source, tests, examples, and configs
pnpm typecheck      # tsc across the workspace
pnpm test           # vitest (no network — the Gemini SDK is mocked)
pnpm -r build       # tsup: ESM + CJS + d.ts
pnpm quality        # lint + typecheck + test + build (same gate CI runs)
pnpm example        # runnable, network-free end-to-end demo
```

## Principles

- **Tests never hit a real provider** — use the fakes in `@gullabs/testing`.
- **Adapters stay thin**: map request⇄raw SDK only. The engine validates output, computes cost, persists.
- **Cost is frozen at write time** (integer micro-USD + `pricingVersion`); the GROSS/subset token
  convention must hold (`cached ⊆ input`, `thinking ⊆ output`).
- Keep the public surface small and additive; breaking changes follow SemVer.

## PRs

Keep them focused. Include tests. `pnpm quality` must pass.
