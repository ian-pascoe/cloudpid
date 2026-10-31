---
status: accepted
---

# Deleted subagent IDs are reusable

Deleting a subagent tombstoned its ID for the life of the Session, so `subagent` could never name it again. Deleting and respawning an agent for the same role is common, and each time the parent had to invent a new ID. pi-minimal-subagents dropped that rule (its ADR-0007), and cloudpid follows it: a spawn that names a deleted ID starts a new, unrelated agent, with a fresh conversation and Launch Contract, and nothing of the deleted one's turns or results. Automatic `agent-<n>` IDs still skip every tombstoned ID, so a parent's earlier mention of `agent-3` never points at a new agent it did not name.

pi-minimal-subagents tells the two agents apart by turn and session IDs that carry a UUID. Here turn IDs are `turn-<n>`, counted per agent, and a Subagent Workspace is found in the Registry by Session and subagent ID, so the Subagents document keeps, by deleted ID, what a later agent of that ID must not repeat or inherit (`retired`):

- **Turn numbering goes on** from the deleted agent's, so `turn-1` of a deleted `worker` and the first turn of the new `worker` are never both `turn-1` in the parent's conversation, a `subagent_wait` by `turn_id`, or a reporter still settling.
- **Its Subagent Workspace**, which `subagent_delete` may have failed to remove. The spawn removes it before asking for a Workspace, or the Registry would hand the new agent the old one's files and branch, and it is refused, naming it, while it cannot be removed.

Everything else compares identity rather than ID: a tool decides only while its calling conversation still runs the caller, a wait, message or delete only while its target runs the conversation it read, and a reporter settles only the turn its own task carries.

## Considered Options

- **Keep the tombstones.** Simplest, but every respawn for a role needs a new name, and the model often tries the old one first.
- **Make turn IDs unique** (a UUID, or the reporter task's ID). It would tell incarnations apart without `retired`, but every report header, wait and test names `turn-<n>`, and the Subagent Workspace would still be found by agent ID.
- **Key Subagent Workspaces by something other than the agent ID.** A Registry migration for a case only a failed removal reaches; the spawn removing what was left behind is local to the extension.

## Consequences

- A Subagent page, a URL or a Session list entry naming a deleted ID shows the new agent once one takes it.
- The Subagents document gains an optional `retired` map, one small entry per deleted ID that no agent has taken again; its version stays 1.
