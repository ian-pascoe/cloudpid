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

The alchemy stack is `infra/alchemy.run.ts`; its scripts run alchemy from `infra/`: `pnpm --filter @cloudpid/infra run dev` serves workerd on `http://localhost:1337`, and `pnpm --filter @cloudpid/infra run deploy --stage dev_$USER` deploys to Cloudflare (use `run`, since bare `pnpm deploy` is pnpm's built-in, and no `--`, which pnpm forwards literally; add `--dry-run` to only plan). It authenticates with the local alchemy profile (`alchemy profile edit --add Cloudflare`) and keeps state with `Cloudflare.state()`. A Worker is declared in its own app with `main: import.meta.url`; the stack imports and `yield*`s it. That makes it an Effect Worker, whose generated entry exports only `default` and its Effect DO classes. A Worker that must export anything else (a plain DO class, a `WorkerEntrypoint` such as `@cloudflare/computer`'s `WorkspaceServiceProxy`) is a plain async Worker instead: its entry module (`main: new URL("./worker.ts", import.meta.url).href`) holds no alchemy code, and a separate resource file declares it, as `apps/server/src/workspace/` does for `Workspaces`.

The codemode sandbox is a plain Worker too (`apps/codemode-sandbox`, resource `CodemodeSandboxes`): it exports pi-codemode's `CodemodeSandboxDurableObject` as `CodemodeSandbox`, has `workersDev: false` and no routes (nothing reaches it but the Session DOs' `CODEMODE_SANDBOX` binding, declared in `apps/server/src/worker.ts` with its `scriptName` Output so it deploys first), and bundles QuickJS's `.wasm` as a compiled module through alchemy's own rolldown rule. In workerd tests that import it, give miniflare `modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }]`.

**Container.** The Workspace DO's Container (`apps/sandbox-image/image/Dockerfile`, declared in `apps/server/src/workspace/resource.ts`) is a Docker image that every deploy and `alchemy dev` builds, so both need a running Docker with the `buildx` plugin (alchemy fails with `DockerBuildFailed` without it; with colima, `brew install docker-buildx` and point `cliPluginsExtraDirs` in `~/.docker/config.json` at `$(brew --prefix)/lib/docker/cli-plugins`). The image is `linux/amd64`, so on Apple silicon start colima with `--vz-rosetta`. `alchemy dev` runs the Container in local Docker without `/dev/fuse`, where computerd falls back to its userspace shim; the real FUSE mount exists only deployed. alchemy is patched (`patches/alchemy@2.0.0-beta.83.patch`) so that adding a Container to a Durable Object class that is already deployed works: alchemy creates the class's container application before the Worker upload that Container-enables the namespace, and Cloudflare rejects it (`Durable Object namespace is not Container-enabled`); the patch retries the create until that upload lands. When upgrading alchemy, `pnpm install` fails on the stale patch: check whether upstream fixed the ordering before porting it.

**Container Toolchains and git.** On each Container start the Workspace DO runs a bootstrap before the first command (`mise install` from the Workspace's `mise.lock`, git's identity and credentials: `docs/spec.md` → _Container and Toolchains_; code in `apps/sandbox-image/src/toolchains.ts` and `apps/server/src/workspace/toolchains.ts`). `CLOUDPID_GITHUB_TOKEN` is a required deploy-time secret (`Config.Redacted`, bound to the Workspaces Worker) that commands get as `GH_TOKEN`/`GITHUB_TOKEN`; `CLOUDPID_GIT_NAME` and `CLOUDPID_GIT_EMAIL` are optional and set the identity of the agent's commits (default `cloudpid` and the owner's email). Under `alchemy dev` the Container has no FUSE, so the stack sets `CONTAINER_FUSE=false` and the `ignore` list is not applied (computerd's shim exits on one). To exercise a Container end to end, deploy your own stage and give the Workspaces Worker a temporary route that runs a command through `ComputerExecutionEnv.onBackend("container")`; `kill 1` in the Container restarts it, and an old Workspace DO instance keeps its old code until it is evicted, so use a new Workspace name after a redeploy.

**Model proxy secrets.** Every deploy and `alchemy dev` needs `MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY` and `CLOUDPID_GITHUB_TOKEN` in the environment: the Session DO and the Workspaces Worker read them with `Config.Redacted`, which binds them to the Worker as secrets (see _CI_ for where they live). `alchemy dev --stage dev_$USER` replaces that stage's deployed Worker with the local one and deletes its Access app; redeploy the stage afterwards.

**Secrets key.** Every deploy and `alchemy dev` also needs `SECRETS_ENCRYPTION_KEY` (at least 32 characters; `openssl rand -base64 32`), the master key the Session DO encrypts the owner's Secrets under, read and bound the same way. CI takes it from the `production` environment's secrets (set by hand: `openssl rand -base64 32 | gh secret set SECRETS_ENCRYPTION_KEY --env production`); locally, keep it in `~/.config/cloudpid/dev.env`. Changing it drops the Secrets held at that moment (they expire within 15 minutes anyway; the agent asks again); messages already scrubbed of a value stay scrubbed, as their index does not depend on the key.

**Web app.** `apps/web` (Vite, React 19, Tailwind v4) is built by the Server's deploy (an alchemy `Command.Build` in `apps/server/src/worker.ts`, which runs `pnpm run build` in `apps/web`) and served by the main Worker as static assets: files are answered by the asset layer, a navigation to `/sessions/:id` gets `index.html`, and `/rpc` and the Session socket reach the Worker. For UI work, run `pnpm --filter @cloudpid/web run dev` next to `alchemy dev`: Vite proxies `/rpc` and the Session socket to `localhost:1337`.
**Search keys.** `EXA_API_KEY` and `PARALLEL_API_KEY` are optional deploy-time secrets for `web_search`: the web extension reads them with `Config.Redacted` (`WebConfigLive`), so a key set in the deploying environment is bound to the Worker as a secret. With neither set, `web_search` answers that it is not configured (`web_fetch` needs no key). CI takes both from the `production` environment's secrets; locally, keep them in `~/.config/cloudpid/dev.env`. `WEB_TOOLS_LIVE=1 pnpm --filter @cloudpid/extensions exec vitest run src/web/live.test.ts` checks the tools against the real network and providers.

**Stages and Access.** `apps/server/src/deployment.ts` decides per stage where the Worker is served and who may reach it: `prod` is served on `https://pi.ianpascoe.dev` (workers.dev off), every other stage on `workers.dev`, and all of them sit behind an Access application that allows only the owner's email. The Access team domain is `spirit-led-software`. `alchemy dev` runs locally and has no Access.

**CI.** `.github/workflows/ci.yml` runs `pnpm check` on every PR and push to `main` and, on push to `main`, deploys stage `prod` in the GitHub environment `production` (deployments from `main` only). Alchemy records the Worker's absolute `main` path in state, but a deploy from another checkout path plans no change, so CI and local deploys can alternate. CI's credentials are code: `infra/github.ts` (stack `cloudpid-github`, stage `ci`) creates the scoped API token `cloudpid-ci-deploy` (Workers Scripts, Workers Containers, Secrets Store for alchemy's state store, Access apps and policies, and zone/DNS/routes on `ianpascoe.dev`) and writes `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID`, `MODEL_PROXY_URL` (variables) into `production`. Deploy it from a workstation with the `admin` alchemy profile (the Cloudflare Global API Key and `gh`): `pnpm --filter @cloudpid/infra run ci:setup`; rerun it to change permissions. To rotate the token, run `pnpm --filter @cloudpid/infra exec alchemy destroy --config github.ts --stage ci --profile admin`, then `ci:setup` again: the `production` environment is retained on destroy, so the hand-set `MODEL_PROXY_API_KEY` and the `main` branch policy survive, and only the token, its secret and the variables are replaced. Set `MODEL_PROXY_API_KEY` by hand (the stack does not manage it): a Commissary API key for `https://api.ai.ianpascoe.dev`, which is outside Access, so a service token cannot authenticate to it: `gh secret set MODEL_PROXY_API_KEY --env production`. `CLOUDPID_GITHUB_TOKEN` is set by hand the same way (a GitHub token that can clone, push and open PRs on the repos the agent works on) and the deploy step passes it on. For local deploys, keep `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY` in `~/.config/cloudpid/dev.env` (outside the repo) and load them with `set -a; . ~/.config/cloudpid/dev.env; set +a`. `.env*` files are gitignored.

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
