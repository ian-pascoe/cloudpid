# cloudpid

A personal, always-on coding agent that recreates the local pi harness on Cloudflare. pi-durable runs the agent, `@cloudflare/computer` holds the files and runs commands, alchemy provisions everything, and Effect is the application language.

These documents record the settled design (first settled on 2026-10-20). Terms follow [`GLOSSARY.md`](../../GLOSSARY.md); the hard-to-reverse choices have ADRs in [`docs/adr/`](../adr/). How to run, deploy and upgrade the stack is in [`docs/development/`](../development/).

| Document                                           | Covers                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `overview.md` (this one)                           | Scope, the Durable Objects, the Session host, the Effect boundary, models, settings, repository layout, milestones    |
| [`workspace.md`](workspace.md)                     | Environments, Repos and Workspaces, the file tools, Skills and project instructions, backends and `bash` routing, git |
| [`container.md`](container.md)                     | The Container: image, Toolchains, bootstrap, Setup and Start Scripts, settings, snapshots, Builds, idle stop          |
| [`agent-capabilities.md`](agent-capabilities.md)   | The agent's tools: tool discovery, subagents, context management, todo, Secrets, web                                  |
| [`browser.md`](browser.md)                         | The browser tool, Browser Handoff, the Browser Pane and Container previews                                            |
| [`agent-changes.md`](agent-changes.md)             | The agent's changes to Environments and Settings, and the owner's Approval                                            |
| [`client-and-protocol.md`](client-and-protocol.md) | The Session socket, Registry RPC, the web UI, notifications, the Session list and titles                              |
| [`diffs-and-review.md`](diffs-and-review.md)       | Call diffs, Changes, Comparisons, the Run diff, the Diff pane, Annotations and Reviews                                |
| [`operations.md`](operations.md)                   | Infra, stages, Access, telemetry, Container cost, the spend limit, testing                                            |
| [`risks-and-spikes.md`](risks-and-spikes.md)       | Known risks and what was measured                                                                                     |

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

| Object                  | Key                           | Holds                                                                                                                                                                                                  |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session DO**          | UUIDv7                        | One pi-durable Harness: the root conversation, its subagent conversations, tasks, documents, usage. It is bound to one Workspace.                                                                      |
| **Workspace DO**        | `ws:<id>`, the Workspace's id | One `@cloudflare/computer` Workspace and its Container: one Workspace's clones. Its Sessions share it.                                                                                                 |
| **Registry DO**         | singleton                     | Environments, Workspaces and Session listings (title, timestamps, status, subagents), settings overrides, push subscriptions.                                                                          |
| **Codemode sandbox DO** | Session DO id                 | QuickJS script execution. It lives in a separately deployed Worker so scripts run in another isolate.                                                                                                  |
| **Browser host DO**     | Session DO id                 | The Session's one Browser Run browser (`agents/browser`) and the runs of the model's CDP code. It lives in the `Browsers` Worker, which binds the `Workspaces` Worker's Container previews entrypoint. |

The Harness and the Workspace live in separate objects ([ADR-0001](../adr/0001-session-and-workspace-durable-objects.md)). An Environment's Build is made by a Workspace DO of its own, `build:<environment id>` (`buildObjectName`; see [_Builds_](container.md)). The Workspace DO is hosted by its own plain Worker, `Workspaces` (bound as `WORKSPACES`): the Worker Shell reaches the DO through a `WorkspaceServiceProxy` entrypoint the hosting Worker must export (`ctx.exports`), and an alchemy Effect Worker's generated entry exports only `default` and its Effect DO classes. Session DOs bind it across scripts with `Cloudflare.DurableObject("Workspace", { scriptName: Workspaces.workerName })`, the Output and not a literal, so `Workspaces` deploys first; they call it through the raw `DurableObjectNamespace` stub, which `getWorkspace()` and `ComputerExecutionEnv` need. The two Workers deploy separately, so `ComputerExecutionEnv`'s requests to the DO only ever gain operations, never change existing ones. The `Browsers` Worker binds the `Workspaces` Worker too, through a service binding to its `WorkspaceContainerPreviews` entrypoint (`Cloudflare.WorkerEntrypoint`), which offers a Workspace's Container preview and nothing else of the DO ([_Container preview_](browser.md)); the Session DOs and the browser host DOs deploy apart as well, so the host's methods only ever gain trailing optional arguments.

### Session host

The Session DO opens the Harness with `openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" })` and wakes itself from its alarm. It follows the pattern in pi-durable's `test-workers/worker.ts`, not Cloudflare's `PiHarness` ([ADR-0002](../adr/0002-own-session-host.md)).

- Arm a 60 s heartbeat alarm while any task is live, a sleeping one included; a blocked task (no definition takes it, or the restart limit parked it) and one that waits on others do not count. pi-durable 1.4.0 has `HarnessOptions.onWake` and `Harness.wake()`, but they are not used: `wake()`'s `active` leaves out a sleeping task, which may be a Run's generation sleeping out a retry backoff, so the Session would report itself idle and clear its calls' state mid-Run. Without `onWake` the Harness keeps a timer for the earliest sleep itself, and `resume()` after an eviction wakes a sleep that came due.
- pi-durable parks a task cut off by a crash, eviction or reset 5 times in a row without committing a new state (`settings.restartLimit`, left at its default): it is blocked until stopped, and its Run stays busy. The Harness's `onReport` (a parked or faulted task, a hook or listener that threw) is logged as a warning.
- Arm the alarm before admitting work. Call `resume()` from the constructor and the alarm.
- Long model streams are bound by the platform's wall-time limits. pi-durable resumes interrupted work.

### Effect boundary

Effect is the language everywhere except pi-durable's own core ([ADR-0003](../adr/0003-effect-around-pi-durable.md)).

- Each DO builds its Layers once and keeps a `ManagedRuntime`. Services (`Context.Service`) include `Harness`, `WorkspaceClient`, `Models`, `Settings`, `Secrets`, `Registry`, and `Telemetry`.
- `packages/effect-durable` provides `defineEffectTool` (Effect `Schema` parameters compiled to TypeBox/JSON Schema), `effectHook`, `effectSection`, `frozenSection` (a section read once per context and then shown as it was), and `effectTask`. Chord `Context` cancellation becomes fiber interruption, and typed failures become tool error results (`effectTask`: the task's `failed` outcome; a defect faults it, as a native throw does). A task's phases run as Effects but still commit their checkpoints through `runtime`.
- Harness internals, commits, documents, and task phases stay native. Effect reaches them through thin facades (`Effect.tryPromise`), never a parallel scheduler.

### Models

- Requests go to the existing proxy `api.ai.ianpascoe.dev` with a Commissary API key, sent as each provider's native API key (`x-api-key` for Anthropic). The proxy is Commissary's API host, which sits outside Cloudflare Access and rejects service tokens. Model IDs match `~/.pi/agent/models.json`.
- Default `anthropic/claude-opus-5-5` at `high` thinking.
- Roles: `small` haiku-5-5, `medium` sonnet-5-5, `large` opus-5-5, `xlarge` fable-5-1, with the hints from `~/.pi/agent/settings.json`.

### Settings

- A typed Effect `Schema` with defaults in `packages/config`: every field has a decoding default, so decoding the overrides gives the resolved settings, and the schema's `Encoded` side is the overrides' shape (a deep partial that rejects unknown keys). Invalid overrides fail with one readable line per problem.
- They are kept at two Scopes ([ADR-0027](../adr/0027-settings-at-two-scopes-with-explicit-overrides.md)). **Global**: a Registry DO document (the `documents` table, named `settings`), editable in the UI at `/settings` over `getSettings`/`updateSettings`. The document is added by a Registry migration (the `documents` table). A write is strict and keeps only what differs from the defaults, so a setting left alone follows later default changes; a read is lenient: saved overrides that no longer resolve (a model a release dropped) are left out one by one and listed in `problem`, and the rest still apply. `getSettings` also answers, for each field, the Environments that override it (`overriddenIn`). **An Environment**: its Settings Overrides, in its row (`environments.settings_overrides`, Registry migration 26; none for an Environment stored before, which inherits Global whole), over `getSettingsOverrides { environment }` (its `overrides`, the Global settings it inherits as `global`, and the two resolved as `settings`) and `updateSettingsOverrides { environment, set?, reset? }`. An Override is explicit: exactly the fields set on purpose, even one equal to the Global value (it is then pinned, and Global's later change does not reach it), until a reset removes it. `set` is a deep partial merged field by field; `reset` names fields. The fields (`packages/config/src/settings-overrides.ts` → `overrideFields`, also the Agent changes' fields) are `model`, `thinkingLevel`, each Role (`roles.<name>`, its model and hint as one value: one set in part is completed from the Role in force), each compaction setting (`compaction.enabled`, …), `tools.offered` (the list replaced whole), `spendLimit.perSession` (an Override of null is no limit for the Environment), `branchSummary.skipPrompt` and each extension option (`extensions.<extension>.<key>`; null resets it). A write is checked strictly over Global; a read is lenient: an Override that no longer resolves is left out, its field inheriting Global, and listed in `problem`. The renamed-tools fix-up (`restart_container` read and saved as `container_restart`) applies at both Scopes.
- **Resolution**: an Environment's settings are its Overrides over Global over the defaults (`resolveOverridesLeniently`). Each Session reads what it resolves from the Registry (`sessionSettings { session }`: Global's overrides and its Environment's Overrides) when a client connects and before it admits input (outside the alarm lock, and not again for 30 s after a failed read), and keeps the last read in its own storage (`settings-source`; a Session that kept only Global's overrides before Overrides existed, `settings-overrides`, starts from them as before), so a change at either Scope applies to the next request of new and idle Sessions without a redeploy and is what a client first sees, and a Registry that is down never stops one. Its subagents run with the same settings: they share the Session's Environment. Two Sessions in different Environments can run with different models, offered tools and spend limits. The web app's branch summary prompt reads the shown Session's Environment's settings. A default changed during a Run reaches the Run from its next provider request, as a pick does. The Harness's `compaction` is a getter over that copy. The default model and thinking level are written to the root conversation's agent before each request unless the Session picked its own (see `configure`); a pick of a model the settings no longer accept is ignored.
- They cover models, roles, thinking level, compaction, the offered tools (`tools.offered`, see [_Tool discovery_](agent-capabilities.md#tool-discovery)), the spend limit (`spendLimit.perSession`, US dollars, off by default; see [_Operations_](operations.md) → Telemetry), whether a move in the Session tree asks about a branch summary (`branchSummary.skipPrompt`, off by default; see [_Session tree_](client-and-protocol.md)), and extension options. A Workspace's Container size, size limit, idle time, extra Container-only paths, variables and Setup and Start Scripts are not in this document: they are its Environment's settings, kept in the Registry with the Environment (see [_Container settings_](container.md)).
- **The agent changes them too** (ADR-0019, ADR-0027, [_Agent changes_](agent-changes.md)): the `settings_*` tools change the model and thinking level, the roles, the offered tools, compaction, the branch summary prompt and extension options, each at a `scope` the agent must name (`*` for Global, or an Environment's id), and `settings_reset` resets a field (an Environment's Override removed, or Global's back to its default). Each change is checked and written as `updateSettings` or `updateSettingsOverrides` is, recorded with its reason under the Scope, listed with a revert, and reaches the next provider request of the Sessions that run with it. The Limits (`spendLimit.perSession`, `subagents.maxSubagentDepth`, `subagents.maxSubagentWorkspaces`) change only with the owner's Approval, at either Scope, set or reset (`settings_spend_limit_set`, `settings_subagent_depth_set`, `settings_subagent_workspaces_set`, `settings_reset`: [_Approval_](agent-changes.md#approval)).

## Repository layout

The repo is a Turborepo with pnpm workspaces. Internal packages are just-in-time: `exports` point at `src/*.ts`, and the Workers' bundlers compile them.

```
infra/                    alchemy stack (alchemy.run.ts): Workers, DOs, Container, Access, secrets
apps/server/              main Worker: Session, Registry DOs; HTTP/WS API; static assets.
                          Workspaces Worker (src/workspace): Workspace DO
apps/codemode-sandbox/    codemode sandbox Worker
apps/browser/             browser Worker: BrowserHost DO (agents/browser on Browser Run), ContainerPreviews entrypoint
apps/web/                 Vite + React UI
apps/sandbox-image/       image/Dockerfile (computerd, mise, preinstalled Toolchains, C toolchain; the Docker build context), base mise.toml, bootstrap
packages/effect-durable/  Effect ↔ pi-durable adapters and service facades
packages/computer-env/    ComputerExecutionEnv
packages/extensions/      one subpath export per extension (/subagents, /context, /todo, /web, /secrets, /browser, …)
packages/protocol/        Session socket messages, RegistryRpcs, AgentEvent reducer, transcript projection
packages/config/          settings Schema and defaults, model roles, shared tsconfig and vitest bases
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
