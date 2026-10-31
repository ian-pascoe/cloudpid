---
status: accepted
---

# The Environment's MCP host object lives beside the Registry and runs the MCP SDK through a stateless engine in a Worker of its own

Each Environment's MCP servers are owned by one Durable Object, `McpHost` (`mcp:<environment id>`), in the `Server` Worker beside the Registry and the Session DOs. It holds all MCP state and policy: the MCP server set, the MCP inventory and its versions, server status, Resource watches, MCP App HTML, the Legacy session and protocol era rows, the access token and `${NAME}` value caches, and the scheduling of discovery and listens. It imports only `@cloudpid/mcp/types`. The MCP SDK runs in `McpEngine`, a stateless `WorkerEntrypoint` in a plain Worker of its own, `McpWorker` (`apps/mcp-worker`). Only `Server` binds that Worker, and it also serves cloudpid's own `/mcp` as an `McpServer` entrypoint. Each engine call gets everything it needs from the host: the target (with its headers and values resolved), the stored era and session rows as `prior`, and callbacks. Callbacks give it an access token (`auth`), pass a server's questions, progress and logs back to the host, report when response headers arrive, and say when the call is aborted. The call returns its result and the updated rows. The engine reaches stdio servers through the `Workspaces` Worker's `WorkspaceMcpBridge` entrypoint.

We chose this because the host must call the Registry and Sessions must call the host, while the SDK (about 9–10 MiB of cold heap per package, ADR-0036) must stay out of the isolates that run Sessions. A Worker's Durable Objects of every class share its isolates, so keeping the SDK out of them means another script. With the state in `Server` and the SDK in a script that `Server` binds one way, there is no binding cycle. Fresh preview stages deploy as they do today: `Workspaces`, then `McpWorker`, then `Server`. The split falls on a seam that already exists, the core's `connect(target, deps)`.

## Considered options

- **The whole host object in a Worker of its own that binds the Registry back** (Server ↔ McpHosts). Cloudflare rejects a binding to a script or class that does not exist yet, so binding by a literal name breaks the first deploy of every fresh stage. alchemy's circular-binding pattern would mean rewriting `Server` into its Tag/`.make()` form, moving the `Server` and Registry declarations into a shared package to avoid a package cycle, and giving up `/mcp`'s entrypoint, since an Effect Worker exports only `default` and its Durable Objects. The installed alchemy beta has no end-to-end test of a cycle through a Durable Object binding, and a failure would block every preview.
- **Callers passing the Registry's stub to the host on each call**: background work (rediscovery after a sign-in, `list_changed`, gap checks) outlives the call that brought the stub. Whether a received stub stays usable after its call returns is unconfirmed.
- **The host and the SDK in `Server`, with the SDK behind a dynamic `import()`**: a module imported later is still evaluated in the same isolates as the Sessions, and ADR-0036's bundle test forbids it.

## Consequences

- Sessions and the host object deploy together, so their RPC can change freely. Version skew matters only between the host and the engine, and between the main Worker and `McpServer`, which only ever gain methods and optional fields.
- The engine keeps nothing between calls. Each call rebuilds the SDK client from the host's stored era and Legacy session rows. An engine deploy cuts the calls in flight (a cut that may have run; never retried for `tools/call`) but loses no state.
- A server's questions and progress reach a Session through callbacks passed down the call, Session → host → engine. Nothing ever calls a Session (ADR-0030, ADR-0032). RPC cannot carry an `AbortSignal`, so each call also carries a callback that stays pending until the caller aborts it and rejects if the caller dies. Either way, the engine aborts the server request.
- Results over 1 MiB pass engine → host → Session as byte streams, which RPC neither clones nor counts against its 32 MiB limit. The engine bounds memory per isolate.
- The Registry still never calls out. The main Worker and the Sessions carry its changes to the host, and the host calls the Registry in the same script for the MCP server set, `${NAME}` values and access tokens.
