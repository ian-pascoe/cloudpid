---
status: accepted (the host's alarm, which holds it in memory while a discovery is in flight: amended by #648)
---

# An MCP task waits in its call up to its server's timeout, then goes on in the background, and the agent is told when it ends and reads its result through a tool

A Modern MCP server may answer a `tools/call` with an MCP task (the `io.modelcontextprotocol/tasks` extension), work it goes on doing after answering. cloudpid declares the extension on every `tools/call` that an agent or an App View makes and can wait for, with no per-server switch. An agent's call (the root's, a subagent's, or one inside a `codemode` script) waits for the task, polling `tasks/get`, for as long as the server's MCP server definition lets a request wait, at most 10 minutes. A task still working then goes on in the background. The call returns cloudpid's own handle (`mcp-task-3`; a script gets an error value naming it), and the server's task id never reaches a model, a client or a span. A pi-durable task in the Session follows the MCP task, sleeping between polls so that evictions and deploys never end it. The MCP host object keeps nothing. When the task ends, an `mcp_task_wait` already waiting on it takes the result. Otherwise, once the conversation is idle, cloudpid posts an entry that says only that the task ended: follow-up input to a root conversation, or a new turn of a subagent, whose answer reaches its parent. The agent then reads the result, which the server wrote, as the result of `mcp_task_wait`. The owner or the agent can cancel a task with `tasks/cancel`; an end the owner caused starts no Run. An App View's call waits for its task only while the View lives, at most 15 minutes. cloudpid is never a task receiver: the extension covers only `tools/call`, and the `2025-11-25` experimental tasks stay out of scope.

## Considered options

- **Waiting to the end, in every call** (VS Code): it holds the Run and the owner's steers for hours. pi-durable counts every eviction of a tool waiting in memory, and cloudpid deploys on every merge, so five merges end the call and lose the task.
- **Going to the background at once** (Claude Code): it costs a tool round and a prompt-cache miss for every short task, and servers may make a task of a three-second job.
- **The agent choosing per call**: an argument on every MCP tool pollutes the server's schemas and can collide with its own.
- **The result's content in the posted entry**: that entry is a user message that starts a Run with nobody watching, the strongest place an injected instruction can get. A tool result keeps the server's text in the role models treat as data. A Resource watch's notice is URI-only for the same reason (ADR-0032).
- **Subagents and scripts waiting to the end**: a subagent can be given a new turn, as `agent_message` and subagent reports already do, so nothing needs to wait.
- **Polling from the MCP host object**: it has no alarm that schedules work (its alarm only holds it in memory while a discovery is in flight, #648) and never calls a Session (ADR-0038).
- **Push through `subscriptions/listen`**: the host can't pass a notification on to a Session, and a dropped stream loses notifications for good.
- **Steering a result into a busy Run**: it would interrupt the agent's work, which subagent reports don't.
- **Showing the server's task id**: the spec lets a task id act as a bearer token, so a leaked id may be all that protects the task.

## Consequences

- A call may return before the server's work ends. The agent sees a handle and three tools (`mcp_tasks`, `mcp_task_wait`, `mcp_task_cancel`), loaded at its first background MCP task.
- A Session that only follows MCP tasks is idle and reads "Following n MCP tasks", not running. Followers don't count as Workspace activity.
- A stdio server's MCP task ends when its Container stops, an hour after the last activity there unless the owner keeps the Container.
- When the server no longer knows a task (`-32602`), or the task can't be reached any more, its outcome is unknown. cloudpid stops following after seven days.
- A question in an MCP task (`input_required`) is an Elicitation or Sampling request like any other, and it can wait as long as the task does.
