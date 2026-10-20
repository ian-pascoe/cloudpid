# Sessions and Workspaces are separate Durable Objects

Each Session is a Durable Object that hosts one pi-durable Harness, and each Workspace is a separate Durable Object that holds one `@cloudflare/computer` Workspace and its Container. Sessions reach their Workspace over RPC through `ComputerExecutionEnv`. The two are kept apart for two reasons. First, pi-durable's Durable Object adapter commits through `ctx.storage.transaction` behind its own operation queue, and the Workspace would write `ctx.storage` directly, so a failed Harness transaction could roll back Workspace writes. Second, several Sessions share one Workspace the way several local pi sessions share a directory. Subagents are task-owned conversations inside their parent's Harness, not separate objects, so ownership, abort, idle waits, and usage come from pi-durable.

## Considered Options

- **Harness and Workspace in one object.** One fewer RPC hop, but it shares the transaction hazard above.
- **One object per agent, with a coordinator log.** This rebuilds ownership and waits that pi-durable already provides.
