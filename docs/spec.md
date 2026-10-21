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
                                       │                    ├─ browser tool ─▶ Browser Worker (BrowserHost DO per Session → Browser Run)
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
| **Browser host DO**     | Session DO id                             | The Session's one Browser Run browser (`agents/browser`) and the runs of the model's CDP code. It lives in the `Browsers` Worker. |

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
- A Session is bound to one Workspace slug, and optionally one repo directory in it, recorded in the Registry when the Session is created (`default` and the root when none is chosen) and never changed. The Session DO asks the Registry for them once and keeps them; `HarnessOptions.env` builds a `ComputerExecutionEnv` on that Workspace's DO for each call, in the conversation's own `cwd`, else `/workspace/<repo>`, else `/workspace`. A repo is a directory name (`REPO_NAME` in `packages/protocol`: letters, digits, `.`, `_`, `-`, never leading with a dot or dash) that the Workspace must already hold when the Session is created, so the `cwd` cannot be a path.
- **Repos from the UI:** the Workspaces page (`/workspaces`) creates a Workspace by slug, lists the repos it holds (`listRepos`: the directories below `/workspace` with a `.git`, read from the Workspace's files without starting the Container), clones one (`cloneRepo`) and starts a Session at the Workspace root or in a repo. The main Worker's endpoint runs the clone on the Container (`git clone -- <url> <name>` as an argument vector in `/workspace`, `GIT_ALLOW_PROTOCOL=https`, 10 minute timeout), where the network and `CLOUDPID_GITHUB_TOKEN` are. `parseRepoSource` (`packages/protocol`, which the UI uses as the owner types) accepts `owner/repo` (GitHub) or an `https` URL of a dotted, non-numeric host whose path is plain segments, and refuses credentials, ports, queries, fragments, escapes, `..`, other schemes and private-looking hosts; the directory defaults to the repo's name and a clone into a directory that is taken fails with git's own message. The clone's files reach the Worker Shell through computer's sync, so `git status` there reads the clone.
- Skills: the headless-safe skills from `~/.pi/agent/skills` are copied to `skills/` and mounted read-only with `WorkerBundle` at `/workspace/.agents/skills`. Repo-local `.agents/skills` are discovered too. A `skills` prompt section lists them.

### Backends

| Backend      | Runs                                                                    | Use                                                                            |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Worker Shell | just-bash in a Dynamic Worker, with `createGitClient()` providing `git` | Text and file commands: `cat`, `grep`, `sed`, `jq`, and read-only `git status` |
| Container    | Real Linux through computerd and FUSE at `/workspace`                   | Anything needing a real binary: `npm`, `node`, test runners, `gh`              |

`bash` chooses a backend per call: an explicit `backend` argument (`worker` or `container`) always wins, and without one the command decides (`routeCommand`, `packages/extensions/src/bash-routing.ts`). The Worker Shell cannot run ELF binaries, has no network, and has no credentials, so a command that needs any of those goes to the Container; a command that is not understood goes there too, since the Container runs anything and starts only when a command is sent to it. The tool description tells the model what each backend can do, that routing is automatic, and that `backend` overrides it; an environment that cannot reach the Container answers a `container` call with an error.

- **Reading the command:** the command is read the way bash reads it (quotes, pipelines and lists, subshells, `$(…)` and backticks, heredocs, `env`/`time`/`timeout`/`xargs`/`find -exec`/`bash -c` wrappers), so a program named in a string or a heredoc body does not count and one inside a substitution does. Every simple command must be one the Worker Shell runs, or the whole call goes to the Container (one call, one backend). `./script`, `/usr/bin/x`, `bash script.sh`, `source`, a command named by `$VAR`, `case`, process substitution, and a command that does not parse go to the Container.
- **Worker Shell commands:** `@cloudflare/computer`'s just-bash core (`cat`, `grep`, `rg`, `sed`, `awk`, `find`, `sort`, `tar`, …, no `curl`, `python`, `node`, `yq`, `sqlite3`), `jq` (an optional computer module the Workspace DO adds), the shell built-ins, and `git`. `WORKER_SHELL_COMMANDS` is that list; a workerd test runs each name through the real Worker Shell.
- **git:** `git` on the Worker Shell is isomorphic-git behind `createGitClient()` (the Workspace DO passes it), not real git, and its output is not always git's. Only a small read-only set stays there, each form checked against real git's output in the workerd test: bare `git status`, `git log --oneline` (with `-n`/`-N`), `git rev-parse` (`HEAD`, `--abbrev-ref HEAD`, `--show-toplevel`), bare `git ls-files`, and `git branch` (bare or `--show-current`). Everything else goes to the Container: every subcommand that writes the index or a ref (`add`, `rm`, `commit`, `tag`, `branch <name>`, `init`, `remote`, …), `diff` and `show` (the client's patches are not git's), plain `log` (another date format), `cat-file` (broken), `clone`, `fetch`, `pull`, `push` (no network or credentials on the Worker Shell), `config`, and what rewrites the working tree (`checkout`, `switch`, `reset`, `merge`, `stash`, `clean`), as does any option or argument not listed (`git status --short`, `git log --graph`). The Worker Shell's git has no default identity (it was removed: a commit there needs `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the command, and the router sends every commit to the Container, whose identity is `CLOUDPID_GIT_NAME`/`CLOUDPID_GIT_EMAIL`).

The Workspace DO registers both backends on its one Workspace, as `worker-shell` and `container-shell`, so both see the same `/workspace`: computer pushes the DO's changes to the Container before a Container command and pulls its changes back after it. `ComputerExecutionEnv.onBackend()` selects one. computerd runs commands with `/bin/sh -c`, which is dash on Debian, so a Container command is wrapped in `exec bash -c '…'` to keep `bash` bash. The Container starts on the first command sent to it and takes about 10 seconds to do so on Cloudflare (4 seconds under `alchemy dev`).

The Worker Shell returns a command's output once, when it exits: `onOutput` gets all of stdout, then all of stderr, attributed but not interleaved in arrival order. The Container streams output as it comes, so its tests must check streaming, which the Worker Shell's cannot.

### Container and Toolchains

[ADR-0004](adr/0004-minimal-container-with-mise-bootstrap.md) covers this design.

- **Image:** `debian:stable-slim` plus `fuse3`, `ca-certificates`, `computerd` (pinned to match `@cloudflare/computer`), and `mise`. Everything else, `git` and `gh` included, is a mise Toolchain. The image must be glibc-based, so no Alpine.
- **Persistence:** `mise.toml` and `mise.lock` live in the workspace and are synced; a Workspace with no mise config gets a base `mise.toml` (git and gh) on the first Container start, and the bootstrap locks it (`mise lock --global`, to `linux-x64`) into `mise.lock` beside it. The Toolchains themselves (`MISE_DATA_DIR`, `MISE_CACHE_DIR`) stay in mise's default place on the Container's disk, `/root/.local/share/mise` and `/root/.cache/mise`, with `TMPDIR` as `/tmp` on the same disk, so an install never renames across a filesystem or the ignore boundary (no `EXDEV`) and nothing of it reaches the Workspace DO. computer's `ignore` (`TOOLCHAIN_IGNORE` in `apps/sandbox-image/src/toolchains.ts`) lists `**/node_modules`, `**/.venv`, `/target` and `/*/target`, and caches (`**/.cache`, `**/__pycache__`, …): they stay container-local and out of DO SQLite. The first plan put the Toolchains under `/workspace/.mise` on that list; see _Known risks_ for why they are not.
- **Bootstrap:** before the first command of each Container start, `ToolchainBackend` (`apps/server/src/workspace/toolchains.ts`, a wrapper around computer's `ContainerBackend`) runs `apps/sandbox-image`'s `bootstrapScript` through the Container's shell. It writes the base `mise.toml` if the root has no mise config of any kind mise reads (`mise.toml`, `.mise.toml`, `mise.local.toml`, `.config/mise.toml`, `.config/mise/config.toml`, `.mise/config.toml`, `.tool-versions`); locks the root's `mise.toml` (`mise lock --global`, when the lockfile is missing or older than the config); runs `mise install` (from `mise.lock`; a no-op for what is present) in `/workspace` and in each repo directory with a mise config; and sets git's identity and credentials. Commands that arrive meanwhile wait for it; computer has pushed the Workspace's files to the Container by then. A command killed or timed out while it waits is not run afterwards. A failed bootstrap is logged (never with the token) and does not stop commands: the command that waited for it starts with a note on stderr (the failure's output, redacted), later ones with a pointer to it, and the next attempt comes after a minute, doubling with each failure in a row up to 15 minutes. A new connection to the same Container does not repeat the bootstrap. A cold start takes about 10 seconds on Cloudflare plus the install (about 10 seconds for git and gh); a restart reinstalls from the lockfile. Snapshotting the Container's disk after an install and when it idles, restored with `launch.containerSnapshot`, is #24.
- **Global default:** the root's `mise.toml` is also mise's global config (`MISE_GLOBAL_CONFIG_FILE`), so git and gh resolve from any directory, not only under `/workspace` (a scratch clone in `/tmp`, the git calls pip and npm make from their own temp directories). The Workspace's own `mise.lock` stays the lockfile; mise locks a global config only through `mise lock --global`, which the bootstrap runs. A root whose config lives elsewhere (`.config/mise.toml`) is installed but is not the global default.
- **Command environment:** computerd starts a command with `PATH` (the image's, with mise's shims first) and `HOME` only, not the image's other variables, so the Workspace DO adds the rest to each command's exec environment (`toolchainEnv`): `MISE_GLOBAL_CONFIG_FILE`, `MISE_TRUSTED_CONFIG_PATHS=/workspace`, `MISE_YES=1`, `GIT_TERMINAL_PROMPT=0` and the GitHub token (see _Git_), under what the caller passes. The token is taken out of what a command prints (`redact.ts`, also when split across output chunks), which stops accidents (`env`, `set -x`) from reaching the Session's history, not a command that encodes it.
- **Under `alchemy dev`:** the local Container has no `/dev/fuse`, and computerd's userspace shim refuses an ignore list (it exits), so the stack sets `CONTAINER_FUSE=false` and the Workspace DO asks for none: `node_modules` and the rest then sync into the local DO like any file. The bootstrap is the same.
- **Size and idle:** `standard-2` by default with a 15-minute inactivity stop. Both are per-Workspace settings. So far the size is fixed in the Workspace DO and the stop is minimal (see below); #24 makes both settings and adds snapshots.
- **Idle stop:** computer never stops the Container it starts (its WebSocket, heartbeat timer and container monitor keep the Workspace DO alive, and the platform's inactivity timeout never fires), so the Workspace DO stops it: every connect, push and pull on the Container records a use, and a Durable Object alarm destroys the Container after 15 minutes without one (`apps/server/src/workspace/idle.ts`). A command still running on the Container counts as use: the Workspace stub the DO hands out (`tracked.ts`) holds the command until its client disposes the exec handle, and the alarm waits again while any is held. The time is fixed and nothing is snapshotted first; #24 refines both.
- **Egress:** unrestricted direct egress in v1, and not logged. A per-Workspace allowlist, and logging with it, come later.

### Concurrency

Sessions on one Workspace share one tree, as local pi sessions share a directory ([ADR-0006](adr/0006-shared-workspace-tree.md)). Subagents share their parent's tree. Git state such as branch and index is shared too.

### Git

- Clone and push with mise-installed `git` and `gh` in the Container (`conda:git` from conda-forge, since mise has no git in its registry otherwise; `gh` from aqua).
- Authentication comes from a GitHub token, the deploy-time secret `CLOUDPID_GITHUB_TOKEN` (`Config.Redacted`, bound to the Workspaces Worker as a secret and read by the Workspace DO). Each Container command gets it as `GH_TOKEN` and `GITHUB_TOKEN`, which is all `gh` needs. The bootstrap also points git's credential helper for `https://github.com` at `$GITHUB_TOKEN`, read when git asks, so no host but github.com is offered it and no file holds it (the helper is in the Container's `~/.gitconfig`, not in `/workspace`). It is not logged.
- Commits are by `CLOUDPID_GIT_NAME` / `CLOUDPID_GIT_EMAIL` (deploy-time variables; defaults `cloudpid` and the owner's email), set as the Container's global git identity unless one is already set. A repo's own `user.name` and `user.email` win.

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
- **Stop.** Stop aborts one conversation, never the agents below it: a subagent's work is background work (its anchor is a background task), so the root's Stop leaves it running, and it reports as usual. **Stop all** (`abort` with `subagents: true`, offered beside Stop while a subagent or background task is live, or while the run goes on with any subagent below it (an idle one can have a report held for that run), and in the task panel) aborts the conversation and every subagent below it with `background: true`, which also aborts their reporters, so the reports held for the parent are dropped (`delivery: "none"`) and nothing starts a new run. A report that is already held when a plain Stop lands is still delivered once the root is idle, which starts a new run: pi-minimal-subagents holds it until the next run, but a reporter that waits for a run that may never come would stay live (and keep the Session's alarm armed) indefinitely, so the rule stays one for every parent, and Stop all is how the owner silences everything.
- **The owner and a subagent.** The owner may submit to and abort a live subagent's conversation from its thread. The Session checks that the conversation is the root's or a live subagent's (the Subagents document maps it; a deleted agent's conversation, or any other, is refused). Input to a subagent is a plain user message: `whenBusy: "steer"` joins its run at the next boundary, `"followUp"` waits for its next run, as for the root. It is not a turn: nothing waits on its answer, so the answer is not reported to the parent, and the parent's `subagent_wait` and reports are untouched. An input the owner steers into a run that also carries a turn of the parent ends in one answer, which the turn reports as usual. Aborting a subagent ends its running turn `aborted` (nothing reported), and keeps the agent for more input.
- `subagent_wait` is a durable task that sleeps until its deadline (`TaskRuntime.sleep`); a rerun of the call after an eviction finds it.
- A child's tools are exactly its grant (`AgentState.tools`): ordinary tools within its caller's, never `context_rollover` (a Handoff would end the child's run without the turn's answer), plus all six coordinator tools when it was launched with `delegation: "fanout"` below the depth cap, or only `agent_message` otherwise.
- The roles come from the settings' `roles`; the depth cap and toolsets from `extensions.subagents` (`maxSubagentDepth`, default 2; `baseToolset`, `readToolset`, `modifyToolset`).

### Context management

pi-context-management's `context_notes`, `context_history`, and `context_rollover` (`@cloudpid/extensions/context`), with its parameters and limits:

- **Notes** are a conversation document (`defineDoc`, `fork: "current"`), which also keeps the last saved Handoff. A Handoff does not touch documents, so Notes outlive it.
- **History** reads entries from storage, also those before a Handoff or compaction; Context Windows start at each head marker (`pi.reset`, `pi.compaction`). Lineage scope covers the conversations of the agent's ancestors and descendants in the Session's subagents document; references are `context:<conversationId>:<entryId>` and `context:<conversationId>:note:<name>`.
- `context_rollover` must be the only call of its round and is not callable from scripts. It returns `control: { handoff }` with the Handoff and a Note Index; pi-durable applies it after the whole round, so the Handoff never splits a tool batch. It also queues a follow-up, so the task continues in the new context, unless the run's only inputs are Rollover requests, as when one is placed after the task's final answer: then the run stops at the Handoff.
- A `CompactionTask` `beforeCompact` hook, in conversations that offer `context_rollover`, turns a background threshold compaction (`backgroundTokens` below the blocking threshold) into a prepare-then-rollover turn: it declines, which blocks nothing, and while a run is live steers a Rollover request into it, once per Context Window. A blocking threshold compaction and an overflow compaction are the Emergency Rollover, because declining a blocking one would send a request without pi-durable's overflow recovery: the summary is the last saved Handoff and the Note Index, on pi-durable's cut, which keeps tool calls with their results. With `backgroundTokens: 0` every Rollover is an Emergency Rollover. A manual compaction keeps pi-durable's summary.
- The transcript shows Handoffs, compaction summaries, and Rollover requests as notices; an extension's input entry asks for a notice with a `notice` title in its data.
- Not ported: Idle Rollover, the `/context`, `/compact`, and `/rollover` commands, and the Rollover Tail (`tailTokens`): a Handoff starts the context from the Handoff alone.

### Secrets

| Kind        | Holds                                                                                                                                            | Storage and use                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deploy-time | Commissary API key for the model proxy, 1Password service-account token (v2), VAPID keys. In v1 also the GitHub token and the Exa/Parallel keys. | Read with `Config.Redacted` in `infra/` and bound as Worker secrets                                                                                                                                                                                                                                    |
| Runtime     | Values entered through `secret_ask`, which opens a masked form in the UI                                                                         | Encrypted with AES-GCM in the Session DO under a key held as a Worker secret. Referenced by pi-secret's double-brace `secret:NAME` placeholder or `$PI_SECRET_*`. Injected into exec env only at call time. Redacted by an `afterTool` hook and at the Session's model seam. Expires after 15 minutes. |

`packages/extensions/src/secrets` ports pi-secret (`NOTICE.md`). The key is `SECRETS_ENCRYPTION_KEY`, from which HKDF derives one AES-GCM key per Session; each record is bound to its name and expiry. A `secret_ask` waits on a durable request: the Session sends the waiting requests to every client (`secret_requests`), the owner answers in a masked form (`secret_answer`), and the request and answer survive eviction, so a call cut off by one finds its answer when it reruns. Values never enter durable state: pi-durable records the arguments a `beforeTool` hook returns, so that hook only blocks calls naming a Secret the Session does not hold, and wraps of the tools that use Secrets (coding tools, Files, `web_fetch`; never `web_search`, whose queries leave for a search provider) resolve placeholders, inject `$PI_SECRET_*` into their commands' environment, and redact streamed output and the command's Result Spill (raw output in the Workspace's shared `/tmp`) inside `execute`. Every held Secret is in every wrapped command's environment, so a process left running in the background keeps it past expiry and `secret_forget`. Provider requests are scrubbed at the Session's `Models` (`scrubbingModels`), so generations, compaction summaries, and a subagent's `compact` summary are all covered; a message is indexed by an unkeyed SHA-256 of its JSON, so its scrubbed form survives eviction, expiry, and a key change. Tools whose arguments become conversation content (code mode, subagents, Notes, Handoffs) are not wrapped; the calls they lead to resolve their own references. Redaction covers each value's common encodings. `secret_ask` and `secret_forget` are parent-only; children read and use the parent's Secrets. An alarm deletes each Secret when it expires, and a request whose call is gone (abandoned while the object was evicted) is withdrawn once the Session is idle.

From v2, secret references may name 1Password items. Credentials then move into a single dedicated vault, and deploy-time secrets shrink to the model proxy key, the 1Password token, and VAPID.

### Web

`packages/extensions/src/web` ports pi-web-tools (`NOTICE.md`): `web_search` over Exa or Parallel (keys are optional deploy-time secrets; a Session with both picks one by a stable hash of its conversation ID) and `web_fetch` (Markdown, text, or HTML; JSON re-indented; `offset`/`limit` line paging). A Worker has no temp file the model can read, so a result over 50 KiB or 2,000 lines is cut to whole lines and ends with a note naming the `offset` that reads on, instead of spilling to disk. HTML converts without a DOM in one linear pass; a page nested more than 1,024 levels deep (browsers stop at 512) or converting to more than 20 MiB of Markdown fails with a note to use `format: html`, so a hostile page cannot stall the Session.

**SSRF guard.** `web_fetch` reaches the network only through `guardedFetch`, which follows redirects itself and, for the URL and every hop, refuses non-HTTP(S) schemes, URLs with credentials, and any host that is or resolves to a loopback, private, link-local, CGNAT, unique-local, multicast, reserved, or cloud-metadata address (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, `*.internal`, `*.local`, single-label names). Numeric hosts are decoded as a resolver would (decimal, hex, octal, short forms) and IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by it.

A Worker cannot resolve a name before `fetch`, so a public-looking name that resolves to a private address is caught by a DNS-over-HTTPS lookup of its A and AAAA records through Cloudflare's resolver before each hop; a lookup that fails refuses the hop. The residual risk is DNS rebinding: the platform's own lookup at `fetch` time is separate from ours, so a name that answers differently to two queries in quick succession can pass. Both lookups share Cloudflare's caching resolver, which holds an answer for its TTL, and Cloudflare's edge also refuses Worker subrequests to private and internal addresses (the guard does not rely on that), so what is left is a narrow race for an attacker who controls a name's records and wants the Session to reach a public address of their choosing, which the guard does not try to prevent.

### Browser

[ADR-0007](adr/0007-browser-and-credentials.md) covers this design.

- **Tool:** `agents/browser` `Browser` with `browserRun(env.BROWSER, { keepAliveMs: 10 min })` in a browser host DO (`BrowserHost`), one per Session, in the plain `Browsers` Worker (`apps/browser`). `agents/browser/pi`'s `browserTool()` there runs the model's CDP code in a Worker Loader isolate (`LOADER`). The Session DO cannot host it: `browserTool` keeps its runs in a `CodemodeRuntime` facet the hosting Worker must export, and the Server Worker, an alchemy Effect Worker, exports only its Effect DO classes. The Session DO's `browser` tool (`packages/extensions/src/browser`) reaches the browser host DO over RPC, takes its description from it, and passes the calling conversation's ID. `Browser` keeps its record through an explicit `DurableBrowserSessionStore`, so no `Lifecycle` is installed: it would take over the object's `fetch`, `alarm`, and WebSocket handlers.
- **Session:** one shared Browser Run session per Session, with a tab per conversation (the root and each subagent: `conversation:<id>` scope) and shared cookies. Logins last as long as the Browser Run session.
- **Keep-alive:** Browser Run reclaims a browser after `keep_alive` without a CDP command (10 minutes here, so a long gap in the middle of a turn does not lose it; its maximum is 20). The Session closes it sooner, through the browser host DO, once the Session has been idle 5 minutes after the browser's last use, so an abandoned browser is not billed for the rest of the `keep_alive`: the time of the last use is kept in the Session DO's storage (noted before a run and after it), joins the Secret expiry as a wake time of the host's alarm (`wakeAt`), and the close runs when the host settles idle (`onIdle`) under a 5-second timeout, so a slow host cannot stall admission. A Session that is never idle is not closed by it; Browser Run's own timeout still applies.
- **Results:** a screenshot is returned as an image part and shown in the tool's card. It is kept in the transcript, so one over about 560 KB (750,000 base64 characters) is replaced by a note to retake it as a smaller JPEG, and only PNG, JPEG, and WebP are kept. Only the latest 3 screenshots go to the model in a request (older ones read `[screenshot omitted]`, at the model seam next to Secret scrubbing), and the transcript snapshot a client gets carries the latest 10, so neither a provider's image limits nor a socket message's size limit grows with a long browsing Session. A screenshot is pixels: it cannot be redacted of a Secret the page shows. Results are redacted of held Secrets by the secrets extension's `afterTool` hook; `browser` is not one of the tools that resolve Secret references, since its code is stored with the run.
- **`browser_handoff({ instructions })`** (`packages/extensions/src/browser/handoff.ts`, host side `apps/browser/src/handoff.ts`): Browser Run's structured handoff (Human in the Loop). The browser host attaches to the conversation's active tab over a CDP connection of its own (`agents/browser`'s `CdpConnection` hands its caller no events), sends `Cloudflare.getLiveView` (`mode: "tab"`, the one mode that supports handoff, valid for the handoff's 30 minutes) and `Cloudflare.handoff` with the instructions and `timeout` of 30 minutes (Browser Run's maximum), and hears the owner press Done or Failed in the Live View as the `Cloudflare.handoffComplete` event on that connection (`success`, `reason`); Browser Run fires it on its own timeout too. A conversation with no open tab gets an error telling the model to open the page with `browser` first.
  - **Link:** the Live View link is a bearer credential for the owner alone. The Session keeps it in its key-value storage, as the request, so that a client that connects later is shown it. It goes to the owner twice: the `handoff_requests` socket message (to every client, with the instructions and the deadline; an empty list once none waits; re-sent on reconnect), and Web Push as a `notice` whose `url` is the link, so a tap opens the Live View (a link too long for a push opens the Session instead, where the card is). It is in no tool argument, result, or `details`, so it reaches neither the transcript nor a model request, nor the snapshot a client gets; a test asserts that on the transcript, the model's requests, the Harness's tables, and the snapshot. The UI shows a card with the instructions and an _Open Live View_ link beside the Secret form.
  - **Completion:** the owner's Done in the Live View is the signal; there is no client command. The tool's result says only how it ended: the user finished, the user could not (with their reason), timed out after 30 minutes, or ended without a word (Browser Run no longer had the handoff). It names no link. Stop withdraws the request and ends the handoff in Browser Run.
  - **Durability:** the tool is `replay: "safe"` and waits in rounds of 25 s on the host's `waitHandoff`, so no call outlives an eviction; the request and its deadline are in the Session's storage, and the rerun after an eviction waits for the same handoff (`startHandoff` is idempotent by the call's task ID, and the host keeps its record in its own storage). A host that restarted reconnects and asks `Cloudflare.getHandoffState`: a handoff that is over with no end event heard ends as "ended". A request whose call is gone is ended once the Session is idle, as an abandoned Secret request is.
  - **Keep-alive:** each round also notes the browser as used, so the Session's 5-minute idle close never runs under a pending handoff (a live tool call means the Session is not idle anyway), and the host's quiet-round `getHandoffState` poll is a CDP command, which keeps Browser Run's own `keep_alive` from reclaiming the browser while the owner works.
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
  - Commands: `submit` (with `whenBusy` and a `requestId` that deduplicates), `abort`, and `watch`/`unwatch`. `configure` picks the root conversation's model and thinking level (`null` follows the default in the settings again); the Session says which fields it picked (`picked`, after `hello` and to every client after a `configure`); it is a socket command, not Registry RPC, because the pick belongs to one Session, is applied by that Session's Harness, and reaches every watching client as an `agent_changed` event. `submit` and `abort` take an optional `conversationId` of a live subagent, and `abort` an optional `subagents` flag that also stops everything below it (see _Subagents_: Stop). `watch_task_graph`/`unwatch_task_graph` start and stop `task_graph` messages: a summary of the Session's live work (`agents`: ID, parent, conversation, role, model, `working` or `idle`; `background`: live background tasks other than the subagents' own bookkeeping), made from pi-durable's `watchTaskGraph()` and the Subagents document, at most one every 250 ms, and only when it changed. The watch is kept in the socket's attachment and restarts on wake, like a conversation's. `secret_answer` answers a Secret request with the values entered in a masked form (or `null` to cancel); the Session sends the waiting requests (`secret_requests`) after `hello` and to every client when they change, and the values never reach a client again. The Session likewise sends the Browser Handoffs waiting for the owner (`handoff_requests`, each with its Live View link) after `hello` and to every client when they change; there is no answer command, as the owner finishes in the Live View. Still to come: `reset`, `compact`, `fork`, and approval responses.
  - `whenBusy: "steer"` joins the running Run at its next boundary, after the tool calls in progress. A steer that finds the Run giving its final answer starts the next Run, as `followUp` does.
  - `watch(conversationId)` streams `events`: a batch holding a `snapshot`, then pi `AgentEvent` batches unchanged. The socket's attachment names its watches. A Session woken from hibernation restarts them, each with a fresh snapshot, on the same socket. A watch that ends, or cannot restart, is dropped with an `error` naming its `conversationId`. A client whose socket closed (an eviction, a deploy) reconnects and watches again.
  - The runtime answers the client's `ping` heartbeat with `pong` without waking the Session.
  - **Registry:** `RegistryRpcs`, an Effect `RpcGroup` over HTTP (`POST /rpc`, JSON), lists and creates Sessions and Workspaces, lists a Workspace's repos and clones one into it, and reads and replaces the settings overrides.
- **Reducer:** `view.ts` and `transcript.ts` from Cloudflare's `agents` example `examples/next/harnesses/pi` (MIT, attributed). They are extended for `nestedTools`, compactions, and subagents. This reducer is the only code that interprets `AgentEvent`s.
- **UI:**
  - Vite and React 19 in `apps/web`, served as static assets by the main Worker.
  - assistant-ui `ExternalStoreRuntime`: steers map to `steerItems`, follow-ups to `items`, and `onCancel` to abort.
  - `streamdown` for Markdown, with Tailwind v4 and shadcn.
- **Subagents in the UI:** a `subagent` tool call that started an agent (its result's `details.conversation_id`) is a card with the agent's ID, role, model and status (from the task graph). Opening it is a second `watch` on that conversation, released when closed; the thread inside is its own assistant-ui runtime, with a composer that steers or queues input and a Stop button (and Stop all, on the same terms). A **Tasks** panel, fed by `watch_task_graph`, lists the agents (each openable into the same thread, with its own Stop) and the background work, and has Stop all.
- **Notifications:** Web Push when a Run ends, fails, or needs input.
  - **Keys:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are deploy-time secrets read by the Registry DO (`Config.Redacted`). The public key reaches the web app through `getPush`; the private key never leaves the Worker.
  - **Subscriptions:** a device's `PushSubscription` (endpoint and keys) is a row of the Registry DO's `push_subscriptions` table, over `getPush`/`subscribePush`/`unsubscribePush`. The settings page turns notifications on (permission, subscribe, `subscribePush`) and off (`unsubscribePush`, unsubscribe) per device. `getPush` says whether the Registry holds the asked endpoint, and the page gives it back a subscription the browser holds but the Registry lost.
  - **Sending:** the Registry DO's `notify(sessionId, event)` (`apps/server/src/push`) encrypts one message per subscription (RFC 8291 `aes128gcm`) and signs it with VAPID (RFC 8292), both on WebCrypto. The body is a title (the Session's title), one line, the Session's page and a tag, a few hundred bytes. Each push is given up on after 5 s, 16 at a time, so the Session's 20 s wait holds for up to 64 browsers (a Session that gave up sooner would send it again). A 404 or 410 from the push service deletes the subscription; any other failure is logged and the subscription kept. Only endpoints at known push services (FCM, Mozilla, Apple, Windows) over https are accepted. A Session DO reaches it through `SessionRegistry.notify`, and extensions through the `OwnerNotifications` service in `@cloudpid/extensions/notify`, which takes a `notice` event (title, body, url; the title, body and url are bounded so a push fits one message).
  - **Triggers:** the Session host keeps the submissions the owner made until their Run's end is notified (in its key-value storage, so an eviction does not lose it), and notifies once they settle: `finished` when one was answered, `failed` (with the error's text) when one went unanswered for any reason but the owner stopping it (`aborted`, `reset`). A notification the Registry could not take stays pending and goes out with the next settle. A Secret request notifies when it is first asked, in the background so the request neither waits for the push nor is held past an abort (`input`, naming the Secrets and the agent's reason, never a value). A Browser Handoff notifies the same way (a `notice` with the instructions as its body and the Live View link as its `url`).
  - **Client:** `apps/web/public/sw.js` is the service worker (scope `/`, no caching): it shows the push, and on a tap focuses the window showing the Session, takes another window of the app to it, or opens one. The manifest and icons make the app installable; on iOS a push needs the installed app.
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
apps/browser/             browser Worker: BrowserHost DO (agents/browser on Browser Run)
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

- **Worker Shell `git status` is not git's.** `git status` stays on the Worker Shell because a cheap status is what the model runs most, but `@cloudflare/computer` 0.5.1's client prints `1 XY path` and `? path` lines (not git's long format), sorts them by path, lists untracked files one by one (git collapses a directory to `dir/`), and gets the staged column wrong whenever the index holds staged entries: a staged, otherwise clean modification prints `MM` (git: `M `), a staged new file `AM` (git: `A `), and a staged new file modified again `A ` (git: `AM`). Unstaged changes, deletions, and untracked files match git, and `.gitignore` is honored. Staged entries come from `git add`, which runs in the Container and reaches the Worker Shell through sync, so `git add` then `git status` is the case that is wrong; if that proves a problem in practice, route `status` to the Container too (one entry in `GIT_ON_WORKER`, at the cost of #22's acceptance example). A tracked file under `TOOLCHAIN_IGNORE` shows as deleted, since the Worker Shell's tree does not hold ignored paths. The Worker Shell and the Container have two different git implementations over one tree, so a repository one wrote is read by the other; the Workspace DO builds the Worker Shell's git client anew for every call (`workerShellGit`, `git.ts`), because one long-lived client caches the index and, having read a repository before its first `git add` (no `.git/index`), kept reporting every committed file as deleted after the Container committed (seen deployed; the workerd test replays it with files real git wrote).
- **Worker Shell git memory.** isomorphic-git reads a whole packfile into memory, and the Workspace DO has 128 MB for everything it hosts, so `git status` or `git log` in a clone with a big pack could take the Workspace down. The Worker Shell's git client (`apps/server/src/workspace/git.ts`) is built anew for every call, so a pack is read again each time, and it refuses any command in a repository whose `.git/objects/pack/*.pack` files total more than 16 MB (`MAX_PACK_BYTES`): the command fails with a message to rerun with `backend: "container"`. Loose objects are not counted, and 16 MB is a conservative guess, not a measurement of where the DO runs out.
- **Preview packages.** `@cloudflare/computer` is a preview: its container backend, the Worker Shell, and computerd are experimental. Pin versions and keep the image and package in lockstep.
- **Unreleased pi-durable features.** `onWake` is not in pi-durable 1.3.0, so the heartbeat fallback is needed until the next release.
- **Container behaviour.**
  - Exec and mmap of binaries from the FUSE mount **work**, measured on Cloudflare (`standard-2`, real `/dev/fuse` mount at `/workspace`, computerd 0.5.1): a copied `perl`, `python` (with its `PYTHONHOME`), and a 120 MB `node` run from `/workspace`; a shared library copied there is mapped by the dynamic loader (`LD_LIBRARY_PATH`, `LD_DEBUG=libs` shows `calling init: /workspace/…`); Python's `mmap` reads a 1 MiB file there with `MAP_PRIVATE` (hash equal to `sha256sum`) and writes one with `MAP_SHARED`, which the Worker Shell then reads. Copying the 120 MB binary took 0.8 s. Under `alchemy dev` the local Docker has no `/dev/fuse`, so computerd uses its userspace shim (a plain directory), where the same script passes; only a deploy exercises FUSE.
  - The Worker Shell sees Container writes, and the Container sees the Worker Shell's, through computer's sync (checked both ways, locally and deployed).
  - Snapshot restore with computerd and `ignore` paths is untested.
  - Cross-boundary renames return `EXDEV`, so tools must keep install and temp directories on one side. Toolchains and `/tmp` are on the Container's disk, and dependency directories are inside the ignored tree they are installed in, so `npm install`, `pip install` and `mise install` all pass (checked deployed).
  - **`listxattr` on an ignored path fails.** Measured on Cloudflare (real FUSE, computerd 0.5.1): `os.listxattr` on a file under an `ignore`d path raises `ENOENT`, where a synced path returns `[]`. Python's `shutil.copystat`/`copy2` and `cp -a`/`mv` (which warn) hit it, so `python -m venv` (ensurepip copies wheels out of the Python install) failed when the Toolchains were under `/workspace/.mise` on the ignore list. They are on the Container's disk instead, where it works. `shutil.copy2` of a file inside `node_modules` or `.venv` still fails: report upstream to computerd, and revisit if it is fixed.
- **1Password in Workers** is unproven ([issue #184](https://github.com/1Password/onepassword-sdk-js/issues/184)).
- **Exposure of the shared browser session.** Raw CDP in the shared browser session can read cookies and filled values, so prompt injection from pages is the main threat. Mitigations are host-side fills, origin checks, and per-item approval.
