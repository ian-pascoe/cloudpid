# MCP spec revisions after 2025-11-25: what a client/host must implement

Research for ticket #374 (map #373). Fetched 2026-10-29. Question: every MCP specification revision, and every accepted SEP or extension the spec now includes, from `2025-11-25` to the present; for each, what a client/host must implement; which of it pi-mcp already covers.

Conventions: **[V]** verified in a primary source (cited), **[I]** inference (reasoned from sources, not stated by them), **[U]** unknown / open.

## 1. Answer in brief

1. **Exactly one dated revision exists after `2025-11-25`: `2026-07-28`**, which the spec's versioning page calls the _current_ revision. The `draft` changelog is empty ("Changes since the most recent release will accumulate here"). **[V]** [versioning](https://modelcontextprotocol.io/specification/versioning), [draft changelog](https://modelcontextprotocol.io/specification/draft/changelog.md), GitHub `docs/specification/` directory listing (`2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`, `draft`).
2. `2026-07-28` is a **breaking, era-changing revision**: it removes the `initialize` handshake, protocol sessions (`Mcp-Session-Id`), the HTTP GET stream, SSE resumability, `ping`, `logging/setLevel`, `resources/subscribe`, `notifications/roots/list_changed` and server-initiated JSON-RPC requests. It adds per-request `_meta` (version, capabilities, client info), `server/discover`, `subscriptions/listen`, Multi Round-Trip Requests (MRTR), `resultType`, cache hints (`ttlMs`/`cacheScope`), mandatory HTTP request headers, and an `extensions` capability map. **[V]** [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md).
3. Spec text calls the two protocol families **Legacy** (`initialize` handshake, `2025-11-25` and earlier) and **Modern** (`2026-07-28`+), and a **dual-era** client is one that speaks both. A modern-only client **fails** against a legacy server; a legacy-only client fails against a modern server. **[V]** [versioning › compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md). So a cloudpid client that connects to today's servers has to be dual-era. **[I]** (the spec makes the matrix explicit; that existing servers are mostly legacy is not stated by a source).
4. **Tasks** left the core and became the official extension `io.modelcontextprotocol/tasks` (Beta, destination: Core), with a redesigned wire shape (`tasks/get`, `tasks/update`, `tasks/cancel`; no `tasks/result`, no `tasks/list`; server-directed creation). **MCP Apps** (`io.modelcontextprotocol/ui`) is a Stable extension. **Skills** and **Server Cards** are Beta extensions. Two **auth extensions** (client credentials, enterprise-managed authorization) are Stable. **[V]** [extensions overview](https://modelcontextprotocol.io/extensions/overview.md).
5. **Roots, Sampling and Logging are Deprecated** in `2026-07-28` (SEP-2577), as are Dynamic Client Registration (in favour of Client ID Metadata Documents), the HTTP+SSE transport, and `includeContext: "thisServer"/"allServers"`. Earliest removal: first revision released on or after 2027-07-28. **[V]** [deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md). Several of the map's "starting positions" (sampling, roots from the Workspace's Repos, server logging, `logging/setLevel`) sit on deprecated features; see §9.
6. **pi-mcp covers none of the `2026-07-28` protocol changes.** It speaks only the legacy handshake (`LATEST_PROTOCOL_VERSION = "2025-11-25"`, `.repos/pi/packages/mcp/src/protocol/types.ts:4`). Its OAuth subset is current (CIMD, DCR with `application_type`, `iss` validation, step-up). It lacks prompts, completion, subscribe, `logging/setLevel`, sampling and elicitation handlers, tasks, and `extensions` capabilities (details §8).
7. The next release is planned for **late March 2027** (SEP-3398, Accepted 2026-10-14, moves the December 2026 target to March 2027), and the roadmap names Tasks, HTTP-over-stdio, ETag caching, DPoP and agent identity, and tool-result-shape redesign as the next areas. **[V]** [SEP-3398](https://modelcontextprotocol.io/seps/3398-release-cycle-updates.md), [roadmap](https://modelcontextprotocol.io/development/roadmap.md) (last updated 2026-08-22). Nothing is in `draft` yet.

## 2. Revision and extension inventory

### 2.1 Core revisions after 2025-11-25

| Revision     | Status          | Notes                                                                                                                                                                                                                                                                                                                               |
| ------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2025-11-25` | Final; baseline | Not a "change"; included because pi-mcp targets it. Changelog: OIDC discovery, icons, incremental scope consent, tool-name guidance, enum elicitation schemas, URL-mode elicitation, sampling with tools, CIMD, experimental tasks, SSE polling. [changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog.md) |
| `2026-07-28` | **Current**     | Everything in §3–§6. Spec: <https://modelcontextprotocol.io/specification/2026-07-28>.                                                                                                                                                                                                                                              |
| `draft`      | Empty           | No accepted changes since `2026-07-28`.                                                                                                                                                                                                                                                                                             |

SEP index: 44 Final, 1 Accepted (SEP-3398, a process SEP). **[V]** [SEP index](https://modelcontextprotocol.io/seps/index.md).

### 2.2 SEPs that landed in `2026-07-28` (core, Standards Track)

| SEP                   | Change                                                                                                                              | Client impact                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 2567                  | Remove protocol sessions and `Mcp-Session-Id`; list endpoints don't vary per connection                                             | Drop session handling on modern servers       |
| 2575                  | Stateless MCP; `server/discover`; `subscriptions/listen`; remove `ping`, `logging/setLevel`, `roots/list_changed`, SSE resumability | Rewrite connection layer                      |
| 2322                  | Multi Round-Trip Requests (`InputRequiredResult`); `resultType`                                                                     | New retry loop for elicitation/sampling/roots |
| 2260                  | Server requests must be tied to a client request                                                                                    | Subsumed by MRTR in modern                    |
| 2243                  | `Mcp-Method`, `Mcp-Name` headers; `x-mcp-header` → `Mcp-Param-*`                                                                    | Mandatory headers on every POST               |
| 2549                  | `ttlMs`, `cacheScope` on list/read results                                                                                          | Client cache                                  |
| 2106                  | `inputSchema`/`outputSchema` any JSON Schema 2020-12 keyword; `structuredContent` any JSON value                                    | Schema handling                               |
| 2164                  | Resource-not-found `-32002` → `-32602`                                                                                              | Accept both                                   |
| 414                   | OpenTelemetry `traceparent`/`tracestate`/`baggage` in `_meta`                                                                       | Optional propagate                            |
| 2468, 2352, 837, 2207 | Auth: `iss` check, issuer-keyed credentials, `application_type`, refresh-token guidance                                             | §6                                            |
| 2577, 2596            | Deprecate Roots/Sampling/Logging; lifecycle policy; deprecate HTTP+SSE                                                              | §5                                            |
| PR #2858              | Deprecate Dynamic Client Registration                                                                                               | §6                                            |

All sources: [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md) and [SEP index](https://modelcontextprotocol.io/seps/index.md). **[V]**

### 2.3 Official extensions (Extensions Track)

| Extension                        | Identifier                                                 | Stage                          | SEP                                                                                       | Spec location                                                                  |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| MCP Apps                         | `io.modelcontextprotocol/ui`                               | **Stable**                     | 1865 (Final)                                                                              | `ext-apps` `specification/2026-01-26/apps.mdx` ("Status: Stable (2026-01-26)") |
| OAuth Client Credentials         | `io.modelcontextprotocol/oauth-client-credentials`         | **Stable**                     | 1046                                                                                      | `ext-auth` stable, revision `2026-07-28`                                       |
| Enterprise-Managed Authorization | `io.modelcontextprotocol/enterprise-managed-authorization` | **Stable**                     | 990                                                                                       | `ext-auth` stable, revision `2026-07-28`                                       |
| Tasks                            | `io.modelcontextprotocol/tasks`                            | **Beta, destination Core**     | 2663 (Final)                                                                              | `ext-tasks` `specification/2026-07-28/tasks.md`                                |
| Skills over MCP                  | `io.modelcontextprotocol/skills`                           | **Beta**, destination unstated | 2640 (Final)                                                                              | `ext-skills` `specification/beta/skills.mdx`                                   |
| Server Cards                     | (none stated)                                              | **Beta**, destination unstated | 2127 (Final; charters the extension, wire format lives in `experimental-ext-server-card`) | see SEP                                                                        |

Stages and destinations: [extensions overview](https://modelcontextprotocol.io/extensions/overview.md); stage definitions and "always disabled by default, explicit opt-in at every stage": same page / [SEP-3392](https://modelcontextprotocol.io/seps/3392-extension-lifecycle.md). Spec files: GitHub tree of `modelcontextprotocol/ext-tasks`, `ext-apps`, `ext-auth`, `ext-skills` (`git/trees/main?recursive=1`). **[V]**

Other Final SEPs in the index are governance/process (932, 994, 1302, 1730, 1850, 2085, 2148, 2149, 2484, 2596, 3392) and not client-facing. SEP-3398 (release cadence) is Accepted, process-only. **[V]**

## 3. Core protocol: connection model (client must implement)

### 3.1 Per-request metadata and `server/discover`

- No handshake. **Every request** carries in `params._meta`: `io.modelcontextprotocol/protocolVersion` (required), `io.modelcontextprotocol/clientCapabilities` (required), `io.modelcontextprotocol/clientInfo` (SHOULD). A request missing a required field is rejected with `-32602`. Servers identify themselves in each result's `_meta["io.modelcontextprotocol/serverInfo"]`. **[V]** [basic › `_meta`](https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md)
- Version mismatch → `UnsupportedProtocolVersionError` (`-32022`, `data.supported`, `data.requested`); the client retries with a mutually supported version. **[V]** [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md)
- `server/discover` (servers MUST implement it; clients MAY call it first): returns `supportedVersions`, `capabilities` (including `extensions`), `instructions`, `serverInfo`, plus `ttlMs`/`cacheScope`. On stdio, a dual-era client SHOULD send it first as the era probe. **[V]** [discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md)
- A server MUST NOT rely on capabilities the client did not declare and MUST return `MissingRequiredClientCapability` (`-32021`) if it needs one. Because capabilities are per request, the client may declare different capabilities on different requests (e.g. `elicitation` only when a UI is attached). **[V]** basic page; the "only when a UI is attached" use is **[I]**.
- Error codes: spec-reserved range `-32020`…`-32099`: `HeaderMismatch -32020`, `MissingRequiredClientCapability -32021`, `UnsupportedProtocolVersion -32022`; implementations MUST NOT emit `-32002` (resource not found, now `-32602`) or `-32042` (URL elicitation required), but clients SHOULD still accept `-32002` from older servers. **[V]** [basic › error codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md)
- Every result carries `resultType` (`complete`, `input_required`, or an extension value such as `task`). Clients MUST treat an absent value as `complete` and any unrecognized value as invalid. **[V]** basic page.

### 3.2 Dual-era detection

- **Streamable HTTP**: try a modern request; on `400 Bad Request` read the body. A recognized modern JSON-RPC error (`UnsupportedProtocolVersion`, `MissingRequiredClientCapability`, `HeaderMismatch`) means modern, retry; an empty or unrecognized body means legacy, fall back to `initialize`. For 400/404/405 without a modern error body the client may further try the deprecated HTTP+SSE `GET` handshake (cloudpid has ruled that out). **[V]** [streamable-http › backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md)
- **stdio**: probe with `server/discover`; `DiscoverResult` or a recognized modern error = modern; any other error or timeout = legacy → `initialize`. The fallback MUST NOT key on one specific error code. **[V]** [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md)
- Cache the era per server process (stdio) or origin (HTTP); MAY persist per server configuration and re-probe if the assumption fails. **[V]** versioning page.
- The old `Mcp-Session-Id`, GET stream, `Last-Event-ID` and server-sent requests remain required **only** when speaking a legacy version to a legacy server (rules live in the `2025-11-25` page). **[V]**

### 3.3 Streamable HTTP (modern)

Client MUSTs **[V]** ([streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md)):

- Each JSON-RPC message is its own POST; `Accept` lists `application/json` and `text/event-stream`; the client MUST handle both response types.
- Headers on every request POST: `MCP-Protocol-Version` (must equal `_meta` value), `Mcp-Method` (all requests), `Mcp-Name` (`tools/call`, `prompts/get` → `params.name`; `resources/read` → `params.uri`; Tasks `tasks/*` → `params.taskId`). Non-ASCII/unsafe values use the `=?base64?…?=` form; plain values that match the sentinel MUST also be encoded.
- `x-mcp-header`: servers may annotate primitive tool parameters; **clients MUST mirror them as `Mcp-Param-{Name}` headers** and MUST drop (and SHOULD warn about) tools whose annotations violate the constraints (empty/non-token name, duplicates case-insensitively, non-primitive or `number` type, not statically reachable through `properties`). On `HeaderMismatch` the client SHOULD re-run `tools/list` and retry.
- Closing the SSE response stream **is** cancellation; no `notifications/cancelled` over HTTP. No client→server notifications are defined for HTTP in this revision.
- No GET endpoint, no sessions, no `Last-Event-ID`: a broken response stream loses the in-flight request and the client MUST re-issue it as a new request with a new ID (changelog item 9).
- Servers MUST NOT send JSON-RPC requests on the response stream; only request-related notifications (`notifications/progress`, `notifications/message`) precede the final response. Clients must ignore SSE comment lines (keep-alive).

### 3.4 stdio (modern)

Newline-delimited JSON; **no headers**; metadata is in `_meta`; server MUST NOT write JSON-RPC requests (server-to-client interactions are MRTR). Client sends `notifications/cancelled` to cancel. Shutdown: close stdin, wait, then SIGTERM/SIGKILL. On unexpected exit the client SHOULD restart the server, retry lost requests, and re-send `subscriptions/listen`. Clients SHOULD NOT use a task/thread/conversation as the lifetime boundary of the stdio process. **[V]** [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md), [basic › statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md). The stdio page states the wire format "works unchanged over Unix domain sockets, TCP connections, or any similar channel", and the roadmap lists "HTTP over stdio" as future work. **[V]** [roadmap §2](https://modelcontextprotocol.io/development/roadmap.md)

### 3.5 Multi Round-Trip Requests (MRTR)

- Replaces server-initiated `roots/list`, `sampling/createMessage`, `elicitation/create`. A server answering `tools/call`, `prompts/get` or `resources/read` (and only those) MAY return `resultType: "input_required"` with `inputRequests` (a map of server-keyed `ElicitRequest` / `CreateMessageRequest` / `ListRootsRequest`) and/or an opaque `requestState`. **[V]** [mrtr](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr.md)
- Client MUSTs: build all requested `inputResponses` before retrying (if `inputRequests` is present); echo `requestState` **verbatim** and never inspect or modify it (and send none if the server sent none); use a **new JSON-RPC `id`** on the retry; scope `inputRequests`/`requestState` to that one retry only. Retried results (those carrying `inputResponses`/`requestState`) MUST NOT be cached. Servers must not send a request kind the client did not declare. **[V]** mrtr page; [caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md)
- URL-mode elicitation: `notifications/elicitation/complete` and `elicitationId` are **removed**; the client learns the outcome by retrying, and SHOULD give the user manual retry/cancel controls. **[V]** [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation.md), changelog minor item 11.
- Consequence for a host: an elicitation/sampling prompt is no longer a live request inside an open call; the original request has already completed with `input_required`, and the answer is delivered on a **new** request. **[I]** (follows from the above; matters for how a durable "ask the user" request is modelled).

### 3.6 Subscriptions

- `subscriptions/listen` is a long-lived POST whose response is an SSE stream (HTTP) or a request/response pair on the shared channel (stdio). Filter: `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions: [uri]`. The server MUST send `notifications/subscriptions/acknowledged` first (the honoured subset) and tag every notification with `io.modelcontextprotocol/subscriptionId` (the listen request's JSON-RPC id). Cancel by closing the stream (HTTP) or `notifications/cancelled` (stdio); a graceful server shutdown ends with a `complete` result. The client SHOULD check the acknowledged filter and, on a non-graceful drop, MAY reconnect; on stdio reconnect it MUST re-send `subscriptions/listen`. **[V]** [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md)
- Replaces `resources/subscribe`/`unsubscribe` and the GET stream. `logging/setLevel` is replaced by a per-request `io.modelcontextprotocol/logLevel`; servers MUST NOT emit `notifications/message` for requests that omit it. `ping` and `notifications/roots/list_changed` are removed. **[V]** changelog items 4–5.
- Request-scoped notifications (`notifications/progress`, `notifications/message`) flow only on the originating request's own stream. **[V]**
- The Tasks extension adds `taskIds` to the listen filter and `notifications/tasks`. **[V]** `ext-tasks` spec §"Task Status Notifications".

### 3.7 Caching

`ttlMs` (ms freshness; absent or negative → 0) and `cacheScope` (`public` | `private`) on `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read` results. Cache key = method + result-affecting params (e.g. `cursor`, `uri`); `private` results must not be shared across authorization contexts (e.g. a different access token); clients SHOULD NOT treat TTL as a polling interval; applies to every page of a paginated list. Tools SHOULD be returned in deterministic order (prompt-cache friendliness). Caching complements, not replaces, list-changed notifications. **[V]** [caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md)

### 3.8 Other core changes a client sees

- `tools/list` and `prompts/list` MUST NOT vary per connection or as a side effect of other requests; they MAY vary by the authorization presented. **[V]** tools/prompts pages.
- `execution.taskSupport` is gone from `Tool` (tasks are server-directed in the extension). `inputSchema`/`outputSchema` accept any JSON Schema 2020-12 keyword; `$ref` resolution requirements and composition-keyword resource bounds were added; external `$ref` fetching MUST be disabled by default. `structuredContent` may be any JSON value. **[V]** tools page diff vs `2025-11-25`, basic › JSON Schema, changelog minor item 10.
- Tool-name uniqueness is per server; aggregating clients SHOULD disambiguate by prefix, and server `serverInfo.name` should not be used for that. **[V]** tools page (this matches cloudpid's `mcp__<server>__<tool>`).
- `completion/complete` is unchanged apart from `ref/resource` also naming URI templates; prompts and resources keep their methods. **[V]** completion/prompts/resources page diffs.
- OpenTelemetry: `traceparent`, `tracestate`, `baggage` are reserved un-prefixed `_meta` keys for W3C Trace Context. **[V]** basic page.
- Cancellation: clients SHOULD set per-request timeouts and cancel on expiry (HTTP: close the stream; stdio: `notifications/cancelled`); servers only send `notifications/cancelled` to end a subscription. Progress is server→client only. **[V]** cancellation/progress pages.

## 4. Tasks extension (`io.modelcontextprotocol/tasks`)

Client obligations **[V]** ([overview](https://modelcontextprotocol.io/extensions/tasks/overview.md), `ext-tasks` `specification/2026-07-28/tasks.md`):

1. Declare `extensions["io.modelcontextprotocol/tasks"]: {}` in per-request `clientCapabilities`; the server advertises it in `server/discover`. A server MUST NOT return a task to a client that did not declare it on that request.
2. Any `tools/call` may return either the normal result or `CreateTaskResult` with `resultType: "task"` (only `tools/call` supports it today). The server alone decides per request; the client never asks.
3. Task = `{taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs|null, pollIntervalMs?}`; statuses `working`, `input_required`, `completed`, `failed`, `cancelled` (last three terminal). `failed` is only for JSON-RPC errors; a tool result with `isError: true` is `completed`.
4. Poll `tasks/get` honouring `pollIntervalMs`; on `completed` read `result`, on `failed` read `error`. **Persist task IDs durably** so polling resumes after a restart (SHOULD).
5. On `input_required`, `tasks/get` returns `inputRequests` (same shapes as MRTR); answer with `tasks/update {taskId, inputResponses}` (ack is eventually consistent; each key unique over the task's life; SHOULD deduplicate). Apply the normal elicitation/sampling trust model: "A task is not a higher-trust channel."
6. `tasks/cancel {taskId}` (cooperative); `notifications/cancelled` MUST NOT be used for tasks.
7. Optional push: put `taskIds` in a `subscriptions/listen` filter to receive `notifications/tasks` (full task state each time). `notifications/progress`/`message` are not supported on tasks.
8. HTTP: `Mcp-Name` MUST be `params.taskId` on `tasks/*` requests.
9. Backward-compat note in the spec: a client with a fixed-return `callTool()` can drive the polling internally and surface only the final result.

Legacy tasks: `2025-11-25` core had experimental tasks (`tasks/result`, `tasks/list`, `execution.taskSupport`, a `task` request param). They are **not** the same wire protocol as the extension. `ext-tasks`' README says its TypeScript package carries "2025-11-25 Tasks receiver support". **[V]** [ext-tasks README](https://github.com/modelcontextprotocol/ext-tasks), changelog item 6. Whether a legacy-era client should speak `2025-11-25` tasks to legacy servers is a product decision, not a spec requirement (negotiation is by version). **[I]**

## 5. Deprecations (all `2026-07-28`; still functional)

| Feature                                            | Migration path the spec gives                 | Earliest removal                            |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Roots                                              | tool parameters, resource URIs, server config | first revision released on/after 2027-07-28 |
| Sampling                                           | integrate with LLM provider APIs directly     | same                                        |
| Logging                                            | stderr (stdio), OpenTelemetry                 | same                                        |
| Dynamic Client Registration                        | Client ID Metadata Documents                  | same                                        |
| `includeContext: "thisServer"\|"allServers"`       | omit or `"none"`                              | follows Sampling                            |
| HTTP+SSE transport (deprecated since `2025-03-26`) | Streamable HTTP                               | three months after SEP-2596 Final           |

**[V]** [deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md), [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging.md), [feature lifecycle](https://modelcontextprotocol.io/community/feature-lifecycle.md): deprecated features stay at least 12 months (90 days under the expedited exception). New implementations "SHOULD NOT adopt" them; the features are fully functional during the window. Because releases are March/September (SEP-3398), the first release eligible to remove them is probably September 2027. **[I]**

Elicitation (form and URL), prompts, completion, resources, tools and progress are **not** deprecated.

## 6. Authorization changes

`2026-07-28` core authorization **[V]** ([authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index.md), [client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)):

- **`iss` validation (SEP-2468)**: the client MUST record the `issuer` from validated AS metadata before redirecting, and MUST validate a present `iss` on the authorization response (RFC 9207 §2.4; exact string comparison, no normalization; also on error responses) before redeeming the code. AS SHOULD send it. A future revision is expected to raise it to MUST.
- **Issuer-keyed credentials (SEP-2352)**: persisted client credentials (pre-registered or DCR) MUST be keyed by the AS `issuer`; MUST NOT be reused with a different AS; MUST re-register when the AS changes.
- **`application_type` (SEP-837)**: MUST be set on DCR (`native` for loopback/CLI/desktop, `web` for remote-hosted).
- **Registration priority**: CIMD (SHOULD support) > pre-registration > DCR (now Deprecated, retained for compatibility).
- Unchanged and already in `2025-11-25`: PRM (RFC 9728) discovery, OAuth AS and OIDC metadata discovery, RFC 8707 `resource`, step-up via `WWW-Authenticate` `insufficient_scope`, token handling; refresh-token guidance (SEP-2207): keep refresh tokens confidential, MAY add `offline_access` only when in the AS's `scopes_supported`, never assume a refresh token is issued.
- Auth applies to HTTP transports; stdio SHOULD NOT follow it.

Auth extensions (Stable, optional) **[V]**: _Client Credentials_ — machine-to-machine, no user, requires pre-registered credentials (no DCR), client authenticates with JWT (RFC 7523, recommended) or client secret; _Enterprise-Managed Authorization_ — the client holds an enterprise-IdP identity assertion, token-exchanges (RFC 8693) for an ID-JAG, then presents it as a JWT grant (RFC 7523) to the MCP server's AS. [ext-cc](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials.md), [ext-ema](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization.md). Whether a single-owner agent has any use for them is a product decision (Client Credentials plausibly, EMA only with an enterprise IdP). **[I]** The roadmap flags DPoP and workload-identity federation as the next auth work, not yet in the spec. **[V]** roadmap §3.

(Hosted OAuth details for cloudpid are the subject of a separate ticket; only the revision-level changes are listed here.)

## 7. Extensions: client/host obligations

Negotiation: `extensions` is a map of identifier → settings object, in `clientCapabilities` (per request, modern) or `initialize` params (legacy; not in the published `2025-11-25` schema, but supported "so extensions work consistently across protocol versions"). Extensions are always off until the developer opts in; if one side lacks the extension the other MUST fall back to core behavior or reject. **[V]** [extensions overview › negotiation](https://modelcontextprotocol.io/extensions/overview.md), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md).

### 7.1 MCP Apps (`io.modelcontextprotocol/ui`, Stable 2026-01-26)

Summary only (a separate ticket covers MCP Apps hosting in depth). Host obligations per the stable spec [`ext-apps/specification/2026-01-26/apps.mdx`](https://github.com/modelcontextprotocol/ext-apps) **[V]**:

- Advertise `extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }` (`mimeTypes` REQUIRED).
- Tools reference a UI via `_meta.ui.resourceUri` (a `ui://` resource); the host fetches it with `resources/read`, and may preload it before the call. Resource `_meta.ui` carries `csp`, `permissions`, `domain`, `prefersBorder`.
- Render in a sandboxed iframe; a Sandbox Proxy must send/receive `ui/notifications/sandbox-proxy-ready` / `sandbox-resource-ready` (Host MUST send the raw HTML only after the proxy is ready).
- Implement the iframe↔host JSON-RPC dialect: `ui/initialize` → `ui/notifications/initialized`, host context and capabilities (`hostContext`, theming, display modes, container dimensions), `ui/open-link`, `ui/message`, `ui/request-display-mode`, `ui/update-model-context`, `ui/notifications/tool-input`, `tool-input-partial`, `tool-result`, `tool-cancelled`, `size-changed`, `host-context-changed`, `ui/resource-teardown`; forward `tools/call`, `resources/read` and related MCP messages from the app to the server (subject to host policy).
- The `draft` Apps spec (not yet released) additionally allows `_meta.ui` on `resources/list` entries with content-item values taking precedence, and relaxes some sandbox-proxy MUSTs to SHOULD. **[V]** diff of `2026-01-26/apps.mdx` vs `draft/apps.mdx`.
- The stable Apps spec's negotiation examples use `initialize`; how it composes with per-request capabilities is covered generically by the extensions overview. No Apps text for the modern era was found. **[U]**

### 7.2 Skills over MCP (`io.modelcontextprotocol/skills`, Beta)

Server declares `resources` + the extension (optional `directoryRead`); client issues `skills/list` (paginated, cacheable) and `skills/get {uri}` only after seeing the declaration, reads files with `resources/read` (or optional `resources/directory/read`). Host MUSTs: preserve server identity + URI in registries/approvals/caches; support loading by URI even if unlisted; not prefetch files ahead of need; verify file digests (SHA-256 from the manifest) and frontmatter, and not use content that fails verification; bind approvals to the full set of URIs+digests (a changed/added/removed file revokes approval); reading `SKILL.md` through `resources/read` does not itself activate a skill. **[V]** [skills overview](https://modelcontextprotocol.io/extensions/skills/overview.md), `ext-skills` repository README (spec written against `2026-07-28`, Beta).

### 7.3 Server Cards (Beta)

Pre-connection discovery document, recommended location `<streamable-http-url>/server-card`; the Final SEP only charters the extension, and the normative format is in `experimental-ext-server-card`. **[V]** [SEP-2127](https://modelcontextprotocol.io/seps/2127-mcp-server-cards.md). Not read in depth; clients do not need it to connect. **[U]** on its current stability since the SEP and the extensions page differ in how they describe it (SEP: Extensions Track Final; overview: Beta).

## 8. What pi-mcp covers (`.repos/pi/packages/mcp`, v1.4.0, pi HEAD 2026-10-29)

| Area                                                                                                                                 | pi-mcp status                                                                                                                                                                 | Evidence                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Protocol version                                                                                                                     | Legacy only: `2025-11-25`, accepts `2025-06-18`, `2025-03-26`, `2024-11-05`                                                                                                   | `src/protocol/types.ts:4-10`; `src/client.ts:204-243` (`initialize` + `notifications/initialized`)                         |
| Modern era (`_meta`, `server/discover`, `resultType`, MRTR, `subscriptions/listen`, `ttlMs`, `Mcp-Method`/`Mcp-Name`/`x-mcp-header`) | **Absent**                                                                                                                                                                    | grep over `mcp/src`, `coding-agent/src/extensions/mcp`, `core/mcp-servers.ts` for these identifiers: no matches            |
| Transports                                                                                                                           | stdio; Streamable HTTP incl. `Mcp-Session-Id`, GET stream, `Last-Event-ID` resumption, `Retry` handling                                                                       | `src/transports/streamable-http.ts:124-128,203-217,328-335,379-445`                                                        |
| Server→client                                                                                                                        | `ping` and `roots/list` handlers only; generic `setRequestHandler`/`request`/`notify`                                                                                         | `src/client.ts:176-184,264,292`                                                                                            |
| Client capabilities                                                                                                                  | `roots`; `sampling`/`elicitation` only pass-through option; no `extensions`                                                                                                   | `src/protocol/types.ts:22-27`, `src/client.ts:219-222`                                                                     |
| Server features                                                                                                                      | tools list/call, resources list/read/templates with pagination; **no** prompts, completion, subscribe, `logging/setLevel` methods (types only)                                | `src/client.ts:296-385`; grep `prompts/`, `completion/`, `logging/`, `resources/subscribe` in `src`: none                  |
| Notifications                                                                                                                        | `notifications/progress`, `notifications/cancelled`; list-changed is handled one level up                                                                                     | `src/client.ts:525-526`; `coding-agent/src/extensions/mcp/runtime.ts:380` (`tools/list_changed`)                           |
| Tasks                                                                                                                                | Type stub only (`ToolExecution.taskSupport`), no methods                                                                                                                      | `src/protocol/types.ts:72-74`                                                                                              |
| Structured content                                                                                                                   | `structuredContent` typed `unknown` (any JSON, as `2026-07-28` allows)                                                                                                        | `CHANGELOG.md` 1.2.0                                                                                                       |
| OAuth                                                                                                                                | PRM + AS/OIDC discovery, RFC 8707 resource, **CIMD** hook, DCR with `application_type`, **`iss` mismatch check** (RFC 9207), step-up on `insufficient_scope`, abortable flows | `src/oauth/discovery.ts`, `flow.ts:52,111,269-270,317`, `errors.ts:13-22`, `callback.ts:160`, `streamable-http.ts:166-170` |
| Issuer-keyed credential storage (SEP-2352)                                                                                           | Not evidenced: `clientInformation()` is read/written in one slot of the provider store                                                                                        | `src/oauth/provider.ts:92-98` **[I]** (not exhaustively traced)                                                            |
| Icons, MCP Apps, Skills, Server Cards                                                                                                | Not handled; the coding-agent docs say `ui://` resources are omitted and resource icons are omitted                                                                           | `coding-agent/docs/mcp.md:246`                                                                                             |
| Legacy HTTP+SSE                                                                                                                      | Rejected                                                                                                                                                                      | matches the map's ruling                                                                                                   |

Reading: pi-mcp is a good **legacy-era transport/client core** with a current OAuth subset, and its generic `request`/`setRequestHandler` is a workable seam for the missing legacy features (prompts, completion, subscribe, setLevel, sampling, elicitation). It has **no support for the modern era**, which would mean new protocol plumbing rather than additions on top. **[I]** The official TypeScript SDK v2 (`@modelcontextprotocol/client` 2.4.0, published 2026-10-23) states it "implement[s] the 2026-07-28 MCP spec" and is "the stable release line"; it is a reference implementation for modern-era behavior. **[V]** npm registry metadata for `@modelcontextprotocol/client`. Its fit with Workers/Durable Objects was not examined. **[U]**

## 9. Implications for the map's settled positions (notes, not design)

- **Sampling, roots, `logging/setLevel`, server logging → telemetry**: each targets a Deprecated feature; `logging/setLevel` and roots change notifications do not exist at all in the modern era (replaced by per-request `logLevel`; roots only via MRTR `roots/list`). Still required for legacy-era servers. The spec's migration advice is "don't add them". Decision needed on legacy-only vs both eras.
- **"HTTP sessions" in the per-Environment connection object**: sessions exist only on the legacy path; modern requests are independent, so a DO need not pin an HTTP session. The Environment object's useful state becomes the discovery/list cache (with `ttlMs`/`cacheScope`, per-authorization-context for `private`) and open `subscriptions/listen` streams. **[I]**
- **Elicitation "as a durable request"**: in the modern era the originating call finishes with `input_required` and the answer arrives on a retry with a new request ID and the echoed `requestState`; the human can answer long after. In legacy it is a live server→client request. Two models behind one UI. **[I]**
- **Stdio bridge**: modern stdio is stateless and servers may be restarted at will, matching "state across idle stops is lost"; the spec explicitly allows the same framing over sockets/TCP for custom transports (stdio page). A bridge must carry `notifications/cancelled` (stdio cancellation) in the stdio↔HTTP translation, since HTTP cancels by closing the stream. **[I]**
- **Discovery cache keyed per Environment by config** fits `ttlMs`/`cacheScope` and `subscriptions/listen` list-changed; for stdio servers the stdio page says to re-send `subscriptions/listen` after restart.
- **OAuth credentials "per server name and URL at Global"** conflicts with SEP-2352 (MUST key persisted credentials by the AS `issuer`; re-register when the AS changes). **[V/I]** (rule is verified; the conflict is read from the map text).
- **Tasks** are the spec's answer to long tool calls over stateless HTTP and survive client restarts (persisted task IDs): a natural fit for DO-hosted polling, and they interact with the Container idle-stop only for stdio servers. **[I]**
- **"If it's in the spec, we implement it"** now includes at least: dual-era negotiation, `server/discover`, MRTR, `subscriptions/listen`, caching, header mirroring (`x-mcp-header`), Tasks, MCP Apps, Skills, Server Cards, both auth extensions, and legacy-era paths for sampling/roots/logging/legacy tasks. The scope is larger than the map's current list; Beta/experimental extensions can change without notice (Experimental) or rarely break (Beta).

## 10. Open unknowns

- **[U]** How many real-world MCP servers (and which of the ones the owner uses) speak the modern era today. The spec says nothing about adoption; the extension client matrix on the docs site rendered empty cells in the fetched markdown.
- **[U]** Whether the stable MCP Apps spec (dated 2026-01-26, negotiating in `initialize`) has a modern-era revision in flight; only the `draft` was found.
- **[U]** Server Cards: normative wire format and real stage (not read; lives in `experimental-ext-server-card`).
- **[U]** Cost/behaviour of holding a long-lived outbound SSE stream (`subscriptions/listen`) from a Durable Object (wall-clock duration billing, hibernation, eviction), and what happens to non-idempotent tool calls when a stream breaks and the spec requires re-issuing as a new request. The spec states the requirement; the Cloudflare side was not researched here.
- **[U]** Whether pi's own roadmap intends to add modern-era support to `pi-mcp` (the map plans an upstreamable local `packages/mcp`). Not researched.
- **[U]** `2025-11-25` experimental Tasks interoperability: no source states how many servers ship it; whether to implement it is a product call.
- **[U]** Contents of the next revision (late March 2027). Only the roadmap's priority areas are known; none are in `draft`.

## 11. Sources

Specification (all fetched 2026-10-29):

- Versioning: <https://modelcontextprotocol.io/specification/versioning> and `…/2026-07-28/basic/versioning.md`
- Changelogs: `…/specification/2026-07-28/changelog.md`, `…/specification/2025-11-25/changelog.md`, `…/specification/draft/changelog.md`
- Deprecated registry: `…/specification/2026-07-28/deprecated.md`
- Basic, MRTR, subscriptions, cancellation, progress: `…/specification/2026-07-28/basic/index.md`, `…/basic/patterns/{mrtr,subscriptions,cancellation,progress}.md`
- Transports: `…/basic/transports/streamable-http.md`, `…/basic/transports/stdio.md`
- Authorization: `…/basic/authorization/{index,authorization-server-discovery,client-registration,security-considerations}.md`
- Server/client features: `…/server/{discover,tools,resources,prompts}.md`, `…/server/utilities/{caching,completion,logging}.md`, `…/client/{elicitation,sampling,roots}.md`
- Extensions: `https://modelcontextprotocol.io/extensions/{overview,client-matrix}.md`, `…/extensions/tasks/overview.md`, `…/extensions/apps/overview.md`, `…/extensions/skills/overview.md`, `…/extensions/auth/*.md`
- Extension repositories (raw spec files): `modelcontextprotocol/ext-tasks` `specification/2026-07-28/tasks.md`; `ext-apps` `specification/2026-01-26/apps.mdx` and `specification/draft/apps.mdx`; `ext-auth` `specification/stable/*/2026-07-28/*.mdx`; `ext-skills` README
- SEPs: <https://modelcontextprotocol.io/seps/index.md>, SEP-2127, 2260, 2577, 2663, 3392, 3398, 1024, 2207
- Roadmap: <https://modelcontextprotocol.io/development/roadmap.md> (last updated 2026-08-22); feature lifecycle: <https://modelcontextprotocol.io/community/feature-lifecycle.md>
- Spec repo directory listing: `https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/contents/docs/specification`
- TypeScript SDK v2: npm registry `@modelcontextprotocol/client` (README, publish times)

pi-mcp (local, read-only reference): `.repos/pi/packages/mcp/src/{client.ts,protocol/types.ts,transports/streamable-http.ts,oauth/*,auth-provider.ts}`, `CHANGELOG.md`; `.repos/pi/packages/coding-agent/docs/mcp.md`, `src/extensions/mcp/runtime.ts`.
