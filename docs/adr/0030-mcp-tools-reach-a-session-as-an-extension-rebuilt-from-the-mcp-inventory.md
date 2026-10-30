---
status: accepted
---

# MCP tools reach a Session as an extension rebuilt from the MCP inventory, named `mcp__<server>__<tool>` in snake_case

pi-durable registers tools by installing extensions and has no runtime `addTools` for tools it has not seen; its `codemode` namespaces are fixed when that extension is created. So a Session builds one `mcp` extension from its Environment's MCP inventory, each tool's call going to the Environment's MCP host object, and when the inventory's version changes (compared at each request start) it installs `mcp` again together with `codemode` (for the namespaces) and `tool-search`. Exposure maps onto pi-durable's flags: `direct` is offered, `deferred` is deferred, `codemode` is callable from tools only (`callers: ["tools"]`) and deferred, so it is neither in the `codemode` section nor loadable by `tool_search`, and `hidden` is not registered. Tool declarations follow the inventory from the next request, which costs one prompt-cache miss per conversation, as a `tool_search` load does; the `mcp_servers` section, by contrast, is read once per Context Window, and a change to it reaches the model as a notice entry placed between rounds (a `write` submission), never as a patched section. Names keep pi's `mcp__<server>__<tool>` shape with snake_case parts (`getUser` becomes `get_user`; `-`, `.` and case are normalized), and a hash of the server and tool name is added to every member of a collision and to a name over the providers' 64 characters, so names never depend on the order a server lists its tools in.

## Considered options

- **Freezing `direct` declarations per Context Window**: keeps the cache whole, but registration is Session-wide while a Context Window is a conversation's, so pi-durable has no way to declare a tool to one conversation's next window and not another's, and a withdrawn tool would stay declared and fail when called.
- **Patching the `mcp_servers` section** (pi-durable's patch entry) or a tail note rewritten on every request (the `todo` extension's): the first breaks the prompt-cache rule, the second carries a byte-stable replay burden for a rare event.
- **pi's names, which keep the server's case and only replace characters outside `[A-Za-z0-9_]`**: breaks the snake_case rule for model-facing tool names and the repo's own check, and pi's first-come collision suffix renames tools when a server reorders its list.
- **The host object pushing changes to Sessions**: it would have to track live Sessions and would wake idle ones.

## Consequences

- `mcp__` with its double underscores is an accepted exception to the snake_case rule; names in `tools.offered`, toolsets, Notes and imported pi transcripts use cloudpid's spelling, so an importer maps pi's names through the same normalization.
- A tool renamed because a new tool of its server collides with it is not announced; a loaded or scripted old name stops resolving.
- A subagent's enabled tools are fixed at its spawn, so tools a server adds later do not reach that child.
