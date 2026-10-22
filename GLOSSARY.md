# cloudpid

A personal coding agent on Cloudflare: pi's harness running durably in Durable Objects, working on project files held in the cloud.

## Agents and conversations

**Session**:
One agent unit of work the user opens: a root conversation, its subagents, and their history, bound to one Workspace.
_Avoid_: Chat, thread, conversation (for the whole unit)

**Archived Session**:
A Session the owner has put away: kept whole, listed apart under _Archived_ rather than with the others, and read-only until it is unarchived.
_Avoid_: Hidden, closed, deleted (for an archived one)

**Deleted Session**:
A Session deleted for good, with everything it held; the files it wrote in its Workspace stay, unless it was the Workspace's last Session and the Workspace is removed with it.
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
One entry of a Todo List: a title, an optional description, and a status (`pending`, `active` or `completed`). The `todo` tool, its parameters and the socket's `todos` message call it a "Task", as pi-todo does; that is the same thing, and not a background task of pi-durable, which the web app's Tasks Pane lists.
_Avoid_: Task (alone, in prose about the product), to-do

## Messages

**Slash command**:
A `/name` at the start of the owner's message that runs an action instead of being sent to the model as written, either in the Session or in the web app.
_Avoid_: Command (alone), action, macro

**Shell escape**:
A `!command` the owner runs from a conversation's composer, shown in that conversation with its output; the output reaches the model with its next request, unless it was a `!!command`, which the model never sees.
_Avoid_: Bash mode, user bash, Slash command (for this)

**Prompt template**:
A Markdown file in a repo's `.agents/prompts` whose Slash command expands into a message, with the command's arguments filled in.
_Avoid_: Prompt, snippet, macro

**Attachment**:
A file the owner gives with a message, stored on the Machine and pointed at by its path; an attached image is also shown to the model.
_Avoid_: Upload (for the file), file mention

## Diffs and review

**Changes**:
A Workspace's uncommitted working tree against its HEAD, shared by every Session on that Workspace.
_Avoid_: Diff (for the whole set), working copy, pending edits

**Comparison**:
A branch's or pull request's changes against its base.
_Avoid_: Branch diff, PR diff (for the thing itself)

**Annotation**:
The owner's note on a line range of a diff, kept as a draft until it is sent in a Review.
_Avoid_: Comment, remark, note (that is an agent's Note)

**Review**:
A batch of Annotations the owner sends to one conversation as a single message.
_Avoid_: Feedback, comment batch, code review (for the message)

## Machines, Repos and Workspaces

**Machine**:
A persistent file tree at `/workspace` with its own Container, holding one or more Repos and the Workspaces made from them.
_Avoid_: Workspace (for the whole tree), sandbox, box, environment

**Repo**:
A git repository cloned onto a Machine, in a directory of its own below `/workspace`; its directory is its main checkout.
_Avoid_: Project, repository directory

**Workspace**:
One working tree of a Repo on one branch, that Sessions bind to: the Repo's main checkout, or a git worktree of its own made for it. A Session at the Machine's root has the root as its Workspace.
_Avoid_: Checkout, worktree (for the thing Sessions bind to), sandbox, project directory

**Main checkout**:
The Workspace that is a Repo's own directory, shared by every Session started in it.
_Avoid_: Default workspace, primary worktree

**Workspace removal**:
Deleting a Workspace's Sessions and its working tree, keeping its branch and the commits on it. Uncommitted changes are lost.
_Avoid_: Cleanup (for the owner's action), reset

**Slug**:
A Machine's fixed identifier, chosen when it is created; it never changes, and a deleted Machine's slug may be used again.
_Avoid_: ID, key (for the Machine's identifier)

**Machine name**:
The label the owner gives a Machine and may rename, shown in place of its Slug; unique among Machines.
_Avoid_: Title, display name, slug (for the label)

**Machine reset**:
Returning a Machine to a fresh start: its Sessions, Workspaces, files, Container and Snapshot are deleted, and its Slug, Machine name and Container settings stay.
_Avoid_: Wipe, clear (for the owner's action), delete (which also forgets the Machine)

## Execution

**Container restart**:
Stopping a Machine's Container and forgetting its Snapshot, so the next message or command starts one from the image, installs the Toolchains and runs the Setup Scripts again; the files and Sessions stay.
_Avoid_: Reset (for the Container alone), reboot

**Backend**:
A place a Machine runs commands: the Worker Shell or the Container.
_Avoid_: Runtime, executor

**Worker Shell**:
The fast in-Worker shell Backend that runs text commands against the Machine's files without real binaries.
_Avoid_: just-bash (as a product name), lite shell

**Container**:
The Linux Backend of a Machine, which runs real programs against the same files.
_Avoid_: Sandbox, VM, box

**Terminal**:
An interactive shell the owner runs on a Machine's Container from a Session, in the Session's directory, shown as a Pane. The agent does not see it.
_Avoid_: Console, shell (alone), PTY

**Pane**:
A panel beside a conversation that shows something live the owner can look at or work in: the Session's tasks (the Tasks Pane), a Terminal, a Live View, an open file. Open Panes are tabs of the Session page's **Pane area**, a column beside the chat (a full-screen sheet on a phone), and are named in the page's URL.
_Avoid_: Preview (that is a pull request's preview stage), viewer, surface

**Early start**:
Starting a Machine's Container (restoring its Snapshot or launching the image, then the bootstrap, Setup Scripts included) when the owner sends a message, before any command asks for it, so the turn's first command does not wait; it does nothing while the Container runs or is starting.
_Avoid_: Warm-up, prewarm, preload

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
A program a Machine or Repo declares in its mise configuration, which the Container finds among the image's preinstalled versions or installs on demand.
_Avoid_: Dependency, package (for tools)

**Setup Script**:
A Repo's `.agents/setup.sh`, which the Container runs to prepare each of the Repo's Workspaces (typically installing its dependencies): after installing the Toolchains, when a Workspace's worktree is made, and again only when it changes or the Container starts from the image; one that failed runs again at the next Container start.
_Avoid_: Install script, setup hook

**Container-only path**:
A path on a Machine that its Container keeps to itself on its own disk, out of the Machine's files (dependency directories, build output, caches): the built-in ones and those the Machine's Container settings add.
_Avoid_: Ignored path (computer's term), excluded path

**Snapshot**:
A saved copy of the Container's disk, taken after the Toolchains are installed and the Setup Scripts have run (when that installed anything) and when the Container stops for being idle, and restored at its next launch so the Toolchains and what the Setup Scripts installed come back without downloading.
_Avoid_: Backup, checkpoint, image (for the saved disk)

**Registry**:
The single index of Machines, Workspaces, Sessions, settings overrides, and notification subscriptions.
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

**Live View**:
A Pane that shows an agent's browser tab live and lets the owner use it, open while a Browser Handoff waits.
_Avoid_: Viewer, screencast, hosted Live View (that is Browser Run's own page)
