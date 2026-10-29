# AGENTS.md

## Design

- **Architecture**: before designing or changing architecture, packages, Durable Objects, tools, or the client protocol, read `docs/architecture/overview.md` and the area's document it lists. Code cites its section in a header comment (`docs/architecture/container.md` → Snapshots); when a change alters what that section says, update the section in the same change. Terms follow `GLOSSARY.md`; hard-to-reverse choices are ADRs in `docs/adr/`.
- **Tool names**: every model-facing tool name is snake_case (`browser_handoff`, `subagent_wait`); wrap and rename library tools that are not.
- **Prompt cache**: a system prompt section is read once per Context Window and then shown as it was; anything added later goes at the end of the context, since a changed section breaks the provider's prompt cache.

## Workspace

Bun installs dependencies and runs scripts (`bunfig.toml`; the version is `packageManager`'s and `mise.toml`'s); Vitest and Vite still run on Node (alchemy hands itself to Bun), and typecheck is `effect-tsgo tsrs`, the Effect-patched native checker ([ADR-0028](docs/adr/0028-bun-for-installs-and-scripts-and-tsrs-for-typecheck.md)). Root `typecheck`, `lint`, `test`, and `build` scripts run through Turborepo (`turbo.json`); `bun run check` runs all but `build`, then `format:check` (oxfmt runs once at the root). Run one package's script with `bun --cwd packages/protocol run test`. `bun install` skips the reference-repository clones when `CI` or `SKIP_REFERENCE_REPOS` is set.

**In the cloudpid harness, run focused checks only.** If you are an agent in a cloudpid Workspace (the repo is under `/workspace`, next to `/workspace/.cloudpid`), do not run `bun run check`, a root `test`, or a whole package's test suite, and do not have your sub-agents run them. CI runs the full suite on every push. Run only:

- the typecheck of the packages you touched;
- `oxlint` and `oxfmt` on the files you changed;
- the single test files that cover your change (`bun --cwd <package dir> vitest run <file>`; for workerd tests, add `--project workerd`).

Every workspace package (`apps/*`, `infra`, `packages/*`) is named `@cloudpid/<dir>` and has the same shape; copy the config files from a sibling package rather than editing the shared bases:

- **Just-in-time**: `exports` point at `src/*.ts`, with no build step. Relative imports end in `.ts`, so every file also runs under plain Node type stripping.
- **Tests** are `src/*.test.ts` (the web app's component tests may be `src/*.test.tsx`, rendered with `react-dom/server`). Tests that need workerd (Durable Object storage, alarms, eviction) are `src/**/*.workerd.test.ts`, run by the package's `workerd` Vitest project.
- **Config**: `package.json` has `typecheck` (`effect-tsgo tsrs`), `lint` (`oxlint`) and `test` (`vitest run`) scripts and a `workspace:*` devDependency on `@cloudpid/config`; `tsconfig.json` extends `@cloudpid/config/tsconfig/base.json`, `vitest.config.ts` re-exports `@cloudpid/config/vitest`, `.oxlintrc.json` extends the root config.
- **Dependencies**: tooling (`typescript`, `vitest`, `oxlint`, `oxfmt`, `turbo`) is installed once at the root. Runtime dependencies go in the package that imports them (`bun --cwd <package dir> add …`); the ones still at the root (`pi-*`, `@cloudflare/*`) move to their first consumer when a change starts using them.

## Development guides

- **Infra** (`docs/development/infra.md`): read before running `alchemy dev` or a deploy, adding or rotating a deploy-time secret, or changing CI.
- **Workers** (`docs/development/workers.md`): read before adding a Worker, a binding or an entrypoint, writing a workerd test, or changing what the Worker Shell runs.
- **Dependencies** (`docs/development/dependencies.md`): read before upgrading a patched or pinned dependency (`@cloudflare/computer`, `pi-durable`, alchemy, `@cloudflare/vitest-plugin`, isomorphic-git, `@pierre/diffs`), or when `bun install` fails on a patch.

## Reference repositories

`bun install` (its `prepare` script; rerun with `bun run prepare`) materializes these read-only references in `.repos/`. Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                  | Path            | Useful for                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Effect-TS/effect`](https://github.com/Effect-TS/effect)   | `.repos/effect` | Source of the `effect` v4 dependency: `Effect`, `Layer`, `Schema`, services, and error-handling APIs (`packages/effect`), plus `platform`, `ai`, and `vitest` packages and their idiomatic usage patterns                                                        |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) | `.repos/pi`     | Source of the `@earendil-works/pi-ai`, `pi-durable`, and `chord` dependencies (`packages/ai`, `packages/durable`, `packages/chord`): LLM provider API, durable agent storage and turn recovery, and multi-process object hosting that Pi on Cloudflare builds on |

## Git hooks

- **pre-commit**: lint-staged runs `oxlint --fix` and `oxfmt` on staged files.
- **commit-msg**: commitlint requires [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, `chore: …`).
- **pre-push**: `bun run typecheck`, `bun run lint` (both cached by Turborepo), and `bun run format:check`. Tests run in CI.
- **post-merge / post-checkout**: `bun install` when `bun.lock` changed, otherwise a reference-repository sync.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `ian-pascoe/cloudpid` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
