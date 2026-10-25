---
status: accepted
---

# The agent manages its Environments and Settings

The owner wants to change the harness by asking the agent ("give this Environment Postgres", "use Sonnet for the small role") instead of editing dialogs. So the agent gets tools for everything the owner edits on the Environments and Settings pages, and the changes apply at once. Each one is an **Agent change**: recorded in the Registry with when, the Session, the tool, the agent's reason and the values before and after (a Secret's name and Build mark, never its value). The Environments and Settings pages list the last 200 per Environment and for the Settings, each with a revert that is itself recorded and is refused when the value has changed since. A Run that made changes ends with one Notification listing them. Each call's card in the transcript shows the old and new values.

Two kinds of change wait for the owner's **Approval** (a durable request answered on a card in the Session, as a `secret_ask` is, with an `input` Notification; no deadline of its own; Stop withdraws it; a decline returns the owner's reason). The first kind is changes to a **Limit**: the Spend limit, an Environment's size limit (`maxInstance`), and the subagent depth. The second kind is changes no revert can undo: deleting an Environment (which removes its Workspaces and their Sessions) and deleting a kept Secret (the history holds no value to bring back). The agent can therefore raise the bounds on itself, but never without the owner's yes, and instructions injected by a page or repo can make only reversible changes, which the owner sees in the Run's Notification and can revert. They cannot raise a Limit or make a change that no revert can undo.

Tools have one purpose each: one action on one thing, never a general update of a settings object. `environment_*` tools act on an Environment, the current one unless an `id` names another (`"*"` for a Secret kept for every Environment). `settings_*` tools act on the Settings. `container_*` tools act on the current Workspace's Container only: `container_restart` (formerly `restart_container`) and `container_resize`. A Container resize lasts until the idle stop and never changes the Environment; `environment_container_resize` does that. The Environment and Settings tools are the root conversation's only, as `secret_ask` is; subagents keep the `container_*` tools. Values the tools save are plain (variables) or stored as written (scripts, Toolchains), so they resolve no Secret Reference and refuse any text that holds a held Secret's value or the GitHub token. A Secret is kept for an Environment only through `secret_ask`'s masked form, where the owner chooses whether to keep it; the default is still this Session only. Before saving a change that a Build depends on, the agent can make a **Test Build** of it: a Build from the proposed Repos, variables, Setup Script, Toolchains and Container-only paths, which no Workspace starts from and which never replaces the last good Build.

## Considered Options

- **Propose, and the owner saves** (Cursor Cloud Agents' `propose-environment-json`). Safe against prompt injection, but every change waits for the owner, which defeats changing the harness by asking. The history, the revert and the Run's Notification give the owner the same say after the fact. Approval is kept for the changes where after the fact is too late.
- **A few broad tools** (`environment_update` taking a partial settings object). Fewer tools, but each change has different effects (a resize costs money, a Setup Script change makes a Build and runs in every Workspace, variables are plain), which a single tool cannot spell out in its description and result. Deferred tools are also found by `tool_search` matching their names. Anthropic's guidance and Cursor's tools both have one purpose per tool.
- **Limits out of the agent's reach.** Simpler, but the owner would then edit them by hand while every other change can be asked for.
- **The agent's own Environment only.** The `id` costs one optional field per tool, and the owner can then manage every Environment from any Session.

## Consequences

- The Session, not only the main Worker, now starts the Build upkeep after a change, and hands the new Container settings to its own Workspace DO at once when the change is to its own Environment. Other Environments' Workspaces get a change at their next readying, as they do for the owner's edits. Every change still applies at a Container's next start; `container_restart` applies it now.
- Approval is the first approval mechanism in the Session; the Guardian (#38) builds on it.
- Triggers (#191) follow the same rules when they arrive: the agent manages them through tools.
