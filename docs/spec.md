# cloudpid: Pi on Cloudflare

A personal, always-on coding agent that recreates the local pi harness on Cloudflare. pi-durable runs the agent, `@cloudflare/computer` holds the files and runs commands, alchemy provisions everything, and Effect is the application language.

This spec records the design settled on 2026-10-20. Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the hard-to-reverse choices have ADRs in [`docs/adr/`](adr/).

## Scope

- **Single user**, behind Cloudflare Access. There are no tenants, quotas, or per-user isolation.
- **v1 clients:** an HTTP and WebSocket API and a web UI. A terminal client and GitHub, Slack, or cron triggers come later.
- **Lean on existing packages.** Prefer Earendil (`pi-durable`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-telemetry`) and Cloudflare (`@cloudflare/computer`, `agents/browser`) building blocks over writing our own.

## Architecture

```
Browser (web UI, PWA) ──Access──▶ Main Worker ──RPC/WS──▶ Session DO (per Session)
                                       │                    ├─ pi-durable Harness (SQLite, prefix pi_)
                                       │                    ├─ Browser (agents/browser → Browser Run)
                                       │                    └─ RemoteCodemodeSandbox ─▶ Codemode Sandbox Worker (DO per Session)
                                       ├──────────────▶ Registry DO (singleton)
                                       └──────────────▶ Workspace DO (per Workspace)
                                                            ├─ computer Workspace (SQLite VFS)
                                                            ├─ Worker Shell backend (just-bash, Worker Loader)
                                                            └─ Container backend ─▶ Container (computerd + mise)
```

### Durable Objects

| Object                  | Key                                       | Holds                                                                                                                             |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Session DO**          | UUIDv7                                    | One pi-durable Harness: the root conversation, its subagent conversations, tasks, documents, usage. It is bound to one Workspace. |
| **Workspace DO**        | slug chosen by the user (e.g. `cloudpid`) | One `@cloudflare/computer` Workspace and its container. Several Sessions may share it.                                            |
| **Registry DO**         | singleton                                 | Workspace and Session listings (title, timestamps, status), settings overrides, push subscriptions.                               |
| **Codemode sandbox DO** | Session DO id                             | QuickJS script execution. It lives in a separately deployed Worker so scripts run in another isolate.                             |

The Harness and the Workspace live in separate objects ([ADR-0001](adr/0001-session-and-workspace-durable-objects.md)).

### Session host

The Session DO opens the Harness with `openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" })` and wakes itself from its alarm. It follows the pattern in pi-durable's `test-workers/worker.ts`, not Cloudflare's `PiHarness` ([ADR-0002](adr/0002-own-session-host.md)).

- Use `HarnessOptions.onWake` and `Harness.wake()` to arm the alarm at the earliest sleep, or as a heartbeat while work is active. They are unreleased on pi main as of 2026-10-20. Until they ship, arm a 60 s heartbeat alarm while any task is live.
- Arm the alarm before admitting work. Call `resume()` from the constructor and the alarm.
- Long model streams are bound by the platform's wall-time limits. pi-durable resumes interrupted work.

### Effect boundary

Effect is the language everywhere except pi-durable's own core ([ADR-0003](adr/0003-effect-around-pi-durable.md)).

- Each DO builds its Layers once and keeps a `ManagedRuntime`. Services (`Context.Service`) include `Harness`, `WorkspaceClient`, `Models`, `Settings`, `Secrets`, `Registry`, and `Telemetry`.
- `packages/effect-durable` provides `defineEffectTool` (Effect `Schema` parameters compiled to TypeBox/JSON Schema), `effectHook`, `effectSection`, and `effectTask`. Chord `Context` cancellation becomes fiber interruption, and typed failures become tool error results.
- Harness internals, commits, documents, and task phases stay native. Effect reaches them through thin facades (`Effect.tryPromise`), never a parallel scheduler.

### Models

- Requests go to the existing proxy `api.ai.ianpascoe.dev` with a Commissary API key (`Authorization: Bearer`). The proxy is Commissary's API host, which sits outside Cloudflare Access and rejects service tokens. Model IDs match `~/.pi/agent/models.json`.
- Default `anthropic/claude-opus-5-5` at `high` thinking.
- Roles: `small` haiku-5-5, `medium` sonnet-5-5, `large` opus-5-5, `xlarge` fable-5-1, with the hints from `~/.pi/agent/settings.json`.

### Settings

- A typed Effect `Schema` with defaults in `packages/config`.
- Runtime overrides live in a Registry DO document, editable in the UI.
- They are passed to the Harness as live getters. They cover models, roles, thinking level, compaction, extension options, container size, idle timeout, and spend limit.

## Workspace and execution

### Filesystem and tools

- The workspace root is `/workspace`, with one directory per repo. A Session's `cwd` defaults to its repo directory.
- `ComputerExecutionEnv` (`packages/computer-env`) implements pi-durable's `ExecutionEnv` over the Workspace DO's RPC stub. It covers `listFiles` via `fs.find`, and must pass `registerEnvConformance`.
- `read`, `write`, `edit`, and `bash` are pi-durable's own tools. `ls`, `find`, and `grep` are thin tools over computer's `fs.readdir`, `fs.find`, and `fs.grep`, so they never start the container. computer's `createPiTools` is not used ([ADR-0008](adr/0008-pi-durable-tools-over-computer-tools.md)).
- Skills: the headless-safe skills from `~/.pi/agent/skills` are copied to `skills/` and mounted read-only with `WorkerBundle` at `/workspace/.agents/skills`. Repo-local `.agents/skills` are discovered too. A `skills` prompt section lists them.

### Backends

| Backend      | Runs                                                                    | Use                                                                        |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Worker Shell | just-bash in a Dynamic Worker, with `createGitClient()` providing `git` | Default for text commands: `cat`, `grep`, `sed`, `jq`, `git status`/`diff` |
| Container    | Real Linux through computerd and FUSE at `/workspace`                   | Anything needing a real binary: `npm`, `node`, test runners, `gh`          |

`bash` chooses a backend per call, with an explicit `backend` argument or a heuristic. The Worker Shell cannot run ELF binaries, so those commands always go to the Container.

### Container and Toolchains

[ADR-0004](adr/0004-minimal-container-with-mise-bootstrap.md) covers this design.

- **Image:** `debian:stable-slim` plus `fuse3`, `ca-certificates`, `computerd` (pinned to match `@cloudflare/computer`), and `mise`. Everything else, `git` and `gh` included, is a mise Toolchain. The image must be glibc-based, so no Alpine.
- **Persistence:** `mise.toml` and `mise.lock` live in the workspace and are synced. `MISE_DATA_DIR` and `MISE_CACHE_DIR` sit under `/workspace/.mise`, which is listed in computer's `ignore`. So are `node_modules`, `.venv`, `target/`, and caches, which keeps them container-local and out of DO SQLite.
- **Bootstrap:** on start, run `mise install`, which does nothing when the tools are already present. Snapshot the container disk after a successful install and when the container idles, and restore with `launch.containerSnapshot`.
- **Size and idle:** `standard-2` by default with a 15-minute inactivity stop. Both are per-Workspace settings.
- **Egress:** unrestricted direct egress in v1, logged. A per-Workspace allowlist comes later.

### Concurrency

Sessions on one Workspace share one tree, as local pi sessions share a directory ([ADR-0006](adr/0006-shared-workspace-tree.md)). Subagents share their parent's tree. Git state such as branch and index is shared too.

### Git

- Clone and push with mise-installed `git` and `gh` in the Container.
- Authentication comes from a GitHub token injected into exec env by the Secrets layer.

## Agent capabilities

### Tool naming

Every model-facing tool name is snake_case. A library tool that isn't gets renamed by a wrapper.

### v1

| Capability      | Tools                                                                                                 | Source                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Files and shell | `read`, `write`, `edit`, `bash`, `ls`, `find`, `grep`                                                 | pi-durable tools plus thin computer-backed tools                                                                     |
| Code mode       | `codemode`                                                                                            | `@earendil-works/pi-durable/codemode` with `RemoteCodemodeSandbox` ([ADR-0005](adr/0005-codemode-sandbox-worker.md)) |
| Tool discovery  | `tool_search`                                                                                         | `@earendil-works/pi-durable/tool-search`, deferred tools                                                             |
| Subagents       | `subagent`, `agent_message`, `subagent_wait`, `subagent_status`, `subagent_cancel`, `subagent_delete` | Port of pi-minimal-subagents onto pi-durable                                                                         |
| Context         | `context_notes`, `context_history`, `context_rollover`                                                | Port of pi-context-management                                                                                        |
| Todo            | `todo`                                                                                                | Port of pi-todo, using a conversation document                                                                       |
| Web             | `web_search`, `web_fetch`                                                                             | Port of pi-web-tools, with an SSRF guard                                                                             |
| Secrets         | `secret_ask`, `secret_list`, `secret_forget`                                                          | Port of pi-secret                                                                                                    |
| Browser         | `browser`, `browser_handoff`                                                                          | `agents/browser` on Browser Run                                                                                      |

### Subagents

The tool surface and semantics stay as they are today:

- Canonical IDs such as `root.agent-1`, plus tombstones and a depth cap.
- Model roles.
- `read`/`modify` toolset presets under a capability ceiling.
- `session_context`: `omit`, `inherit`, or `compact`.
- Wait events: `turn`, `message`, `timeout`, and `steered`.

They are rebuilt on pi-durable primitives, following its example 23:

- Children are conversations owned by a background anchor task.
- Answers return through reporter tasks as follow-up messages, deduplicated by `requestId`.
- `subagent_wait` is a durable task using `sleepUntil`.

### Context management

- **Notes** are a conversation document (`defineDoc`, `fork: "current"`).
- **History** reads entries from storage. Lineage scope covers subagent conversations in the same Harness.
- `context_rollover` returns `control: { handoff }`.
- A `CompactionTask` `beforeCompact` hook turns automatic compaction into a prepare-then-rollover turn. The cut keeps tool batches whole.

### Secrets

| Kind        | Holds                                                                                                                                            | Storage and use                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy-time | Commissary API key for the model proxy, 1Password service-account token (v2), VAPID keys. In v1 also the GitHub token and the Exa/Parallel keys. | Read with `Config.Redacted` in `infra/` and bound as Worker secrets                                                                                                                                                                                                                      |
| Runtime     | Values entered through `secret_ask`, which opens a masked form in the UI                                                                         | Encrypted with AES-GCM in the Session DO under a key held as a Worker secret. Referenced by pi-secret's double-brace `secret:NAME` placeholder or `$PI_SECRET_*`. Injected into exec env only at call time. Redacted by `afterTool` and `beforeRequest` hooks. Expires after 15 minutes. |

From v2, secret references may name 1Password items. Credentials then move into a single dedicated vault, and deploy-time secrets shrink to the model proxy key, the 1Password token, and VAPID.

### Browser

[ADR-0007](adr/0007-browser-and-credentials.md) covers this design.

- **Tool:** `agents/browser` `Browser` with `browserRun(env.BROWSER)` in the Session DO, using `Lifecycle.install(this)` for the browser only. `browserTool()` registers the model-facing `browser` tool, which runs CDP code in a Worker Loader isolate.
- **Session:** one shared Browser Run session per Session DO, with a tab per conversation and shared cookies. Logins last as long as the Browser Run session.
- **`browser_handoff({ instructions })`:** calls `Cloudflare.handoff`. The Live View URL goes only to the user, through the UI and Web Push. The tool waits durably for `handoffComplete`, up to 30 minutes.
- **v2, `fill_credential({ item, fields, submit? })`:**
  - The host resolves 1Password items, checks that the active tab's origin matches the item's URLs, types the values with CDP `Input.insertText`, and computes TOTP itself.
  - It returns only `{ ok, filled, origin }`.
  - The first use of each item in a Workspace asks the user: once, or always for this Workspace.
- **1Password access (v2):**
  - First a time-boxed spike running `@1password/sdk` in the Worker, with its WASM loader aliased to a Workers module import.
  - Fallback: a minimal Node container with the SDK behind its own DO, exposing only `resolve`.
  - The token never reaches the Workspace container.

### v2

- 1Password credentials and `fill_credential`.
- Guardian: tool-call review, needing an approval primitive in the UI.
- Advisor.
- Git checkpoints and the formatter.
- Remote MCP servers (executor, upsy) through `@earendil-works/pi-mcp`, with OAuth state in a DO.

### Dropped

- **Needs local or interactive support we won't have:** LSP, DAP, termctrl/PTY (computer has no PTY), plannotator, autoresearch.
- **Local-only UI:** command-deck, bible-verses, skills-selector UI, tps-tracker, and the theme, Orca, and Herdr extensions.
- **Desktop MCP servers:** browser-use, computer-use, rea.

## Client and protocol

- **Wire:** Effect RPC over WebSocket, with the `RpcGroup` in `packages/protocol` shared by server and web.
  - Commands: `submit` (with `whenBusy`), `abort`, `reset`, `compact`, `configure`, `fork`, list and create operations, and secret and approval responses.
  - `watch(conversationId)` streams a snapshot, then pi `AgentEvent` batches unchanged.
  - Use alchemy's `RpcWebSocket`/`RpcDurableObject` if they survive DO hibernation. Otherwise use the Cloudflare pi example's message shapes, wrapped in Effect `Schema`.
- **Reducer:** `view.ts` and `transcript.ts` from Cloudflare's `agents` example `examples/next/harnesses/pi` (MIT, attributed). They are extended for `nestedTools`, compactions, and subagents. This reducer is the only code that interprets `AgentEvent`s.
- **UI:**
  - Vite and React 19 in `apps/web`, served as static assets by the main Worker.
  - assistant-ui `ExternalStoreRuntime`: steers map to `steerItems`, follow-ups to `items`, and `onCancel` to abort.
  - `streamdown` for Markdown, with Tailwind v4 and shadcn.
- **Subagents in the UI:** an expandable child thread under the subagent tool call, opened with a second `watch` on `details.conversationId`. A task-graph panel is fed by `watchTaskGraph`.
- **Notifications:** Web Push when a Run ends, fails, or needs input.
- **Titles:** a background task asks the `small` role for a 3–6 word title, stored in the Registry DO.

## Operations

- **Infra:** alchemy `2.0.0-beta.83` with `@effect/platform-node`. Workers and DOs are written in alchemy's Effect form, or as plain classes through Worker `bindings` where a mixin such as `withWorkspace` requires it. Containers use `schedulingPolicy: "durable_object"`.
- **Stages:** `alchemy dev` (workerd and local Docker, stage `dev_$USER`) and a single `prod` stage with `Cloudflare.state()`. GitHub Actions runs `pnpm check` and deploys `prod` on push to `main`.
- **Access:** every stage's main Worker sits behind a Cloudflare Access application (declared on the Worker's `access` prop) with one policy, allow the owner's email. `prod` is served on `pi.ianpascoe.dev` (`ianpascoe.dev` zone, Access team `spirit-led-software`) and not on `workers.dev`; other stages stay on `workers.dev`.
- **CI credentials:** a second stack, `infra/github.ts` (`cloudpid-github`, stage `ci`), creates the scoped deploy API token and the GitHub environment `production` (deployments from `main` only) with its secrets and variables. See `AGENTS.md` → _Infra_.
- **Telemetry:**
  - A `pi-telemetry` → Effect `Tracer` adapter feeds Workers Observability logs and traces.
  - `pi.usage` is shown per Session in the UI.
  - A per-Session spend limit is enforced by a `beforeRequest` hook.
- **Testing:**
  - Vitest 5 with `@cloudflare/vitest-plugin` (the successor of `vitest-pool-workers`) for DO tests: eviction, alarm, and resume.
  - pi-ai `fauxProvider` for scripted turns.
  - `registerEnvConformance` for `ComputerExecutionEnv`.
  - `@effect/vitest`.
  - One alchemy `Test` deploy smoke test.

## Repository layout

The repo is a Turborepo with pnpm workspaces. Internal packages are just-in-time: `exports` point at `src/*.ts`, and the Workers' bundlers compile them.

```
infra/                    alchemy stack (alchemy.run.ts): Workers, DOs, Container, Access, secrets
apps/server/              main Worker: Session, Workspace, Registry DOs; HTTP/WS API; static assets
apps/codemode-sandbox/    codemode sandbox Worker
apps/web/                 Vite + React UI
apps/sandbox-image/       Dockerfile (computerd + mise), base mise.toml, bootstrap
packages/effect-durable/  Effect ↔ pi-durable adapters and service facades
packages/computer-env/    ComputerExecutionEnv
packages/extensions/      one subpath export per extension (/subagents, /context, /todo, /web, /secrets, /browser, …)
packages/protocol/        RpcGroup, AgentEvent reducer, transcript projection
packages/config/          settings Schema and defaults, model roles, shared tsconfig and vitest bases
skills/                   bundled skills
```

## Milestones

Each milestone deploys and works end to end before the next begins.

| Milestone     | Delivers                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 Scaffold   | Turborepo and packages. The alchemy stack deploys a hello Worker behind Access to `dev` and `prod`. CI runs check and deploy.                                                        |
| M1 Chat       | Session DO host (Harness, alarm and wake, model proxy). Registry DO, Effect RPC over WebSocket, and the web UI with the reducer. No tools.                                           |
| M2 Files      | Workspace DO and `ComputerExecutionEnv` with conformance. pi-durable `read`/`write`/`edit`/`bash` on the Worker Shell, plus `ls`/`find`/`grep`, skills mount, and `createGitClient`. |
| M3 Container  | Minimal image, `ignore` paths, `mise install` bootstrap, snapshots, idle stop, backend routing.                                                                                      |
| M4 Code mode  | Sandbox Worker, `codemode`, `tool_search`, deferred tools.                                                                                                                           |
| M5 Extensions | Subagents, context, todo, web, secrets, titles, Web Push, telemetry, spend limit.                                                                                                    |
| M6 Browser    | `browser` and `browser_handoff`.                                                                                                                                                     |
| v2            | 1Password, guardian, advisor, git checkpoints, formatter, remote MCP.                                                                                                                |

## Known risks and spikes

- **Preview packages.** `@cloudflare/computer` is a preview: its container backend, the Worker Shell, and computerd are experimental. Pin versions and keep the image and package in lockstep.
- **Unreleased pi-durable features.** `onWake` is not in pi-durable 1.3.0, so the heartbeat fallback is needed until the next release.
- **Unverified container behaviour.**
  - Exec and mmap of binaries from the FUSE mount are untested.
  - Snapshot restore with computerd and `ignore` paths is untested.
  - Cross-boundary renames return `EXDEV`, so tools must keep install and temp directories on one side.
- **Unverified alchemy behaviour.** Whether alchemy's RPC over WebSocket survives DO hibernation is unknown, and this decides the wire format.
- **1Password in Workers** is unproven ([issue #184](https://github.com/1Password/onepassword-sdk-js/issues/184)).
- **Exposure of the shared browser session.** Raw CDP in the shared browser session can read cookies and filled values, so prompt injection from pages is the main threat. Mitigations are host-side fills, origin checks, and per-item approval.
