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

**Session draft**:
A new Session as the owner writes it before it exists: its first message, its Environment and its Workspace. Sending it registers the Session and opens it.
_Avoid_: Draft alone (an Annotation not yet sent is a draft too), new chat

**Conversation**:
One transcript inside a Session: the root conversation or a subagent's.
_Avoid_: Session (for a single transcript), thread

**Session tree**:
The tree a Session's root conversation grows when the owner goes back to an earlier point of it and carries on from there; `/tree` shows it and moves between its Session branches.
_Avoid_: Conversation tree, History (that is one path's past)

**Session branch**:
One path of a Session tree, from the Session's start to one of its leaves. The **active branch** is the one the Session's next message continues; the others are kept as they were.
_Avoid_: Branch (alone, as a noun: a Workspace's branch is git's), thread, alternative. The bar's **Branch** button is a verb, the action of moving the active branch there.

**Fork**:
A new Session started from a point of another Session's active branch (before one of the owner's messages, or after an answer), carrying the branch up to that point; the source Session is left as it was. `/fork` makes one.
_Avoid_: Session branch (that stays in its Session), copy, duplicate

**Clone**:
A Fork taken at the latest point of the source's active branch, so both Sessions go on from where it is now; `/clone` makes one.
_Avoid_: Copy, duplicate

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
A file the owner gives with a message, stored in the Session's Workspace and pointed at by its path; an attached image is also shown to the model.
_Avoid_: Upload (for the file), file mention

## Diffs and review

**Changes**:
A Workspace's uncommitted work in each of its Repos against their HEAD, shared by every Session on that Workspace.
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

## Environments, Repos and Workspaces

**Environment**:
What the owner, or the agent for the owner, sets up for Sessions to work in, under a name of its choosing: its Repos (none or several) and their configuration (Toolchains, variables, Secrets, Container settings, Setup and Start Scripts). Every Workspace is made from one.
_Avoid_: Project, template, Machine, sandbox

**Repo**:
A git repository an Environment names; each Workspace of the Environment holds a clone of its own in a directory of the Repo's name.
_Avoid_: Project, repository directory

**Workspace**:
One working copy of an Environment that Sessions bind to: its own clones of the Environment's Repos on a branch of its own, and a Container of its own. A new Session gets a new Workspace unless it is started in one that exists.
_Avoid_: Machine, worktree, checkout, sandbox, environment (for the working copy)

**Spare Workspace**:
The one Workspace each Environment keeps made ahead from its last good Build (cloned, set up, its Container snapshotted and stopped) and bound to no Session, so the next new Session takes it instead of waiting for a Workspace to be made. Another is made once it is taken, or once the Environment's Repos or its last good Build change.
_Avoid_: Pool, warm Workspace, standby

**Build**:
An Environment's prepared starting point for its Workspaces' Containers: a Snapshot with its Toolchains installed and what its Setup Scripts download (packages, images) already there. It is made again when the Environment changes or a default branch moves, and the last good one stays in use while a new one fails.
_Avoid_: Image, template, cache

**Test Build**:
A Build the agent makes from proposed Environment changes before saving them, to check that they work. No Workspace starts from it, and it never replaces the Environment's last good Build.
_Avoid_: Dry run, preview Build, draft Build

**Workspace removal**:
Deleting a Workspace with its Sessions, files and Container. What it pushed stays on the remote; its uncommitted changes and unpushed commits are lost.
_Avoid_: Cleanup (for the owner's action), reset

## Execution

**Container restart**:
Stopping a Workspace's Container and forgetting its Snapshot, so the next message or command starts one from its Environment's Build and runs its Start Scripts again; the files and Sessions stay. The owner's, from the Environments page. The agent's (`container_restart`, for a Container that no longer answers) keeps the Snapshot unless asked for a fresh one, so the next Container starts from it.
_Avoid_: Reset (for the Container alone), reboot

**Container resize**:
The agent restarting its Workspace's Container at another size, up to its Environment's size limit, for that Container alone: the next Container after the idle stop has the Environment's size again. Changing the Environment's size is not a Container resize.
_Avoid_: Scaling, upgrade

**Backend**:
A place a Workspace runs commands: the Worker Shell or the Container.
_Avoid_: Runtime, executor

**Worker Shell**:
The fast in-Worker shell Backend that runs text commands against the Workspace's files without real binaries.
_Avoid_: just-bash (as a product name), lite shell

**Container**:
The Linux Backend of a Workspace, its own, which runs real programs against the same files.
_Avoid_: Sandbox, VM, box, Machine

**Memory guard**:
What stops the largest process in a Container that is nearly out of memory, so the Container keeps answering; each command running then ends with a note naming what was stopped.
_Avoid_: OOM killer (the kernel's, which acts too late to save the Container)

**Terminal**:
An interactive shell the owner runs on a Workspace's Container from a Session, in the Session's directory, shown as a Pane. The agent does not see it.
_Avoid_: Console, shell (alone), PTY

**Pane**:
A panel beside a conversation that shows something live the owner can look at or work in: the Session's tasks (the Tasks Pane), a Terminal, a Live View, an open file. Open Panes are tabs of the Session page's **Pane area**, a column beside the chat (a full-screen sheet on a phone), and are named in the page's URL.
_Avoid_: Preview (that is a pull request's preview stage), viewer, surface

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
A program an Environment or Repo declares in its mise configuration, which the Container finds among the image's preinstalled versions or installs on demand.
_Avoid_: Dependency, package (for tools)

**Setup Script**:
A script that installs what an Environment's Workspaces need (typically their dependencies): the Environment's own, and each Repo's `.cloudpid/setup.sh`. A Build runs them; a Workspace runs each once on its Container, a Workspace made from a Build too, and again when it changes on the Workspace's branch.
_Avoid_: Install script, setup hook

**Start Script**:
A script that starts what a Workspace needs running (databases, services) at each start of its Container: the Environment's own, and each Repo's `.cloudpid/start.sh`.
_Avoid_: Setup Script (for this), startup hook, entrypoint

**Container-only path**:
A path whose files only the Workspace's Container has, on its disk and in its Snapshot, never in the Workspace's files: in the Workspace's directory, the built-in ones (dependency directories, build output, caches) and those its Environment adds; outside it, every path. The agent's file tools and commands reach them through the Container.
_Avoid_: Ignored path (computer's term), excluded path

**Snapshot**:
A saved copy of a Container's disk, restored when a Container starts so what was installed comes back without downloading: a Workspace's, taken when its Container stops for being idle, and an Environment's Build.
_Avoid_: Backup, checkpoint, image (for the saved disk)

**Registry**:
The single index of Environments, Workspaces, Sessions, settings overrides, and notification subscriptions.
_Avoid_: Catalog, directory

**Notification**:
A Web Push to the owner's subscribed devices when a Session's Run ends, fails, or needs input, linking to the Session.
_Avoid_: Alert, push message (for the user-facing thing)

**Settings**:
The typed configuration with defaults (default model and thinking level, Roles, compaction, offered tools, spend limit, extension options). The overrides the owner or the agent saves live in the Registry, and each Session reads them before its next request.
_Avoid_: Config, preferences

**Usage**:
What a Session has spent on model requests: tokens by kind and the cost in US dollars, summed over its root conversation, its subagents and its title call. Shown in the Session's header.
_Avoid_: Billing, tokens (for the whole figure)

**Spend limit**:
The most a Session may spend, in US dollars, set in the Settings (off by default). A Session at its limit refuses its next model request and ends the Run unanswered, with a message that says why; raising or clearing the limit lets the next prompt go on.
_Avoid_: Budget, quota, cap

## The agent's changes to its harness

**Agent change**:
A change the agent makes to an Environment or to the Settings, recorded with when, the Session, the reason and the values before and after, so the owner can see it and revert it. Some have no revert: the making of an Environment (deleting one needs the owner's Approval), a Build asked for, and a Secret the owner kept in a `secret_ask` form on the agent's request or that the agent deleted with the owner's Approval (recorded by name only, as the history holds no value to bring back). A change the owner approved first is marked so; deleting an Environment is recorded nowhere, as its history goes with it.
_Avoid_: Audit entry, self-modification (for one change), edit

**Limit**:
A setting that bounds what the agent may spend or start: the Spend limit, an Environment's size limit, the subagent depth. The agent changes one only with the owner's Approval.
_Avoid_: Guardrail, ceiling, cap, quota

**Approval**:
The owner's yes or no to an Agent change that waits for it: a change to a Limit, or one no revert can undo (deleting an Environment or a kept Secret).
_Avoid_: Confirmation, permission, consent

## Credentials and the browser

**Secret**:
A value the agent may use but never see: entered by the owner for one Session, kept for an Environment or for every Environment, or resolved from 1Password at use time.
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
A Pane that shows an agent's browser tab, and the windows it opened, live and lets the owner use it, open while a Browser Handoff waits.
_Avoid_: Viewer, screencast, hosted Live View (that is Browser Run's own page)
