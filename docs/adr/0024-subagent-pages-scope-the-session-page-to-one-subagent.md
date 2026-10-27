---
status: accepted
---

# Subagent pages scope the Session page to one Subagent

A Subagent, above all one in a Subagent Workspace, is separate work the owner wants to follow on its own, but the web app showed it only as a Subagent Pane beside the root chat, and its Changes not at all (ADR-0021: "Files, Changes and Terminal panes show the Session's Workspace only"). The Session list now nests each Session's Subagents under it, as a tree by `parent`, and each opens a **Subagent page** (`/sessions/:id/agents/:agentId`): the Session page scoped to that Subagent, with its conversation as the chat, the Changes of its conversation's Workspace (its Subagent Workspace, else its nearest ancestor's, else the Session's) in the Diff pane and the Session details, its own Todo List, its subtree in the Subagents Pane, and a Session layout of its own. The Subagent stays a subagent of its Session: Usage, the Spend limit, the Session's menu and its status (`running` is still the root conversation's) are the Session's, and the page offers only the Subagent's own Stop.

To list Subagents for every Session without waking each Session DO, the Session DO writes a summary of its task graph's agents (`id`, `parent`, `role`, `status`, `branch`) to its `SessionRecord` in the Registry when that list changes, so the Session list's existing poll carries it. The Changes messages (`watch_changes`, `refresh_changes`, `changes`) take an optional `conversationId`, which the Session DO resolves through the conversation's Placement to its Workspace DO. This supersedes ADR-0021's consequence for Changes; Files and Terminal Panes do not exist yet, and the owner still cannot start a Subagent from the UI.

## Considered Options

- **A Subagent as a Session of its own in the list.** Its own page and Changes for free, but it is the Clone that reports back that ADR-0021 rejected: waits, Stop, the task graph and the Spend limit would have to span Session objects.
- **Only the Subagent Pane, made larger.** No new page, but it stays beside the root chat, with the root's Panes and the Session's Changes, which is the isolation the owner asked for.
- **Read Subagents from each Session's socket.** No Registry change, but the list would open a socket to, and wake, every Session DO it shows; or show the open Session's Subagents alone.

## Consequences

- Every change to a Session's agents (a spawn, a delete, `working` to `idle`) is a Registry write, throttled by the Session DO.
- Every Subagent is listed, those left on a Session branch that is not active too, since they still run and hold Workspaces.
