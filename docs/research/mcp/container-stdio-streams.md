# Can a Cloudflare Container carry a long-lived stdio MCP stream?

Research for the MCP wayfinder map ([#373](https://github.com/ian-pascoe/cloudpid/issues/373)), ticket
[#376](https://github.com/ian-pascoe/cloudpid/issues/376). Researched 2026-10-29. Planning input only: no design is
decided here.

**Question.** Which Cloudflare Containers primitives can carry a long-lived, bidirectional JSON-RPC stream between a
Durable Object and a process in the Container; how does each count as Container activity (sleep/idle); how long can each
stay open and what ends it (DO eviction, deploy)? And which existing stdio→Streamable HTTP bridges exist (footprint,
license, multi-server, server→client requests)?

Labels: **[V]** verified in a primary source (cited); **[I]** inference from verified facts; **[?]** unknown.

## Short answer

1. **Two primitives can carry the stream; one is a poor fit.** A bridge process in the image serving the stdio server as
   HTTP/SSE (or WebSocket) on a Container port, reached with `ctx.container.getTcpPort(port).fetch` from the Workspace
   DO, carries it, and so does `ctx.container.exec(cmd, { stdin: "pipe" })` (no `pty`) with the DO relaying
   `stdin`/`stdout`. `exec` with `pty` is unsuitable for a JSON-RPC byte stream (merged stderr, `\r\n` rewriting).
2. **Neither has a documented time limit of its own.** workerd puts no timeout on `exec` or on port connections; the
   Workers limits page says a DO request/RPC/response stream/WebSocket has **no hard wall-time limit** while the caller
   stays connected. What ends a stream is **the DO instance going away** (deploy, runtime update, platform restart,
   eviction) or the **Container stopping**.
3. **The container-facing stream lives in whichever DO called `ctx.container`** (the Workspace DO). Its handles die with
   that DO instance. A **bridge's session** (a process in the Container) survives a DO restart and can be re-attached to
   by the next instance; an **`exec`'d process's stdin/stdout pipes** cannot (no way to re-attach to an `ExecProcess`
   handle is documented). That is the main structural difference.
4. **None of them counts as cloudpid "Container use" by itself.** cloudpid's `IdleStop` is the only thing that stops its
   Container (the platform's inactivity timeout never fires there: computer's WebSocket/heartbeat/monitor keep the DO
   alive); a stream is "use" only if cloudpid code calls `touch()` or `hold()` on it. The one existing long-lived socket
   to a Container port (the Container preview's carried sockets) does `hold({ writes: false })`. The settled rule "a stdio
   server never keeps the Container awake on its own" therefore means **do not `hold` for a stream's mere existence**;
   `touch()` per message/call (as a tool call is a use), bounded by the hold cap.
5. **Bridges exist and are MIT, but none matches "one persistent child per server, server→client requests forwarded,
   spawned lazily".** supergateway (TypeScript) does multi-server and forwards server→client requests in stateful mode,
   with one child per session; sparfenyuk/mcp-proxy (Python) shares one child per server but forwards no
   sampling/elicitation/roots; punkpeye/mcp-proxy (TypeScript) shares one child and documents that sampling, elicitation
   and roots do not cross it. A bridge of our own can be very thin, since stdio framing is already one JSON-RPC message
   per line.
6. **The spec direction cuts the need for long-lived streams.** MCP `2026-07-28` removes the GET stream and
   protocol-level sessions from Streamable HTTP and moves sampling/elicitation/roots into `input_required` results
   ("MRTR"), so the only long-lived stream is `subscriptions/listen`. `2025-11-25` has them all, with server-closable
   SSE and `Last-Event-ID` resumption. Both eras must be served, so a stream that survives a dropped connection (or a
   bridge that tolerates reconnects) is needed for the 2025-era servers.

## Context in cloudpid (what "activity" means here)

- **[V]** The platform's own inactivity timeout never fires for a Workspace Container: "computer never stops the
  Container it starts (its WebSocket, heartbeat timer and container monitor keep the Workspace DO alive, and the
  platform's inactivity timeout never fires), so the Workspace DO stops it" (`docs/architecture/container.md` → _Idle
  stop_). cloudpid never calls `setInactivityTimeout` itself (only forwarding wrappers: `apps/server/src/workspace/launch.ts:204`,
  `exit-report.ts:181`, `notify.ts:419`); computer's backend defines but does not call it (`@cloudflare/computer@0.8.0`
  `dist/backends/container/index.js:727`).
- **[V]** `IdleStop` (`apps/server/src/workspace/idle.ts`): `touch()` records a use and arms the alarm; `hold()` makes a
  running thing count as use until it ends; the alarm stops the Container (snapshot first) once idle for the Workspace's
  idle time, and a **hold cap** (`CONTAINER_HOLD_CAP_MS` = 60 min, or the idle time if longer) stops a Container kept
  past it since the last _owner/agent activity_ (`noteActivity`), dropping the holds (`idle.ts:25-33`, `#heldStop`).
  Activity is a command started, a Session message or live Run (60 s heartbeat), a file write; **a Container preview's
  requests and sockets are explicitly not activity** (`container.md` → Idle stop, `container-preview.ts` header).
- **[V]** Today's only long-lived stream to a Container port is the Container preview: `Workspace`'s
  `ctx.container.getTcpPort(port).fetch(url, { headers: { upgrade: "websocket" } })` → `response.webSocket`, held as
  `activity.hold({ writes: false })` until it closes, with a 15 s keep-alive write to the page's SSE stream and a
  stall check (`apps/server/src/workspace/container-preview.ts:312-420`, `CONTAINER_PREVIEW_KEEP_ALIVE_MS`).
- **[V]** Today's `exec` uses are one-shot: `cloudpid-notify` with a closed `ReadableStream` stdin
  (`notify.ts:377`) and the snapshot scan (`snapshots.ts:787`). The Terminal (ADR-0012) is the planned `pty`/streaming
  stdin user; it is not implemented (`grep pty:` finds no call), so there is no in-repo measurement of a long-lived exec.
- **[V]** The Container image already has Node 24, Bun, Python 3.14 and `uv` (mise system installs,
  `apps/sandbox-image/image/mise.toml`), `socat` and `netcat-openbsd` (Dockerfile apt list), and runs computerd on port
  8080 under `cloudpid-supervise` (the Container's entrypoint, `apps/sandbox-image/image/supervise`). Port 8080 is
  computerd's and must not be used (`docs/architecture/browser.md`, spike #244 FINDINGS).
- **[V]** Computer's own command path (`ComputerExecutionEnv.exec`) takes argv/cwd/env/timeout and a one-shot stdin
  (ADR-0012), so it cannot carry a bidirectional stream; only the platform's `ctx.container` can.

## 1. The primitives

All paths below are the **Workspace DO's** `ctx.container` (`getTcpPort`/`exec` exist only on the DO that owns the
Container). A Session-side or MCP-side object would reach them through the Workspace DO (RPC with byte streams, or a
`fetch` to it).

| Primitive                                                                               | Shape                                                                                                                                                                        | Limits and what ends it                                                                                                                                                                                                    | Platform inactivity                                  | cloudpid `IdleStop`                     | Fit for stdio MCP                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getTcpPort(p).fetch()` with a streamed (SSE/chunked) response                          | Request/response; the response body is the server→DO stream, **one-way**; DO→server messages need separate POSTs (the transport's own shape: every client message is a POST) | No time limit in workerd (it "deliberately do[es] not impose [a] timeout" on port connects: `workerd/src/workerd/api/container.c++:1197-1202`); ends when either side closes, the Container stops, or the DO instance ends | Counts only through keeping the DO in memory (below) | Not counted unless code `touch`/`hold`s | **Fits** Streamable HTTP exactly (POST + SSE response)                                                                                                                            |
| `getTcpPort(p).fetch()` with a WebSocket upgrade → `response.webSocket`                 | Full-duplex, message-framed                                                                                                                                                  | Same; 32 MiB max received message (DO limit)                                                                                                                                                                               | Same                                                 | Preview code holds it                   | **Fits** (a bridge would need to offer WS; MCP's standard transports have none)                                                                                                   |
| `getTcpPort(p).connect()`                                                               | Raw TCP socket (`readable`/`writable`)                                                                                                                                       | Same; counts as an outbound connection                                                                                                                                                                                     | Same                                                 | Not counted unless coded                | Fits for a newline-framed socket bridge (MCP stdio framing works over any byte stream: 2026-07-28 stdio spec)                                                                     |
| `ctx.container.exec(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })` (no `pty`) | `process.stdin` WritableStream, `process.stdout`/`stderr` ReadableStreams, `exitCode`, `kill()`                                                                              | "`exec()` has no built-in timeout"; the process outlives the request that started it ("Canceling the request that started a process does not stop the process"); `kill`/`signal` reach only that process, not its children | Same                                                 | Not counted unless coded                | **Fits** natively: stdio server on stdin/stdout, stderr apart as the spec wants                                                                                                   |
| `exec` with `pty`                                                                       | One merged stream, terminal converts line endings to `\r\n`, `stderr` forced to `"combined"`                                                                                 | Same as above                                                                                                                                                                                                              | Same                                                 | Same                                    | **Poor**: merged stderr and `\r\n` break JSON-RPC framing; **[I]** echo and canonical-mode line limits (a Linux tty's 4096-byte line buffer) too, unless the server sets raw mode |
| Stdio MCP server run through computer's `exec`                                          | One-shot stdin, output callback                                                                                                                                              | Command timeout                                                                                                                                                                                                            | Held while the command runs (`tracked.ts`)           | Counted (it is a command)               | **No**: no streaming stdin (ADR-0012)                                                                                                                                             |
| `monitor()`                                                                             | Not a stream: promise settling when the Container exits                                                                                                                      | Pins the DO against eviction up to 15 min                                                                                                                                                                                  | —                                                    | —                                       | Lifecycle signal only                                                                                                                                                             |

Sources: API shapes and limits from the Durable Object Container API page
(<https://developers.cloudflare.com/containers/api/durable-object-container/>: `exec`, `getTcpPort`, `monitor`,
`setInactivityTimeout`), the "Execute commands" guide
(<https://developers.cloudflare.com/containers/guides/execute-commands/>), and workerd's `container.{h,c++}`
(`src/workerd/api/container.h:353`, `container.c++:675-800`). The `pty` defaults are in `container.c++:701-716` and the
API page ("With `pty`, `stdin` defaults to `"pipe"`, and `stderr` defaults to `"combined"`… The terminal converts line
endings to `\r\n`").

### What keeps the DO (and therefore the platform's activity clock) alive

The platform's Durable Object Container API ties container inactivity to the **DO becoming inactive**: "`setInactivityTimeout()`
sets how long a container keeps running after its Durable Object becomes inactive… Without a timeout, Cloudflare stops
the container shortly after the Durable Object becomes inactive" and a restarted DO "starts without one" (API page). That
is the whole documented definition: no page says an open `exec` or port stream "renews activity" as such. So, for the
platform clock, each primitive counts exactly as far as it keeps the DO from being evicted:

- **[V]** DO lifecycle: after all requests/events finish and 70–140 s of inactivity in the non-hibernatable state the DO
  is evicted; pending I/O, RPC calls, outbound `fetch()`, `container.monitor()`, `waitUntil`, timers, TCP sockets and
  outbound WebSockets "prevent eviction… until it completes or for up to 15 minutes from when it starts, whichever comes
  first. Operations started together do not combine their windows. Starting another operation later can extend the Durable
  Object's time in memory" (<https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>).
- **[V]** The Workers limits page says the opposite end of the same thing: DO (RPC/HTTP) wall time is "Unlimited… No hard
  limit while the caller stays connected to the Durable Object. Durable Objects remain active while a request, RPC call,
  response stream, WebSocket, or pending I/O is in flight"
  (<https://developers.cloudflare.com/workers/platform/limits/>, "Wall time limits by invocation type").
- **[V, measured]** Spike #244 (`spikes/container-preview/FINDINGS.md` at `8a58f49`, on a stand-in DO using the same
  `getTcpPort` call): an SSE stream to a page open from outside, i.e. an **inbound request in flight**, kept the DO in
  memory and the Container running (206 s with a 60 s idle stop; ≥5 min for the HMR sockets); but "a Durable Object whose
  **only open sockets are ones it opened** is not kept in memory": the browser host DO holding only outbound CDP
  WebSockets was evicted ~73 s after its last request; the stand-in Box with no page open was evicted and its Container
  stopped about a minute after its last request.
- **[?]** The 15-minute per-operation cap and the measured eviction of an outbound-sockets-only DO disagree with the "any
  stream pins the DO" reading of the limits page, and nobody measured an outbound `getTcpPort`/`exec` stream held longer
  than ~15 minutes on an otherwise idle DO. In cloudpid the Workspace DO is also pinned by computer's heartbeat (a new
  operation every ~20 s) and monitor, so it likely stays in memory regardless **[I]**; but that is the existing claim
  in `container.md`, not something these sources prove for a 15-minute-plus idle stream.

### What ends a stream

- **[V]** A **DO shutdown** (deploy, runtime update, platform decision): in-flight HTTP/RPC requests may finish for up to
  30 s if they do not touch storage; "WebSocket requests are terminated automatically during shutdown"; "the object
  instance is automatically restarted" (<https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>,
  Shutdown behavior). Workers runtime updates give existing requests and connections up to 20 minutes
  (<https://developers.cloudflare.com/workers/platform/limits/>, Runtime updates). **[V, measured]** Spike #244: the Box DO
  was restarted by the platform ~4 min into a run "with both sockets open… nothing was deployed"; the sockets and SSE
  stream ended with it, a fresh instance served the next request, **the Container and Vite (a process in it) kept
  running**.
- **[V]** A `monitor()` promise "does not carry over when the Durable Object restarts"; the Container keeps running
  ("If `running` is `true` when the Durable Object starts, call `monitor()` again") (API page). So **a DO restart does not
  stop the Container or its processes; it only drops the DO-held handles.**
- **[V]** The Container stopping (an idle or held stop, `destroy()`, `container_restart`, resize): "A Container's
  processes never survive a stop, a restart, a snapshot or a Build" (spike FINDINGS, "A preview does not start the
  Container"; snapshots capture only the root file system: API page `snapshotContainer`). The stop sends `SIGTERM`, waits up
  to 15 minutes, then `SIGKILL` (Lifecycle page: <https://developers.cloudflare.com/containers/platform-details/architecture/>,
  "Container shutdown"; this page describes the platform-initiated stop; whether `destroy()` waits the same grace is **[?]**).
  The preview's sockets closed with 1006 when the Container was destroyed (FINDINGS).
- **[V]** The platform sends **no keep-alive** and has no idle-connection timeout in the docs for these paths; the
  Container-class proxy and cloudpid's preview send their own (below).
- **[V]** The six-simultaneous-connections limit counts only connections still **waiting for response headers**: "Once
  response headers arrive for a connection, it no longer counts" (<https://developers.cloudflare.com/workers/platform/limits/>).
  So many open SSE streams to a Container are fine **if the bridge flushes headers immediately** (spec 2025-11-25 says
  servers SHOULD send a priming SSE event at once).
- **[?]** What happens to an **`exec`'d process whose DO handle is gone** (DO restarted, `stdin` writer dropped): the
  guide says only that cancelling the originating request does not stop it. Neither the docs nor workerd's client code
  (`container.c++` builds the RPC; the process lives in the closed container runtime) say whether it keeps running or
  receives EOF/SIGPIPE, or whether `ExecProcess` can be re-attached by pid. **[I]** An unattached stdio server will see
  EOF or a broken pipe on stdin/stdout and exit, as the stdio spec tells servers to ("exit promptly when stdin is
  closed").

### How `@cloudflare/containers` (the `Container` class) counts it, for contrast

Not used by cloudpid (it drives `ctx.container` through computer) but it shows the platform authors' idea of activity:
`containerFetch` calls `renewActivityTimeout()` per proxied request and per WebSocket message in either direction, counts
an inflight request until the response body's `pipeTo` finishes (or the WebSocket closes), and `isActivityExpired()`
returns false while any are inflight (`cloudflare/containers` `src/lib/container.ts:1054-1069`, `1215-1303`, `2208-2214`;
default `sleepAfter` 10 m, <https://developers.cloudflare.com/containers/api/container-class/>). So in that library an
open SSE stream or WebSocket holds the Container awake **for as long as it is open**, which is the opposite of the settled
cloudpid rule for stdio servers.

## 2. What the stream has to carry (spec)

- **stdio** (2025-11-25 and 2026-07-28): newline-delimited JSON-RPC, no embedded newlines, `stderr` for logs, shutdown by
  closing stdin then `SIGTERM`/`SIGKILL`, restart on unexpected exit
  (<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>). The 2026-07-28 page says the framing
  "works unchanged over Unix domain sockets, TCP connections, or any similar channel".
- **Streamable HTTP 2025-11-25:** each client message is a POST; a request's POST may answer as an SSE stream that can carry
  server requests/notifications before the response; an optional GET stream carries unrelated server→client messages;
  `Mcp-Session-Id`; the server MAY close a connection after sending an event ID and the client SHOULD reconnect with
  `Last-Event-ID` (resumable), honoring `retry`; disconnection is not cancellation
  (<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>, "Sending Messages to the Server", "Listening
  for Messages from the Server", "Resumability and Redelivery").
- **Streamable HTTP 2026-07-28:** POST-only; no GET stream; no protocol sessions; no `Last-Event-ID`; the server MUST NOT send
  independent JSON-RPC requests on the stream (sampling/elicitation/roots arrive as `input_required` results, MRTR); the
  long-lived stream is a `subscriptions/listen` response; **closing the response stream is the cancellation signal**; and
  "because the protocol is stateless" a restarted stdio process just has its lost requests retried
  (<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>,
  `.../transports/stdio` → Unexpected Termination).
- **[I]** So the stream demands differ by era. 2025-era stdio servers need their server→client requests carried while a call
  runs and sessions kept (stdio itself is one persistent connection, hence a persistent child); 2026-era servers need only
  per-request streams plus an optional `subscriptions/listen` stream. For a DO↔Container leg, a per-request stream whose
  loss cancels the call is spec-conformant in 2026-07-28; in 2025-11-25 a lost stream is not a cancel, so a bridge that
  buffers events (resumable) or a client that re-sends `notifications/cancelled` is needed.

## 3. Existing stdio→Streamable HTTP bridges

Cloned and read at the commits shown (2026-10-29). Footprint = what must exist in the image.

|                                                       | supergateway                                                                                                                                                                                                                          | sparfenyuk/mcp-proxy                                                                                                                                                   | punkpeye/mcp-proxy                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo / ver.                                           | `supercorp-ai/supergateway` v4.2.1 (`2f5148c`)                                                                                                                                                                                        | `sparfenyuk/mcp-proxy` v0.13.0 (`701a045`)                                                                                                                             | `punkpeye/mcp-proxy` v6.7.21                                                                                                                            |
| License                                               | MIT                                                                                                                                                                                                                                   | MIT                                                                                                                                                                    | MIT                                                                                                                                                     |
| Runtime / deps                                        | Node ≥20; express 4, ws, `@modelcontextprotocol/sdk` 1.30 **and** `client`/`server`/`node` 2.0.0, cross-spawn, yargs, zod (`package.json`); also ships single-file executables with Node built in, **44–47 MB** each (release assets) | Python; `mcp>=1.27.1,<2`, `uvicorn`, `httpx-auth` (`pyproject.toml:31`)                                                                                                | Node; `@modelcontextprotocol/client` + `server` ^2.0.0, `pipenet` (`package.json`)                                                                      |
| Image fit                                             | Node via mise (npx/bun), or the 44 MB binary                                                                                                                                                                                          | Python/uv via mise (`uvx mcp-proxy`)                                                                                                                                   | Node via mise                                                                                                                                           |
| Streamable HTTP out                                   | Yes: stateless (a server, transport **and child per POST**: `StatelessRequest`, `statelessRequest.ts:21-50`) or `--stateful` (session per client, **child per session**)                                                              | Yes; `json_response=True`, `event_store=None` (JSON replies, no SSE resumption: `mcp_server.py:96-101`), SSE too                                                       | Yes (sessionful and `--stateless`), plus legacy SSE; resumability via an in-memory event store                                                          |
| Multiple servers                                      | Yes: `--config` with an `mcpServers` file, each at `/<name>/mcp`; also **combined** servers on one URL (`README`)                                                                                                                     | Yes: `--named-server NAME CMD` / `--named-server-config`, at `/servers/<name>/` (`README`) — all children **spawned eagerly at startup** (`mcp_server.py:253-290`)     | **No**: one upstream per process (run several)                                                                                                          |
| Child lifecycle                                       | Spawn on session (or per request when stateless); `--sessionTimeout`; exits when stdin closes                                                                                                                                         | One persistent child per server, shared by every client; the proxy **exits non-zero if a child exits** (`_StdioExitWatch`)                                             | One persistent upstream shared by all downstream sessions (README)                                                                                      |
| Server→client requests (sampling, elicitation, roots) | **Passed through** on outputs that carry them (stateful Streamable HTTP, SSE, WS) (`README`)                                                                                                                                          | **Not forwarded**: `create_proxy_server` registers handlers for prompts, resources, tools, completion, logging level, (un)subscribe, progress only (`proxy_server.py`) | **Not implemented** "yet"; documented as not crossing the proxy (`README`, "What does not cross the proxy"); also no logging passthrough for 2026-07-28 |
| Other                                                 | `--healthEndpoint`, `--apiKey`, CORS; 2026-07-28 support; tasks "not yet"                                                                                                                                                             | `/status`, OAuth2 client options                                                                                                                                       | `logging/setLevel` per downstream connection; resource subscribe routed; `Mcp-Session-Id`                                                               |
| Fit to the leading shape                              | Closest: multi-server, server→client, but a child per session and a heavy dep tree                                                                                                                                                    | One shared child per server (matches a per-Environment MCP object holding one session), but no server→client requests and eager spawn                                  | Shared child, but single-server and no server→client                                                                                                    |

Notes **[I]**:

- cloudpid's need (settled in the map): the DO holds one session per server; stdio is lazy (spawned when the Container
  wakes and a tool is first wanted); server→client requests (sampling, elicitation, roots) are in scope for a 2025-era
  server; the Container runs it in the calling agent's Workspace with `cwd`/roots. None of the three satisfies all of
  these as shipped. supergateway's stateful mode comes nearest if the DO keeps one long session per server; its
  per-session spawn is harmless then, since the DO is the only client.
- A bridge of our own is small because the framing already matches: HTTP POST body → one line on the child's stdin;
  child stdout line → SSE event; plus session/ID bookkeeping and keep-alive comments. Cost is protocol-awareness it
  would have to have (matching a response to the POST that carried its request, `notifications/cancelled`, `Last-Event-ID`
  replay) versus a message-level relay that is protocol-agnostic and leaves those to a Streamable HTTP server in the Worker.
  Both are options, not a recommendation.
- Cloudflare's own docs have no stdio→HTTP bridge for Containers (searched the Containers docs; none found).
  `@modelcontextprotocol/sdk` has `StreamableHTTPServerTransport` and `StdioClientTransport`, the pieces all three bridges
  are built from.

## 4. Implications for cloudpid (not a design)

- **Where the stream lives.** The container-facing end must be in the Workspace DO (or reached through it). A Session/MCP
  object would hold a client to the Workspace DO and the Workspace DO would hold the port/exec stream. Byte-oriented
  `ReadableStream`/`WritableStream` can cross DO RPC with flow control (ownership transferred), per
  <https://developers.cloudflare.com/workers/runtime-apis/rpc/> and the exec guide ("Return standard output over RPC").
  **[?]** whether `exec`'s stdin `WritableStream` can be passed back over RPC (the guide shows only a `ReadableStream` given
  to `exec`'s `stdin` and stdout returned).
- **`exec` vs bridge-on-a-port.**
  - `exec` + pipes: no extra process, no port, `cwd`/`env`/`user` per call, stderr apart; but the stream's end-points die
    with the DO instance, and **a server restart on DO restart is the likely outcome [I]**. Fine for stateless 2026-era
    servers; loses 2025-era server state (which is already lost across idle stops).
  - Bridge on a port: re-attachable after a DO restart (persist the session id in DO storage); standard Streamable HTTP
    reconnect semantics with `Last-Event-ID` if the bridge buffers; one more supervised process and port (cf. ADR-0012's
    reasoning for rejecting a PTY server); the bridge needs to listen on `0.0.0.0` (the Container's port is reached on its
    interface, not loopback: spike error `The container is not listening in the TCP address 10.0.0.1:5173`) and so is
    reachable by the agent's own commands (a bearer secret is needed; spec's `Origin`/auth requirements apply).
  - Neither survives a Container stop; both cold-start on the next call (the settled design).
- **Activity accounting.** To honor "the server never keeps the Container awake on its own" with these primitives: no `hold`
  for the open stream; `touch()` when a call starts/ends and on traffic; keepalives must not count as use; and the
  60-minute hold cap is irrelevant to MCP traffic unless a Run's heartbeat is activity. A call in flight during an idle
  stop is the same race the code already handles for commands (`IdleStop` snapshot-then-recheck); a long tool call may
  want a `hold` for its duration (a design choice, not settled here).
- **Keep-alive and stall detection.** Reuse the preview's pattern: a periodic write, with a write failure meaning the peer
  is gone and "unread with no progress" meaning it stopped reading (`container-preview.ts`). Spec-wise, SSE comment
  keep-alives are encouraged for long-lived streams (2026-07-28 Streamable HTTP page).
- **Header flush.** If SSE streams are held through `fetch`, ensure the bridge sends headers/priming event at once so the
  stream does not sit in the six-connection "waiting for headers" budget.
- **After a DO restart:** reconnect (2025-era: resume the session id; 2026-era: just resend the request, as the spec
  says), re-arm anything the DO held (`monitor()`, subscriptions), and re-derive the Container's state from
  `ctx.container.running`.

## Open unknowns and suggested probes

1. **[?] Fate of an `exec`'d process when its DO handle is lost** (DO restart, `stdin` dropped, request cancelled): runs on,
   gets EOF, killed? Probe: `exec(["sh","-c","while sleep 1; do date >> /tmp/x; done"], { stdin: "pipe" })`, restart the DO
   (deploy or evict), inspect `/tmp/x` and `ps`.
2. **[?] Whether an outbound `getTcpPort`/`exec` stream held >15 min pins the DO** (the lifecycle page's 15-minute cap against
   the limits page's "unlimited"), with and without computer's heartbeat. Probe: stand-in DO, one SSE through `getTcpPort`,
   no other traffic, observe eviction and Container stop past 15 min with and without a bridge keep-alive.
3. **[?] Whether bytes on `exec`/port streams count as activity to the platform** beyond keeping the DO in memory (docs define
   it only through DO inactivity). Irrelevant to cloudpid's own `IdleStop`, relevant if cloudpid ever sets
   `setInactivityTimeout`.
4. **[?] `destroy()`'s grace period** for a process (SIGTERM→15 min→SIGKILL is documented for platform stops), which decides
   whether a stdio server gets time to flush on an idle stop.
5. **[?] Can the `exec` `stdin` `WritableStream` be returned over DO RPC**, or must the Workspace DO relay it?
6. **[?] Per-`exec`/per-port limits**: max concurrent exec processes, max concurrent port connections, and tunnel pooling
   limits are not documented (workerd pools tunnels per port up to a bound, `container.c++:24-27`).
7. **[?] Unmeasured here:** end-to-end latency and throughput of line-framed JSON-RPC through `exec` pipes versus
   `getTcpPort` (not documented; spike #244 measured only HTTP page loads).
8. **[?] Bridge behavior under a spec we only read:** none of the three bridges was run here; their behavior is from their
   source and READMEs at the commits above.

## Sources

Cloudflare (fetched 2026-10-29): Durable Object Container API
<https://developers.cloudflare.com/containers/api/durable-object-container/>; Execute commands
<https://developers.cloudflare.com/containers/guides/execute-commands/>; Lifecycle of a Container
<https://developers.cloudflare.com/containers/platform-details/architecture/>; Container class
<https://developers.cloudflare.com/containers/api/container-class/>; Lifecycle of a Durable Object
<https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>; Durable Objects limits
<https://developers.cloudflare.com/durable-objects/platform/limits/>; Workers limits
<https://developers.cloudflare.com/workers/platform/limits/>; Workers RPC
<https://developers.cloudflare.com/workers/runtime-apis/rpc/>. Source: `cloudflare/workerd`
`src/workerd/api/container.{h,c++}` (main); `cloudflare/containers` `src/lib/container.ts` (main).
MCP: <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>;
<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>;
<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>.
Bridges: <https://github.com/supercorp-ai/supergateway>, <https://github.com/sparfenyuk/mcp-proxy>,
<https://github.com/punkpeye/mcp-proxy>. Repo: `docs/architecture/container.md`, `docs/adr/0012-*.md`,
`apps/server/src/workspace/{idle,container-preview,notify,Workspace}.ts`, `apps/sandbox-image/image/*`, spike #244 FINDINGS
(`git show 8a58f49:spikes/container-preview/FINDINGS.md`).
