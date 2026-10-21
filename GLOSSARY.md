# cloudpid

A personal coding agent on Cloudflare: pi's harness running durably in Durable Objects, working on project files held in the cloud.

## Agents and conversations

**Session**:
One agent workspace-of-work the user opens: a root conversation, its subagents, and their history, bound to one Workspace.
_Avoid_: Chat, thread, conversation (for the whole unit)

**Archived Session**:
A Session the owner has put away: kept whole, listed apart under _Archived_ rather than with the others, and read-only until it is unarchived.
_Avoid_: Hidden, closed, deleted (for an archived one)

**Deleted Session**:
A Session deleted for good, with everything it held; the files it wrote in its Workspace stay.
_Avoid_: Archived (for a deleted one), removed

**Conversation**:
One transcript inside a Session: the root conversation or a subagent's.
_Avoid_: Session (for a single transcript), thread

**Subagent**:
A child agent whose conversation is owned by its parent within the same Session.
_Avoid_: Child session, worker, sub-session

**Run**:
The turns an agent takes from one input to its final answer.
_Avoid_: Job, execution

**Role**:
A named model tier (`small`, `medium`, `large`, `xlarge`) chosen when delegating work.
_Avoid_: Tier, model class

**Context Window**:
The part of a conversation the model sees: the entries from the latest Handoff or compaction summary on. Older entries leave it but stay in History.
_Avoid_: Context (alone, for this span), session

**Handoff**:
An agent-written note that starts a fresh Context Window in the same conversation.
_Avoid_: Summary, checkpoint note

**Rollover**:
Starting a conversation's fresh Context Window from a Handoff, which the agent prepares when the context is nearly full.
_Avoid_: Compaction (for the agent-written kind), reset

**Rollover request**:
The message that asks the agent, once per Context Window, to update its Notes and roll over, sent when the context crosses the compaction threshold.
_Avoid_: Compaction prompt, reminder

**Emergency Rollover**:
A Rollover that cannot wait for the agent, when the context is about to overflow or has: the last saved Handoff and the Note Index replace older entries.
_Avoid_: Overflow compaction, summary

**Note**:
A named Markdown text an agent keeps in its conversation, which outlives every Handoff.
_Avoid_: Memory, scratchpad

**Note Index**:
The list of Note names and references a new Context Window starts with, so the agent can read its Notes instead of carrying them.
_Avoid_: Note list, memory dump

**Todo List**:
The flat list of Todo Items an agent keeps in its conversation to track what it means to do. Every conversation has its own, and it outlives every Handoff.
_Avoid_: Plan, checklist, task list

**Todo Item**:
One entry of a Todo List: a title, an optional description, and a status (`pending`, `active` or `completed`). The `todo` tool, its parameters and the socket's `todos` message call it a "Task", as pi-todo does; that is the same thing, and not a background task of pi-durable, which the web app's Tasks panel lists.
_Avoid_: Task (alone, in prose about the product), to-do

## Messages

**Slash command**:
A `/name` at the start of the owner's message that runs an action instead of being sent to the model as written, either in the Session or in the web app.
_Avoid_: Command (alone), action, macro

**Prompt template**:
A Markdown file in a repo's `.agents/prompts` whose Slash command expands into a message, with the command's arguments filled in.
_Avoid_: Prompt, snippet, macro

**Attachment**:
A file the owner gives with a message, stored in the Workspace and pointed at by its path; an attached image is also shown to the model.
_Avoid_: Upload (for the file), file mention

## Workspaces and execution

**Workspace**:
A persistent project file tree, holding one or more repos, shared by every Session bound to it.
_Avoid_: Sandbox, project directory, box

**Slug**:
A Workspace's fixed identifier, chosen when it is created; it never changes, and a deleted Workspace's slug may be used again.
_Avoid_: ID, key (for the Workspace's identifier)

**Workspace name**:
The label the owner gives a Workspace and may rename, shown in place of its Slug; unique among Workspaces.
_Avoid_: Title, display name, slug (for the label)

**Backend**:
A place a Workspace runs commands: the Worker Shell or the Container.
_Avoid_: Runtime, executor

**Worker Shell**:
The fast in-Worker shell Backend that runs text commands against the Workspace without real binaries.
_Avoid_: just-bash (as a product name), lite shell

**Container**:
The Linux Backend of a Workspace, which runs real programs against the same files.
_Avoid_: Sandbox, VM, box

**Offered tool**:
A tool in the model's tool list: one the settings' offered set names (the core coding tools, `codemode`, `tool_search`, the context tools, and `secret_ask` by default; `tool_search` and `context_rollover` always), or a deferred tool `tool_search` loaded on that branch.
_Avoid_: Enabled tool, active tool

**Deferred tool**:
A tool left out of the model's tool list until `tool_search` loads it, though scripts and other tools can call it at any time.
_Avoid_: Hidden tool, optional tool

**Skill**:
A directory with a `SKILL.md` (name, description, instructions) and supporting files that the agent reads by path when a task matches its description. Bundled Skills ship with cloudpid and are mounted read-only at `/workspace/.agents/skills`; a repo may add its own in `.agents/skills`.
_Avoid_: Plugin, command

**Toolchain**:
A program a Workspace declares in its mise configuration and the Container installs on demand.
_Avoid_: Dependency, package (for tools)

**Snapshot**:
A saved copy of the Container's disk, taken after the Toolchains are installed and when the Container stops for being idle, and restored at its next launch so the Toolchains come back without downloading.
_Avoid_: Backup, checkpoint, image (for the saved disk)

**Registry**:
The single index of Workspaces, Sessions, settings overrides, and notification subscriptions.
_Avoid_: Catalog, directory

**Notification**:
A Web Push to the owner's subscribed devices when a Session's Run ends, fails, or needs input, linking to the Session.
_Avoid_: Alert, push message (for the user-facing thing)

**Settings**:
The typed configuration with defaults (default model and thinking level, Roles, compaction, offered tools, spend limit, extension options). The overrides the user saves live in the Registry, and each Session reads them before its next request.
_Avoid_: Config, preferences

**Usage**:
What a Session has spent on model requests: tokens by kind and the cost in US dollars, summed over its root conversation, its subagents and its title call. Shown in the Session's header.
_Avoid_: Billing, tokens (for the whole figure)

**Spend limit**:
The most a Session may spend, in US dollars, set in the Settings (off by default). A Session at its limit refuses its next model request and ends the Run unanswered, with a message that says why; raising or clearing the limit lets the next prompt go on.
_Avoid_: Budget, quota, cap

## Credentials and the browser

**Secret**:
A value the agent may use but never see, entered by the user or resolved from 1Password at use time.
_Avoid_: Env var, key (in general)

**Secret Reference**:
The text that stands for a Secret in a tool call, a placeholder or an environment variable named after it, resolved only when the call runs.
_Avoid_: Secret (for the reference)

**Credential**:
A 1Password item the agent may fill into a web page, scoped to the item's own sites.
_Avoid_: Login, password (for the item)

**Browser Handoff**:
Giving the user live control of the agent's browser for a step the agent cannot do.
_Avoid_: Handoff (alone), takeover, live view (for the act)
