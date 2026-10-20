# cloudpid

A personal coding agent on Cloudflare: pi's harness running durably in Durable Objects, working on project files held in the cloud.

## Agents and conversations

**Session**:
One agent workspace-of-work the user opens: a root conversation, its subagents, and their history, bound to one Workspace.
_Avoid_: Chat, thread, conversation (for the whole unit)

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

**Handoff**:
An agent-written note that starts a fresh context window in the same conversation.
_Avoid_: Summary, checkpoint note

## Workspaces and execution

**Workspace**:
A persistent project file tree, holding one or more repos, shared by every Session bound to it.
_Avoid_: Sandbox, project directory, box

**Backend**:
A place a Workspace runs commands: the Worker Shell or the Container.
_Avoid_: Runtime, executor

**Worker Shell**:
The fast in-Worker shell Backend that runs text commands against the Workspace without real binaries.
_Avoid_: just-bash (as a product name), lite shell

**Container**:
The Linux Backend of a Workspace, which runs real programs against the same files.
_Avoid_: Sandbox, VM, box

**Toolchain**:
A program a Workspace declares in its mise configuration and the Container installs on demand.
_Avoid_: Dependency, package (for tools)

**Registry**:
The single index of Workspaces, Sessions, settings overrides, and notification subscriptions.
_Avoid_: Catalog, directory

## Credentials and the browser

**Secret**:
A value the agent may use but never see, entered by the user or resolved from 1Password at use time.
_Avoid_: Env var, key (in general)

**Credential**:
A 1Password item the agent may fill into a web page, scoped to the item's own sites.
_Avoid_: Login, password (for the item)

**Browser Handoff**:
Giving the user live control of the agent's browser for a step the agent cannot do.
_Avoid_: Handoff (alone), takeover, live view (for the act)
