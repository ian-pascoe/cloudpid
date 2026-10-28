# Infra: running, deploying and CI

How to run the stack locally, deploy it, and keep its secrets and CI credentials. The design behind it is in [`../architecture/operations.md`](../architecture/operations.md).

## The stack

The alchemy stack is `infra/alchemy.run.ts`; its scripts run alchemy from `infra/`:

- `pnpm --filter @cloudpid/infra run dev` serves workerd on `http://localhost:1337`.
- `pnpm --filter @cloudpid/infra run deploy --stage dev_$USER` deploys to Cloudflare. Use `run` (bare `pnpm deploy` is pnpm's built-in) and no `--` (pnpm forwards it literally); add `--dry-run` to only plan.

It authenticates with the local alchemy profile (`alchemy profile edit --add Cloudflare`) and keeps state with `Cloudflare.state()`. Alchemy records the Worker's absolute `main` path in state, but a deploy from another checkout path plans no change, so CI and local deploys can alternate.

`alchemy dev --stage dev_$USER` replaces that stage's deployed Worker with the local one and deletes its Access app; redeploy the stage afterwards.

## Stages and Access

`apps/server/src/deployment.ts` decides per stage where the Worker is served and who may reach it: `prod` is served on `https://pi.ianpascoe.dev` (workers.dev off), every other stage on `workers.dev`, and all of them sit behind an Access application that allows only the owner's email. The Access team domain is `spirit-led-software`. `alchemy dev` runs locally and has no Access.

## Docker for the Container image

Every deploy and `alchemy dev` builds the Container's image (`apps/sandbox-image/image/Dockerfile`), so both need a running Docker with the `buildx` plugin; without it alchemy fails with `DockerBuildFailed`. With colima, `brew install docker-buildx` and point `cliPluginsExtraDirs` in `~/.docker/config.json` at `$(brew --prefix)/lib/docker/cli-plugins`. The image is `linux/amd64`, so on Apple silicon start colima with `--vz-rosetta`.

`alchemy dev` runs the Container in local Docker without `/dev/fuse`, where computerd falls back to its userspace shim: the real FUSE mount exists only deployed. The stack sets `CONTAINER_FUSE=false` there, and the `ignore` list is not applied (computerd's shim exits on one). Snapshots are off under `alchemy dev` too.

## Web UI development

Run `pnpm --filter @cloudpid/web run dev` next to `alchemy dev`: Vite proxies `/rpc` and the Session socket to `localhost:1337`. On a cloudpid Container, start it with `VITE_POLL=1`: `/workspace` is a FUSE mount whose changes made through the Workspace raise no inotify events, so without polling Vite keeps serving a file's old version.

## Secrets and variables

Every deploy, `alchemy dev` and a preview's destroy (which evaluates the stack) read these from the environment. Workers read them with `Config.Redacted`, which binds them to the Worker as secrets. Locally, keep them in `~/.config/cloudpid/dev.env` (outside the repo; `.env*` files are gitignored) and load them with `set -a; . ~/.config/cloudpid/dev.env; set +a`.

| Name                                                        | Required | What it is                                                                                                                                                                                         |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_PROXY_URL`, `MODEL_PROXY_API_KEY`                    | yes      | The model proxy and a Commissary API key for `https://api.ai.ianpascoe.dev`, which is outside Access, so a service token cannot authenticate to it. Read by the Session DO.                        |
| `CLOUDPID_GITHUB_APP_ID`, `CLOUDPID_GITHUB_APP_PRIVATE_KEY` | yes      | cloudpid's GitHub App (ADR-0025), bound to the Workspaces Worker and the main Worker. `apps/server/src/github/config.ts` fails on a key that is not an RSA PEM. The key never reaches a Container. |
| `SECRETS_ENCRYPTION_KEY`                                    | yes      | The master key the owner's Secrets are encrypted under (Session, Registry and Workspace DOs); at least 32 characters.                                                                              |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`    | yes      | The Web Push identity (RFC 8292), read by the Registry DO (`apps/server/src/push/config.ts`).                                                                                                      |
| `CLOUDPID_GIT_NAME`, `CLOUDPID_GIT_EMAIL`                   | no       | The identity of the agent's commits (default `cloudpid` and the owner's email).                                                                                                                    |
| `EXA_API_KEY`, `PARALLEL_API_KEY`                           | no       | `web_search`'s providers (`WebConfigLive`); with neither, `web_search` answers that it is not configured (`web_fetch` needs no key).                                                               |
| `CLOUDPID_ANALYTICS_TOKEN`                                  | no       | An API token with Account Analytics Read, for the Container cost in the Session header; unset or empty, the cost is estimated.                                                                     |

### Making and rotating them

- **`SECRETS_ENCRYPTION_KEY`**: `openssl rand -base64 32`. Changing it drops the Secrets held at that moment (they expire within 15 minutes anyway; the agent asks again); messages already scrubbed of a value stay scrubbed. It also leaves every Secret kept for an Environment unopenable (the Registry logs each by name and leaves it out, so the owner sets it again), and each Workspace takes no snapshot and makes no Build until a readying hands its copy again. A malformed key fails only what needs it: Environments with no kept Secret work as before, and those with some get none in their Workspaces' set-up (`secretsUnavailable`), no new Build, and Secrets calls that fail saying why.
- **VAPID pair**: the public key is a base64url uncompressed P-256 point, the private key a base64url 32-byte scalar, the subject a `mailto:` URL. This prints the public key, then the private one:

  ```sh
  node -e "const {publicKey,privateKey}=require('node:crypto').generateKeyPairSync('ec',{namedCurve:'P-256'});const j=privateKey.export({format:'jwk'});console.log(Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64url'),j.d)"
  ```

  The layer checks the three at startup (subject, key lengths, and that the two are a pair), so a malformed secret fails a deploy or `alchemy dev` at once. Rotating the pair strands every device's subscription (a push service refuses a subscription made with another key, so each push is logged as a failure); a device replaces its own the next time the app is opened, if it still allows notifications.

- **GitHub App**: `pnpm --filter @cloudpid/infra run github-app:setup` (`infra/github-app-setup.ts`) creates the app through GitHub's manifest flow (one confirmation in the browser), writes the ID and key into `production`, `preview` and `~/.config/cloudpid/dev.env` with `gh secret set`, sends the owner to install the app (All repositories) on their account and each organization, and checks each installation by minting a GitHub token. GitHub shows the key only then: to rotate or replace it, generate one in the app's settings and set it by hand in both environments.
- **`CLOUDPID_ANALYTICS_TOKEN`**: CI's tokens are made by `infra/github.ts` (below); for local deploys, mint one in the dashboard.

## CI

`.github/workflows/ci.yml` runs what `pnpm check` runs on every PR and push to `main`, split over parallel jobs (`checks`: typecheck, lint, format and the web build; the tests of every package but the server; the server's tests in three `vitest --shard`s), and a `Check` job that passes only when all of them did, the status the `main` ruleset requires.

- **Caches:** `checks` and `preview` set up through `.github/actions/setup`: pnpm, Node, the pnpm store cached by lockfile with a fallback to the newest store and pruned before it is saved, then the install. `preview`, which holds deploy credentials, only reads the cache, and the `prod` deploy uses none. Each part of `checks` also caches turbo's `.turbo/cache` under its own key, pruned to the entries its tasks used.
- **`prod`:** on push to `main`, CI deploys stage `prod` in the GitHub environment `production` (deployments from `main` only).
- **Previews:** each pull request from a branch of this repository (not a fork, which gets no secrets) gets stage `pr-<number>` once `check` passes, deployed by the `preview` job in the GitHub environment `preview` (any branch). `infra/alchemy.run.ts` posts its URL as one PR comment (`GitHub.Comment`, with the workflow's `GITHUB_TOKEN`) that each push updates; closing or merging the PR runs `alchemy destroy --stage pr-<number>` from the PR's head commit. Deploys and the destroy of one PR never overlap or cancel midway (job concurrency `preview-<number>`). A preview whose secret is missing fails its deploy and its destroy.

### CI credentials

They are code: `infra/github.ts` (stack `cloudpid-github`, stage `ci`) creates the scoped API token `cloudpid-ci-deploy` (Workers Scripts, Workers Containers, Secrets Store for alchemy's state store, Access apps and policies, and zone/DNS/routes on `ianpascoe.dev`) and writes `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID`, `MODEL_PROXY_URL` (variables) into `production`. It also creates the `preview` environment and its token `cloudpid-ci-preview` (the same account permissions, no zone ones) with the same secret and variables, and one analytics token per environment (`cloudpid-container-analytics`, `cloudpid-container-analytics-preview`) written as `CLOUDPID_ANALYTICS_TOKEN`.

Any branch can use `preview`'s token, and Workers Scripts Write covers every Worker on the account, `prod`'s included, so whoever can push a branch can reach `prod`.

- **Deploy or change permissions:** from a workstation with the `admin` alchemy profile (the Cloudflare Global API Key and `gh`): `pnpm --filter @cloudpid/infra run ci:setup`. Rerun it after pulling a change to `infra/github.ts`.
- **Rotate the token:** `pnpm --filter @cloudpid/infra exec alchemy destroy --config github.ts --stage ci --profile admin`, then `ci:setup` again. The `production` environment is retained on destroy, so the hand-set secrets and the `main` branch policy survive; only the token, its secret and the variables are replaced.
- **Hand-set secrets:** the stack does not manage `MODEL_PROXY_API_KEY`, `SECRETS_ENCRYPTION_KEY`, the VAPID three, `EXA_API_KEY` or `PARALLEL_API_KEY`. Set each in both environments with `gh secret set <NAME> --env production` and `--env preview`, giving `preview` an encryption key and VAPID pair of its own (the dev ones from `~/.config/cloudpid/dev.env` will do), since the previews share them.

Workers Scripts Write also covers what rides on the script upload: observability (`WORKER_OBSERVABILITY`) and the Images binding need no extra permission.

## Checking a deployed stage

- **A Container end to end:** deploy your own stage and give the Workspaces Worker a temporary `workersDev` route that runs a command through `ComputerExecutionEnv.onBackend("container")` (and can destroy the Container, to check snapshots: a restore and the idle stop only exist deployed). `kill 1` in the Container restarts it (PID 1 is the image's supervisor, which stops computerd and sends no exit report); `pkill -KILL -x computerd` makes it log one (`workspace.container.output` in the Workspaces Worker's logs). An old Workspace DO instance keeps its old code until it is evicted, so start a Session in a new Workspace after a redeploy.
- **Traces:** in the dashboard (Workers → Observability → Traces) or through the telemetry query API (`POST /accounts/{id}/workers/observability/telemetry/query`, `view: "traces"`), whose `traces` view lists summaries only: span names and attributes are in the dashboard. To see what a span is made of while debugging, log from inside it: a log line carries the trace and span ID it ran under.
- **Web tools:** `WEB_TOOLS_LIVE=1 pnpm --filter @cloudpid/extensions exec vitest run src/web/live.test.ts` checks `web_search` and `web_fetch` against the real network and providers.
- **Images quota:** every account is on the Images Free plan by default: 5,000 unique transformations a month, after which the binding answers error 9422 and `read` leaves the image out with a note.
