# MCP core: client libraries for a dual-era MCP client/host

Research for ticket #394 (map #373). Fetched and run on 2026-10-30. Question: which library should be cloudpid's MCP client core: (a) extend `@earendil-works/pi-mcp` 1.4.0, (b) adopt the official TypeScript SDK v2 (`@modelcontextprotocol/client` 2.4.0), or (c) write its own; judged on dual-era support (`2025-11-25` legacy and `2026-07-28` modern), the extensions cloudpid needs, and fit with Workers / Durable Objects (workerd).

The spec facts (what a client must implement, eras, extensions, deprecations) are not redone here; they are in `docs/research/mcp/mcp-spec-revisions.md` on branch `research/mcp-spec-revisions`.

Conventions: **[V]** verified in a primary source (cited) or by an experiment I ran (§9); **[I]** inference; **[U]** unknown / not verified.

## 1. Answer in brief

1. **One official `Client` speaks both eras; the default is legacy.** Era selection is opt-in through `ClientOptions.versionNegotiation`: absent or `mode: 'legacy'` runs the plain `initialize` handshake with no probe; `mode: 'auto'` probes with `server/discover` and falls back to `initialize`; `mode: { pin: '2026-07-28' }` never falls back. `connect(transport, { prior })` takes a host-supplied cached verdict (`{ kind: 'modern', discover }` or `{ kind: 'legacy' }`). The SDK itself caches nothing across connects; the host owns the cache and its freshness. **[V]** (§2)
2. **Probe fallback is more conservative than the spec.** Anything not positively recognized as modern falls back to `initialize`: any 4xx, any JSON-RPC error other than `-32022`, an unrecognized `DiscoverResult` shape. Not era evidence, so they raise typed errors instead: 401/403, 5xx, network failure, HTTP timeout, a 2xx with an unusable body. On stdio only, a probe timeout or child exit means legacy. The spec text says a recognized `-32020`/`-32021` body means modern; the SDK deliberately treats them as legacy. **[V]** (§2.2)
3. **MRTR (`input_required`) is auto-fulfilled inside `callTool`/`getPrompt`/`readResource`** through the same `setRequestHandler('elicitation/create' | 'sampling/createMessage' | 'roots/list')` handlers used for legacy server→client requests, up to `inputRequired.maxRounds` (default 10), with a fresh request id and byte-exact `requestState` echo. The original call stays pending while the handler runs, which is in-memory and non-durable. A manual mode exists (`inputRequired: { autoFulfill: false }` plus per-call `allowInputRequired: true`): the `input_required` value is handed back and the host retries itself. That is the only route to a durable "ask the user later". **[V]** (§3.1)
4. **Covered natively:** `server/discover` (`client.discover()`, `getDiscoverResult()`), `subscriptions/listen` (`client.listen(filter)`, auto-opened by `ClientOptions.listChanged`), legacy `resources/subscribe` (`subscribeResource`), the legacy GET stream, per-request `_meta` envelope, `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` headers, response cache with `ttlMs`/`cacheScope` (pluggable store, per-principal partition), generic `capabilities.extensions` negotiation (reaches both the legacy `initialize` body and the modern envelope), OAuth (authorization code with `iss` check, CIMD via `clientMetadataUrl`, DCR, `ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `CrossAppAccessProvider`, DPoP, custom `AuthProvider` with only `token()`), custom `fetch`, `AbortSignal`, timeouts, progress, and a Skills client (`@modelcontextprotocol/client/ext/skills`). **[V]**
5. **Not covered natively, needs extra packages or host code:**
   - **Tasks (`io.modelcontextprotocol/tasks`)**: the SDK does not implement it (tracking issue #2189 open). The separate package `@modelcontextprotocol/ext-tasks` 0.2.2 (0.x, Apache-2.0, peer `client ^2`) wraps a connected `Client`. Its 2025-11-25 ("V1") tasks ride the SDK request path; its 2026-07-28 ("V2") tasks need the host to supply a `rawDispatch` and `v2RequestFraming`, because the SDK Client's public API cannot send or decode `resultType: "task"`. **[V]**
   - **MCP Apps**: `@modelcontextprotocol/ext-apps` (`app-bridge` host entry; MIT; peers `client`/`server`/`core ^2`). It is a browser-side bridge that forwards to an SDK `Client`. **[V]**
   - **Server Cards**: nothing in the SDK. **[V]** (grep found nothing)
   - **Declaring** `io.modelcontextprotocol/oauth-client-credentials` / `…/tasks` / `…/ui` in `capabilities.extensions` is the host's job; the SDK providers do not auto-declare them. **[V]** (grep)
6. **Runtime fit: good, and verified in workerd.** The client/server packages build from `zod` + `@modelcontextprotocol/core` (+ `eventsource`, `eventsource-parser`, `pkce-challenge`, optional dynamic `jose`, `cross-spawn` only in the `/stdio` entry). A `_shims` export map has a `workerd` condition that selects `@cfworker/json-schema` (no `new Function`); the `node` condition selects Ajv (contains `new Function`, forbidden by workerd). I ran client and `createMcpHandler` server in Miniflare/workerd: both eras worked, with and without `nodejs_compat`. **[V]** (§5, §9) Costs: ≈ 88 KB gzipped minified for a client-only bundle (≈ 140 KB gzipped for client + server, minified); and open upstream issue #2865 reports ≈ 8.6–10 MiB extra cold V8 heap per package in workerd from eager `preloadSchemas()`. **[V]**
7. **Server side:** `createMcpHandler(factory)` from `@modelcontextprotocol/server` returns a web-standard `{ fetch }`; it serves `2026-07-28` per request and, by default (`legacy: 'stateless'`), also serves legacy clients per request. It is stateless: no sessions, no GET stream (legacy GET/DELETE answer 405), no server→client requests for legacy clients (MRTR handlers degrade to a clean refusal). Verified in workerd. **[V]** (§6)
8. **Cloudflare `agents` 0.32.0 already wraps the v2 SDK (`@modelcontextprotocol/client` 2.4.0, exact-pinned peer).** `MCPClientConnection` defaults to `versionNegotiation: { mode: 'auto' }`, `inputRequired: { autoFulfill: true }`, and the CfWorker validator; it persists `discoverResult`, `sessionId` and `protocolVersion` in the Agent's SQLite row and re-supplies `prior` on restore. `createMcpHandler` (from `agents/mcp/server`) wraps the SDK v2 handler. It has no Tasks, no Apps, no `extensions`, and no durable MRTR continuation (documented as intentionally absent). **[V]** (§7)
9. **pi-mcp upstream:** the only public item is open issue #10416 "Support Stateless MCP (2026-07-28)" (reopened by a maintainer, assigned; no maintainer comment on scope). A related issue (#11353) was auto-closed and not reopened. One partial step shipped (1.2.0: `structuredContent` any JSON). No issue/PR proposes adopting the official SDK. pi's `CONTRIBUTING.md`: "pi's core is minimal", all new-contributor issues and PRs are auto-closed, PRs only after a maintainer `lgtm`. So dual-era work in pi is possible only by maintainer consent, on their schedule. **[V]** (§8)
10. **Other dual-era TS clients exist:** `@ai-sdk/mcp` 2.0.88 (own implementation; `server/discover`, `Mcp-Method`, `input_required`); `mcp-use`, `@mastra/mcp`, `@langchain/mcp-adapters`, `@tanstack/ai-mcp` wrap `@modelcontextprotocol/client` v2; `fastmcp` 4.23.8 is still on SDK v1 and has no `2026-07-28`. **[V]** (§10)

## 2. Era negotiation in the official client

### 2.1 Surface

Source of truth: `docs/protocol-versions.md`, `docs/migration/support-2026-07-28.md`, `docs/advanced/gateway.md` in `modelcontextprotocol/typescript-sdk` at `main` (tag `v2.4.0`, HEAD `39ae8e6`), and `packages/client/src/client/{versionNegotiation,probeClassifier}.ts`. **[V]**

| Item | Behaviour |
| --- | --- |
| Default | `versionNegotiation` absent = `mode: 'legacy'`: the 2025 `initialize` handshake "byte for byte", no probe. "Nothing in v2 puts a 2026-07-28 byte on the wire by default." |
| `mode: 'auto'` | One `server/discover` probe (the probe request already carries the `_meta` envelope), then modern or `initialize` on the same connection. |
| `mode: { pin: '2026-07-28' }` | Modern or `SdkError(EraNegotiationFailed)`; never falls back. |
| `connect(transport, { prior })` | `{ kind: 'modern', discover }` adopts a persisted `DiscoverResult` with zero round trips; `{ kind: 'legacy' }` goes straight to `initialize`. Freshness is the host's job; "a stale legacy verdict succeeds silently forever", so date and expire legacy verdicts. |
| Introspection | `getProtocolEra()` (`'modern' | 'legacy' | undefined`), `getDiscoverResult()` (plain JSON, persistable), `getNegotiatedProtocolVersion()`, `getServerCapabilities()`, `getServerVersion()`, `getInstructions()`, `client.discover()` re-probe (modern only). |
| `probe` options | `{ timeoutMs (default: request timeout, 60 s), maxRetries (default 0, timeout re-sends only) }`. |
| `supportedProtocolVersions` | Its 2026+ entries are what the probe offers; the legacy fallback exists only while the list has a pre-2026 entry. |
| Era "legacy" covers | `2024-10-07` … `2025-11-25`; "modern" starts at `2026-07-28`. |
| Wrong-era methods | Era-mismatched methods are physically absent: e.g. `ping`, `subscribeResource`, `tasks/result` on a modern connection, `listen()`, `discover()` on a legacy one, throw `SdkError(MethodNotSupportedByProtocolVersion)` before reaching the transport. |

### 2.2 Probe verdict table (`probeClassifier.ts`) **[V]**

| Probe outcome | Verdict |
| --- | --- |
| 2xx `DiscoverResult` with a mutual modern version | modern |
| 2xx `DiscoverResult` with no overlap | legacy (if a legacy version is in `supportedProtocolVersions`), else `UnsupportedProtocolVersionError` |
| 2xx with unusable body (non-JSON, `204`, missing/unaccepted content type) | **typed error** `EraNegotiationFailed` (`202`/empty SSE surfaces as the probe timeout) |
| JSON-RPC error `-32022` with `data.supported` containing a mutual modern version | "corrective": re-send the probe at that version once, loop-guarded |
| `-32022`, modern-only disjoint list | typed `UnsupportedProtocolVersionError` |
| `-32022` with legacy-only list, or without a valid `data.supported` | legacy |
| `-32001`, `-32020`, `-32021` (explicitly "not probe-recognized") and every other code | legacy |
| HTTP 401 / 403 (any body) | typed `SdkHttpError` (`ClientHttpAuthentication` / `ClientHttpForbidden`), or the auth flow's own error (`UnauthorizedError` etc.) propagated; never era evidence |
| HTTP 5xx (any body) | typed `SdkHttpError(EraNegotiationFailed)` |
| Other HTTP 4xx (404, 405, 400, …) with or without a JSON-RPC body | JSON-RPC body classified as above; else legacy |
| Network error | typed `EraNegotiationFailed`; except browser opaque CORS `TypeError` which is legacy |
| Timeout / connection closed during probe | **HTTP: typed error** (`RequestTimeout`); **stdio: legacy** |

Divergences from the spec text recorded in `mcp-spec-revisions.md` §3.2: the spec says a recognized modern error body (`UnsupportedProtocolVersion`, `MissingRequiredClientCapability`, `HeaderMismatch`) on a 400 means modern; the SDK treats `-32020`/`-32021` as legacy (its comment: deployed servers overload codes). The SDK also does not offer the deprecated HTTP+SSE `GET` fallback on 404/405 inside `connect()`; the docs show a manual retry with `SSEClientTransport` on a fresh `Client`. **[V]** (classifier + `docs/clients/connect.md`)

On the SDK's own stdio transport the probe runs on a disposable sibling process (some stdio servers, e.g. rmcp, exit on any pre-`initialize` request). Irrelevant for cloudpid's HTTP-only use, since the bridge exposes Streamable HTTP. **[V]**

My own workerd experiment (§9) against hand-written legacy-only fetch handlers confirmed: 404, 400 with `-32000`, 400 with `-32020` all fell back to `initialize`; 500 raised `ERA_NEGOTIATION_FAILED`; 401 raised `CLIENT_HTTP_AUTHENTICATION`. **[V]**

### 2.3 Caching the era

No built-in persistent cache. The documented host loop (`docs/advanced/gateway.md` › "Caching discovery verdicts"): store `getDiscoverResult()` (modern) or "absent = legacy" together with a host timestamp; supply it as `prior` while fresh; supply `undefined` under `auto` to re-probe. Key it by the authorization context ("Never share a persisted `DiscoverResult` across principals"). The response cache (`ttlMs`/`cacheScope`) is a separate cache owned by the SDK. **[V]** A modern-verdict `connect({ prior })` never auto-opens a `subscriptions/listen` stream; the host calls `listen()`. **[V]**

## 3. Client API by feature

### 3.1 MRTR / server→client requests

- Declare capabilities in the constructor (`capabilities: { elicitation: { form: {}, url: {} }, sampling: {}, roots: {} }`); register handlers once with `setRequestHandler('elicitation/create' | 'sampling/createMessage' | 'roots/list', fn)`. "The same handler answers a request the server pushes to your client and a request the SDK fulfils for you inside a `callTool()` round." **[V]** (`docs/clients/server-requests.md`)
- Modern: `callTool()` returns a plain `CallToolResult`; `resultType` is consumed internally. `'complete'` stripped, `'input_required'` fulfilled, any other `resultType` (including `task`) rejects with `SdkError(UnsupportedResultType)`. **[V]** (`support-2026-07-28.md` › "Wire-only members")
- Options: `inputRequired: { maxRounds (10), autoFulfill (true) }`. `autoFulfill: false` plus per-call `allowInputRequired: true` hands the input-required value back; the host must send the retry (`inputResponses`, verbatim `requestState`, new id). `callTool` is typed `Promise<CallToolResult>` so the manual result is a cast (`isInputRequiredResult` and `withInputRequired()` exist). Example: `examples/mrtr/client.ts`; test `packages/client/test/client/inputRequiredEngine.test.ts:344`. **[V]**
- `RequestOptions.maxTotalTimeout` bounds the whole multi-round flow. **[V]**
- Legacy servers keep pushing `elicitation/create` etc. over the session; the same handlers run. A modern-era client "drops inbound server→client JSON-RPC requests" instead of answering. **[V]**
- Consequence **[I]**: with the default path the host's elicitation UI runs inside an awaiting promise, so a DO eviction loses the pending call. Cloudflare's own agents docs say the same (§7). A durable ask requires manual mode on modern connections, and nothing durable is possible for legacy pushed requests.

### 3.2 `server/discover`, `subscriptions/listen`, legacy equivalents

- `client.discover()` / `getDiscoverResult()`; `ttlMs`/`cacheScope` on `DiscoverResult` are read by the cache layer and hidden at the type level only. **[V]**
- `client.listen({ toolsListChanged, promptsListChanged, resourcesListChanged, resourceSubscriptions })` returns an `McpSubscription` (`honoredFilter`, `closed` resolving `'local' | 'graceful' | 'remote'`, `close()`); "the SDK never re-listens for you". `ClientOptions.listChanged` auto-opens a stream on a modern connection from the intersection of configured and advertised capabilities and re-fetches lists on change (`autoOpenedSubscription`). Notifications dispatch through the same `setNotificationHandler` registrations as legacy unsolicited ones. **[V]** (`docs/clients/subscriptions.md`)
- Legacy: `subscribeResource` / `unsubscribeResource`; unsolicited `list_changed`; GET standalone SSE stream opened after `notifications/initialized` (observed in my test: `GET /mcp` → 405 against the stateless handler, tolerated). **[V]**
- Cancellation: on a modern Streamable HTTP connection aborting a request closes its SSE response stream (the spec cancellation signal); legacy and stdio POST `notifications/cancelled`. **[V]**

### 3.3 Extensions

- `capabilities.extensions: Record<string, JSONObject>` exists on both client and server capability schemas (`packages/core/src/schemas.ts:469,555`); `registerCapabilities` before `connect()`; the server's map is read from `getServerCapabilities()?.extensions` (`docs/advanced/custom-methods.md`). **[V]**
- In workerd I declared `extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } }`: it appeared in the legacy `initialize` params (`capabilities.extensions`, despite the 2025 wire-view *type* omitting it) and in the modern `server/discover` probe's `_meta["io.modelcontextprotocol/clientCapabilities"]`. **[V]** (experiment)
- **Tasks**: see §1.5. Package facts, `@modelcontextprotocol/ext-tasks` 0.2.2 (published 2026-09-30; 0.x): entries `/client`, `/receiver`, `/core`, `/core/v1`, `/core/v2`; dep `zod ^4.5.4`; optional peer `client ^2`; `createTaskSessionFromClient(client, { endpointId, onInputRequest, rawDispatch?, v2RequestFraming? })`; durable `handoff()` / `resumeTask(reference)`; its own `onInputRequest` path for Tasks-extension MRTR and task-attached input (SDK handlers keep serving the 2025 peer requests and base MRTR). V2 detection is `getProtocolEra() === 'modern'` and server `extensions["io.modelcontextprotocol/tasks"]` being `{}`. For V2 "the SDK Client public API" lacks "exact V2 request metadata framing", so the host must provide a coordinator that owns request ids and responses. **[V]** (`typescript/*.md`, `src/client/sdk-client-adapter.ts:44-69,95-120,360-415`). The SDK ROADMAP lists Tasks under "Extensions … implemented as they stabilize"; the 2025-11-25 experimental tasks (SEP-1686) are "not served" by v2. **[V]** (`ROADMAP.md`)
- **MCP Apps**: `@modelcontextprotocol/ext-apps` latest dist-tag 2.0.4 (2026-10-27; MIT; exports `.`, `./app-bridge`, `./app-with-deps`, `./react`, `./react-with-deps`, `./schema.json`, `./server`; peers `zod ^4.2`, `react`/`react-dom` (listed as peers; optional-ness not checked), SDK v2 packages `^2`). Version 2.1.0 is on the registry (published 2026-10-27) while git history shows its bump reverted (`07cda25 Revert "Bump version to 2.1.0"`) and `latest` still points at 2.0.4; treat 2.0.4 as the stable pin. `AppBridge extends Protocol<BaseContext>` (SDK `Protocol`), is built as `new AppBridge(client | null, hostInfo, hostCapabilities)`, forwards the view's `tools/call`, `resources/*`, `prompts/*` to the given `Client`, and talks to the view through `PostMessageTransport`. So the bridge lives where the iframe lives (the browser); in cloudpid's split (client in a DO, host UI in a browser) it must either be given a `Client` proxy or `null` plus host-handled callbacks. **[V]** for the class shape; the split-deployment point is **[I]**. No Apps text for the modern era was found by the prior research. **[U]** whether `ext-apps` handles per-request capability declaration for the modern era; I only verified the SDK passes arbitrary `extensions` through.
- **Skills**: `@modelcontextprotocol/client/ext/skills` `SkillsClient` (`list`, `get`, `read` with size/digest/frontmatter verification, `readDirectory`); "works on 2025-11-25 and 2026-07-28"; server side `SkillsExtension` (`attach` is `@experimental`). Added in 2.4.0 (SEP-2640). **[V]** (client `CHANGELOG.md`)
- **Server Cards**: no SDK support or mention. **[V]** (grep over repo `*.ts`/`*.md`)

### 3.4 OAuth and auth hooks (`docs/clients/oauth.md`, `machine-auth.md`) **[V]**

- `StreamableHTTPClientTransport({ authProvider })` accepts either `AuthProvider` (just `token()` plus optional `onUnauthorized(ctx)`; one retry on 401) or the full `OAuthClientProvider`.
- `OAuthClientProvider`: `clientInformation(ctx)`/`saveClientInformation(info, ctx)` keyed by `ctx.issuer` (SEP-2352), `tokens()`/`saveTokens()`, `state()`, `saveCodeVerifier()`/`codeVerifier()`, `saveDiscoveryState()`/`discoveryState()` (AS-binding across the redirect), `redirectToAuthorization(url)`, `clientMetadataUrl` (CIMD; HTTPS URL with non-root path; used as `client_id` when the AS advertises support), `validateResourceURL`, `scopeForRefresh`, `skipOfflineAccessConsentPrompt`. `application_type` is set by `clientMetadata`.
- Flow: connect throws `UnauthorizedError` after `redirectToAuthorization`; `transport.finishAuth(URLSearchParams)` validates `iss` (RFC 9207, `IssuerMismatchError`), exchanges the code, saves tokens; reconnect on a fresh transport. State lives on the provider, so a DB-backed provider survives DO eviction.
- Step-up: `onInsufficientScope: 'reauthorize' | 'throw'`, `maxStepUpRetries`.
- Non-interactive: `ClientCredentialsProvider` (`client_secret_basic`), `PrivateKeyJwtProvider` (RFC 7523; PEM/JWK, uses a dynamic `import("jose")`), `CrossAppAccessProvider` + `discoverAndRequestJwtAuthGrant` / `requestJwtAuthorizationGrant` / `exchangeJwtAuthGrant` (Enterprise-Managed Authorization / SEP-990), DPoP (`withDpop`, `DpopSession`, `generateDpopKeyPair`). `expectedIssuer` guards against sending a secret to an unexpected AS (omitting it is deprecated). DCR: `registerClient` still present (deprecated in the spec; the SDK notes CIMD preference).
- `redirectPolicy: 'same-origin'` default since 2.3.0 (cross-origin redirects fail unless `'follow'`). Middleware: `applyMiddlewares`, `createMiddleware`, `withOAuth`, `withLogging`, `withDpop*` wrap `fetch`.

### 3.5 Transport plumbing

- **Custom `fetch`**: `StreamableHTTPClientTransportOptions.fetch` is "used for all network requests"; `requestInit` for headers; per-message `TransportSendOptions.headers`. **[V]** (`streamableHttp.ts:157-260`)
- **Abort / timeouts / progress**: per-request `signal`, `timeout` (default `DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000`), `resetTimeoutOnProgress`, `maxTotalTimeout`, `onprogress`; timeouts raise `SdkError(RequestTimeout)`. **[V]** (`packages/core-internal/src/shared/protocol.ts:103-142`)
- **Legacy session**: `sessionId` and `protocolVersion` constructor options let a transport resume a known session; `terminateSession()` sends DELETE; reconnection options (`maxRetries` default 2, backoff) plus a pluggable `reconnectionScheduler` ("serverless functions that terminate before the timer fires"). Open upstream issues of note: #1708 (404 handling for expired session not per spec), #2098 (2-retry SSE reconnect ceiling, silent success after exhaustion). **[V]**
- **Response size / byte streaming: none on HTTP.** A JSON response is read with `response.json()`; an SSE response is piped through `eventsource-parser`'s stream into whole-message `JSON.parse`. No `maxResponseBytes`-style option, no raw-byte or chunk access to a tool result. `maxBufferSize` exists only for the stdio `ReadBuffer`. So large-result protection (cloudpid's own caps) would have to wrap `fetch`/`Response` in the injected `fetch` (truncate or reject by `Content-Length`/stream byte count), which is possible because the transport takes any `fetch`. **[V]** (source reading `streamableHttp.ts:1186-1210`, grep for size options) / wrapping is **[I]**. (2.3.0 made a 50 MB single SSE event fast: changelog.)

## 4. The package split and stability

| Package (all 2.4.0 on 2026-10-23 unless noted) | Role | Runtime deps |
| --- | --- | --- |
| `@modelcontextprotocol/client` | `Client`, transports (Streamable HTTP, SSE client, stdio via `/stdio`), OAuth, `/ext/skills`, `/validators/{ajv,cf-worker}`, `/_shims` | `zod ^4.2`, `@modelcontextprotocol/core` (exact), `eventsource ^3`, `eventsource-parser ^3.0.8`, `pkce-challenge ^5`, `jose ^6.1` (dynamic import), `cross-spawn ^7` (stdio entry) |
| `@modelcontextprotocol/server` | `McpServer`, `createMcpHandler`, `serveStdio` (`/stdio`), `/ext/skills`, validators | `zod ^4.2`, `core` |
| `@modelcontextprotocol/core` | public zod schemas and types; `/internal` (no compatibility promise) | `zod ^4.2` |
| `@modelcontextprotocol/server-legacy` | frozen v1 `SSEServerTransport` (deprecated, removal planned in v3) | |
| `@modelcontextprotocol/{node,express,hono,fastify}` | thin framework adapters (node 2.1.2, express 2.0.2, hono 2.0.2, fastify 2.0.1) | framework as peer |
| `@modelcontextprotocol/ext-apps` 2.0.4, `ext-tasks` 0.2.2 | extension packages (own repos) | |

Sources: npm registry metadata and tarballs for 2.4.0 (inspected `package.json`, `dist/*.mjs` import lists), `VERSIONING.md`, `DEPENDENCY_POLICY.md`. **[V]**

- **License**: Apache-2.0 (package manifests; "MIT text for earlier contributions" in `LICENSE`). ext-apps MIT, ext-tasks Apache-2.0. **[V]**
- **ESM**: `type: module`, dual ESM/CJS export maps, Node `>=20`. `README`: TypeScript ≥ 6 needs `"types": ["node"]` because published `.d.mts` references `Buffer`. **[V]**
- **Schema library**: zod v4 internally (`zod/v4`); server tool/prompt schemas use Standard Schema (bring any Standard-Schema library). The client's public API takes plain JSON Schema objects for tools, so cloudpid's Effect Schema is not forced into the client path; `zod ^4` is still a transitive runtime dependency (≈ one of the main weight contributors). **[V]** for zod; "Effect Schema not forced" is **[I]**.
- **JSON Schema validator** (output-schema validation and elicitation helpers): `jsonSchemaValidator` is a `ClientOptions` field; defaults come from the `_shims` export condition. `/validators/cf-worker` wraps `@cfworker/json-schema`; `/validators/ajv` bundles Ajv 8. **[V]**
- **Release cadence**: 2.0.0 2026-07-27 (with the spec), 2.1.0 09-23, 2.2.0 09-28, 2.3.0 10-02, 2.3.1 10-05, 2.4.0 10-23 (four minors and one patch in ≈ 3 months); 37 commits to `main` since 2026-10-01; 14 client versions on npm including pre-releases; npm provenance via GitHub OIDC trusted publisher. **[V]**
- **Stability promises** (`VERSIONING.md`): SemVer 2.0; core/client/server/server-legacy/codemod are a fixed version group; breaking = removing API, changing documented behaviour, dropping Node LTS, removing a transport, **dropping a protocol revision the SDK previously negotiated**; non-breaking = adding new spec revisions, optional params, new exports; deprecate "when feasible" for ≥ 1 minor; `core/internal` explicitly excluded. Dependencies: conservative, bumped only for security/bug/spec reasons. **[V]**
- **v1 maintenance**: `v1.x` branch (`@modelcontextprotocol/sdk`, 1.32.2 on 2026-10-23) "continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27)", i.e. until ≥ 2027-01-27; it "targets the 2025-11-25 revision; new spec revisions are implemented on `main` only". **[V]** (`README.md`, `ROADMAP.md`)
- **Conformance**: runs on each push to `main` against 2025-11-25 and 2026-07-28. **[V]** (`ROADMAP.md`)
- **Churn evidence relevant to a pin**: 2.3.0 changed redirect handling (cross-origin redirects no longer followed) as a minor; 2.4.0 started rejecting `x-mcp-header` on `number` params; the Ajv fast-uri bump made some `$id`/`$ref` forms stop compiling (patch). Behavioural tightening arrives in minors and patches. **[V]** (client `CHANGELOG.md`)

## 5. Runtime fit: workerd and Durable Objects

### 5.1 Node built-ins and polyfills

Import audit of `@modelcontextprotocol/client@2.4.0` `dist/*.mjs` **[V]**:

- Node-only imports: `node:process` and `node:stream` appear only in `stdio.mjs` (the `/stdio` entry), plus `cross-spawn` there. `index.mjs` and the shared chunks import no `node:*` module. The stdio `ReadBuffer` uses `Buffer` but is only reachable through `/stdio`. The workerd shim sets `CORS_IS_POSSIBLE = false` and the CfWorker validator.
- `index.mjs` statically imports `eventsource` (for `SSEClientTransport`) and `eventsource-parser/stream`; `public-*.mjs` imports `pkce-challenge`; `jose` is dynamically imported only in `PrivateKeyJwtProvider`. `crypto` use is `globalThis.crypto.subtle` / `getRandomValues` (DPoP).
- `node:http`, `ajv` (outside the Node shim), `cross-spawn` (outside `/stdio`): not required.
- Experiment: client + `createMcpHandler` server bundled by esbuild (`platform: neutral`, conditions `workerd,worker,browser,import`, `node:*` external) ran correctly in Miniflare 4.20260730.0 / workerd 2026-07-30 with `compatibility_flags: ["nodejs_compat"]`, and also with no compatibility flags. **[V]** (§9)

### 5.2 `new Function` and the validator choice

- Cloudflare: "For security reasons, the following are not allowed: `eval()`, `new Function`, …" (<https://developers.cloudflare.com/workers/runtime-apis/web-standards/>, updated 2026-04-23). **[V]**
- Ajv's compiled validators use `new Function`; the SDK's Node shim bundles Ajv (`ajvProvider-*.mjs`: one `new Function`). **[V]** (grep of the tarball)
- Export map `./_shims` order is `node`, `browser`, `default`, `workerd`: resolution picks by condition. My bundling tests: conditions `workerd,worker,browser` → CfWorker; `browser` → CfWorker; `node` (`conditions: ['import','node']`) → the bundle contains Ajv and 1 `new Function`. **[V]** (esbuild runs) So the default is correct under wrangler/Vite's workerd conditions but can silently flip to Ajv under a build that resolves the `node` condition. **[I]** Cloudflare `agents` removes this risk by importing `@modelcontextprotocol/client/validators/cf-worker` and passing it explicitly (`runtime.ts`); it also wraps it to route `$schema: draft-07` documents to a draft-7 instance (`new CfWorkerJsonSchemaValidator({ draft: '7' })`). **[V]** (the reason, that the default instance does not handle draft-07 documents, is **[I]**) (cloudflare/agents `packages/agents/src/mcp/client/runtime.ts`) Recommendation-shaped inference: always pass `jsonSchemaValidator` explicitly. **[I]**
- Zod v4 also has a JIT path that uses `new Function`; it is feature-detected, and my workerd run, which exercised parsing in both eras, produced no error. **[V]** (experiment) / mechanism **[I]**.

### 5.3 Size and memory

Measured with esbuild 0.28.2, ESM, workerd conditions, `node:*` external: **[V]**

| Bundle | Unminified | Minified | gzip (minified) |
| --- | ---: | ---: | ---: |
| client only (`Client` + `StreamableHTTPClientTransport`, tree-shaken) | 678 KB | 324 KB | 88 KB |
| client + `createMcpHandler` server + zod | 1,077 KB | 525 KB | 140 KB |

Tarball sizes: client 1.75 MB, server 1.68 MB, core 158 KB (mostly dual CJS/ESM plus sourcemaps; unpacked client 7.3 MB). **[V]**

Memory: issue #2865 (open, 2026-09-25): both workerd shims call `preloadSchemas()` at module scope; one reporter measured ≈ 10 MiB of cold used heap saved by removing the two calls (23.2 MB → 12.5 MB), a second reproducer saw 8.6–8.8 MB per package (client 17.7 MB vs 8.9 MB stripped; server+client 29.6 → 18.8 MB; empty Worker 0.74 MB) at a cost of 11–16 ms of construction time per package that otherwise lands on the first request; the eager call is deliberate (#2483). Options discussed upstream: document, opt-out, build only the negotiated era. No fix yet. **[V]** DO isolate limit is 128 MB; relevant but not a blocker. **[I]**

### 5.4 DO hibernation and long streams

- Hibernation drops the in-memory `Client`; reconnect on wake. Pieces the SDK gives: `prior` verdicts, OAuth state on the provider, `sessionId`/`protocolVersion` options for legacy session resume, a response-cache store interface (`responseCacheStore`, entries are JSON strings), `getDiscoverResult()` as plain JSON. **[V]**
- Nothing in the SDK is DO-specific; open-stream behaviour (`subscriptions/listen`, SSE response streams, the legacy GET stream) in a DO that wants to hibernate is **[U]** (not tested; Cloudflare's agents code re-opens a restored list subscription after reconnect: `openRestoredListSubscription`).
- In-flight requests, MRTR driver state, `listen` streams and pending handlers are process-memory; a lost modern SSE stream "loses the in-flight request" and the spec requires re-issue. **[V]** for the SDK/spec behaviour, consequences for non-idempotent calls **[I]**.

## 6. Server side: `createMcpHandler`

From `docs/serving/web-standard.md`, `legacy-clients.md`, `protocol-versions.md`, `http.md` and my workerd run. **[V]**

- `createMcpHandler(factory, options?)` returns `{ fetch, close, notify, bus }`; `export default handler` is a valid Worker entry. The factory is invoked once per request (fresh `McpServer`) and receives `{ era }`.
- Serves `2026-07-28` per request. Default `legacy: 'stateless'` also serves 2025-era `initialize`/tool calls per request (fresh instance, no sessions); `legacy: 'reject'` answers legacy with `400` + `-32022` naming the supported modern version. Legacy `GET`/`DELETE` → `405`. `isLegacyRequest(request)` + `legacyStatelessFallback(factory)` allow routing a sessionful legacy deployment beside a strict modern one.
- Stateless legacy has no return path for server→client requests: `inputRequired(...)` handlers (written once) degrade to a "did not declare the required capability" refusal (observed in my run: tool result `isError: true`). The legacy shim that issues real `elicitation/create` needs stdio or a sessionful legacy wiring. JSON-mode legacy hosting cannot deliver mid-call requests.
- No Host/Origin validation by default (`hostHeaderValidationResponse`, `originValidationResponse` helpers are provided; upstream issue #2844 notes bare-fetch mounts skip them). Auth is pass-through: verify yourself, `handler.fetch(request, { authInfo })`, read as `ctx.http.authInfo`.
- Changes: `handler.notify.{toolsChanged,...}` over an in-process `ServerEventBus`; multi-isolate delivery needs a user-supplied bus. `requestState` must be integrity-protected (`createRequestStateCodec` HMAC helper; "signed, not encrypted"). Cache hints through `ServerOptions.cacheHints`. Modern server enforces `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` consistency with the body (400 `-32020`). The SDK server serves Tasks only through user-registered handlers (`tasks/get`, `tasks/cancel`), not as a built-in.
- Skills server (`SkillsExtension`, `attach` experimental) is included in 2.4.0.

Verified in workerd: one factory served `modern` calls (`server/discover` then `tools/call` with `Mcp-Method` header, MRTR elicitation round trip returning `city={"city":"Lisbon"} era=modern`) and `legacy` calls (`initialize`, `tools/call`) from the same endpoint. **[V]** (§9)

## 7. Cloudflare `agents` and `createMcpHandler`

Sources: npm `agents` 0.32.0 (2026-10-29; MIT), `cloudflare/agents` repo at `be17492`, `docs/agents/mcp-client.md`, `docs/agents/mcp-servers.md`, `packages/agents/CHANGELOG.md`, <https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/> (updated 2026-10-27). **[V]**

- **SDK versions**: peer dependencies `@modelcontextprotocol/client` `2.4.0`, `@modelcontextprotocol/server` `2.4.0` (both exact) and `@modelcontextprotocol/sdk` `1.32.2` (v1, optional, retained for `McpAgent` and the legacy handler). Changelog: v2 support first landed against `2.0.0-beta.5`, then stable 2.0.0, 2.2.0, 2.3.1, 2.4.0 (PR #2744 also added `clientMetadataUrl` to `DurableObjectOAuthClientProvider` for CIMD). The Cloudflare docs: "Agents SDK v0.20.0 uses `@modelcontextprotocol/client` and negotiates stateless or legacy behavior automatically. The MCP client does not need `@modelcontextprotocol/sdk` or `@modelcontextprotocol/server`."
- **Does it speak `2026-07-28`?** Yes, by delegation: `MCPClientConnection` builds an SDK `Client` with `DEFAULT_CLIENT_OPTIONS = { jsonSchemaValidator: CompatibleWorkerJsonSchemaValidator, versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: true } }`; docs: "uses `server/discover` with Stateless servers and falls back to the `initialize` handshake on the same connection for Legacy Streamable HTTP and SSE servers". Transports: `streamable-http`, `sse`, `auto` (streamable then SSE), and an in-house `rpc` transport (DO-to-DO).
- **Hibernation** (`MCPClientManager`, `client/storage.ts`, `connection.ts`): server rows live in the Agent's SQLite table `cf_agents_mcp_servers` with `server_options` JSON containing a durable subset of client options (capabilities, `versionNegotiation`, `inputRequired`, `listMaxPages`, `cachePartition`, `defaultCacheTtlMs`, …), transport options, `retry`, and, after connect, `sessionId`, `protocolVersion` and `discoverResult`. On restore `tryConnect` passes `prior = { kind: 'modern', discover }` only when the transport has a session id and a stored `discoverResult` (code gate; an ordinary stateless modern server has no session id, so [I] it re-probes on wake), then re-opens a `listen` subscription for the advertised `listChanged` capabilities. Stale legacy sessions are detected and re-initialized (`_recoverStaleSession`). OAuth tokens and client info are stored in SQLite via `DurableObjectOAuthClientProvider`.
- **Documented limits**: "Handlers and pending calls are memory-only. A Durable Object hibernation or isolate restart does not preserve an in-flight interactive call … Agents intentionally does not persist in-flight Stateless `requestState` or implement a manual/resumable continuation layer." Elicitation handlers are re-attached in `onStart()`; advertised modes are persisted.
- **Not present**: no Tasks, no MCP Apps, no generic `extensions` plumbing, no response-size limits (grep over `packages/agents/src/mcp` for `io.modelcontextprotocol`, `ui://`, `tasks`).
- **`createMcpHandler`**: `agents/mcp/server` exports an SDK-v2 handler wrapper (`handler-stateless.ts`): takes a factory returning an SDK v2 `McpServer`/`Server`, serves `2026-07-28` and stateless legacy clients from one endpoint, adds Host/Origin validation (`allowedHostnames`, `allowedOriginHostnames`), CORS, `workers-oauth-provider` auth-context mapping to `AuthInfo`, and the SDK `fetch`/`notify` surface; legacy fallback uses the SDK's web-standard transport with a 25 s SSE keepalive. SDK-v1 servers and `McpAgent` are deprecated and feature-frozen. (docs/agents/mcp-servers.md says "draft MCP `2026-07-28`"; stale wording, the same page and the changelog treat it as the shipped revision.)
- **Reading** **[I]**: Cloudflare's reference implementation chose option (b) and is the closest working example of "v2 SDK client inside a DO" (also a source of battle-tested workarounds: explicit CfWorker validator with draft-07 routing, persisted discover verdict, restored `listen`). It is not reusable as a library for cloudpid's needs without adopting `Agent`/`this.mcp`, but its `MCPClientConnection` logic is a MIT-licensed pattern source.

## 8. pi-mcp (`earendil-works/pi`, `packages/mcp`)

Local facts: version 1.4.0, MIT, runtime dependency `cross-spawn` only, ≈ 3.3 k lines excluding tests, exports `.`, `./oauth`, `./testing`; pi HEAD `6454d07` (2026-10-30). Spec coverage is in `mcp-spec-revisions.md` §8. **[V]**

Public issues/PRs (queried through `gh` on 2026-10-30): **[V]**

| # | State | What |
| --- | --- | --- |
| [#10416](https://github.com/earendil-works/pi/issues/10416) "Support Stateless MCP (2026-07-28) the current latest version" | **open**. Auto-closed 2026-10-03 as a new-contributor issue; reopened and assigned to `davidbrai` on 2026-10-05. | Author `SamMorrowDrums` (GitHub MCP maintainer) proposes dual-era `pi-mcp` over stdio and Streamable HTTP, an optimistic `server/discover` probe with fast fallback, keeping pi's result-envelope contract; says MRTR may be skippable "given you're primarily focused on code mode". Comments: another user asks for "a signal on 'we are intentionally never going to support v2' vs. 'yeah we will someday'"; `chubes4` offers to contribute a small stateless probing client (Roadie PR #358); WordPress.com's MCP server already speaks `2026-07-28` with `input_required`. **No maintainer comment on scope or timeline.** |
| [#11353](https://github.com/earendil-works/pi/issues/11353) "add support for MCP protocol 2026-07-28 to pi-mcp" (Tasks/Skills/elicitation hooks) | closed 2026-10-23 (auto-closed, not reopened) | |
| commit `67996ab` (Armin Ronacher, 2026-10-12), pi-mcp 1.2.0 changelog | shipped | `structuredContent` may be any JSON value, "as MCP 2026-07-28 allows", referencing #10416 |
| #10274 "Support MCP elicitation" | closed 2026-10-01 | elicitation support landed in pi's host (legacy-style) |
| #10647 "Proposal: public MCP hooks for host-owned access and authentication controls", #10525 (client credentials with JWT assertion), #10172 (OAuth `authServerMetadataUrl`/`skipIssuerMetadataValidation`) | open / closed | adjacent host-hook and OAuth demand |
| #11335 "MCP HTTP JSON responses bypass maxMessageBytes" (open); stdio `maxMessageBytes` exists in `src/transports/stdio.ts` | open | pi has an explicit message-size limit for stdio, with HTTP JSON a known gap; the official SDK has none for HTTP |
| Searches for `MRTR`, `server/discover`, `input_required`, `modelcontextprotocol/client` | | no issue or PR about adopting the official SDK; no PR for `2026-07-28` |

Would upstream accept dual-era work? `CONTRIBUTING.md` ("pi's core is minimal … PRs that bloat the core will likely be rejected"; "Do not open a PR unless you have already been approved by a maintainer using `lgtm`"; changelog edits by maintainers only). Pi maintainers have partially engaged (#10416 reopened, `structuredContent` change), but have published no position, no design, no acceptance of an external PR. **[I]** It is a gated, maintainer-controlled path; an upstreamable dual-era PR needs prior `lgtm` on an issue, and acceptance is **[U]**. The fact that pi's own `coding-agent` already hosts pi-mcp as a built-in extension means any scope will be set by pi's core maintainers. **[I]**

## 9. Experiments run (reproducible summary)

Environment: Node 24.22.1, `npm i @modelcontextprotocol/client@2.4.0 @modelcontextprotocol/server@2.4.0 zod miniflare esbuild`, Miniflare 4.20260730.0 (workerd 2026-07-30), compat date 2026-07-01. Worker built with esbuild (`platform: neutral`, conditions `workerd,worker,browser,import`, `node:*` external). Client talked to the in-Worker `createMcpHandler` through `StreamableHTTPClientTransport({ fetch })`. **[V]**

1. Server factory `({ era }) => McpServer` with a plain tool and an `inputRequired.elicit` tool. Client A `versionNegotiation: { mode: 'legacy' }`, client B `{ mode: 'auto' }`, both with an `elicitation/create` handler. Result: A `getProtocolEra() = legacy`, tool text `hi x (legacy)`; elicitation tool returned `isError: true` ("per-request legacy serving cannot receive server-to-client requests"). B `modern`, `hi x (modern)`, elicitation round trip auto-fulfilled → `city={"city":"Lisbon"} era=modern`. Wire order seen at the handler: legacy = `POST initialize`, `POST notifications/initialized`, `GET /mcp` (405) then `tools/call`; modern = one `POST server/discover` then three `POST tools/call` (plain tool, MRTR first leg, MRTR retry; `Mcp-Method` header present).
2. Same bundle with no `compatibility_flags`: identical results.
3. Extensions: client `capabilities.extensions['io.modelcontextprotocol/ui']` set; legacy `initialize` params contained it, modern probe `_meta` contained it. `Mcp-Method: server/discover`, `MCP-Protocol-Version: 2026-07-28` on the probe.
4. Fallback matrix against hand-written fetch handlers (legacy-only fakes): result listed in §2.2.
5. Sizes: §5.3. Validator condition test: §5.2.

Not tested: a real Durable Object with hibernation, real remote servers, large payloads, OAuth round trips, `subscriptions/listen` over a long-lived stream.

## 10. Other maintained TS clients (brief)

Facts from the npm registry (2026-10-30) and grepping published `dist` for `2026-07-28`, `server/discover`, `input_required`. **[V]** for presence; behaviour not exercised.

| Package | Version | Relation to the SDK | Dual-era? |
| --- | --- | --- | --- |
| `@ai-sdk/mcp` (Vercel AI SDK) | 2.0.88, modified 2026-10-30 | **own implementation**; deps `@ai-sdk/provider`, `provider-utils`, `cross-spawn`, `pkce-challenge` (no `@modelcontextprotocol/*`) | Yes: `LATEST_PROTOCOL_VERSION = "2026-07-28"`, `server/discover` probe, `Mcp-Method` header, `resultType: "input_required"` handling with `allowInputRequired`, "Modern MCP result is missing resultType" check. Stdio is a separate `mcp-stdio` dir. |
| `mcp-use` | 2.12.2 | wraps `@modelcontextprotocol/client` 2.3.1, `server`, `core`, `ext-apps` | Yes (via SDK); also `server/discover` in its own code |
| `@mastra/mcp` | 2.6.0 | wraps `client` 2.4.0, `server`, `ext-apps`, `node` | Yes (via SDK) |
| `@langchain/mcp-adapters` | 2.0.1 | wraps `client ^2.2.0` | Via SDK (no own discover code) |
| `@tanstack/ai-mcp` | 1.0.0 (2026-10-22) | wraps `client ^2.0.0`, `server`, `jose` | Via SDK |
| `fastmcp` | 4.23.8 | still `@modelcontextprotocol/sdk ^1.24.3` (v1) | **No** (no `2026-07-28` in `dist`) |

Reading: the ecosystem is converging on the official v2 packages as the dual-era engine; `@ai-sdk/mcp` is the one independent dual-era client implementation, and so a third-party reference for what a from-scratch client has to do. **[I]**

## 11. What this means for the three candidates (inference, not a decision)

| Need | (a) extend pi-mcp 1.4.0 | (b) official SDK v2 | (c) own |
| --- | --- | --- | --- |
| Legacy-era client | yes (tools/resources; no prompts/completion/subscribe/setLevel/sampling/elicitation handlers) | yes, complete, incl. prompts, completion, subscribe, GET stream | all to write |
| Modern-era client (`_meta`, discover, headers, cache, listen) | none; "new protocol plumbing" (`mcp-spec-revisions.md` §8) | yes, conformance-tested vs both revisions | all to write (≈ `client.ts` 2.7 k lines, `streamableHttp.ts` 1.3 k, `versionNegotiation.ts`/`probeClassifier.ts` ≈ 1 k in the SDK, plus `core-internal` wire codecs) |
| Era probe logic with deployed-server quirks | none | detailed, with opinionated fallbacks and a host-supplied `prior` | all to write; `@ai-sdk/mcp` and the SDK are the references |
| MRTR | none | auto-fulfil, manual mode | to write |
| Tasks ext. | none | not in SDK; `ext-tasks` 0.2.x on top; V2 needs host `rawDispatch` | to write against `ext-tasks`' published schemas anyway |
| Apps ext. | none | `ext-apps` helper (browser) | n/a |
| Skills ext. | none | client `ext/skills` | |
| OAuth | current subset; abortable; CIMD hook | broader (client credentials, private-key JWT, cross-app access, DPoP) | |
| workerd fit | not examined by me **[U]** (3.3 k lines, only `cross-spawn`; Node-free `StreamableHttpTransport` plausible) | verified; ≈ 88 KB gz + 9–10 MiB heap | optimal in size |
| Large-response limits | stdio only; HTTP gap (#11335) | none on HTTP; inject `fetch` wrapper | free to design |
| Durable ask-the-user for MRTR | to design | manual mode exists | to design |
| Upstream posture | gated, minimal-core, no stated plan | official; public semver + 6-month v1 window; fast minors | n/a |
| Effect v4 fit | Promise API, wrap | Promise/class API with `AbortSignal`; wrap | native |

Points that survive any choice **[I]**: the host (not the library) must own the era-verdict cache, the DiscoverResult/list cache keyed per authorization context, OAuth credential storage keyed by issuer, durable task ids, `requestState`-based continuation for human prompts, `fetch`-level response-size caps, and extension capability declarations. The official SDK supplies the mechanisms for most of these (`prior`, `responseCacheStore` + `cachePartition`, provider hooks, manual MRTR, injectable `fetch`) but not the policy.

## 12. Open unknowns

- **[U]** Real Durable Object behaviour: memory/CPU of holding `subscriptions/listen` SSE streams and legacy GET streams, hibernation interaction, wall-clock billing; whether re-listen after eviction loses events. Not tested.
- **[U]** Whether pi-mcp's `StreamableHttpTransport` runs unmodified in workerd (not tried); its relative size and heap use vs the SDK.
- **[U]** `@modelcontextprotocol/ext-tasks` V2 against a real modern Tasks server through the SDK `Client` (the `rawDispatch` coordinator contract is documented but I did not build one); stability of a 0.2.x package.
- **[U]** Whether `ext-apps` `AppBridge` works against a modern-era SDK `Client` end-to-end (peer range allows `^2`), and how it composes with per-request extension declaration.
- **[U]** `ext-apps` 2.1.0 on npm vs reverted version bump in git: intended or accidental.
- **[U]** Server Cards wire format and any client support (neither SDK nor ext packages mention it).
- **[U]** Whether the SDK will add Tasks (#2189) or an HTTP response-size option in 2.x; whether upstream accepts a `maxResponseBytes`-type option.
- **[U]** pi maintainers' plan for #10416 (scope, timeline, whether they would take an external dual-era PR or adopt the SDK).
- **[U]** Real-world share of servers on each era (as in `mcp-spec-revisions.md` §10).
- **[U]** The effect of workerd's `allow_eval_during_startup` / compat-date flags on libraries that evaluate code at module scope (not needed by the SDK's CfWorker path, so left unexamined).

## 13. Sources

npm registry (fetched 2026-10-30): `@modelcontextprotocol/{client,server,core,node,express,hono,fastify,sdk,ext-apps,ext-tasks}`, `agents`, `@ai-sdk/mcp`, `mcp-use`, `fastmcp`, `@mastra/mcp`, `@langchain/mcp-adapters`, `@tanstack/ai-mcp`; tarballs of `client`, `server`, `core` 2.4.0 inspected (`package.json`, `dist/*.mjs`).

GitHub (cloned at the stated heads, 2026-10-30):
- `modelcontextprotocol/typescript-sdk` `main` @ `39ae8e6` (tag `v2.4.0`): `README.md`, `VERSIONING.md`, `DEPENDENCY_POLICY.md`, `ROADMAP.md`, `docs/{protocol-versions,troubleshooting}.md`, `docs/clients/*.md`, `docs/serving/*.md`, `docs/advanced/{gateway,custom-methods,custom-transports}.md`, `docs/migration/support-2026-07-28.md`, `packages/client/src/client/{client,streamableHttp,probeClassifier,versionNegotiation,authExtensions}.ts`, `packages/client/CHANGELOG.md`, `packages/core/src/schemas.ts`, `packages/core-internal/src/shared/protocol.ts`, `examples/{mrtr,dual-era,extension-capabilities,gateway}`; issues #2189, #2865, #1708, #2098, #2844.
- `modelcontextprotocol/ext-tasks` @ `b3d28ac`: `README.md`, `typescript/*.md`, `packages/ext-tasks/src/client/sdk-client-adapter.ts`.
- `modelcontextprotocol/ext-apps` @ `cf599cc`: `src/app-bridge.ts`, `RELEASES.md`.
- `cloudflare/agents` @ `be17492`: `packages/agents/src/mcp/client/{connection,runtime,storage,index}.ts`, `packages/agents/src/mcp/server/handler-stateless.ts`, `docs/agents/{mcp-client,mcp-servers}.md`, `packages/agents/CHANGELOG.md`, `packages/agents/package.json`; <https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/>; <https://developers.cloudflare.com/workers/runtime-apis/web-standards/>.
- `earendil-works/pi` @ `6454d07`: `packages/mcp/{package.json,CHANGELOG.md,src/transports/stdio.ts}`, `CONTRIBUTING.md`; issues #10416 (+ timeline), #11353, #10274, #10647, #11335, commit `67996ab`.

Prior research: `docs/research/mcp/mcp-spec-revisions.md` on `research/mcp-spec-revisions`.

Experiments: scratch project under `/tmp/wt` (Miniflare + esbuild); sources summarized in §9, not committed.
