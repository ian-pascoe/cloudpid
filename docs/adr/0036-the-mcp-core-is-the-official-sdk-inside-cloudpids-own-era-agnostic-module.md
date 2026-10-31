---
status: accepted
---

# The MCP core is the official TypeScript SDK inside cloudpid's own era-agnostic module, and pi-mcp only signs in

cloudpid's MCP client speaks both protocol eras: Legacy (`2025-11-25` and earlier) and Modern (`2026-07-28`). Its engine is the official TypeScript SDK v2 (`@modelcontextprotocol/client`, with `server` for cloudpid's own `/mcp` route), pinned exactly, inside `packages/mcp` (`@cloudpid/mcp`). That module gives the Environment's MCP host object one Effect interface, the same for both eras: list, call a tool, get a prompt, read a resource, complete, listen, and resume an answered question. Results are typed as complete, input required, or task, and errors are typed. Era probing (through the SDK's own classifier) and its cache, retries, cuts, byte limits, server questions, the Legacy form of listening, and the task wire all stay behind it. The SDK cannot decode `resultType: "task"`, so the module sends the tasks extension's requests itself, on an SDK transport of its own. pi-mcp is kept only for its `oauth` functions, which the Registry's sign-in code uses (ADR-0034); the SDK's own OAuth is not used.

We chose the SDK because it already ships the Modern plumbing (the `server/discover` probe, MRTR, `subscriptions/listen`, cache hints, the `Mcp-*` headers), runs in workerd with its Workers JSON Schema validator, and is tested against the conformance suite in both eras. pi-mcp speaks only Legacy, and pi has no stated plan for `2026-07-28`.

## Considered options

- **Extending pi-mcp to both eras**, upstream or in a local layer: months of protocol work that the SDK has already done, for an upstream that says it does not implement `2026-07-28` and takes PRs only after a maintainer's approval.
- **Our own client**: the same cost, without even pi-mcp's Legacy base.
- **Exposing the SDK `Client` to the host object**: every caller would relearn the era differences, MRTR, and the cut rules.
- **The SDK's OAuth for sign-in**: importing it into the Registry loads the SDK into the Sessions' script, and half of the sign-in additions (revocation, client-secret renewal, the auth-method order) would still be ours.

## Consequences

- The SDK adds about 9–10 MiB of cold heap per package to every isolate that loads it ([typescript-sdk#2865](https://github.com/modelcontextprotocol/typescript-sdk/issues/2865)). So only `packages/mcp` imports `@modelcontextprotocol/*`, and only `McpWorker`'s stateless `McpEngine` and `McpServer` (`/mcp`) entrypoints load its runtime; the MCP host object drives the engine over RPC (ADR-0038). Everything else imports its types and uses RPC.
- The SDK's releases tighten behaviour in minors. A bump is gated by the conformance suite at the SDK's own CI version, the fake servers of both eras, golden tests of the SDK behaviour the core leans on, and workerd tests. It is pinned on its own, not to `agents`' peer.
- Protocol fixes go upstream to the SDK, not to pi: forwarding `onRequestStreamEnd`, the reconnect and expired-session bugs, a per-call `allowTask`, opting out of eager schema loading, and tying incoming server requests to their call. Until then they are worked around at the injected `fetch`. pi gets only the sign-in additions, as an issue before any PR.
- The owner's earlier lean to build MCP locally on pi-mcp, upstreamable to pi, is given up.
