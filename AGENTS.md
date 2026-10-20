# AGENTS.md

## Design

- **Spec**: before designing or changing architecture, packages, Durable Objects, tools, or the client protocol, read `docs/spec.md`; it records the settled design and milestones.
- **Tool names**: every model-facing tool name is snake_case (`browser_handoff`, `subagent_wait`); wrap and rename library tools that are not.

## Workspace

Layout is in `docs/spec.md` → _Repository layout_. Root `typecheck`, `lint`, `test`, and `build` scripts run through Turborepo (`turbo.json`); `pnpm check` runs all but `build`, then `format:check` (oxfmt runs once at the root). Run one package with `pnpm --filter @cloudpid/protocol test`.

Every workspace package (`apps/*`, `infra`, `packages/*`) is named `@cloudpid/<dir>` and follows the same shape:

- **Just-in-time**: `exports` point at `src/*.ts`; there is no build step to run before dependents see a change. Add the package's own tests as `src/*.test.ts`. Tests that need workerd (Durable Object storage, alarms, eviction) are `src/**/*.workerd.test.ts`, run by the package's `workerd` Vitest project through `@cloudflare/vitest-plugin` (see `apps/server/vitest.config.ts`): `pnpm exec vitest run --project workerd <file>`.
- **`package.json`** has `typecheck` (`tsc`), `lint` (`oxlint`), and `test` (`vitest run`) scripts, and a `workspace:*` devDependency on `@cloudpid/config`.
- **`tsconfig.json`** extends `@cloudpid/config/tsconfig/base.json`; **`vitest.config.ts`** re-exports `@cloudpid/config/vitest`; **`.oxlintrc.json`** extends the root config. Copy these from a sibling package instead of editing the shared bases per package.
- Tooling (`typescript`, `vitest`, `oxlint`, `oxfmt`, `turbo`) is installed once at the root; packages do not list it.
- Runtime dependencies go in the package that imports them (`pnpm --filter @cloudpid/<pkg> add …`); the ones still at the root (`pi-*`, `@cloudflare/*`) move to their first consumer when a ticket starts using them.
- Relative imports end in `.ts` (`allowImportingTsExtensions` is on in the shared tsconfig), so every file also runs under plain Node type stripping.
- Effect's `http` modules are unstable but allowed through `allowedUnstableApis` in the shared tsconfig; add other unstable subtrees (`effect/rpc`, …) there when a ticket adopts them.
- `skills/` is bundled skill content, not a package.

`pnpm install` skips the reference-repository clones when `CI` or `SKIP_REFERENCE_REPOS` is set; the `effect-tsgo` patch still runs.

## Infra

The alchemy stack is `infra/alchemy.run.ts`; its scripts run alchemy from `infra/`: `pnpm --filter @cloudpid/infra run dev` serves workerd on `http://localhost:1337`, and `pnpm --filter @cloudpid/infra run deploy --stage dev_$USER` deploys to Cloudflare (use `run`, since bare `pnpm deploy` is pnpm's built-in, and no `--`, which pnpm forwards literally; add `--dry-run` to only plan). It authenticates with the local alchemy profile (`alchemy profile edit --add Cloudflare`) and keeps state with `Cloudflare.state()`. A Worker is declared in its own app with `main: import.meta.url`; the stack imports and `yield*`s it.

**Model proxy secrets.** Every deploy and `alchemy dev` needs `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY` in the environment: the Session DO reads them with `Config.Redacted`, which binds them to the Worker as secrets (see _CI_ for where they live). `alchemy dev --stage dev_$USER` replaces that stage's deployed Worker with the local one and deletes its Access app; redeploy the stage afterwards.

**Stages and Access.** `apps/server/src/deployment.ts` decides per stage where the Worker is served and who may reach it: `prod` is served on `https://pi.ianpascoe.dev` (workers.dev off), every other stage on `workers.dev`, and all of them sit behind an Access application that allows only the owner's email. The Access team domain is `spirit-led-software`. `alchemy dev` runs locally and has no Access.

**CI.** `.github/workflows/ci.yml` runs `pnpm check` on every PR and push to `main` and, on push to `main`, deploys stage `prod` in the GitHub environment `production` (deployments from `main` only). Alchemy records the Worker's absolute `main` path in state, but a deploy from another checkout path plans no change, so CI and local deploys can alternate. CI's credentials are code: `infra/github.ts` (stack `cloudpid-github`, stage `ci`) creates the scoped API token `cloudpid-ci-deploy` (Workers Scripts, Secrets Store for alchemy's state store, Access apps and policies, and zone/DNS/routes on `ianpascoe.dev`) and writes `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID`, `MODEL_PROXY_URL` (variables) into `production`. Deploy it from a workstation with the `admin` alchemy profile (the Cloudflare Global API Key and `gh`): `pnpm --filter @cloudpid/infra run ci:setup`; rerun it to change permissions. To rotate the token, run `pnpm --filter @cloudpid/infra exec alchemy destroy --config github.ts --stage ci --profile admin`, then `ci:setup` again: the `production` environment is retained on destroy, so the hand-set `MODEL_PROXY_API_KEY` and the `main` branch policy survive, and only the token, its secret and the variables are replaced. Set `MODEL_PROXY_API_KEY` by hand (the stack does not manage it): a Commissary API key for `https://api.ai.ianpascoe.dev`, which is outside Access, so a service token cannot authenticate to it: `gh secret set MODEL_PROXY_API_KEY --env production`. For local deploys, keep `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY` in `~/.config/cloudpid/dev.env` (outside the repo) and load them with `set -a; . ~/.config/cloudpid/dev.env; set +a`. `.env*` files are gitignored.

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
