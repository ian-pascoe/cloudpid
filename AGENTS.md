# AGENTS.md

## Design

- **Architecture**: before designing or changing architecture, packages, Durable Objects, tools, or the client protocol, read `docs/architecture/overview.md` and the area's document it lists. Code cites its section in a header comment (`docs/architecture/container.md` → Snapshots); when a change alters what that section says, update the section in the same change. Terms follow `GLOSSARY.md`; hard-to-reverse choices are ADRs in `docs/adr/`.
- **Tool names**: every model-facing tool name is snake_case (`browser_handoff`, `subagent_wait`); wrap and rename library tools that are not. MCP tools keep `mcp__<server>__<tool>` (ADR-0030).
- **Prompt cache**: a system prompt section is read once per Context Window and then shown as it was; anything added later goes at the end of the context, since a changed section breaks the provider's prompt cache.

## Workspace

pnpm installs dependencies (`pnpm install`, configured in `pnpm-workspace.yaml`; the version is `packageManager`'s and `mise.toml`'s), and Vite+ (`vite-plus`, whose CLI is `vp`) formats, lints and runs the tasks ([ADR-0055](docs/adr/0055-vite-plus-and-pnpm.md)). Typecheck is `effect-tsgo tsrs`, the Effect-patched native checker ([ADR-0028](docs/adr/0028-bun-for-installs-and-scripts-and-tsrs-for-typecheck.md)). Run scripts with `pnpm run` (one package's: `pnpm --filter @cloudpid/<dir> run <script>`) and binaries with `pnpm exec`.

- **Always the project's own `vp`**: `pnpm exec vp …`, or a `pnpm run` script. mise's `npm:vite-plus` is a second copy of the toolchain, whose `vp test` brings its own Vitest, and the workerd projects then fail with `Cannot read properties of undefined (reading 'config')`. The standalone global CLI from vite.plus hands commands to the project's copy.
- **Root scripts**: `pnpm run check` runs `vp check` (format, lint and type-aware lint, once at the root), then every package's `typecheck` and `test` (`vp run -r`). `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, `pnpm run format`, `pnpm run format:check` and `pnpm run build` run one part.
- **Tasks**: each package's `typecheck` and `test` (`vitest run`) are Vite Task tasks, cached. Vite Task tracks the files a task reads, so a change to another package's source reruns the tasks that read it. A test's cache is keyed on the variables `packages/config/src/tasks.ts` names (`CI`, the live tests' and benchmarks' switches, `UPDATE_SNAPSHOT`); other variables reach it without keying the cache. `apps/sandbox-image`'s `test` is uncached: on macOS a cached task runs uutils' coreutils, which its memory-guard tests fail under. Run one package's task with `pnpm exec vp run @cloudpid/protocol#test`, and one test file with `cd <package dir> && pnpm exec vitest run <file>` (for workerd tests, add `--project workerd`).
- **Focused lint and format**: `pnpm exec vp lint <files>` (type-aware rules included) and `pnpm exec vp fmt --check <files>` (`pnpm exec vp fmt <files>` writes).
- `pnpm install` skips the reference-repository clones when `CI` or `SKIP_REFERENCE_REPOS` is set.

**In the cloudpid harness, run focused checks only.** If you are an agent in a cloudpid Workspace (the repo is under `/workspace`, next to `/workspace/.cloudpid`), do not run `pnpm run check`, a whole-repo `vp check`, a root `test`, or a whole package's test suite, and do not have your sub-agents run them. CI runs the full suite on every push. Run only:

- the typecheck of the packages you touched (`pnpm exec vp run @cloudpid/<dir>#typecheck`);
- `pnpm exec vp lint <files>` and `pnpm exec vp fmt --check <files>` on the files you changed;
- the single test files that cover your change (`cd <package dir> && pnpm exec vitest run <file>`; for workerd tests, add `--project workerd`).

Every workspace package (`apps/*`, `infra`, `packages/*`) is named `@cloudpid/<dir>` and has the same shape; copy the config files from a sibling package rather than editing the shared bases:

- **Just-in-time**: `exports` point at `src/*.ts`, with no build step. Relative imports end in `.ts`, so every file also runs under plain Node type stripping. `packages/pi-cloudpid` runs on the owner's machine, loaded from source by `pi install git:github.com/ian-pascoe/cloudpid` (the root `package.json`'s `pi` manifest), and must not import Workers code. That install is npm's production install at the root, so a dependency on a workspace package is a plain version (`"*"`), never `workspace:*`, which npm cannot install (pnpm links them to the workspace's packages: `linkWorkspacePackages: true`), and the root `prepare` (`scripts/prepare.sh`) does nothing without the development tools.
- **Tests** are `src/*.test.ts` (the web app's component tests may be `src/*.test.tsx`, rendered with `react-dom/server`). Tests that need workerd (Durable Object storage, alarms, eviction) are `src/**/*.workerd.test.ts`, run by the package's `workerd` Vitest project.
- **Config**: `package.json` has a `"*"` devDependency on `@cloudpid/config` (never `workspace:*`: see _Just-in-time_); `vite.config.ts` passes `@cloudpid/config/tasks` to `run.tasks` (`typecheck` and `test`), `tsconfig.json` extends `@cloudpid/config/tsconfig/base.json`, and `vitest.config.ts` re-exports `@cloudpid/config/vitest`. Lint and format are configured once, in the root `vite.config.ts`: a package's own lint rules are `lint.overrides` there, by path, never a block in its own `vite.config.ts`.
- **Dependencies**: tooling (`typescript`, `@effect/tsgo`, `vite-plus`, `vitest`) is installed once at the root; `vitest` is also in the packages whose test plugins peer it, and `apps/web` declares `vite-plus` and `vite` (Vite+'s core) for its own `vp build` and its Vite plugins' peer. Runtime dependencies go in the package that imports them (`pnpm --filter @cloudpid/<dir> add …`); the ones still at the root (`pi-*`, `@cloudflare/*`) move to their first consumer when a change starts using them.

## Development guides

- **Infra** (`docs/development/infra.md`): read before running `alchemy dev` or a deploy, adding or rotating a deploy-time secret, or changing CI.
- **Workers** (`docs/development/workers.md`): read before adding a Worker, a binding or an entrypoint, adding an import to `apps/server/src/worker.ts`, writing a workerd test, or changing what the Worker Shell runs.
- **Tests** (`docs/development/testing.md`): read before writing, changing or reviewing a test.
- **Dependencies** (`docs/development/dependencies.md`): read before upgrading a patched or pinned dependency (`@cloudflare/computer`, `pi-durable`, alchemy, `@cloudflare/vitest-plugin`, Vite+ and Vitest, isomorphic-git, `@pierre/diffs`), or when `pnpm install` fails on a patch.

## Reference repositories

`pnpm install` (its `prepare` script; rerun with `pnpm run prepare`) materializes these read-only references in `.repos/`. Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                  | Path            | Useful for                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Effect-TS/effect`](https://github.com/Effect-TS/effect)   | `.repos/effect` | Source of the `effect` v4 dependency: `Effect`, `Layer`, `Schema`, services, and error-handling APIs (`packages/effect`), plus `platform`, `ai`, and `vitest` packages and their idiomatic usage patterns                                                        |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) | `.repos/pi`     | Source of the `@earendil-works/pi-ai`, `pi-durable`, and `chord` dependencies (`packages/ai`, `packages/durable`, `packages/chord`): LLM provider API, durable agent storage and turn recovery, and multi-process object hosting that Pi on Cloudflare builds on |

## Git hooks

Vite+ runs the hooks in `.vite-hooks/`, installed by `prepare` (`vp config`); `VP_GIT_HOOKS=0` disables them.

- **pre-commit**: `vp staged` runs `vp lint --fix` and `vp fmt` on staged files (the root `vite.config.ts`'s `staged`).
- **commit-msg**: commitlint requires [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, `chore: …`).
- **pre-push**: `vp check` (format, lint and type-aware lint) and `vp run -r typecheck` (cached by Vite Task). Tests run in CI.
- **post-merge / post-checkout**: `vp install --frozen-lockfile` when `pnpm-lock.yaml` changed, otherwise a reference-repository sync.

## Agent skills

### Issue tracker

Issues live in Linear (team SPI, project id `c5b4ec54-51b3-4742-88a1-0a75c7c646a8`); GitHub Issues are the public intake and sync one-way into it. Reach Linear through Executor's Linear app, falling back to the `linear` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
