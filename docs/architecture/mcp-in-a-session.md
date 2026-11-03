# MCP in a Session: tools, resources and prompts

What an MCP server gives a Session's agents and its owner: tools, resources, prompts and completions, and what cloudpid answers a server about roots and logs. Everything here runs in the Session object and the web app. The Session reaches servers only through the Environment's `McpHost`, using `McpHostClient` (`@cloudpid/extensions/mcp`, with a live adapter in `apps/server/src/session/mcp-host.ts` and an in-memory fake for its tests, `packages/extensions/src/mcp.testing.ts`). It never imports `@modelcontextprotocol/*`, only `@cloudpid/mcp/types` (see [_Packages and objects_](mcp.md#packages-and-objects) and [_RPC_](mcp-connections.md#rpc)). The pure functions the Session, the Settings page and `settings_mcp_*` share live in `@cloudpid/config`: Exposure resolution, `conn` and `mcpServerIdentity`.

## The `mcp` extension

MCP tools reach a Session as one `mcp` Session extension built from the Environment's MCP inventory. Each tool's `execute` calls `McpHost.request({ op: "tools/call" })` ([ADR-0030](../adr/0030-mcp-tools-reach-a-session-as-an-extension-rebuilt-from-the-mcp-inventory.md)).

- **Request start:** at each request start, where the Session already refreshes its Settings, it calls `McpHost.requestStart({ caller: { session, conversation, workspace }, known, windowOpened?, waitFor?, waitMs? })`. **Precondition for a stdio server:** the Session's Workspace readying is lazy, so before `requestStart`, or any `McpHost` call that may reach the bridge, the Session awaits a call to its calling Workspace (`noteSessionActivity`, for one), so the Workspace has marked itself. `WorkspaceMcpBridge`'s 404 `no_workspace` means "never used, or destroyed", and this precondition is what makes the host's reading of it as destroyed right ([_The stdio bridge_](mcp-connections.md#the-stdio-bridge)).
  - **Returns:** `{ version, promptsVersion, servers: { [name]: { toolsHash, promptsHash, state } }, watches: { changed, ended }, features }`.
  - **Skipped:** a Session whose `sessionSettings.mcp.servers` is 0 and which has no Resource watches makes no call, so `McpHost` is never woken for an Environment without MCP servers.
  - **`windowOpened`** is set on a Context Window's first request. It makes the host ask the Registry for the MCP server set.
  - ([The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382) D2.1, D6.1)
- **Rebuild:** the Session installs `mcp`, `codemode` (with the servers as `CodemodeNamespace`s, a static option) and `tool-search` again, together, when any of these changes:
  - the inventory's `version`;
  - `tools.offered`;
  - the `features` its tool declarations used ([Deploys under deferred Durable Object code updates](https://github.com/ian-pascoe/cloudpid/issues/423) D1.2).

  The reload replaces the `mcp` entry in the extension list `host.ts` captures at start ([MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D1).

- **Versions are content hashes** over stored canonical JSON.
  - A reinstall over unchanged tools gives byte-identical declarations and sections (tested).
  - A flip back brings the old version back.
  - `promptsVersion` is separate, so a change to prompts alone never reinstalls `mcp` ([MCP prompts and completions](https://github.com/ian-pascoe/cloudpid/issues/386) D9.1).
  - Editing `description`, `timeout`, `enabled`, `exposure` or `toolExposure` bumps `version` but never reconnects, since `conn` leaves them out ([The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382) D3.1, D3.5).
- **Waiting:** a server that has an inventory is never waited for.
  - A Session's first request waits up to 10 s (`waitFor`) only for servers that have no inventory yet and whose Exposure can yield `direct`. The wait ends early for a server that reaches `sign_in`, `unavailable` or `failed` ([Signing in to remote MCP servers](https://github.com/ian-pascoe/cloudpid/issues/390) D5).
  - Other servers are discovered in the background. `requestStart` may start the calling Workspace's Container to discover a stdio server.
  - Scripts, `searchTools()`, `ALL_TOOLS`, `describeNamespace()` and `tool_search` read the inventory from the request's start.
  - A call connects lazily within the definition's `timeout`, and wakes the Container for a stdio server.
  - pi's per-script `reachesTools` wait is not ported ([MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D7).
- **Set changes under a Session:**
  - The next reinstall drops removed tools.
  - A stale name added by `modelTools.add` is left in place, so a returning server's loaded tool stays loaded.
  - A call in flight is not cut by the reinstall, but fails (`ServerChanged`) if the host drops its connection.
  - A rename caused by a new collision is not announced ([MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D19).
- **As built** ([#452](https://github.com/ian-pascoe/cloudpid/issues/452)): `McpTools` (`packages/extensions/src/mcp.ts`) is what a Session holds per runtime, one for each Environment, and `sessionMcp` (`apps/server/src/session/mcp-host.ts`) is the Session host's `mcp` option: `start`, a request start's host calls, and `reinstall`, what to install for what the tools are built from now.
  - **Where it runs:** in an owner message's prepare step (`startRequest` in `session/host.ts`), after the Settings are read, with no Session lock held, so a wait for discovery holds up neither Stop nor another conversation. Starts of different conversations run side by side, and each read of the host's inventory is numbered when it is sent, so only a newer read replaces the one the tools are built from; a start that finds the version unchanged takes a number too, so a read sent before it never lands over what it confirmed. Every install after the object starts (a Settings reload's and a start's) takes one install lock, uninterruptibly, and builds what it installs under it from the settings in force then, so an older build, or one for older settings, never lands over a newer one, nor is a build cut from its install by a Stop that withdraws the message. Subagents' conversations make no request start of their own yet: the inventory is the Environment's, shared, and a request start is made as the Session's. Their calls are not: each names the Workspace of the conversation that makes it (its own Subagent Workspace's, or its nearest ancestor's, else the Session's), and a call to a stdio server marks that Workspace used before it is sent (`McpToolOptions.ready`), so a stdio server runs in the Container of the Workspace that calls it ([#460](https://github.com/ian-pascoe/cloudpid/issues/460); what a child inherits is [#462](https://github.com/ian-pascoe/cloudpid/issues/462)'s). Their `mcp_servers` notices come from their requests' own section render instead (see [_The prompt cache and the `mcp_servers` section_](#the-prompt-cache-and-the-mcp_servers-section)).
  - **Restart:** the last build's inventory is kept in the Session's storage (chunked in `kv`), only what the build reads of each server (`McpBuildServer`: its name, state, tools and `instructions`, and of its entry `type`, `timeout`, `description` and the Exposure keys, never its URL, headers, `env` or OAuth, where a Repo file may hold a literal credential; text kept with more is written again without it, and text that cannot be read is nothing kept), and the Session host installs it again when the object starts, before anything resumes, without calling the host: a resumed Run or call finds the tools and the declarations its Context Window was shown. A resumed `mcp__` call settles as "interrupted and may have partially run" when its `mcp.sent` marker is there ([#458](https://github.com/ian-pascoe/cloudpid/issues/458); [_Calls and results_](#calls-and-results)); the other markers are later.
  - **What it needs:** the Environment's ID and MCP server count, which the Registry's Session settings source carries (`sessionSettings.mcp`). A Session in no Environment, or with no servers, calls nothing and has no MCP tools (Resource watches come with [#478](https://github.com/ian-pascoe/cloudpid/issues/478)); with servers, it first awaits `noteSessionActivity` on its Workspace, every time (the precondition above), then calls `requestStart`. A mark that fails is tried once more; if that fails too, the start is skipped with a warning, calling no host, and the tools stay as they were built. So is a start whose Workspace cannot be looked up, or whose Session the Registry does not name: a failure, not "no servers", so nothing built is dropped for it.
  - **`windowOpened`** is set on the first request start of each Context Window (the conversation's latest head marker entry, `latestHeadMarker`): the Session keeps each conversation's last opened window in `kv`, so it is set once per window, whatever evictions come between.
  - **The wait:** before its first build, the Session asks `servers({ parts: [] })` for the servers with no inventory, and passes those whose Exposure, `toolExposure` or an offered pattern can make a tool `direct` (`mayBeDirect`) as `waitFor`, with `waitMs` 10 s.
  - **The rebuild key** is `version`, `tools.offered`, the features of `MCP_TOOL_FEATURES` (`inventory` and `call`) the host lists, and the caller the tools call for. On a change, the Session reads `servers({ parts: ["tools", "instructions"] })` and installs `mcp` (which carries the `mcp_servers` section, the same one in every build), `codemode` with the servers as namespaces, and `tool-search` (`reloadToolSearch`) together; an equal key installs nothing. The build is pure over the host's answer and the offered set, so a reinstall over unchanged tools is byte-identical (tested in `packages/extensions/src/mcp.test.ts` with the real `codemode`: the same declarations and no new system section).
  - **Degrading:** a host that lists neither feature (an older host) gives no MCP tools; a host that fails, or answers something this build cannot read, keeps the tools built, and the request starts anyway.
- **Other tools in `mcp`:** `mcp_sign_in_ask`, registered only when the set has an OAuth-capable HTTP server (see [_Sign-in requests_](mcp-sign-in.md#sign-in-requests)), and the `mcp_tasks` / `mcp_task_wait` / `mcp_task_cancel` tools (see [_MCP tasks_](mcp-server-requests.md#mcp-tasks)) are part of the same rebuild. The `settings_mcp_*` tools are a static `settings_mcp` extension instead (see [_The agent's changes_](mcp-configuration.md#the-agents-changes)).

## Exposure

Exposure decides how each tool is registered. It is resolved by one pure function, `resolveExposure` (`packages/config/src/mcp-exposure.ts`), which also says what decided each tool. The function takes the server's `exposure` (default `codemode`, with alias `codemode-deferred`), then `toolExposure`, keyed by the server's own tool names as pi's are (not cloudpid's snake_case spelling), where exact names beat `*` patterns and the first matching pattern wins. The MCP inventory itself knows nothing of Exposure ([MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D2).

| Exposure   | Registration                              | Reached by                                                                                                                            |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `direct`   | registered and offered                    | the model and scripts                                                                                                                 |
| `deferred` | `deferred: true`                          | `tool_search`, then the model; scripts at any time                                                                                    |
| `codemode` | `callers: ["tools"]` and `deferred: true` | scripts only: not in the `codemode` section's inline list, not in `agent.deferred` (so `tool_search` can't load it), still `callable` |
| `hidden`   | not registered                            | nothing; the server's App Views can't call it either                                                                                  |

- **`tools.offered`:** a match lifts a `codemode` or `deferred` tool to `direct`, never a `hidden` one. `tool-search` does not wrap `mcp__*` tools: the `mcp` extension reads the offered set itself.
- **Tool visibility:** a tool reaches the model only if its visibility includes `"model"` and its Exposure isn't `hidden`. `tools.offered` can't lift an `["app"]`-only tool ([Rendering an MCP App in the web UI](https://github.com/ian-pascoe/cloudpid/issues/384) D7). See [_A View's calls_](mcp-apps.md#an-app-views-calls) for what an App View may call.
- **`deferred_tools`** leaves out every `mcp__*` tool, since its family grouping by first `_` would lump them together. The `mcp_servers` section says how each server's tools are reached instead (D4).
- **`autoEnableCodemode` is not ported:** it has no key under `mcp`, and a pi import ignores it with a hint.
  - The `mcp_servers` intro tells the model to load `codemode` with `tool_search` first when the conversation's `codemode` is deferred.
  - The Settings MCP section warns when `tools.offered` lacks `codemode` while a server has `codemode` exposure (D8).
- **As built** ([#452](https://github.com/ian-pascoe/cloudpid/issues/452); `mcpExtension` in `packages/extensions/src/mcp/tools.ts`, its flags in `mcp/exposure.ts`, its results in `mcp/result.ts`): each tool the inventory lists is registered by the flags of the table, from `resolveExposure` over the entry's `exposure` and `toolExposure` and the offered set; a server switched off registers nothing, nor does a tool whose `_meta.ui.visibility` leaves out `"model"`. An entry's Exposure this build does not know reads as `codemode`. `tool-search` neither wraps nor lists `mcp__*` tools (`isMcpToolName`, with the other `mcp__` name helpers in `@cloudpid/config`). The `mcp_servers` section is built ([#461](https://github.com/ian-pascoe/cloudpid/issues/461); see [_The prompt cache and the `mcp_servers` section_](#the-prompt-cache-and-the-mcp_servers-section)).
- **Not registered:** these become per-tool problems shown in `settings_mcp_get` (see [_Lists_](mcp-configuration.md#lists)):
  - a tool whose `x-mcp-header` fails `xMcpHeaderProblems` ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D14);
  - a Legacy tool with the experimental `execution.taskSupport: "required"`. Legacy calls `optional` ones synchronously ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) E2, as amended into [MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) by [MCP tasks](https://github.com/ian-pascoe/cloudpid/issues/389));
  - tools past the per-server bound: 500 tools and 1 MiB of declarations, in list order.
- **Kept, with a problem:**
  - An `inputSchema` that TypeBox `Compile` rejects is declared as a loose object.
  - An `outputSchema` that throws or uses remote `$ref`s declares `structuredContent` as any JSON.
  - Descriptions are cut at 4,000 characters, with no server prefix (D15, D16).
- **Subagents:**
  - An inheriting child gets MCP tools as its caller has them. Presets and exact lists include them only by pattern or name.
  - A `codemode` tool is never offered to a child, and `hidden` is never in a ceiling.
  - A child's enabled list is fixed at spawn, so tools a server adds later don't reach it. A `tools: { remove }` for inheriting children is a later addition.
  - A child in a Subagent Workspace runs stdio servers in its own Container and shares the Environment's inventory (D13).

## Tool names

- **Shape:** `mcp__<server>__<tool>`, both parts snake_case, computed by one pure normalization in `@cloudpid/config` (`mcpToolName`, `mcpToolNames` and the importer's `mcpToolNameFromPi`, in `mcp-tool-names.ts` beside the Exposure resolver) that prompts, the importer of pi transcripts and `settings_mcp_*` share ([MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D6).
  - **Server part:** lowercased, with `-` → `_`.
  - **Tool part:** `_` inserted before each uppercase run, lowercased, `[^a-z0-9]` → `_`, runs of `_` collapsed and ends trimmed (`getUser` → `get_user`). It is runs of `a-z0-9` joined by single `_`, and may begin with a digit (`2fa`). A tool with no letter or digit (`-`) becomes `tool`, and the collision rule tells it from a real `tool`.
- **Collisions:** every member of a collision gets `_` plus 8 hex digits of `sha256("server\0tool")`, with the normalized server name and the tool as the server calls it (so a change of the server name's case or `-` renames nothing). A hashed name that equals another tool's plain name hashes that one too. Since every member is renamed, a name never depends on the order a server lists its tools in.
- **Length:** a name over 64 characters is cut to 55 (a trailing `_` trimmed), then `_` and the hash. This is the providers' limit: Anthropic `^[a-zA-Z0-9_-]{1,64}$`, OpenAI ≤ 64. A server name of 48 characters or more leaves no room for a tool part in those 55: the name is then `mcp__<server cut to 44>__<hash>`.
- **Server names** clash case-insensitively and `-`/`_`-insensitively, across every layer of the set.
- **Exception to the rule:** the double underscore of `mcp__` is an exception to the Tool-names rule, and `@cloudpid/effect-durable`'s tool-name check (`isToolName`) learns it: `mcp__<server>__<tool>`, the server part lower-case `[a-z0-9_]` (it may hold `__`) and the tool part runs of `[a-z0-9]` joined by `_` (a digit may lead). Nothing else is excepted.
- **Where cloudpid's spelling is used:** `tools.offered`, toolsets, Notes and imported pi transcripts. The Session-import translator maps pi's `mcp__x__getUser` through the same function and leaves unknown names as they are (see [_Translation_](mcp-endpoint.md#translation); [ADR-0030](../adr/0030-mcp-tools-reach-a-session-as-an-extension-rebuilt-from-the-mcp-inventory.md)).
- **In owner UI:** the configured server name is shown; model-facing text uses the normalized `<server>` part.

## The prompt cache and the `mcp_servers` section

- **Declarations follow the inventory from the next request.** Each change costs one prompt-cache miss per conversation, as a `tool_search` load does. Declarations are not frozen per Context Window: registration is Session-wide, and a withdrawn tool would stay declared ([MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D3).
- **The `codemode` section** gives no header to a server with no `direct` tool, so a new namespace leaves it unchanged (D17).
- **`mcp_servers`** is a `frozenSection`, read once per Context Window. It lists the enabled servers that have any `codemode` or `deferred` tool, or resources, by name:
  - The line format is `- mcp__<server> (codemode|tool_search|direct): <summary>`; `direct` is the label of an all-`direct` server listed for its resources only.
  - The line ends `· resources` when the server has resources. An all-`direct` server with resources gets a line too ([MCP resources](https://github.com/ian-pascoe/cloudpid/issues/385) D2.2).
  - The summary is the definition's `description`, else the first line of the server's `instructions` with control characters stripped, else none.
  - The summary is capped at 250 characters, and the whole section at 4,096, with any overflow counted.
- **Line states:**
  - An undiscovered server reads `(connecting)`.
  - One that needs sign-in reads `(needs sign-in)` ([Signing in to remote MCP servers](https://github.com/ian-pascoe/cloudpid/issues/390) D5.1).
  - A server that has an inventory keeps its line.
- **The intro** names:
  - how a `(codemode)` server is called, `tools.mcp__<server>__<tool>(args)`, and that a `(direct)` server's tools are in the tool list already;
  - the three resource tools, when the build registers them;
  - loading `codemode` with `tool_search` when it is deferred;
  - `mcp_sign_in_ask`, in one sentence, when the build registers it.

  It never mentions prompts.

- **Changes** are never patched into the section. A change reaches the model as a notice: a pi-durable `write` submission of `kind: "cloudpid.mcp-servers"`, a user message with `data.notice`.
  - It is placed at the next boundary while busy, at once when idle, and never starts a Run.
  - What a conversation was last shown is read from its own context, so there is one notice per change per conversation, subagents included (D14).
  - `settings_mcp_*` results say that the section stays as it is for this Context Window and that a notice follows (see [_Results_](mcp-configuration.md#results); [The agent's changes to MCP servers](https://github.com/ian-pascoe/cloudpid/issues/391) D9.1).
- **As built** ([#461](https://github.com/ian-pascoe/cloudpid/issues/461); the pure listing, intro and notice text in `packages/extensions/src/mcp/servers.ts`, the notice's Harness writes in `mcp/notices.ts`, `McpTools` in `mcp.ts`, the Session host's calls in `apps/server/src/session/host.ts` and `mcp-host.ts`):
  - **The section** is built by every `mcp` extension: the one `McpTools` builds, and `emptyMcpExtension`, which a Session starts with and whose section is frozen empty, so that a Session with no servers shows nothing now and is told of one by a notice later, never by a patch to its running prompt. The section reads the newest listing (the one of the last reinstall) when it is first read in a Context Window, so a reinstall over unchanged lines is byte-identical (tested with a real run: the same system messages, a flip back included).
  - **What is listed:** an enabled server that has a tool the model reaches that is `codemode` or `deferred` (after `tools.offered`, which lifts a tool to `direct`) or has resources (`McpServerInventory.resources`, as the host carries it: `· resources` shows as soon as a server declares the capability, though the resource tools themselves are not built yet), or one with no inventory yet whose entry can make a tool `codemode` or `deferred`. The line says `(tool_search)` when every tool that is not `direct` is `deferred` and `(codemode)` otherwise (scripts reach every such tool), and `(direct)` for a server whose tools are all `direct` and that is listed for its resources only. A server hidden by its own `exposure` is listed only through a `toolExposure` that lifts one of its tools, and never shows `· resources`. A server with no inventory reads `(needs sign-in)` in the `sign_in` and `rejected` states and `(connecting)` in every other, `failed` and `unavailable` included, as the design says (the host's own state is what `settings_mcp_*` and the Settings page will show). A summary that carries `<` or `>` shows them as `‹` and `›`: a server's words must not close the section.
  - **The caps:** the summary is cut at 250 characters (the cut ends in `…`), and the listing may take what the 4,096 leave beside the longest intro (the section is within 4,096 whichever intro it has); servers past it end in `- … and N more not listed`. The intro never depends on the listing, so the listing is all a hash stands for.
  - **The notice** carries the whole new listing, never only the lines that changed: a conversation's context holds only the hash of the listing it was last shown, which cannot say what differs, and one list that replaces the last cannot be misread after several changes. (It also costs at most one more 4 KiB entry, and only for a change.) When the section the conversation was shown listed nothing, the notice also carries the intro, which the section never did, with whether `codemode` is deferred for that conversation.
  - **What a conversation was last shown** is derived, not stored: the newest of the section its context holds (`pi.system`) and the notices it has had (their `data.hash`), then any notice still queued (read from `Harness.inspect()`; the listing's hash ends its request ID). So a Handoff, a navigation or a fork needs nothing of its own: a fork inherits the notices of its history, and is told only what is new to it. A conversation whose context holds no section yet (its first request of the window shows it) is told nothing. A listing that flips back to what the section showed while the first notice is still queued is told too, since the model reads the first notice before it.
  - **The request ID** of a notice is `cloudpid.mcp-servers:<entry the check read>:<notices queued>:<listing hash>`: unique for each notice that is due, and the same for a check that ran again after a crash, which finds the first submission instead of writing a second (pi-durable 1.4 cannot admit a submission inside a commit). One conversation's checks run one at a time.
  - **Who checks, and when:**
    - Every reinstall tells the conversations before it installs: `McpReinstall.announce` runs in the host's install lock, ahead of `installOver`, so a notice is queued before any model call can render the declarations it explains (a busy conversation crossing a boundary in between would otherwise call with the new tools and no notice). This holds for each reinstall that changes the listing, whoever made it: a request start, a settings read, `tools.offered` reloaded mid-Run. Each conversation of the Session is asked, so an idle subagent or branch is told at once and a busy one at its next boundary. (A section that told the conversation at its next request instead would be too late: that Run is already busy when the request renders, so the write would queue to the boundary after it.)
    - The owner's conversation is also checked right after its request start's install (`McpTools.notify`, in `startRequest` before its message is placed), so its notice comes before the message and, when it is idle, at once; `notify` also finishes a broadcast that failed.
    - The broadcast is not interrupted (a Stop of the message that ran it never leaves the rest untold), and `changed` is cleared only when every conversation was asked and no newer change came, so a failed one is run again by the next request. One broadcast runs at a time.
    - A Session that starts again keeps, in its storage, the hash of the listing its last completed broadcast told (`McpToolsStore.broadcast`). A wake (an alarm's too) whose kept listing is that hash reads no conversation; one whose kept listing differs, because a crash cut a broadcast off, finishes it once its work is resumed. That announcement runs in the background, not in the start. The notices already written are not written twice (the request ID).
    - `frozenSection`'s `whenShown` still runs for each request that finds the section already shown, as the fallback for a conversation the broadcast missed.
    - A listing that is not known yet (no reinstall returned a build: an object that started again without a kept build) is never compared, so no notice is false; a Session with no MCP server pays nothing.
    - A conversation known to be up to date for the listing in force is not checked again until the listing changes or its section is shown anew. One that showed no section when asked is left out of later broadcasts until its section is shown (its first request shows it as it is). A conversation with a Run live and no section yet may be in its first `prepare`, which shows the section as it is: it is neither told nor left out.
    - A broadcast costs one `Harness.inspect()` for all conversations (read again only for one written since), one context read for each conversation not yet known to be up to date, four at a time.
    - **Known limits.** (a) The notice before the declarations holds up to the boundary: pi-durable places a Run's inbox in `finishToolRound`'s commit and fixes the tools later, in `prepare`, so in a gap of microtasks a request can have the new tools and its notice comes one boundary later. (b) After a crash in the middle of a broadcast, Runs that resume can render the kept build before their notice is written. (c) A Stop and the owner's message wait for a broadcast that their request start runs: it reads storage only, and grows with the number of conversations and the size of their contexts.
  - **The intro's sentences** are made one place each in `mcpServersIntro`, and only for the tools the build registers (`introFeaturesOf` over the extension's tool names): the resource tools and `mcp_sign_in_ask` are not built yet (see [_Resource tools_](#resource-tools), [_Sign-in requests_](mcp-sign-in.md#sign-in-requests)), so their sentences are absent now. The ticket that adds a tool turns its sentence on by registering it. The intro is frozen per Context Window, so it is right once they are.
  - **At deploy**, a live Context Window gets the section added once (empty for a Session with no MCP server); a provider that sends mid-conversation system messages sees an empty `Updated system prompt section "mcp_servers"` message, and a Session with MCP servers has one prompt-cache miss for each live window.
  - **Seams:** `settings_mcp_*` is not built yet either, so the sentence in its results (see [_Results_](mcp-configuration.md#results)) has no result to sit in: the notice does not depend on who changed the set, and needs nothing from those tools.
- **Codemode namespaces:**
  - `name` and `prefix` are both `mcp__<normalized server>`.
  - `description` comes from the definition; `instructions` is the server's full text, cut at 16 KiB.
  - `-` and `_` spellings are both accepted (`toCodemodeIdentifier`); the bare server name is not.
  - An undiscovered server has no namespace (D17).

## Calls and results

- **Text to the model** ([MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D9):

  | Result content           | What the model gets                                                                              |
  | ------------------------ | ------------------------------------------------------------------------------------------------ |
  | text                     | text                                                                                             |
  | image                    | an image, within ResultImages bounds                                                             |
  | audio or unknown         | a placeholder line                                                                               |
  | `resource_link`          | one line (see [_Resource links and embedded resources_](#resource-links-and-embedded-resources)) |
  | embedded `resource` text | text                                                                                             |
  | embedded image blob      | an image                                                                                         |
  | other embedded blob      | a Result Spill                                                                                   |
  - `isError` becomes an error result, using pi's message when the content is empty.
  - Text over pi-durable's limits keeps its head, and the full text goes to a Result Spill in `/workspace/.cloudpid/tmp`, as `bash` does. The Session writes it into the calling conversation's Workspace without waking the Container.
  - Empty `content` with `structuredContent` gives the JSON as text.

- **`details`** is `{ server, tool, title, hints, full_output_path, meta }`. Other areas add these keys:
  - `sign_in` (see [_Sign-in requests_](mcp-sign-in.md#sign-in-requests));
  - Sampling summaries and `elicitation` (see [_Sampling requests_](mcp-server-requests.md#sampling-requests), [_Elicitation requests_](mcp-server-requests.md#elicitation-requests));
  - `mcp_task` (see [_MCP tasks_](mcp-server-requests.md#mcp-tasks));
  - `error`, which is `too_large`, `invalid_structured_output`, `sampling_refused` or `mcp_task_background`;
  - `cut`, which is `host_lost` or `engine_lost` (see [_Failures and cuts_](mcp-connections.md#failures-and-cuts)).

  The tool's `_meta` is passed on each call as `details.meta` (see [_Declaring and reading Apps_](mcp-apps.md#declaring-and-reading-apps)).

- **The script value:** every MCP tool declares `structuredOutputSchema` `{ content, structuredContent?, isError? }`, with `_meta` dropped.
  - `structuredContent` is typed by the tool's `outputSchema`, with local `$ref`s relocated.
  - MCP's camelCase keys are kept, as a documented exception to the snake_case shapes.
  - `isError` resolves rather than throwing.
  - Text blocks are cut largest-first to stay under the nested-value bound, with `truncated: true` (D10).
  - Binary data (an image's `data`, a blob) is never cut: a block that does not fit is replaced whole by a line that says so, before any text is cut.
- **Output validation:** the engine checks `structuredContent` against the schema compiled at discovery and returns `structuredOutput: valid | invalid` ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D17).
  - On an `invalid` result, a model call keeps its text, and the value is dropped and logged.
  - A nested call errors with `invalid_structured_output`.
- **Progress, timeouts and cancellation** (the full timeout and byte-limit tables are in [_Requests and Legacy sessions_](mcp-connections.md#requests-and-legacy-sessions)):
  - The request lives in `McpHost`, which enforces the definition's `timeout` (default 60 s). Progress (at most 10/s) resets the timeout and goes to the running call's `details`, never output text. The web doesn't render a running call's `details`, so an ordinary call's progress shows nowhere else (As built, [#458](https://github.com/ian-pascoe/cloudpid/issues/458), below); an MCP task's progress goes to the `mcp_tasks` list instead ([MCP tasks](https://github.com/ian-pascoe/cloudpid/issues/389), amending [MCP tools in a Session](https://github.com/ian-pascoe/cloudpid/issues/381) D11).
  - The Session waits on its RPC for the timeout plus some slack.
  - Stop aborts the RPC, and the host cancels the request.
  - A cut `tools/call` is never retried in either era. The agent gets "cut before its answer arrived; it may or may not have run".
  - A result over 16 MiB is an error ("over 16 MiB and dropped; the tool may have run", `details.error: "too_large"`), never a truncation ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D15, D16).
- **As built** ([#452](https://github.com/ian-pascoe/cloudpid/issues/452)): a call sends `request({ op: "tools/call" })` with the Session, its conversation and its Workspace, and awaits it for its whole length with its `untilAborted` (resolved by the call's abort signal, so by Stop) and `onProgress` hooks. The model gets text and image blocks, an embedded resource's text, a placeholder line for any other block, `structuredContent` as JSON when there is no content, and `isError` as an error; a failed request is an error with its message (a `Cut` that may have run says so). Its `details` are in the #458 note below. The Session waits at most the server's `timeout` (default 60 s) plus `MCP_CALL_SLACK_MS` (60 s: the three connects of up to `MCP_CONNECT_TIMEOUT_MS` a call may make when its server's era is in doubt, and 15 s for the RPCs) from the call's start or its last progress notice, so the host, which counts a wait for a slot toward the timeout, answers first whenever it can; past that, or when the RPC to the host breaks (`HostLost`), it aborts the call and answers that it may have run, with `details.cut: "host_lost"` and no cause shown to the model (the cause is logged).
- **As built** ([#458](https://github.com/ian-pascoe/cloudpid/issues/458); `packages/extensions/src/mcp/`: `result.ts`, `blocks.ts`, `value.ts`, `schema.ts`, `spill.ts`, `stream.ts`, `details.ts`, `ended.ts`, `head.ts`, `tools.ts`):
  - **`details`:** `{ server, tool, title?, hints?, meta?, full_output_path?, progress?, error?, cut? }` (`McpDetails`, with the hints and the `_meta` bound, in `details.ts`). `progress` is only on a running call. `details` is written and never decoded, so an `error` or `cut` a later build adds is a string an older reader passes over.
  - **Questions ([#472](https://github.com/ian-pascoe/cloudpid/issues/472)):** `details.elicitation` is `[{ server, mode: "form", action, by: "owner" | "cloudpid", reason?, fields }]` (`McpElicitationDetail`), one entry per form the server asked during the call, with the names of the fields answered and never a value; each one not accepted adds an info diagnostic `elicitation`, which pi-durable shows the model as a `<harness>` line ([_Elicitation requests_](mcp-server-requests.md#elicitation-requests)). The call's `timeout` and slack stand still while a question waits (the one `pausableDeadline` the core and the Session share), and the call's card in the transcript lists each question under "Questions". A card is withdrawn, and the server told `cancel`, when the server is switched off, hidden or removed at a request start.
  - **Text to the model:** an image block outside PNG, JPEG, GIF and WebP, and an embedded blob that is not an image, go to a Result Spill with a line naming it. A `resource_link` is one line without pi's `read_mcp_resource` clause (the resource tools are [#471](https://github.com/ian-pascoe/cloudpid/issues/471)'s), and `details.resources` chips are left to [#477](https://github.com/ian-pascoe/cloudpid/issues/477). An `isError` result with no text says `MCP tool <server>/<tool> returned an error`. Text over 50 KiB or 2000 lines is cut to its head by the extension itself, as pi-durable cuts any tool's output, so pi-durable and the `afterTool` hooks are handed the head and not a result's 16 MiB. The cut is found by scanning to the limits, never by splitting the whole text, and is made as pi-durable makes it: the server's text blocks are joined with nothing between them, the head takes the place of the first of them and keeps whole lines with their newlines, and images stay where they were. The lines this build writes about a block it cannot show (a link, a placeholder, where a file was saved) are never part of the text that is cut, and stay in place. The model is told as it is of any tool's output, with a `truncated` warning, `Output truncated to its beginning: N lines, M bytes dropped`, for a script's call too. The full text, joined the same way, goes to a Result Spill for a model's call (`.txt`; `details.full_output_path` and an info diagnostic `full_output`). Spill files are not redacted of Secrets, which is left for later with the rest of redaction for MCP traffic.
  - **The script value:** `structuredOutputSchema` is `scriptSchemaOf(outputSchema)`: `{ content, structuredContent?, isError?, truncated? }` and the tool's `outputSchema` for `structuredContent`. A nested call is a task whose input has `kind: "nested"`; it spills nothing: the value holds everything that fits `MAX_NESTED_STRUCTURED_OUTPUT_BYTES` (less headroom), text cut largest-first with `truncated: true`. Binary data (an image's `data`, a blob) is never cut, since half a base64 string is no image: a block that does not fit is replaced whole by a line (`[image content omitted: too large for a script's value]`), the largest first and before any text is cut. `structuredContent` alone over the budget is measured once and ends the cutting, since nothing else can make the value fit (`ResultBounds` refuses it): measured with 16.3 MiB of `structuredContent` and three images, a script's value is built in about 23 ms with one pass over it, where it had been re-measured for each image dropped. A model's call gives pi-durable `{ content: [] }` as its value, since the model never sees it and pi-durable only checks it against the schema, whose other keys are optional: nothing of a large result is measured, cut or held twice for it (2 ms, nothing allocated, for the same result).
  - **An invalid `structuredOutput`:** the value is omitted and `details.error` is `"invalid_structured_output"`. A nested call is an error result with one error diagnostic of that code that says why, so pi-durable adds no line of its own. A model call keeps its text and is told nothing more: pi-durable reports the missing value to the host, which is the logging the spec asks for.
  - **Streams:** the Session reads a result over 1 MiB in `execute`, one over 4 MiB at a time per isolate (the decode slot), to at most 32 MiB (the engine's serialization of 16 MiB of server text, escapes included); past that is `too_large`. The slot is held until the result is cut to what the model or the script gets (`readStreamed`'s `use`), not only while it is read. A read has an idle deadline, `MCP_STREAM_IDLE_MS` (30 s) between chunks, past which the stream is cancelled and the call is `details.cut: "engine_lost"`, as it is when the stream breaks mid-read. Stop cancels a stream at once, and ends a wait for the slot at once without waiting for the holder. A wait for the slot has its own deadline, `MCP_STREAM_SLOT_WAIT_MS` (45 s), 15 s under the 60 s (`MCP_STREAM_HOLD_MS`, in `@cloudpid/mcp/types`) that the engine lets a stream go unread, so a waiter says so before the engine errors its stream: the call is `details.cut: "engine_lost"`, "dropped unread … The tool ran." (a result the engine produced, so `mayHaveRun` is true). Measured in Node/V8 with a 16 MiB text result: its read and parse is the peak, about 50 MB of JS heap (the chunks' strings and their join, then the join flattened for `JSON.parse`), about 34 MiB once parsed (the value, and the encoded copy a spill writes) and the call's result is a head of 50 KiB and a value of 4 KiB; the decode slot keeps two results from overlapping, so two in a row need no more than one. The same read before the head was cut handed pi-durable the whole text and a 1.5 MB value; the peak of the read itself was the same, so a result the size of the limit still takes a large part of the object's 128 MB while it is read.
  - **Cuts:** `engine_lost` is a `Cut` with `lost: "engine"` (`@cloudpid/mcp/types`: an optional field, so an older host's `Cut` still decodes): the host sets it when the engine's RPC broke. Any other `Cut` is the server's or the host's own, and is shown with its message without `details.cut`; `host_lost` stays the Session's, as before.
  - **Replay:** the `mcp.sent` memo is read, then written before the request leaves. A rerun that finds it settles the call as an error, "Tool <name> was interrupted and may have partially run; it was not sent again.", with no `details.cut`, since only `host_lost` and `engine_lost` are cuts. The other markers come with [#387](https://github.com/ian-pascoe/cloudpid/issues/387) and [#389](https://github.com/ian-pascoe/cloudpid/issues/389).
  - **Annotations:** `title` and the four hints ride in `details`, with `meta` whole when its stored bytes are within 16 KiB. Past that, `meta` keeps its `ui` key always (an MCP App's `resourceUri`, `visibility`, `csp`) and the other keys that fit, the smallest first, so one large key never costs the rest. There is no MCP card in the web yet, so nothing shows them.
  - **Progress:** an ordinary call's progress stays in the running call's `details.progress`, which resets the timeout, is never output text, and is gone from the settled result's `details`. The web does not render it, and no lane or status line shows it (rejected: a cost in web state for a notice most servers send rarely).
  - **Secrets:** the Secrets `beforeTool` hook blocks an `mcp__*` call whose arguments hold any Secret Reference, held or not, naming it and pointing to the server's `headers`/`env` as `${NAME}`. It gives no backslash-escape hint, and an escaped reference is text that reaches the server as written.
- **Replay:** every MCP tool is `replay: "safe"`, with memo markers, so a `tools/call` is never sent twice. An eviction mid-call settles as "may have partially run" ([Sampling](https://github.com/ian-pascoe/cloudpid/issues/387) D17, [MCP tasks](https://github.com/ian-pascoe/cloudpid/issues/389) D3.2, [ADR-0039](../adr/0039-an-mcp-servers-sampling-request-runs-on-the-owners-models-in-a-completion-of-its-own-and-waits-for-the-owners-yes-unless-its-definition-allows-it.md)). The markers are in [_The waiting-question record_](mcp-server-requests.md#the-waiting-question-record), and the MCP task handoff after `min(timeout, 10 min)` in [_MCP tasks_](mcp-server-requests.md#mcp-tasks).
- **Annotations:** `title` labels the tool card. The four hints ride in `details` as badges. Hints are untrusted, so they never gate Approval or change replay (D12).
- **Secret References** are never resolved in MCP arguments.
  - The Secrets `beforeTool` hook blocks an `mcp__*` call whose arguments hold any Secret Reference that no backslash escapes, held or not, naming it and pointing to the server's `headers`/`env`.
  - Results are redacted by `afterTool`, as every result is (D18; [ADR-0029](../adr/0029-repo-mcp-servers-run-as-its-scripts-do.md)).

## Resources

A server's resources and resource templates are not in the MCP inventory. The inventory keeps only each server's `resources` capability (`subscribe`, `listChanged`), and a change to it bumps `version` ([MCP resources](https://github.com/ian-pascoe/cloudpid/issues/385) D3).

### Resource tools

- **The tools** are pi's `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`, taking `server`, `cursor` and `uri`. The read also takes `watch` (D1).
  - `server` is the normalized `<server>` part; the configured name is accepted too.
  - `uri` may come from a listing, a filled template or a resource link. It needn't be listed.
  - The read takes only an expanded URI: the model has no completion tool.
- **Exposure:** the widest among enabled, non-`hidden` servers that have resources, ranked `direct` > `deferred` > `codemode`. `deferred` ranks above `codemode` because it reaches more: scripts and `tool_search`.
  - Only a server's own `exposure` counts, not `toolExposure`.
  - `tools.offered` lifts each tool on its own.
  - The tools are not registered when no server has resources.
  - They are left out of `deferred_tools` (D2).
- **Listing is live:** lists are asked for when needed and never reinstall tools.
  - **Cache:** `McpHost` caches list results in memory (≤ 4 MiB per object, 8 MiB per isolate, LRU), keyed by (server instance, auth context, method, cursor).
    - The auth context is a SHA-256 over the URL, the access token and every header resolved from a Secret or Variable.
    - Modern results are cached for `ttlMs`, capped at 24 h, with `cacheScope` treated as `private` ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D13). Legacy results are not cached.
    - A server's cache is dropped by a definition change, a re-initialize, a different protocol version or a stdio exit.
  - Listing all servers stops at 1,000 items or 256 KiB, with `truncated` and `incomplete: [{ server, next_cursor }]`.
  - A resource `list_changed` only invalidates the cache. Nothing reaches the conversation (D3).
- **Reading:**
  - **Results** follow [_Calls and results_](#calls-and-results), redacted as any result. In the script value they are `{ server, uri, contents }`. Text over the bound is cut, with `text_truncated` and `full_output_path`. A blob becomes `{ uri, mimeType, full_output_path }`.
  - **Keys:** MCP's camelCase keys are kept. Keys cloudpid adds are snake_case.
  - **Size:** 16 MiB on the wire on every path (agent read, read at send, preview, gap re-read), counted as bytes arrive.
  - **Retries:** one, on a cut or a 408/429/5xx, for reads and lists only.
  - **`https:` URIs** are read through the server and never fetched by cloudpid.
  - **Hidden from lists:** `ui://` and `profile=mcp-app` resources are left out of lists and the `@` menu, but stay readable.
  - **Metadata:** annotations are passed through; icons are dropped (D4).
- **Server questions:** the agent's reads take Sampling and Elicitation requests as its tool calls do, a Legacy `-32042` included (see [_Questions_](mcp-server-requests.md#questions); [Sampling](https://github.com/ian-pascoe/cloudpid/issues/387) D1.1, [Elicitation](https://github.com/ian-pascoe/cloudpid/issues/388) D1.1, D18.4). They are never MCP tasks.

### Resource links and embedded resources

- **The model's line** for a `resource_link` is pi's: `[Resource <uri> "<title>" (<mimeType>, <size>): <desc>. Read it with read_mcp_resource (server "<server>")]`. The read clause is dropped when the resource tools don't reach that server ([MCP resources](https://github.com/ian-pascoe/cloudpid/issues/385) D5).
- **The tool card** shows a chip for each link or embedded resource.
  - `details` keeps references only: up to 20 of `{ uri, mimeType, size, kind: text|image|spill|link, part?, path? }`, with URIs up to 2,048 characters.
  - A `ui://` link belongs to [_MCP Apps_](mcp-apps.md#app-views-in-the-transcript).
- **Previews:**
  - **Rendering:** Markdown is rendered without raw HTML, `text/html` is shown as source, images are shown, and anything else is a download.
  - **No Container start:** previews never start the Container. An `input_required` says to open the resource in a conversation.
  - **A missing spill:** a spill that cleanup removed falls back to one read.
  - **Not redacted:** previews are the owner's own view and are never stored.

### Resource watches

A Resource watch belongs to a conversation, and only the agent starts one ([ADR-0032](../adr/0032-a-resource-watch-is-held-while-its-conversation-runs-and-checked-by-re-reading-after-every-gap.md); [MCP resources](https://github.com/ian-pascoe/cloudpid/issues/385) D6).

- **Starting and ending:** `read_mcp_resource { watch: true }` subscribes, then reads. The owner gets a Resource watch by asking the agent. `watch: false` ends it and still reads.
  - The Resource watch is pending until the read returns contents, whose SHA-256 becomes its baseline. Change events in the meantime are ignored.
  - A read that ends without contents drops the pending watch ("not watched: the read did not complete") ([Elicitation](https://github.com/ian-pascoe/cloudpid/issues/388) D18.3).
  - A read whose watch row the host couldn't store returns the content with the Resource watch not started ([Deploys under deferred Durable Object code updates](https://github.com/ian-pascoe/cloudpid/issues/423) D3.2).
- **The notice:** each request start pulls `watches: { changed, ended }` from `requestStart`. The Session places one `Resource watches` notice: a `write` submission of `kind: "cloudpid.mcp-resource-watches"`, marked as coming from MCP servers.
  - It names URIs only, in Changed and Ended groups, with at most 20 entries and at most 3 sub-resource URIs per Resource watch.
  - It never starts a Run, and the host never calls a Session.
- **The protocol side:** `McpHost` keeps one `resources/subscribe` set (Legacy) or one `subscriptions/listen` (Modern) per server, shared by every Resource watch on it ([The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382), [The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D12).
  - A mark is a flag plus sub-URIs, so duplicate events are harmless.
  - A filter change opens the new listen, waits up to 10 s for its acknowledgement, then closes the old one.
  - A URI left out of the acknowledgement is refused or ended.
- **Holding:** a server's stream is held only while a watching conversation has made a request in the last 15 min, and swapped when older than 10 min.
  - Any span without the stream is a gap: between Runs, a deploy, an eviction, a new HTTP session.
  - After a gap, the host re-reads each watch the agent's last read still describes, at most 6 at a time, and marks it changed when the SHA-256 differs. A failed re-read reads "could not be checked; may have changed".
  - The result reaches the model at the next request.
- **Stdio:**
  - Listens and subscribes go to the bridge with `use: false`, so they never hold the Container.
  - A Resource watch belongs to the server process in the watching conversation's Workspace. It ends, with a notice, when that process ends ("server process ended"), and is never resumed on a respawn.
- **A Legacy HTTP server** that answers GET with 405 is refused up front ("cannot send updates"), and no `resources/subscribe` is sent. A 404 session means re-initialize, re-subscribe and gap-check. After an hour of failures the watch ends.
- **Ends:**
  - `watch: false`;
  - the server switched off, `hidden`, removed, changed ("server changed"), or no longer able to subscribe;
  - the owner signing out of its MCP sign-in, or it becoming `required` ("signed out") ([Signing in to remote MCP servers](https://github.com/ian-pascoe/cloudpid/issues/390) D7.2);
  - its stdio process ending;
  - the owner's ✕;
  - its subagent deleted, or its Session deleted or archived (`apply({ kind: "end_watches" })`);
  - the active Session branch moving (silently);
  - 7 days without a request, swept at `requestStart` and `apply`, never by alarm.
- **Caps:** 20 per conversation and 100 per Environment. Over a cap the read still happens and says why the resource isn't watched.
- **Lifetime:** Resource watches survive Rollover and compaction. Each subagent conversation has its own. Forks and Clones don't inherit them.
- **UI:** Session details lists Watched resources per conversation, each with ✕. The MCP status UI, itself left for later (map → MCP status in the UI), shows their counts.

### Attached resources

An Attached resource is the owner's: one picked in the composer, read once when the message is sent, and never watched ([MCP resources](https://github.com/ian-pascoe/cloudpid/issues/385) D7).

- **The `@` menu** lists files, then resources grouped by server.
  - `@<server>:` narrows the list.
  - Only servers the resource tools reach are listed.
  - Rows are ranked by match, then priority.
  - Picking a resource makes a chip.
- **Starting nothing:** the menu never starts a Container. A stopped stdio server shows a muted row, and a listing is held 30 s for the menu.
- **Templates** are filled in the shared `ArgumentForm` with `ref/resource` completions (see [_Arguments and completions_](#arguments-and-completions)).
- **At admission** the Session reads each resource in the message's prepare stage, 15 s per read, in parallel. A read may start the Container.
  - **Text** goes into an untrusted `<mcp_resources>` block of `<resource server uri>` elements, escaped and redacted before storage.
  - **Images** become image parts within the inline budget.
  - **Binaries, and text over the guard,** go to `/workspace/.cloudpid/uploads/<session>/`.
  - **Chips** go in the `cloudpid.user` entry.
- **Failures:**
  - Not found, or the server gone: `ATTACHED_RESOURCE_GONE` refuses the send, as `ATTACHED_PAGE_GONE` does.
  - Any other failure sends the message with `<resource … error="…"/>` and a "Could not be read" chip.
  - A read at send has no conversation to ask in. So its Sampling requests are refused, Elicitation requests get `cancel`, and an `input_required` becomes the error line ([Sampling](https://github.com/ian-pascoe/cloudpid/issues/387) D1.4, [Elicitation](https://github.com/ian-pascoe/cloudpid/issues/388) D1.4).

## Prompts

An MCP prompt is the owner's, picked as a Slash command. It is got when its message is sent, and the result becomes the owner's one user message ([ADR-0033](../adr/0033-an-mcp-prompt-is-got-when-its-message-is-sent-and-becomes-the-owners-one-message.md)). The agent cannot get one: there is no tool and no `codemode` method, and `mcp_servers` doesn't mention prompts ([MCP prompts and completions](https://github.com/ian-pascoe/cloudpid/issues/386) D10).

### The `/` menu and the catalog

- **Offered from** servers that are enabled and not `hidden` by their own `exposure`, a Repo's `.pi/mcp.json` servers included. `toolExposure` and `tools.offered` play no part (D1).
- **From the MCP inventory only**, so the menu never wakes a Container. A stopped stdio server's cached prompts stay pickable, and an undiscovered or failed server shows a muted row.
- **Bounds at discovery**, reported as per-server problems:
  - at most 100 prompts and 64 KiB of metadata per server;
  - a prompt with more than 16 arguments, an empty or duplicate argument name, or a name over 128 characters is not offered;
  - `title` is cut at 120 characters, `description` at 1,000 and an argument's description at 500, with control characters stripped;
  - `icons` and `_meta` are dropped.
- **Naming:** `/mcp__<server>__<prompt>`, by the tool-name function. The collision hash is computed within one server's prompts.
  - `mcp__` is reserved: a Prompt template named so is left out of the listing.
  - The `/mcp` command, left for later (map "MCP status in the UI"), will rank first as the exact match (D2).
- **The menu:**
  - MCP prompts come after Skills, in one section per server, "MCP · <server>" (plus "· from <repo>" for a Repo's server).
  - A row shows the label with `mcp__<server>__` muted, an argument hint (`<required> [optional]`), then the title, " — " and the first line of the description.
  - With no query, servers are in order; while typing, rows are ranked by `rank`.
  - MCP prompts are not in the `$` menu.
- **The catalog:** `catalog` adds:
  - `prompts: [{ command, server, source: "owner" | "repo:<owner/repo>", name, title?, description, arguments: [{ name, title?, description?, required }], completions }]`;
  - `mcpServers: [{ server, state: "connecting" | "unavailable" | "sign_in" }]`.

  It keeps the same 30 s refresh. The catalog is Environment-wide, so it is the same in every conversation. The draft composer gets it through the main Worker from `McpHost.servers`. It never reads a server (D3; `sign_in` from [Signing in to remote MCP servers](https://github.com/ian-pascoe/cloudpid/issues/390)).

- **Subagents and archives:** a subagent's composer offers the same prompts into its own conversation, with stdio running in its own Workspace. An archived Session's read-only composer offers none.

### Arguments and completions

- **One `ArgumentForm({ fields, complete?, onDone })`** serves both prompts and the `@` menu's resource templates ([MCP prompts and completions](https://github.com/ian-pascoe/cloudpid/issues/386) D4).
  - **For a prompt:** one field per argument, in declared order.
  - **For a template:** the RFC 6570 variables are the fields, with `{?…}`/`{&…}` optional. The header shows the URI as filled, and Done gives an Attached resource chip.
  - **Keys:** Tab or Enter moves to the next field, ↑/↓ pick a suggestion, and Escape cancels.
- **The MCP prompt chip** sits above the input, for example "github · Review PR · pr_number: 123". Clicking it edits it, and ✕ removes it.
  - The textarea stays for the owner's own words.
  - Submitting sends `submit.mcpPrompt { server, name, arguments }`.
  - A prompt with no arguments makes a chip at once.
  - Done is disabled while a required field is empty, and the Session checks again (`MCP_PROMPT_ARGUMENTS`).
- **Values:**
  - Empty optional fields are omitted.
  - Values may be multi-line. NUL and control characters other than `\n`/`\t` are stripped.
  - Each value is at most 64 KiB, and all values together at most 128 KiB.
  - Arguments the prompt no longer declares are dropped at send.
- **One prompt per message**, which runs no command. `$name` Skill links still apply to the typed text.
- **No typed form:** text starting `/mcp__<non-space>` sent without `mcpPrompt` is refused (`MCP_PROMPT_FAILED`, "pick it from the / menu").
- **Composer state:** the chip is held beside `AttachmentsState`.
  - It is lost on reload, given back on refusal, and counted by `draftHeldAtom`.
  - `Navigated` gains `mcpPrompt?`, so Branch restores the chip. Redacted values come back redacted, and a prompt no longer offered restores as an unsendable chip.
- **Completion** is UI-only (D5).
  - **Request:** the socket's `mcp_complete { requestId, field, conversationId?, server, ref, argument, context: { arguments } }` goes to the Session, then to `McpHost.request({ op: "completion/complete", ctx: { workspace, start: false, timeoutMs: 5000 } })`, with the conversation's own Workspace.
  - **Answer:** `mcp_completion { requestId, status: ok | unsupported | not_running | sign_in | failed, values, total?, hasMore }`.
  - **Draft composer:** completes through the main Worker, for HTTP servers only.
  - **Timing:**
    - `context.arguments` holds the other fields' non-empty values.
    - A request is sent on focus, then 120 ms after typing stops.
    - Each field has one request in flight; a newer one cancels the older (`notifications/cancelled`). Completions are never retried.
    - Answers are cached for the form's life by (server, ref, argument, value, context hash). Meanwhile the last answer is narrowed locally with `rank`.
  - **Values:**
    - At most 100, in the server's order.
    - Values over 1,000 characters and duplicates are dropped.
    - `hasMore` and `total` show "keep typing".
    - No request is sent without the server's `completions` capability.
  - **States:**
    - "Loading suggestions…";
    - "Suggestions unavailable";
    - "Sign in to <server> for suggestions", as a link;
    - "Suggestions once <server> is running": a completion never starts a Container or spawns a stdio server. A stdio completion still counts as use of a running Container.
  - **No conversation:** a completion has none, so a Sampling or Elicitation request during it is refused (see [_Questions_](mcp-server-requests.md#questions)).

### Getting a prompt at send

- **`prompts/get` runs once, when the message is admitted** ([ADR-0001](../adr/0001-expand-skills-and-prompt-templates-at-submit.md)'s moment), never at pick time ([MCP prompts and completions](https://github.com/ian-pascoe/cloudpid/issues/386) D6).
  - It goes through `McpHost.request({ op: "prompts/get" })` with the conversation's Workspace, and may discover the server, start the Container and spawn a stdio server.
  - Bounds:
    - 30 s, or the definition's lower `timeout`;
    - one retry on a cut, 408, 429 or 5xx;
    - at most 16 MiB, counted as bytes arrive.
  - A resent `requestId` finds the first submission.
  - A task-shaped answer is a `ProtocolViolation` ([MCP tasks](https://github.com/ian-pascoe/cloudpid/issues/389) D10.3).
- **Prepare, then place:** admission splits in two.
  - **Prepare** runs outside the Session lock, in a line per conversation: the settings read and the MCP request start ([_The `mcp` extension_](#the-mcp-extension)), template expansion, Attached page and Attached resource reads, and the prompt get.
  - **Place** runs briefly under `inArrivalOrder`, in each line's order: the `requestId` check, `guard` and `admitDraft`.
  - Messages keep their order within each conversation.
  - **The line** is per conversation and in memory (`apps/server/src/session/admission.ts`). A message finds its conversation and joins that conversation's line under `inArrivalOrder`, so one sent while `navigate` or `switchBranch` runs is for the branch it moves to, and is in line before any sent after it. It prepares when those before it have been placed, and is placed in the same turn, so each conversation's messages are placed in the order they arrived and a slow one holds back only the ones behind it. A message interrupted while it waits still waits its turn.
  - **The tree stays put:** from joining the line until it is placed, `navigate` and `switchBranch` are refused on that conversation's branch ("The Session tree cannot be navigated while a message is being prepared"). The refusal is the `error` message's text, as the others are, so an older client shows it as it does them.
  - **Stop withdraws the line.** A plain Stop of a conversation (the composer's Stop, `session_stop`, and Stop all for every conversation it stops) withdraws every message in that conversation's line that is not yet being placed, as it withdraws queued input, whether the message is preparing or waiting its turn ([#548](https://github.com/ian-pascoe/cloudpid/issues/548)).
    - **Cancelled, nothing placed:** what the message was fetching (template expansion, Attached page and resource reads, the prompt get) is cancelled, and nothing it had prepared is placed. A message waiting its turn never starts.
    - **Placing is not cut:** a message already placed under `inArrivalOrder` when Stop arrives is placed, and the Stop, which then aborts the conversation, withdraws it as queued input.
    - **The line keeps its order:** a withdrawn message still leaves its place in turn, so the ones behind it are never stuck, and it stops counting as preparing, so the tree may move again. A message sent after the Stop joins the line as usual.
    - **The answer is the one queued input gets:** the submitter sees it vanish without a failure, as withdrawn queued input does, and may send it again. On the socket the `submit` command is answered with `null` (a client reads a `result` without a `submissionId` as no submission, and keeps no text for it; older clients do too). Over the MCP endpoint `session_send` answers `stopped`, which is not retryable (the owner stopped it, and sending it again would place it after their Stop; a reader that does not know the code reads `unavailable` with `retryable: false`). A Review's drafts are untouched, as they are deleted only once its message is placed.
    - **A resend is withdrawn again:** a withdrawn message leaves no submission for a resent `requestId` to find, so the Session keeps the `requestId`s of withdrawn messages in storage (the newest 64, for 10 min) and answers a resend the same way, rather than place it after the Stop. A message sent under a new `requestId` is a new message.
    - **Other conversations' lines are not touched.** A message sent before the Stop that has not joined its line yet (it waits for the lock a `navigate` holds across its summary, so its conversation is known only then) is withdrawn when it joins, if its conversation is the one Stopped; the Session keeps where each Stop reached while such a message is on its way. A message with no conversation named is for the branch it moves to, so a Stop of the branch being left does not reach it.
    - **Abort:** the `abort` command is how every Stop reaches the Session, so abort withdraws the line exactly as Stop does, for the conversation it names (and the subagents below it with `subagents`). What an abort of one call does (a tool call, an MCP request) never touches a line.
  - Commands, Fork/Clone, lookups and other conversations go ahead.
  - **Status:** a message in a line counts as unsettled input, so the Session is not idle while one waits and `session_stop` does not skip it.
  - **The composer** offers Stop, and `/stop`, while a Run is going or a message of that conversation is still being sent (its lane row "Sending…"), so a message held in its line, a slow page read or a question card, can be stopped with no Run to stop.
- **Steers and queued follow-ups** are prepared at submit, so a follow-up carries what the server returned when it was sent. The lane row reads "Getting <title> from <server>…", then shows the chip label and the typed text.
- **Server questions during a get** are answered live in both eras, never deferred, since the prepare stage is in memory; D6.4's first-build refusal is lifted ([Sampling](https://github.com/ian-pascoe/cloudpid/issues/387) D1.2, D12.2; [Elicitation](https://github.com/ian-pascoe/cloudpid/issues/388) D1.2, D18.1). The cards and their bounds are in [_Questions_](mcp-server-requests.md#questions).
  - **The card** waits above the composer, named in the lane row, for at most 5 min, with no Notification. The 30 s get bound pauses meanwhile.
  - **The line:** while it waits, the conversation's line is held, but commands, Fork/Clone and other conversations go ahead, and Stop withdraws the message (the card is withdrawn with it).
  - **Endings:** an Elicitation request whose 5 min run out gets `cancel` and the get goes on; a Modern Sampling refusal fails the send with `MCP_PROMPT_FAILED`, Retry offered.
  - **Summaries** are kept in `mcpPrompt.sampling` and `mcpPrompt.elicitation`.

- **Failures** refuse the send; the message is never sent as typed.
  - **`MCP_PROMPT_ARGUMENTS`:** the Session's own check or a `-32602`, with a message of at most 300 characters, redacted. The form reopens.
  - **`MCP_SIGN_IN_REQUIRED`**, as a Sign in link.
  - **`MCP_PROMPT_TOO_LARGE`.**
  - **`MCP_PROMPT_FAILED`**, with Retry, when:
    - the server is off, `hidden`, removed, unreachable or failing to spawn;
    - the prompt is not listed;
    - the get times out;
    - the server answers `-32603` or another error;
    - the result is malformed;
    - a draft's first message waited past the timeout for its new Workspace ("Workspace not ready").

  A refusal goes back to an empty composer with the chip restored. Otherwise the row stays "Not sent: <reason>", with Restore and Discard.

### Into the conversation

- **One user message**, never extra pi-ai messages. In order:
  1. the `<mcp_prompt server name title>` block, which holds:
     - the user parts' text, joined by blank lines;
     - the assistant parts, as `<prompt_message role="assistant">`;
     - `[image n]` markers;
     - escaped attributes, with `server` the normalized name;
  2. the prompt's images;
  3. the owner's typed text;
  4. Attachments, Attached pages and Attached resources, as today.

  ([MCP prompts and completions](https://github.com/ian-pascoe/cloudpid/issues/386) D7)

- **Trust:** the prompt's text, both roles, is the owner's request, a Repo's server's included. The wrapper carries no trust sentence. Embedded resources go into untrusted `<mcp_resources>` blocks, in place.
- **Content:**
  - **Images** (PNG, JPEG, WebP, GIF) become image parts within whatever `INLINE_IMAGE_BUDGET` the owner's images left. Past that, they become a file in `/workspace/.cloudpid/uploads/<session>/` and a line `[image n: <path> (mime, size)]`.
  - **Audio** becomes a file and a line `[audio: <path> (mime, size)]`.
  - **`resource_link`** becomes the resource-link line.
  - **Embedded text** becomes an escaped `<resource server uri mime_type>`. Over the Attached-resource guard, it becomes a file and a `path`.
  - **An embedded blob** becomes an image if it is one, else a file.
  - **Files** are written by the Session without waking the Container.
  - **`audience`** is ignored; other annotations are dropped.
- **Cleaning:** the content is cleaned, redacted, then escaped before storage. Secret References in arguments are neither resolved nor blocked.
- **Size:** the block plus the typed text is at most 1 MiB, and the whole input at most 1.9 MB (`MAX_STORED_INPUT_BYTES`). Anything larger is refused with `MCP_PROMPT_TOO_LARGE`.
- **The transcript:** `cloudpid.user` data adds `mcpPrompt { server, command, name, title?, arguments (redacted), description?, parts, resources, sampling?, elicitation? }`.
  - `description` is the result's, up to 1,000 characters, and never sent to the model. `resources` holds at most 20, shaped as for tool cards.
  - `display` is the typed text.
  - The card shows a chip line "MCP prompt · github · Review PR" with its arguments, then the typed text, then a closed disclosure with what the model got. Assistant parts are quoted under "Assistant (from the prompt)" and never drawn as an agent bubble.
  - Title, tree and lanes use `display`, else the chip label (D8).
- **Copies and exports:**
  - Fork, Clone and branches copy the entry without a new get. Editing the message gets the prompt again at send.
  - `/export` writes the display, then `MCP prompt: github/review_pr (pr_number=123)`, then the block as a blockquote, with `[image]` markers and resources by URI.

### Freshness

- **When prompts are listed:**
  - at discovery;
  - on `list_changed` over a stream the host already holds: the Legacy GET stream, or a Modern listen opened for other reasons, with `promptsListChanged: true` added;
  - when `ttlMs` expires;
  - after a get fails with an unknown name.

  The host never opens a stream for prompts alone ([MCP prompts and completions](https://github.com/ian-pascoe/cloudpid/issues/386) D9).

- **A stale list** (older than `ttlMs`; 10 min for Legacy) is served to a catalog read and refreshed in the background, for HTTP servers and running stdio processes only.
- **Nothing reaches the conversation** when prompts change.

## Roots

- **Who gets roots:** they are declared only on bridge connections, that is to stdio servers.
  - Remote HTTP servers get no `roots` capability in either era: the paths mean nothing to them, and the names would leak private Repos.
  - The client feature is still built in full ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D19).
- **What is offered:** one root `file:///workspace/<repo-dir>`, named `owner/name`, for each Repo of the Workspace whose Container runs the server. A Repo's own stdio server gets only its Repo.
- **Who answers:** the core, inside `McpEngine`, from the `roots` dependency `McpHost` supplies for the connection's Workspace. Roots never reach a Session or the owner.
  - **Legacy:** a `roots/list` arrives on the call's stream, or on the GET stream with no call.
  - **Modern:** a roots request arrives in an `input_required` round, and is answered in the same retry (D11).
- **Not built, by design:** `roots.listChanged`. A Workspace takes the Environment's Repos when it is made and keeps them, so the Roots of a running server never change; a later Repo of the Environment reaches only a Workspace made after it.
- **As built** ([#460](https://github.com/ian-pascoe/cloudpid/issues/460)): `McpDeps.roots` (`packages/mcp`) declares `roots: {}` and answers `roots/list` only when given, and the engine gives it only to a stdio target, from `target.roots`, an empty list included. The host builds them from the Registry's answer to `mcpServerValues` for the caller's Workspace (`repos`: its directory and `owner/repo` slug), one `file:///workspace/<directory>` each, named by slug; an entry from a Repo's own `.pi/mcp.json` gets only that Repo.

## Server logging

- **Level:** `warning` in both eras, sent only to servers that declare `logging`. Legacy sends `logging/setLevel` after `initialize`; Modern sends `_meta` `logLevel` on every request ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D21).
- **`notifications/message`** goes through the engine's `onLog` hook to `McpHost`, which turns `warning` and above into a span event and keeps a ring of the last 50 per server, read through `mcpServerLog` (see [_Telemetry_](mcp-connections.md#telemetry); [The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382) D12.2). Log messages never reach the model or a Session's transcript. An App View's `notifications/message` goes to telemetry too (see [_The bridge_](mcp-apps.md#the-bridge)).
- **As built** ([#453](https://github.com/ian-pascoe/cloudpid/issues/453)): the level is asked only of a server that declares `logging`, and only when something listens (`McpDeps.onLog`; the engine always passes one). Legacy sends `logging/setLevel` after an `initialize` that opens a session the host keeps (a reused session already has it), and never for a server that keeps none, in a discovery or a call, since it forgets the level at once and the round trip would be for nothing; Modern `_meta` `logLevel` on every list and `tools/call` request. There is no `onLog` engine hook: the logs return in the call's result (`logs`), scrubbed and cut, so a background discovery has them too; the host keeps the ring and raises the span events ([_Telemetry_](mcp-connections.md#telemetry)).
- **Stdio stderr** stays in the bridge's 64 KiB tail, read through `bridge_status`. A cut call quotes the tail's last 2 KiB (see [_Failures and cuts_](mcp-connections.md#failures-and-cuts)).

## Testing and telemetry

- **Spans:** `McpHost`'s spans (`mcp.request_start`, `mcp.request` for calls, gets, reads, lists and completions, `mcp.listen`, `mcp.gap_check`) cover every request from this section, never recording argument or result values (see [_Telemetry_](mcp-connections.md#telemetry)). Dedicated spans per `prompts/get` and per completion, Telemetry and Usage for MCP calls and Resource watches, and the rest of redaction for MCP traffic (MCP arguments, resource text in spills), are left for later (map "Secrets and telemetry for MCP traffic").
- **Tests:**
  - **The core and the host:** see [_Testing and tracing_](mcp.md#testing-and-tracing) and [_Testing_](mcp-connections.md#testing).
  - **Session-side tests** the tickets require:
    - a reinstall over unchanged tools is byte-identical ([MCP prompts and completions](https://github.com/ian-pascoe/cloudpid/issues/386) D9.1);
    - a nested `codemode` MCP call surviving eviction ([Sampling](https://github.com/ian-pascoe/cloudpid/issues/387), as amended by [Elicitation](https://github.com/ian-pascoe/cloudpid/issues/388) D5.4).
  - **Left to implementation:** unit tests for the name function (collision, length and pi-import cases), the Exposure table, and the `mcp_servers` section's caps and notice dedupe.
  - **Left for later:** resource fixtures (a fake server in both eras with subscribe, listen and a GET answering 405, and workerd tests for eviction gaps, the listen swap, the hash check, the 16 MiB abort and watch expiry).
