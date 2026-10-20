# AGENTS.md

## Design

- **Spec**: before designing or changing architecture, packages, Durable Objects, tools, or the client protocol, read `docs/spec.md`; it records the settled design and milestones.
- **Tool names**: every model-facing tool name is snake_case (`browser_handoff`, `subagent_wait`); wrap and rename library tools that are not.

## Workspace

Layout is in `docs/spec.md` → _Repository layout_. Root `typecheck`, `lint`, `test`, and `build` scripts run through Turborepo (`turbo.json`); `pnpm check` runs all but `build`, then `format:check` (oxfmt runs once at the root). Run one package with `pnpm --filter @cloudpid/protocol test`.

Every workspace package (`apps/*`, `infra`, `packages/*`) is named `@cloudpid/<dir>` and follows the same shape:

- **Just-in-time**: `exports` point at `src/*.ts`; there is no build step to run before dependents see a change. Add the package's own tests as `src/*.test.ts`.
- **`package.json`** has `typecheck` (`tsc`), `lint` (`oxlint`), and `test` (`vitest run`) scripts, and a `workspace:*` devDependency on `@cloudpid/config`.
- **`tsconfig.json`** extends `@cloudpid/config/tsconfig/base.json`; **`vitest.config.ts`** re-exports `@cloudpid/config/vitest`; **`.oxlintrc.json`** extends the root config. Copy these from a sibling package instead of editing the shared bases per package.
- Tooling (`typescript`, `vitest`, `oxlint`, `oxfmt`, `turbo`) is installed once at the root; packages do not list it.
- Runtime dependencies go in the package that imports them (`pnpm --filter @cloudpid/<pkg> add …`); the ones still at the root (`effect`, `alchemy`, `pi-*`, `@cloudflare/*`) move to their first consumer when a ticket starts using them.
- `skills/` is bundled skill content, not a package.

## Infra

The alchemy stack is `infra/alchemy.run.ts`; run alchemy from `infra/` (`pnpm --filter @cloudpid/infra dev` for workerd on `http://localhost:1337`, `deploy -- --stage dev_$USER` for Cloudflare). It authenticates with the local alchemy profile (`alchemy profile edit --add Cloudflare`) and keeps state with `Cloudflare.state()`. A Worker is declared in its own app with `main: import.meta.url`; the stack imports and `yield*`s it. Relative imports in Worker and stack files end in `.ts`. Effect's `http` modules are unstable, so files that use them carry `@effect-diagnostics unstableApiUsage:skip-file`, and Worker files carry `apiStabilityLeak:skip-file`.

`pnpm install` skips the reference-repository clones when `CI` or `SKIP_REFERENCE_REPOS` is set; the `effect-tsgo` patch still runs.

## Reference repositories

`pnpm install` (its `prepare` script; rerun with `pnpm run prepare`) materializes these read-only references in `.repos/`.
Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                  | Path            | Useful for                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Effect-TS/effect`](https://github.com/Effect-TS/effect)   | `.repos/effect` | Source of the `effect` v4 dependency: `Effect`, `Layer`, `Schema`, services, and error-handling APIs (`packages/effect`), plus `platform`, `ai`, and `vitest` packages and their idiomatic usage patterns                                                        |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) | `.repos/pi`     | Source of the `@earendil-works/pi-ai`, `pi-durable`, and `chord` dependencies (`packages/ai`, `packages/durable`, `packages/chord`): LLM provider API, durable agent storage and turn recovery, and multi-process object hosting that Pi on Cloudflare builds on |

## Git hooks

Husky hooks run on every commit and push:

- **pre-commit**: lint-staged runs `oxlint --fix` and `oxfmt` on staged files.
- **commit-msg**: commitlint requires [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, `chore: …`).
- **pre-push**: `pnpm run typecheck`, `pnpm run lint` (both through Turborepo, cached), and `pnpm run format:check`. Tests run in CI; run `pnpm run check` for everything locally.
- **post-merge / post-checkout**: `pnpm install` when `pnpm-lock.yaml` changed, otherwise a reference-repository sync.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `ian-pascoe/cloudpid` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
