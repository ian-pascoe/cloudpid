---
status: accepted
---

# An MCP server's Sampling request runs on the owner's models in a completion of its own, and waits for the owner's yes unless the server's definition allows it

An MCP server may ask cloudpid for a reply from a model (`sampling/createMessage`). cloudpid answers only during a call the agent or the owner made in a conversation, and refuses everywhere else. The reply comes from the Session's own `Models`, so Usage, the Spend limit and Secret scrubbing apply as to any other model request. It runs in a completion of its own: the server's system prompt, messages and tools, with nothing of cloudpid's added. No Instructions, conversation or cloudpid tools go in, and `includeContext` is treated as `none`. The server picks the model only through its hints and priorities, mapped onto the Roles. Automatic choice stops at `medium`; only the owner, on the card, can pick a larger Role. Each MCP server definition carries `sampling: "ask" | "allow" | "off"`, default `ask`. With `ask`, the owner allows or refuses on a card, for the call, in the Session, or always/never for that server. A Repo's `.pi/mcp.json` can't grant `allow`, so its `allow` reads as `ask`. With `off`, sampling is never declared. The reply goes only back to the server. A record of each request, kept outside History, never reaches any model.

## Considered options

- **Giving the server context through `includeContext`**: it would hand a third party the owner's conversation, and the spec deprecated it.
- **Asking on every request**: a server's tool loop samples many times within one call, and the owner would face a card for each.
- **Never asking**: an unknown server could spend the owner's money unattended.
- **VS Code's grants per server only**: the first yes would silently cover every later call. cloudpid's main grant is per call, with a Session and an always grant behind it.
- **Letting the owner review or edit the request and the reply (the spec's SHOULDs)**: the completion never sees the owner's context, and the card already shows the request before it runs, so a second gate adds friction without protection.
- **Counting Usage on the tool's result**: that lands only when the call settles, so the Spend limit would miss a running tool loop.
- **Using the Session's model, or no ceiling**: the agent's model (opus by default) and a server's hints should not set what a server's request costs.
- **Not declaring sampling at all** (SEP-2577 advises new implementations not to add it): cloudpid implements deprecated features while the spec still has them, and a server that samples cannot work otherwise.

## Consequences

- A refusal on a Modern server has no wire form, so it ends the originating call in cloudpid without telling the server. A Legacy server gets the JSON-RPC error.
- A deferred Modern request keeps its call running across a Session restart. That makes the `mcp` tool replay-safe, guarded by markers so that a `tools/call` is still never sent twice.
- A Legacy request lives only while its call waits, which gives the owner 10 minutes.
- Sampling is deprecated in `2026-07-28` (SEP-2577) and may be removed from the first revision released on or after 2027-07-28. A connection at a revision without sampling never declares it. The code stays while any revision cloudpid speaks still has sampling.
