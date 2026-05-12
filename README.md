# ginnung-pipelines

Concrete consumer pipelines for the Ginnung cognitive runtime. Each package here is a "dogfood" pipeline that depends on Lattice (L0 policy rules) and Sonder (audit chain) and produces a publishable artifact alongside its `sonderevent.ndjson` log.

The first pipeline is the **writing pipeline** (`packages/writing-pipeline`) — takes a one-line idea and produces a publishable essay, instrumented end-to-end with SonderEvents. Its central design constraint is voice fidelity: output must match the builder's voice and actively suppress AI-slop patterns.

See the full spec: `Dev/ops/specs/ginnung-dogfood-writing-pipeline.md`.

## Workspace

```
packages/
  writing-pipeline/   — one-line idea → essay + sonderevent.ndjson
```

## Toolchain

- pnpm 10.4.0 (pinned; `pnpm@8` will silently downgrade the lockfile — use the standalone `pnpm@10.x` binary)
- Node 20 / 22 / 24 (CI matrix)
- TypeScript 5.x, ES2022 + NodeNext modules
- vitest for tests, tsup for build

## Scripts

```
pnpm install           # install workspace deps
pnpm build             # build all packages
pnpm test              # run all tests
pnpm typecheck         # typecheck all packages
```
