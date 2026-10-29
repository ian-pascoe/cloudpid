# Serving MCP from cloudpid's main Worker behind Cloudflare Access

Ticket: [#378](https://github.com/ian-pascoe/cloudpid/issues/378) (map [#373](https://github.com/ian-pascoe/cloudpid/issues/373)). Read on 29 Oct 2026; Cloudflare docs, the MCP spec and GitHub were current that day.

**Question.** What does it take for the main Worker to be a remote MCP _server_ that a local client (pi, Claude Code) reaches while the deployment sits behind Access? Compare Access's MCP-client support (Access as OAuth authorization server, managed OAuth, service tokens), `@cloudflare/workers-oauth-provider`, and the `agents` package's MCP server support (`McpAgent`, Streamable HTTP). Must a server hold state per MCP session? Which fits a single-owner deployment?

## Short answer

1. **Access, not a library, is the authorization layer.** Turn on **managed OAuth** on the Access application that already fronts the Worker. Access then acts as the OAuth authorization server for non-browser clients (401 + discovery, DCR, auth code + PKCE, refresh), enforces the existing owner-email policy, and forwards a signed assertion to the Worker. The Worker adds no OAuth code. A **service token** (a `Service Auth` policy plus two headers) covers headless use and is a fallback for clients that cannot do the OAuth dance.
2. **The server needs no per-MCP-session state.** Sessions are optional in 2025-11-25 and removed in 2026-07-28. `agents`' `createMcpHandler` is a stateless fetch handler (a fresh `McpServer` per request) and fits the Worker's Effect `fetch`. `McpAgent` (a Durable Object per MCP session) is **deprecated and feature-frozen** by Cloudflare.
3. **`workers-oauth-provider` is the wrong fit** here. It makes the Worker its own authorization server, which duplicates what Access gives for free and collides with Access (its discovery/token/register endpoints must be reachable without an Access login).
4. **Open items that need a live spike** (§8): whether pi and Claude Code complete managed OAuth end to end against a Worker-destination Access app, whether DCR is offered there, and what the alchemy `access` prop must become to carry `oauthConfiguration`.

## 1. Facts: what the deployment looks like today

| Fact | Source |
| --- | --- |
| Every stage's main Worker is behind one Access application with one policy, allow the owner's email; `prod` on `pi.ianpascoe.dev`, team `spirit-led-software` | `docs/architecture/operations.md` (Access bullet); `apps/server/src/deployment.ts:11-22` |
| The policy is passed as the Worker's inline `access: { policies }` prop | `apps/server/src/deployment.ts:12-14` |
| The Worker's `fetch` is an Effect handler that routes socket, attachment and registry-RPC paths and falls through to `hello`; no JWT validation code exists in the repo | `apps/server/src/worker.ts:227-262`; grep for `Cf-Access`/`jwt` finds only GitHub App and Web Push JWTs |
| Compatibility date `2026-08-31` (alchemy adds `nodejs_compat` only for dates before `2026-08-04`; later dates get it by default) | `apps/server/src/worker.ts:143`; `@alchemy.run/cloudflare/src/Workers/Worker.ts:739`, `Compatibility.ts:32-50` |
| Today a non-browser request is **302-redirected to the Access login page**. Probe of `https://pi.ianpascoe.dev/mcp` (no credentials): `HTTP/2 302`, `location: …cloudflareaccess.com/cdn-cgi/access/login/pi.ianpascoe.dev…`, and `www-authenticate: Cloudflare-Access resource_metadata="https://pi.ianpascoe.dev/.well-known/cloudflare-access-protected-resource/mcp"` | live `curl -i`, 29 Oct 2026 |
| That `resource_metadata` URL is served by Access and returns `{"resource":"https://pi.ianpascoe.dev/mcp","protected":true,"team_domain":"spirit-led-software.cloudflareaccess.com","authorization_servers":["https://spirit-led-software.cloudflareaccess.com"],"authentication_methods":[{"name":"cloudflared",…}]}` | live `curl`, 29 Oct 2026 |
| The team domain's AS metadata (managed OAuth is off on this account's apps) lists authorization, token and revocation endpoints, PKCE `S256`, `none` client auth, and **no `registration_endpoint`** | live `curl https://spirit-led-software.cloudflareaccess.com/.well-known/oauth-authorization-server` |

So today an MCP client cannot connect: a 302 with a `Cloudflare-Access` challenge scheme is not an OAuth challenge. pi's challenge parser accepts only the `bearer` and `dpop` schemes (`.repos/pi/packages/mcp/src/oauth/discovery.ts:39-41`), and the transport starts OAuth only on a 401 (`streamable-http.ts:343`).

## 2. Access as the authorization server (managed OAuth)

**Verified**

- Managed OAuth "turns Access into a standard OAuth 2.0 authorization server for your application". Access enforces the same policies as a browser login and "your origin sees no difference". Non-browser clients get a **401** (not a 302) with a `WWW-Authenticate` header pointing at Access's discovery metadata. Prerequisite: a self-hosted app, an MCP server application, or an MCP portal, and a client that supports RFC 8707. — <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>
- Discovery: the app domain serves `/.well-known/oauth-authorization-server` (RFC 8414) and RFC 9728 resource metadata; the flow is authorization code with PKCE; Access issues **opaque** tokens (`oauth:…`), not JWTs, and resolves them to the user server-side, then forwards a signed assertion (`Cf-Access-Jwt-Assertion`) to the origin. — same page, _Authorization flow_ and _Token format_.
- Settings (API `oauth_configuration`): `dynamic_client_registration.{enabled, allow_any_on_localhost, allow_any_on_loopback, allowed_uris}`, `grant.access_token_lifetime` (default 15 min), `grant.session_duration`. Cloudflare recommends a 5–15 min access token with a 1–2 week grant for CLI/agent use; policies are re-evaluated on each refresh. — same page, _Managed OAuth settings_.
- Cloudflare's agent guide shows the metadata a managed-OAuth app returns: `registration_endpoint` (…/cdn-cgi/access/oauth/registration), `none` client auth, `S256`; the 401 carries `www-authenticate: Bearer realm="OAuth", error="invalid_token", …, resource_metadata="https://<hostname>/.well-known/cloudflare-access-protected-resource/"`. — <https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/> (updated 15 Apr 2026)
- The `/authorize` request **must carry the RFC 8707 `resource` parameter**, equal to the protected URL: without it Access answers `invalid_target / No resource parameter found`; with `resource=https://…/mcp` it issues a code. — <https://github.com/anthropics/claude-ai-mcp/issues/478> (a user's manual trace, not Cloudflare documentation)
- DCR is refused unless the client's redirect URI is allowed: `400 invalid_client_metadata: redirect_uri is not allowed by the account configuration`; the fix is the `allowed_uris` / localhost / loopback settings. — <https://github.com/anthropics/claude-ai-mcp/issues/478> (a collaborator's comment, 25 Jun 2026). Local clients use loopback redirects, which the two `allow_any_on_*` flags cover (pi: `http://127.0.0.1:<port>/callback`, `.repos/pi/packages/coding-agent/docs/mcp.md:146`; Claude Code: `http://localhost:PORT/callback`, with one release sending `127.0.0.1` — <https://code.claude.com/docs/en/mcp>, _Use a fixed OAuth callback port_).
- Client behaviour seen in the field: Claude Code connects to a managed-OAuth MCP URL, while claude.ai web and mobile connectors failed against it (closed as not planned). — <https://github.com/anthropics/claude-ai-mcp/issues/410>, `/478`. Not relevant to a pi/Claude Code deployment; it is a warning that claude.ai connectors are not a supported client.
- pi's client does what managed OAuth needs: reads `resource_metadata` from a `Bearer` 401, falls back to `/.well-known/oauth-protected-resource[/path]`, discovers the AS from `authorization_servers[0]`, sends `resource` on `/authorize` and `/token` when it found resource metadata, registers by DCR or sends a CIMD, and stores tokens in `~/.pi/agent/mcp-auth.json`. — `.repos/pi/packages/mcp/src/oauth/discovery.ts:39-60,70-103,150-200`, `flow.ts:189-212`; `coding-agent/docs/mcp.md:115-175`.
- Claude Code supports OAuth 2.0 for remote servers (401/403 triggers sign-in, refresh and one retry), DCR, CIMD, `--callback-port`, `--client-id`. — <https://code.claude.com/docs/en/mcp> (_Authenticate with remote MCP servers_).
- The alchemy resource exposes it: `Cloudflare.Access.Application` has `oauthConfiguration` with `grant.{accessTokenLifetime, sessionDuration}` and `dynamicClientRegistration.{enabled, allowedUris, allowAnyOnLocalhost, allowAnyOnLoopback}`, with an "MCP server" example. — `@alchemy.run/cloudflare/src/Access/Application.ts:75-98,209,421-436` (2.0.0-beta.84).
- **But the Worker's inline `access: { policies, … }` form cannot carry it.** `WorkerAccessApplication` has only `policies`, `name`, `sessionDuration`, `allowedIdps`, `autoRedirectToIdentity`, `appLauncherVisible`, `previews`. To set `oauthConfiguration` the stack must declare a `Cloudflare.Access.Application` and pass it as `access` (the "shared application" form). — `src/Workers/WorkerAccess.ts:27-62`.

**Inference**

- Managed OAuth on the existing app is the whole "auth server" story for a single owner: one policy (owner email) already exists, the owner already has an Access session at the IdP, so a pi sign-in is one browser click.
- Access's tokens are opaque and resolved by Access, so the Worker never sees an OAuth token; it sees the same `Cf-Access-Jwt-Assertion`/`ctx.access` as a browser request.

**Not verified**

- That the Worker-destination Access app (what `access` creates) accepts managed OAuth (docs list "self-hosted application" as the prerequisite; alchemy creates `self_hosted` apps with `worker` destinations, `Application.ts:~340-380`).
- Whether a token minted for `resource=https://pi.ianpascoe.dev/mcp` is accepted on other paths of the same app (docs say a token works across all domains of one app; path scoping is not documented).

## 3. Service tokens

**Verified**

- A client sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request. The app needs a policy with action **Service Auth** that includes the token (a plain `allow` policy would still prompt for IdP login). New secrets are `cfast_…` (since 26 Aug 2026), old ones 64 hex; both work. An app can be set to read both from one header (`read_service_tokens_from_header`, e.g. `Authorization`). — <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>; <https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/>
- Managed OAuth vs service tokens: OAuth is user-based and shows the user to Access with identity policies and no shared secret; service tokens are machine identity with a shared secret to distribute and rotate, "best for fully automated systems". — managed-oauth page, _Managed OAuth vs service tokens_.
- alchemy: `Cloudflare.Access.ServiceToken` (with `clientSecretVersion` to rotate) and `Cloudflare.Access.Policy({ decision: "non_identity", include: [{ serviceToken: { tokenId } }] })`. — `src/Access/ServiceToken.ts:95-115`. alchemy has no `read_service_tokens_from_header` prop (grep of `Access/`); the two-header form needs none.
- pi sends static `headers` from `mcp.json` with `${VAR}` expansion (an OAuth flow is skipped when an `Authorization` header is set); Claude Code takes `--header` / `headers` / `headersHelper`. So `CF-Access-Client-Id`/`-Secret` work in both. — `coding-agent/docs/mcp.md:55,81,133`; <https://code.claude.com/docs/en/mcp>.
- At the Worker, `ctx.access.getIdentity()` can report `service_token_id` and `service_token_status` (and may return `undefined` for some service-token flows), so the server can tell a token from the owner. — `src/Workers/WorkerAccess.ts:~95-125`.

**Inference**

- A service token on the _same_ app that fronts the web UI grants the whole origin (UI socket, attachments, registry RPC), not only `/mcp`. Cloudflare resolves overlapping apps by specificity ("the more specific rule takes precedence, and no rule is inherited" — <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/>), so a second app for `pi.ianpascoe.dev/mcp` could carry the token policy and managed OAuth alone. Not tested, and whether a path app works for the `workers.dev` stages is unknown.
- A secret at rest on the laptop is the cost; fine for a headless/CI case, worse than OAuth for an interactive pi.

## 4. `@cloudflare/workers-oauth-provider`

**Verified** (v1.2.4, 22 Oct 2026; <https://github.com/cloudflare/workers-oauth-provider>, <https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/>)

- Two roles in 1.x: `OAuthAuthorizationServer` (discovery, DCR/CIMD, token, revocation; your `/authorize` page signs the user in, shows consent and calls `completeAuthorization()` with `props`) and `OAuthResourceServer` (wraps the MCP handler, publishes RFC 9728 metadata, 401s without a token, rejects tokens for another resource, validates through a Service Binding). The 0.x/1.0 `OAuthProvider` class that wraps a whole Worker still appears in `agents` docs (`mcp-servers.md`, `securing-mcp-servers.md`).
- Needs an `OAUTH_KV` namespace for grants and tokens, and the `global_fetch_strictly_public` flag for CIMD. Tokens, codes and secrets are stored hashed; `props` are encrypted. Scopes are advertised, not enforced.
- The library does _not_ authenticate the user. The doc's `/authorize` is `const user = { id: "user-123" }` — "replace with your own sign-in".

**Inference**

- Behind Access, the authorization server's `/.well-known/*`, `/oauth/register`, `/oauth/token` and the `/mcp` resource must be reachable by a client with no Access cookie, so they would need a bypass policy or a separate unprotected hostname, and `/authorize` would take the owner's identity from Access (`Cf-Access-Jwt-Assertion`) to auto-complete. That is a second authorization system layered over the first, plus a KV namespace, a Service Binding between two entrypoints (or the older wrapper that takes over the Worker's `default export`, where cloudpid's is an alchemy Effect Worker), and an Access bypass that removes the Worker-edge guard from `/mcp`.
- Worth it only when the server must be reachable by clients that cannot go through Access (claude.ai connectors, other users). cloudpid is a single owner.

## 5. The `agents` package

**Verified** (docs read for `agents` 0.20+ guidance, `apps/browser` has `agents@0.30.1` installed; MCP SDK v2 packages pinned `@modelcontextprotocol/server@2.3.1`)

- `createMcpHandler(factory, options)` from `agents/mcp/server`: a fresh `McpServer` (from `@modelcontextprotocol/server`) per request, Streamable HTTP only, default route `/mcp`, `AsyncLocalStorage` so it needs `nodejs_compat`. It serves the 2026-07-28 stateless protocol and 2025-era clients from one endpoint (`legacy: "stateless"` default; `"reject"` for stateless-only). — <https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>; `apps/browser/node_modules/agents/docs/mcp-servers.md`
- In the legacy lane each POST makes a new server and transport, **GET and DELETE return 405, no `Mcp-Session-Id` exists, and server-pushed elicitation, sampling and roots fail immediately**; no resumability or replay. — handler-api page, _Compatibility with legacy clients_.
- The handler is callable with `(request, env, ctx)` and has `fetch(request, { authInfo, parsedBody })` for composition; the default export must stay a Worker object (a function default export is read as a `WorkerEntrypoint`). `notify.toolsChanged()` etc. are isolate-local. — handler-api page; `docs/mcp-servers.md`.
- Origin/Host checks: the wrapper rejects malformed/opaque browser `Origin`s and defaults to localhost and `workers.dev`; a custom domain needs `allowedHostnames` / `allowedOriginHostnames` (e.g. `pi.ianpascoe.dev`). — handler-api page, _Origin validation and CORS_.
- "State without protocol sessions": data that must survive requests lives in a Durable Object, D1, KV or R2, keyed by the authenticated user, not an MCP session id. A tool may call an Agent/DO by name. — transport page; `docs/mcp-servers.md` (_Keep state in bindings_).
- `McpAgent` (a Durable Object per MCP session, `McpAgent.serve("/mcp")`, hibernation, `props`, `elicitInput`) is "deprecated and feature-frozen"; no removal version. It runs only an SDK **v1** `McpServer` and needs a staged migration if you use sessions. — <https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/>; JSDoc `@deprecated` in `agents/dist/agent-routing-CDbpVjYq.d.ts:1297-1303`. Cloudflare's own migration table sends `McpAgent` without stateful features straight to `createMcpHandler`.
- A long stream is cut by the edge's roughly 5-minute idle-stream watchdog; `McpAgent` kept streams alive with keepalives (25 s on GET, always on POST). The stateless handler has `keepAliveMs` (15 s) for listen streams only. — agent-api page, _Stream resumability_; handler-api options table.

**Inference**

- `createMcpHandler` slots into the Effect `fetch` as one more route (call `handler.fetch(request, { authInfo })` with the request the Effect layer holds, then return the `Response`), after the `ctx.access` check. Worker `access` does not need the library's `OAuthProvider`.
- Using `agents` only for `createMcpHandler` adds a dependency that today only `apps/browser` has; `@modelcontextprotocol/server` v2 itself is web-standard, so the handler could also be used without `agents` (not checked).

## 6. Must the server hold state per MCP session?

**No.**

- 2025-11-25: a session id is optional — "A server using the Streamable HTTP transport **MAY** assign a session ID"; a client must echo one only if given; the server may answer `405` to `DELETE`. — <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports> (_Session Management_)
- 2026-07-28 (now the **current** revision per <https://modelcontextprotocol.io/specification/versioning>): protocol-level sessions and `Mcp-Session-Id` are removed; `initialize` is removed (each request carries its version and capabilities in `_meta`); `server/discover` is mandatory; servers that need cross-call state use explicit, server-minted handles passed as tool arguments; server-initiated requests (`roots/list`, `sampling/createMessage`, `elicitation/create`) become multi-round-trip `input_required` results; GET and `resources/subscribe` are replaced by `subscriptions/listen`; SSE resumption is removed. — <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- pi's client still speaks **2025-11-25** (`LATEST_PROTOCOL_VERSION`, `.repos/pi/packages/mcp/src/protocol/types.ts:4-9`), tolerates a missing session id (`streamable-http.ts:335`) and a `405` on the GET stream (`:457-465`), so a stateless server on the legacy lane serves it. Claude Code's protocol version was not checked.
- Cloudflare's MCP portals already speak 2026-07-28 and 2025 Streamable HTTP with per-request selection, so the ecosystem handles both. — <https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/> (_Transport_).

**Implications for the server's design (not designing it here)**

- Durable state belongs in cloudpid's own objects (Session/Registry DOs), reached by a handle the tool call carries (a Session id), not by an MCP session.
- On the legacy lane the server cannot ask the client questions (sampling, elicitation, roots); on 2026-07-28 it asks by `input_required` retry. A handoff that needs the laptop's answers must use that, or tool arguments.
- A long-running tool call is one HTTP response and is subject to Access's/edge idle and duration limits; a handoff should return a handle fast and be polled, not hold a stream (the ticket for the handoff protocol owns this).

## 7. Which fits a single-owner deployment

| | Managed OAuth (Access) | Service token | `workers-oauth-provider` | `McpAgent` |
| --- | --- | --- | --- | --- |
| Role | Authorization server | Machine credential | Second authorization server | Server class (DO per session) |
| Worker code | none (reads `ctx.access`) | none | `/authorize`, KV, 2 entrypoints or wrapper, bypass | DO + SDK v1 server |
| Infra change | `oauthConfiguration` on a shared `Access.Application` | `ServiceToken` + `non_identity` policy | KV, Access bypass paths, service binding | DO migration |
| Identity at Worker | owner's email | token id only | whatever `/authorize` stores | `props` |
| Secrets to distribute | none | client id + secret per laptop | none | none |
| pi / Claude Code | both support the flow; field reports show it works with Claude Code | both support static headers | both would work | both |
| Fit | **primary** | fallback / headless | overbuilt | deprecated |

Verdict, as a leading position for the spec ticket rather than a design: managed OAuth on the existing Access app, a service token as the headless fallback, and a stateless `createMcpHandler` route; skip the provider library and `McpAgent`.

## 8. Open unknowns (suggested spike)

1. **End to end with pi and Claude Code.** Turn managed OAuth on for a preview stage and run `pi mcp login` / `claude mcp add --transport http` against `/mcp`. Check: the 401 carries a `Bearer` challenge pi parses; `registration_endpoint` is present (the team-level metadata fetched today has none, with managed OAuth off); DCR accepts `127.0.0.1`/`localhost` redirects; both clients send `resource`; refresh works after the access token lapses.
2. **Does managed OAuth work on a Worker-destination Access app** (what the `access` prop makes), on `workers.dev` stages as well as the custom domain? If not, a `self_hosted` app with `domain` for the path or host is needed.
3. **Path scoping.** Whether a second app at `pi.ianpascoe.dev/mcp` takes precedence for managed OAuth and a service-token policy, leaving the browser app alone; and whether an OAuth token bound to one `resource` is rejected on other paths.
4. **Coexistence** of an owner-email `allow` policy, a `Service Auth` policy and managed OAuth on one app (documented separately, not together).
5. **alchemy**: how the stack passes a shared `Cloudflare.Access.Application` to the Worker's `access` while keeping `preview_worker` destinations, and the effect on the `dev_$USER` stage ("alchemy dev … deletes its Access app", `docs/development/infra.md:14`).
6. **Header and body limits through Access** for a large handoff payload were not researched.
7. **`ctx.access` on non-Access paths**: `undefined` means the request did not pass Access; the server should refuse `/mcp` then (relevant to local `alchemy dev`, which has no Access).
8. Claude Code's negotiated protocol version against a `createMcpHandler` endpoint (stateless 2026-07-28 vs legacy lane) was not checked.
