# cloudpid: Pi on Cloudflare

A personal, always-on coding agent that recreates the local pi harness on Cloudflare. pi-durable runs the agent, `@cloudflare/computer` holds the files and runs commands, alchemy provisions everything, and Effect is the application language.

This spec records the design settled on 2026-10-20. Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the hard-to-reverse choices have ADRs in [`docs/adr/`](adr/).

## Scope

- **Single user**, behind Cloudflare Access. There are no tenants, quotas, or per-user isolation.
- **v1 clients:** an HTTP and WebSocket API and a web UI. A terminal client and GitHub, Slack, or cron triggers come later.
- **Lean on existing packages.** Prefer Earendil (`pi-durable`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-telemetry`) and Cloudflare (`@cloudflare/computer`, `agents/browser`) building blocks over writing our own.

## Architecture

```
Browser (web UI, PWA) ──Access──▶ Main Worker ──WS─────▶ Session DO (per Session)
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

The Harness and the Workspace live in separate objects ([ADR-0001](adr/0001-session-and-workspace-durable-objects.md)). The Workspace DO is hosted by its own plain Worker, `Workspaces` (bound as `WORKSPACES`): the Worker Shell reaches the DO through a `WorkspaceServiceProxy` entrypoint the hosting Worker must export (`ctx.exports`), and an alchemy Effect Worker's generated entry exports only `default` and its Effect DO classes. Session DOs bind it across scripts with `Cloudflare.DurableObject("Workspace", { scriptName: Workspaces.workerName })`, the Output and not a literal, so `Workspaces` deploys first; they call it through the raw `DurableObjectNamespace` stub, which `getWorkspace()` and `ComputerExecutionEnv` need. The two Workers deploy separately, so `ComputerExecutionEnv`'s requests to the DO only ever gain operations, never change existing ones.

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

- Requests go to the existing proxy `api.ai.ianpascoe.dev` with a Commissary API key, sent as each provider's native API key (`x-api-key` for Anthropic). The proxy is Commissary's API host, which sits outside Cloudflare Access and rejects service tokens. Model IDs match `~/.pi/agent/models.json`.
- Default `anthropic/claude-opus-5-5` at `high` thinking.
- Roles: `small` haiku-5-5, `medium` sonnet-5-5, `large` opus-5-5, `xlarge` fable-5-1, with the hints from `~/.pi/agent/settings.json`.

### Settings

- A typed Effect `Schema` with defaults in `packages/config`: every field has a decoding default, so decoding the overrides gives the resolved settings, and the schema's `Encoded` side is the overrides' shape (a deep partial that rejects unknown keys). Invalid overrides fail with one readable line per problem.
- Runtime overrides live in a Registry DO document (the `documents` table, named `settings`), editable in the UI at `/settings` over `getSettings`/`updateSettings`. The document is added by a Registry migration (the `documents` table). A write is strict and keeps only what differs from the defaults, so a setting left alone follows later default changes; a read is lenient: saved overrides that no longer resolve (a model a release dropped) are left out one by one and listed in `problem`, and the rest still apply.
- Each Session reads the overrides from the Registry when a client connects and before it admits input (outside the alarm lock, and not again for 30 s after a failed read), and keeps the last read in its own storage, so a changed default applies to the next request of new and idle Sessions without a redeploy and is what a client first sees, and a Registry that is down never stops one. A default changed during a Run reaches the Run from its next provider request, as a pick does. The Harness's `compaction` is a getter over that copy. The default model and thinking level are written to the root conversation's agent before each request unless the Session picked its own (see `configure`); a pick of a model the settings no longer accept is ignored.
- They cover models, roles, thinking level, compaction, and extension options. Still to come: container size, idle timeout, and spend limit.

## Workspace and execution

### Filesystem and tools

- The workspace root is `/workspace`, with one directory per repo. A Session's `cwd` defaults to its repo directory.
- `ComputerExecutionEnv` (`packages/computer-env`) implements pi-durable's `ExecutionEnv` over the Workspace DO's RPC stub. It covers `listFiles` via `fs.find`, and must pass `registerEnvConformance`.
- `read`, `write`, and `edit` are pi-durable's own tools, and `bash` is pi-durable's tool with one more argument, `backend` (`@cloudpid/extensions/coding-tools`, see _Backends_). `ls`, `find`, and `grep` are thin tools over computer's `fs.readdir`, `fs.find`, and `fs.grep` (`@cloudpid/extensions/files`), so they never start the container: they reach the Workspace only through a file-search interface that has no command execution. Their parameters and output follow local pi's; `find` and `grep` skip `node_modules` and `.git`, since the Workspace's file system has no `.gitignore` handling. computer's `createPiTools` is not used ([ADR-0008](adr/0008-pi-durable-tools-over-computer-tools.md)).
- A Session is bound to one Workspace slug, recorded in the Registry when the Session is created (`default` when none is chosen) and never changed. The Session DO asks the Registry for it once and keeps it; `HarnessOptions.env` builds a `ComputerExecutionEnv` on that Workspace's DO for each call, in the conversation's `cwd` or `/workspace`.
- Skills: the headless-safe skills from `~/.pi/agent/skills` are copied to `skills/` and mounted read-only with `WorkerBundle` at `/workspace/.agents/skills`. Repo-local `.agents/skills` are discovered too. A `skills` prompt section lists them.

### Backends

| Backend      | Runs                                                                    | Use                                                                        |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Worker Shell | just-bash in a Dynamic Worker, with `createGitClient()` providing `git` | Default for text commands: `cat`, `grep`, `sed`, `jq`, `git status`/`diff` |
| Container    | Real Linux through computerd and FUSE at `/workspace`                   | Anything needing a real binary: `npm`, `node`, test runners, `gh`          |

`bash` chooses a backend per call, with an explicit `backend` argument (`worker`, the default, or `container`) or a heuristic. The Worker Shell cannot run ELF binaries, so those commands always go to the Container. Only the explicit argument exists so far: the heuristic is [issue #22](https://github.com/ian-pascoe/cloudpid/issues/22). The tool description tells the model what each backend can do (`@cloudpid/extensions/coding-tools`), and an environment that cannot reach the Container answers a `container` call with an error.

The Workspace DO registers both backends on its one Workspace, as `worker-shell` and `container-shell`, so both see the same `/workspace`: computer pushes the DO's changes to the Container before a Container command and pulls its changes back after it. `ComputerExecutionEnv.onBackend()` selects one. computerd runs commands with `/bin/sh -c`, which is dash on Debian, so a Container command is wrapped in `exec bash -c '…'` to keep `bash` bash. The Container starts on the first command sent to it and takes about 10 seconds to do so on Cloudflare (4 seconds under `alchemy dev`).

The Worker Shell returns a command's output once, when it exits: `onOutput` gets all of stdout, then all of stderr, attributed but not interleaved in arrival order. The Container streams output as it comes, so its tests must check streaming, which the Worker Shell's cannot.

### Container and Toolchains

[ADR-0004](adr/0004-minimal-container-with-mise-bootstrap.md) covers this design.

- **Image:** `debian:stable-slim` plus `fuse3`, `ca-certificates`, `computerd` (pinned to match `@cloudflare/computer`), and `mise`. Everything else, `git` and `gh` included, is a mise Toolchain. The image must be glibc-based, so no Alpine.
- **Persistence:** `mise.toml` and `mise.lock` live in the workspace and are synced. `MISE_DATA_DIR` and `MISE_CACHE_DIR` sit under `/workspace/.mise`, which is listed in computer's `ignore`. So are `node_modules`, `.venv`, `target/`, and caches, which keeps them container-local and out of DO SQLite.
- **Bootstrap:** on start, run `mise install`, which does nothing when the tools are already present. Snapshot the container disk after a successful install and when the container idles, and restore with `launch.containerSnapshot`.
- **Size and idle:** `standard-2` by default with a 15-minute inactivity stop. Both are per-Workspace settings. So far the size is fixed in the Workspace DO and the stop is minimal (see below); #24 makes both settings and adds snapshots.
- **Idle stop:** computer never stops the Container it starts (its WebSocket, heartbeat timer and container monitor keep the Workspace DO alive, and the platform's inactivity timeout never fires), so the Workspace DO stops it: every connect, push and pull on the Container records a use, and a Durable Object alarm destroys the Container after 15 minutes without one (`apps/server/src/workspace/idle.ts`). A command still running on the Container counts as use: the Workspace stub the DO hands out (`tracked.ts`) holds the command until its client disposes the exec handle, and the alarm waits again while any is held. The time is fixed and nothing is snapshotted first; #24 refines both.
- **Egress:** unrestricted direct egress in v1, and not logged. A per-Workspace allowlist, and logging with it, come later.

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

- Canonical IDs such as `agent-1` and `agent-1.reviewer` (a leading `root.` is accepted; `root` and `parent` are reserved), plus tombstones and a depth cap.
- Model roles.
- `read`/`modify` toolset presets under a capability ceiling.
- `session_context`: `omit`, `inherit` (the parent's conversation quoted before the task), or `compact` (a summary of it, made by the `small` role's model, or the child's own when no `small` role is configured).
- Wait events: `turn`, `message`, `timeout`, and `steered`. One open wait per caller and child; a second is refused.

They are rebuilt on pi-durable primitives, following its example 23 (`@cloudpid/extensions/subagents`):

- Children are conversations owned by a background anchor task.
- Each input to a child is a turn, carried by a background reporter task in its parent's conversation. A Session document records the agents, their recent turns, tombstones, and open waits, and one commit decides each delivery.
- A settled turn's answer goes to a `subagent_wait` blocked on it. Otherwise it is held (`delivery: "pending"`) until the parent is idle, so a later `subagent_wait` in the parent's run can still claim it, and then reported as a follow-up, deduplicated by `requestId`. The rule is the same for every parent: the root gets the report as follow-up input, and a parent that is itself a subagent gets it as a new turn, whose answer is reported further up. Inputs steered into one run end in one answer, which is delivered once; the other turns are `duplicate`.
- After the user presses Stop, a held report is still delivered once the root is idle, which starts a new run. pi-minimal-subagents instead holds it until the next run; #30 decides which to keep.
- `subagent_wait` is a durable task that sleeps until its deadline (`TaskRuntime.sleep`); a rerun of the call after an eviction finds it.
- A child's tools are exactly its grant (`AgentState.tools`): ordinary tools within its caller's, plus all six coordinator tools when it was launched with `delegation: "fanout"` below the depth cap, or only `agent_message` otherwise.
- The roles come from the settings' `roles`; the depth cap and toolsets from `extensions.subagents` (`maxSubagentDepth`, default 2; `baseToolset`, `readToolset`, `modifyToolset`).

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

### Web

`packages/extensions/src/web` ports pi-web-tools (`NOTICE.md`): `web_search` over Exa or Parallel (keys are optional deploy-time secrets; a Session with both picks one by a stable hash of its conversation ID) and `web_fetch` (Markdown, text, or HTML; JSON re-indented; `offset`/`limit` line paging). A Worker has no temp file the model can read, so a result over 50 KiB or 2,000 lines is cut to whole lines and ends with a note naming the `offset` that reads on, instead of spilling to disk. HTML converts without a DOM in one linear pass; a page nested more than 1,024 levels deep (browsers stop at 512) or converting to more than 20 MiB of Markdown fails with a note to use `format: html`, so a hostile page cannot stall the Session.

**SSRF guard.** `web_fetch` reaches the network only through `guardedFetch`, which follows redirects itself and, for the URL and every hop, refuses non-HTTP(S) schemes, URLs with credentials, and any host that is or resolves to a loopback, private, link-local, CGNAT, unique-local, multicast, reserved, or cloud-metadata address (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, `*.internal`, `*.local`, single-label names). Numeric hosts are decoded as a resolver would (decimal, hex, octal, short forms) and IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by it.

A Worker cannot resolve a name before `fetch`, so a public-looking name that resolves to a private address is caught by a DNS-over-HTTPS lookup of its A and AAAA records through Cloudflare's resolver before each hop; a lookup that fails refuses the hop. The residual risk is DNS rebinding: the platform's own lookup at `fetch` time is separate from ours, so a name that answers differently to two queries in quick succession can pass. Both lookups share Cloudflare's caching resolver, which holds an answer for its TTL, and Cloudflare's edge also refuses Worker subrequests to private and internal addresses (the guard does not rely on that), so what is left is a narrow race for an attacker who controls a name's records and wants the Session to reach a public address of their choosing, which the guard does not try to prevent.

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

- **Wire:** the contract lives in `packages/protocol`, shared by server and web ([ADR-0009](adr/0009-session-socket-messages-over-alchemy-rpc.md)).
  - **Session socket:** `GET /sessions/:id/socket` on the main Worker, forwarded to the Session DO, which accepts it as a hibernatable WebSocket. A Session the Registry does not know answers 404. Messages are JSON in the Cloudflare pi example's shapes, as Effect `Schema`. The Session greets a client with `hello` and its root conversation. Commands carry an optional `id`, which a `result` or an `error` answers, also when the command cannot be read. Keys a command does not define are an error.
  - Commands: `submit` (with `whenBusy` and a `requestId` that deduplicates), `abort`, and `watch`/`unwatch`. `configure` picks the root conversation's model and thinking level (`null` follows the default in the settings again); the Session says which fields it picked (`picked`, after `hello` and to every client after a `configure`); it is a socket command, not Registry RPC, because the pick belongs to one Session, is applied by that Session's Harness, and reaches every watching client as an `agent_changed` event. Still to come: `reset`, `compact`, `fork`, and secret and approval responses.
  - `whenBusy: "steer"` joins the running Run at its next boundary, after the tool calls in progress. A steer that finds the Run giving its final answer starts the next Run, as `followUp` does.
  - `watch(conversationId)` streams `events`: a batch holding a `snapshot`, then pi `AgentEvent` batches unchanged. The socket's attachment names its watches. A Session woken from hibernation restarts them, each with a fresh snapshot, on the same socket. A watch that ends, or cannot restart, is dropped with an `error` naming its `conversationId`. A client whose socket closed (an eviction, a deploy) reconnects and watches again.
  - The runtime answers the client's `ping` heartbeat with `pong` without waking the Session.
  - **Registry:** `RegistryRpcs`, an Effect `RpcGroup` over HTTP (`POST /rpc`, JSON), lists and creates Sessions and Workspaces, and reads and replaces the settings overrides.
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
apps/server/              main Worker: Session, Registry DOs; HTTP/WS API; static assets.
                          Workspaces Worker (src/workspace): Workspace DO
apps/codemode-sandbox/    codemode sandbox Worker
apps/web/                 Vite + React UI
apps/sandbox-image/       image/Dockerfile (computerd + mise; the Docker build context), base mise.toml, bootstrap
packages/effect-durable/  Effect ↔ pi-durable adapters and service facades
packages/computer-env/    ComputerExecutionEnv
packages/extensions/      one subpath export per extension (/subagents, /context, /todo, /web, /secrets, /browser, …)
packages/protocol/        Session socket messages, RegistryRpcs, AgentEvent reducer, transcript projection
packages/config/          settings Schema and defaults, model roles, shared tsconfig and vitest bases
skills/                   bundled skills
```

## Milestones

Each milestone deploys and works end to end before the next begins.

| Milestone     | Delivers                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 Scaffold   | Turborepo and packages. The alchemy stack deploys a hello Worker behind Access to `dev` and `prod`. CI runs check and deploy.                                                        |
| M1 Chat       | Session DO host (Harness, alarm and wake, model proxy). Registry DO, the Session socket and Registry RPC, and the web UI with the reducer. No tools.                                 |
| M2 Files      | Workspace DO and `ComputerExecutionEnv` with conformance. pi-durable `read`/`write`/`edit`/`bash` on the Worker Shell, plus `ls`/`find`/`grep`, skills mount, and `createGitClient`. |
| M3 Container  | Minimal image, `ignore` paths, `mise install` bootstrap, snapshots, idle stop, backend routing.                                                                                      |
| M4 Code mode  | Sandbox Worker, `codemode`, `tool_search`, deferred tools.                                                                                                                           |
| M5 Extensions | Subagents, context, todo, web, secrets, titles, Web Push, telemetry, spend limit.                                                                                                    |
| M6 Browser    | `browser` and `browser_handoff`.                                                                                                                                                     |
| v2            | 1Password, guardian, advisor, git checkpoints, formatter, remote MCP.                                                                                                                |

## Known risks and spikes

- **Preview packages.** `@cloudflare/computer` is a preview: its container backend, the Worker Shell, and computerd are experimental. Pin versions and keep the image and package in lockstep.
- **Unreleased pi-durable features.** `onWake` is not in pi-durable 1.3.0, so the heartbeat fallback is needed until the next release.
- **Container behaviour.**
  - Exec and mmap of binaries from the FUSE mount **work**, measured on Cloudflare (`standard-2`, real `/dev/fuse` mount at `/workspace`, computerd 0.5.1): a copied `perl`, `python` (with its `PYTHONHOME`), and a 120 MB `node` run from `/workspace`; a shared library copied there is mapped by the dynamic loader (`LD_LIBRARY_PATH`, `LD_DEBUG=libs` shows `calling init: /workspace/…`); Python's `mmap` reads a 1 MiB file there with `MAP_PRIVATE` (hash equal to `sha256sum`) and writes one with `MAP_SHARED`, which the Worker Shell then reads. Copying the 120 MB binary took 0.8 s. Under `alchemy dev` the local Docker has no `/dev/fuse`, so computerd uses its userspace shim (a plain directory), where the same script passes; only a deploy exercises FUSE.
  - The Worker Shell sees Container writes, and the Container sees the Worker Shell's, through computer's sync (checked both ways, locally and deployed).
  - Snapshot restore with computerd and `ignore` paths is untested.
  - Cross-boundary renames return `EXDEV`, so tools must keep install and temp directories on one side.
- **1Password in Workers** is unproven ([issue #184](https://github.com/1Password/onepassword-sdk-js/issues/184)).
- **Exposure of the shared browser session.** Raw CDP in the shared browser session can read cookies and filled values, so prompt injection from pages is the main threat. Mitigations are host-side fills, origin checks, and per-item approval.
