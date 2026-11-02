# MCP: signing in

An MCP sign-in is how cloudpid reaches a remote MCP server that wants OAuth. It belongs to one MCP server, is kept Global in the Registry, and only the owner makes one ([ADR-0034](../adr/0034-an-mcp-sign-in-belongs-to-one-mcp-server-is-kept-global-in-the-registry-and-only-the-owner-makes-one.md)). cloudpid names itself to authorization servers with a public client document, and their answers come back on a public callback outside Access ([ADR-0035](../adr/0035-cloudpid-identifies-itself-with-a-public-client-document-and-takes-authorization-responses-outside-access.md)). The design is the same in both Protocol eras: a 401 at `server/discover` counts the same as one at `initialize` ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D22). Exhaustive detail is in [Signing in to remote MCP servers](https://github.com/ian-pascoe/cloudpid/issues/390), amended by [Verify MCP sign-in on a deployed stage](https://github.com/ian-pascoe/cloudpid/issues/403) and [Whether workers.dev stages serve the client document](https://github.com/ian-pascoe/cloudpid/issues/422). None of this applies to cloudpid's own MCP endpoint, which Access managed OAuth signs in (see [_Access and identity_](mcp-endpoint.md#access-and-identity)). Its paths stay outside `/oauth/mcp/*` and outside the bypass application.

## MCP sign-ins

- **Which servers:** OAuth applies only to HTTP entries without an `Authorization` header, and only after a 401. A stdio entry with `oauth`, or one that also has an `Authorization` header, is refused in Settings and skipped in a Repo file. There is no `oauth: false`. A 401 on an entry that has an `Authorization` header makes it `failed`, never `sign_in`.
- **Key:** a sign-in is keyed by (source, normalized name, URL):
  - source is `owner` (Global or any Environment's own entry) or `repo:<owner/repo>`;
  - the name is spelled as the `mcp__<server>` part (see [_Tool names_](mcp-in-a-session.md#tool-names));
  - the URL is `new URL(url).href` without its fragment.

  Sign-ins are kept Global, per stage. `sentry-work` and `sentry-personal` on one URL are two accounts. A rename, a URL change or the owner's copy of a Repo entry needs a new sign-in, and the old one is listed as unused. There is no rename tool, so a sign-in never follows a new name without the owner's yes ([The agent's changes to MCP servers](https://github.com/ian-pascoe/cloudpid/issues/391) D1.4). Keeping a sign-in across a rename is left for later. A Repo's server never uses the owner's sign-in. The owner may sign it in separately, and every Environment holding that Repo shares the result. An OAuth token is not a Secret: ADR-0029's rule is met by the source in the key and by the resource binding (below).

- **What a sign-in row holds** (`mcp_sign_ins`):
  - status, and the issuer, authorization server metadata and discovery recorded at sign-in;
  - `resource`;
  - the client: `client_id`, a kind (`configured` | `document` | `registered` | `client_grant`), and the secret or key as a `{scope, name}` reference, never a copy;
  - granted scope and `expires_at`;
  - step-up state (wanted scope, count) and the last challenge;
  - the last error (≤300 chars) and its time;
  - created, refreshed and used times;
  - sealed `{access_token, refresh_token?}`.
- **Client registrations** (`mcp_client_registrations`, from DCR) are keyed by (issuer, redirect URI, `client_name`) and shared by every sign-in at that issuer. Each holds `client_id`, a sealed `client_secret` and `client_secret_expires_at`. A registration within 5 min of expiry is replaced at the next start.
- **Client bindings** (`mcp_client_bindings`): (sign-in key, configured `clientId`) → issuer (SEP-2352). They survive Sign out and are dropped once no MCP server set names that pair.
- **Storage:** five Registry tables in one migration: `mcp_sign_ins`, `mcp_client_registrations`, `mcp_client_bindings`, `mcp_pending_sign_ins` and `mcp_sign_in_waiters`.
  - Sealing is AES-GCM under a key HKDF derives from `SECRETS_ENCRYPTION_KEY` for the purpose `mcp-oauth`, with each row bound to its table and key.
  - A pending row stores only the SHA-256 of `state`.
- **Bounds:**
  - Sign-ins: 200. At the limit the least recently used row without tokens is evicted; if there is none, the new one is refused with a message naming Global's MCP servers page.
  - Registrations: 100. Bindings: 200. Unreferenced rows are evicted, otherwise the new one is refused.
  - Pending rows: 20, dropping the oldest.
  - Waiters: 100, then refused; each expires after 30 days.
  - Each token ≤16 KiB, a token response ≤64 KiB, recorded metadata ≤64 KiB.
- **A malformed `SECRETS_ENCRYPTION_KEY`:** rows are kept unopened, token requests answer `unavailable`, and starts are refused with the reason in Settings. A row that does not open under a well-formed key counts as `required`.
- **Lifetime:** deleting an Environment leaves its sign-ins in the Registry, listed as unused, and so does removing an entry. A Repo's sign-in is listed under that Repo.

## Tokens reach the host object

- **Only the Registry holds tokens at rest, and only it refreshes them.** `McpHost` calls `mcpAccessToken({ environment, server, stale? })` before it connects to an OAuth-capable HTTP server. The Registry works out the key from that Environment's own set. The answer is either:
  - `{ status: "ok", token, expiresAt, resource }`, or
  - `{ status: "required" | "step_up" | "rejected" | "refresh_failing" | "unavailable", reason, scope? }`.

  On `required` or `unavailable`, the server's MCP inventory entry becomes `sign_in` or `unavailable` with no tools, and no network call is made. The engine's `auth(stale)` hook asks the host, which asks the Registry, and the transport gets only an `AuthProvider` over that answer. The SDK's own OAuth is never used ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D6).

- **The host's cache** is in memory only. It holds a token until `exp − 60 s`, or for 15 min when there is no expiry. It drops the token on a 401, on eviction, or on `apply({ kind: "sign_ins" })`.
- **Resource binding:** a token is attached only to requests that are same-origin with, and within the path of, the sign-in's `resource`. That is the protected resource metadata's resource (through `selectResource`), else the entry's URL.
  - Authorized requests use `redirect: "manual"`, so a redirect outside the resource fails without the token.
  - The host replaces the exact token it sent with `[REDACTED]` in that call's result.
  - Tokens never enter a Session, a Workspace DO or a Container.
- **Reports and pushes:**
  - On transitions only, the host calls `reportMcpAuth({ environment, server, event: "needs_sign_in" | "step_up" | "rejected" | "working", challenge?: { resourceMetadataUrl?, scope?, error?, errorDescription? } })`.
  - The Registry never calls out. When a callback completes, or after a sign-out or a rebind, the main Worker takes the change from the Registry's answer and passes it to each host using the sign-in as `apply({ kind: "sign_ins", … })` ([The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382) D6.3, which replaces the Registry's `mcpSignInsChanged` push of [Signing in](https://github.com/ian-pascoe/cloudpid/issues/390) D4.4). It carries that push's `{ servers, change: "signed_in" | "signed_out" | "replaced" | "rebound" }`; left to implementation: the exact field layout inside `apply`.
  - A lost push heals at the next `windowOpened`, whose `mcpServerSet` answer carries `signInsRevision`.
  - `signed_in`, `replaced` and `rebound` make the host rediscover its `sign_in` and `rejected` HTTP servers at once, never waking a Container. The host's 401/403 handling is in [_Requests and Legacy sessions_](mcp-connections.md#requests-and-legacy-sessions), its discovery states and backoff in [_Discovery and the MCP inventory_](mcp-connections.md#discovery-and-the-mcp-inventory).
- **The sign-in id:** `McpHost`'s `tasks/*` results carry the MCP sign-in id, so an MCP task's follower can tell "not reachable under the current sign-in" from "expired" ([MCP tasks as durable long-running requests](https://github.com/ian-pascoe/cloudpid/issues/389) D4.3). Left to implementation: the id's form and how it reaches the host (an additive field on `mcpAccessToken`'s `ok` answer is the natural place).
- **Version skew:** host → Registry has no gate. New statuses and fields are additive, with a fallback member read as a generic failure ([Deploys under deferred Durable Object code updates](https://github.com/ian-pascoe/cloudpid/issues/423) D1).
- **Code:** the Registry's and the main Worker's sign-in code imports only `@cloudpid/mcp/oauth` (and `@cloudpid/mcp/types`), neither of which loads the SDK (see [_Packages and objects_](mcp.md#packages-and-objects)). `./oauth` exposes `@earendil-works/pi-mcp/oauth`'s discovery, flow functions, `stepUpScope`, `parseWwwAuthenticate` and errors. It never uses `McpOAuthProvider`, `OAuthCallbackServer` (`node:http`) or `authorizeMcp`, which drops the client and the tokens on `invalid_client`.
  - cloudpid implements pi-mcp's `OAuthClientProvider` over the Registry.
  - cloudpid's own additions live in `./oauth` too: RFC 7009 revocation, the `client_credentials` grant, `private_key_jwt`, `client_secret_expires_at` and the issuer-pin check. They go to pi as an issue first ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D6).
  - Every OAuth fetch goes through `guardedFetch` with a 15 s timeout.

## The `oauth` fields

`mcp.servers.<name>.oauth` holds the fields below ([Signing in](https://github.com/ian-pascoe/cloudpid/issues/390) D3). Unknown keys follow [_Entries_](mcp-configuration.md#entries), and pi ignores the keys only cloudpid reads.

- `clientId`: 1–256 printable characters, no whitespace.
- `clientSecret`: needs `clientId`. In Settings it is exactly one `${NAME}`, resolved from Secrets then Variables; a literal is refused.
- `privateKey`: a `${NAME}` holding a PKCS#8 PEM. Only for `client_credentials`, and not together with `clientSecret`.
- `keyId`: 1–256 characters.
- `scope`: ≤64 tokens, ≤1 KiB. The scope requested is configured ∪ challenged, else the protected resource metadata's `scopes_supported`. `offline_access` is added when the authorization server lists it.
- `clientName`: 1–100 characters, DCR only.
- `clientRegistration`: `auto` (default) | `cimd` | `dcr`. `cimd` together with `clientId` or `clientName` is refused.
- `authServerMetadataUrl`: https, ≤2,048, fetched through `guardedFetch`. It pins the authorization server.
- `issuer`: https, no query or fragment, ≤2,048. It pins the issuer, compared after trimming one trailing `/`.
- `grantType`: `authorization_code` (default) | `client_credentials`.
- `callbackPort` and `callbackUrl`: accepted and ignored. `@cloudpid/config` gives a hint that the key is ignored (`mcpEntryHints`); the Settings page, which knows the stage's app origin, adds cloudpid's redirect URI where it shows the hint.
- **A Repo's `.pi/mcp.json`:** every field is allowed. `${NAME}` resolves Variables only, and naming a Secret skips the entry (ADR-0029). A literal `clientSecret` or `privateKey` is accepted, since the file is public already.
- **The agent:** any change to `oauth` is a change to an MCP server definition and needs the owner's Approval. `clientSecret` and `privateKey` are accepted only as `${NAME}` (see [_The agent's changes_](mcp-configuration.md#the-agents-changes)).

## Client registration

- **The ladder,** run at each start ([Signing in](https://github.com/ian-pascoe/cloudpid/issues/390) D2.1):
  1. **A configured `clientId`.**
  2. **The client document**, used when all of these hold:
     - the stage's `MCP_CLIENT_DOCUMENT` is on;
     - `clientRegistration` ≠ `dcr`;
     - the authorization server advertises `client_id_metadata_document_supported`, `none` auth and `authorization_response_iss_parameter_supported`.
  3. **DCR**, with `application_type` as pi-mcp sets it. An authorization server that does not advertise `iss` gets the redirect URI `/oauth/mcp/callback/<12-char hash of the issuer>`.
  4. **A problem** naming the redirect URI to register. A DCR refusal shows its status, ≤300 chars of its body, and "may accept only clients it knows".

  With `clientRegistration: "cimd"`, a server that doesn't support the document is a problem.

- **Client name:**
  - `cloudpid` on prod;
  - `cloudpid (<label>)` on other deployed stages;
  - `cloudpid (<label>, local)` under `alchemy dev`.

  It applies to the document and to DCR's `client_name`. Off prod, a configured `clientName` gets the suffix too. The suffix is never cut: past 100 characters, the configured part is shortened at a code-point boundary ([Whether workers.dev stages serve the client document](https://github.com/ian-pascoe/cloudpid/issues/422) D3).

- **Issuer binding** (SEP-2352):
  - A configured client with a pin (`oauth.issuer`, or the document at `authServerMetadataUrl`) refuses a mismatched issuer.
  - An unpinned client's first binding, and any change of its issuer, goes through an interstitial on `/oauth/mcp/start`. The page shows:
    - the server, its source and URL;
    - the issuer URL and the client id;
    - the secret's `${NAME}` and where it resolves, never a value.

    Continue is a `POST` with an `Origin` check and a one-time field. Cancel deletes the pending row. A rebind drops the old issuer's tokens.

  - For document and DCR clients, a change of issuer makes the sign-in `required` ("now signs in at B (was A)").
  - A refresh goes only to the token endpoint recorded at sign-in. Discovery runs again only at a start.
- **GitHub and Figma:**
  - GitHub offers neither DCR nor the document, so it signs in through a configured client. The recipe:
    1. Create the owner's own GitHub App, "cloudpid MCP", with prod's callback `https://pi.ianpascoe.dev/oauth/mcp/callback`. A GitHub App takes up to 10 callbacks, so in practice prod only.
    2. Configure the entry with `oauth: { clientId: "<app client id>", clientSecret: "${GITHUB_MCP_CLIENT_SECRET}" }` (any Secret name).
    3. Confirm the issuer once on the interstitial.

    Alternatively, put a PAT in `headers` (`Authorization: "Bearer ${NAME}"`). [ADR-0025](../adr/0025-github-access-through-a-github-app.md) still stands for cloudpid's own GitHub access.

  - Figma admits only catalog clients. It gets the DCR problem of step 4, and nothing else is done for it.

## The client document and the callback outside Access

- **Routes on the main Worker:**
  - `GET /oauth/mcp/client.json` and `GET /oauth/mcp/callback[/<id>]` are public on every deployed stage.
  - `GET`/`POST /oauth/mcp/start` stays behind Access.
- **Origin:** `https://pi.ianpascoe.dev` on prod and `appOrigin(stage)` elsewhere (`https://cloudpid-server-<label>.ian-g-pascoe.workers.dev`, from `apps/server/src/deployment.ts`; see [_The App sandbox_](mcp-apps.md#the-app-sandbox) for the fixed names). The Worker gets it as a deploy-time var and never takes it from `Host`.
- **The document:**

  | Field                        | Value                                     |
  | ---------------------------- | ----------------------------------------- |
  | `client_id`                  | its own URL                               |
  | `client_name`                | the stage's client name                   |
  | `redirect_uris`              | `[<origin>/oauth/mcp/callback]`           |
  | `grant_types`                | `["authorization_code", "refresh_token"]` |
  | `response_types`             | `["code"]`                                |
  | `token_endpoint_auth_method` | `"none"`                                  |
  | `application_type`           | `"web"`                                   |

  It is served with `Cache-Control: public, max-age=3600`. Authorization servers fetch it at the first sign-in and cache it: Sentry and Linear never refetched it, at later sign-ins or at refreshes. So keep it stable. A change takes up to an hour to reach them, and changing its URL voids every sign-in that uses the document client. The route records each fetch as span attributes (user agent, `request.cf.asn`, status), with no cookies and no query, so "never fetched" can be told apart from "fetched and got a 200".

- **The Access bypass:** each stage declares a `self_hosted` `Cloudflare.Access.Application` with exactly two `public` destinations, `<origin>/oauth/mcp/client.json` and `<origin>/oauth/mcp/callback`, and one Bypass/Everyone policy. A path-scoped application takes precedence over the Worker's own.
  - It is declared only while the main Worker is live, by the same provider-mode test alchemy uses for the Worker's Access application, whatever `MCP_CLIENT_DOCUMENT` says, because the public callback serves DCR too.
  - Neither CI token needs a new permission.
  - The preview destroy job's leftover check also deletes Access applications whose destinations are all on `cloudpid-server-pr-<n>.<subdomain>.workers.dev`, and fails only if a delete fails. A leftover is otherwise harmless: on a host with no script it reaches no Worker.
  - **Leftovers are adopted** ([Whether workers.dev stages serve the client document](https://github.com/ian-pascoe/cloudpid/issues/422) D6.2, checked on a preview): Cloudflare refuses a second application with the same destinations (409, `application_already_exists`) and echoes the first destination as the application's `domain`. So the bypass declares `domain` as its first destination (`<origin host>/oauth/mcp/client.json`) with `adopt: true`, and alchemy takes a leftover over instead of the deploy failing.
- **Bots and WAF:** no Skip rule. Nothing challenged cookieless datacenter fetches of the document, Sentry's and Linear's included, with Bot Fight Mode off ([Verify MCP sign-in on a deployed stage](https://github.com/ian-pascoe/cloudpid/issues/403), answer 1). A challenge found later gets a host+path Skip rule ([Signing in](https://github.com/ian-pascoe/cloudpid/issues/390) D2.7).
- **`MCP_CLIENT_DOCUMENT`:** set by `deployment(stage, { dev })`. It is on for every live deployed stage and off under `alchemy dev`. Turning it off removes the document from the ladder for new sign-ins only; the route keeps serving. It exists as the way out if an authorization server refuses `workers.dev` clients. The other way out is an entry's `clientRegistration: "dcr"`.
- **A refused document client:** an authorization server shows the refusal only on its own page; RFC 6749 §4.1.2.1 forbids redirecting back. So when a document-client sign-in expires without a callback, the Settings row says: "If <AS host> showed an error about the client, set Client registration to DCR."
- **The Access guard** ([Whether workers.dev stages serve the client document](https://github.com/ian-pascoe/cloudpid/issues/422) D9). It lands first, before the bypass, as its own slice. Access lets through more than the two named paths (any sub-path, any capitalisation, doubled slashes), so the Worker doesn't trust that Access ran:
  - **The exact public paths** are `/oauth/mcp/client.json`, `/oauth/mcp/callback` and `/oauth/mcp/callback/<12-char hash>`, matched case-sensitively. They skip the check and never read identity. Every other form under those two prefixes gets a 404 before the guard and ahead of the single-page app's fallback, asset serving, and any case-insensitive or `%2f`-decoding router. The router is a pure function (`apps/server/src/sign-in-routes.ts`) that reads the path as it was sent: it treats a path as under a prefix after decoding escapes, applying `;` path parameters and dot segments, collapsing slashes and lowercasing, so it refuses more than it serves. Until the sign-in slice ([Start and complete MCP sign-ins with the client document](https://github.com/ian-pascoe/cloudpid/issues/450)) serves them, the two exact paths answer 404 too.
  - **Every other route** (`/`, assets, `/rpc`, the socket, attachments, `/oauth/mcp/start`) needs a valid `Cf-Access-Jwt-Assertion`. The Worker checks it against the `spirit-led-software` team's keys: issuer, signature, `exp`, `nbf`, and an `aud` equal to the Worker's own application's. The `email` must be `OWNER_EMAIL`, with no `common_name`. Anything else gets a 403, and the guard fails closed. `/mcp` takes its own audience (see [_Access and identity_](mcp-endpoint.md#access-and-identity)).
  - The audiences arrive as deploy-time vars from alchemy outputs (`CLOUDPID_ACCESS_AUD` for the main application's; see `docs/development/infra.md` → Stages and Access). The Worker and its own application's `aud` form a cycle in alchemy's graph, which the engine settles through the Worker's precreate stub, so main routes check the audience. A deployed Worker missing them refuses every guarded route. A `fetch` through a service binding carries no assertion and is refused; internal callers use RPC entrypoints.
  - Under `alchemy dev`, a request counts as the owner only when both hold:
    - the Worker was built in local mode, a var only the stack's local branch sets;
    - the host is loopback.

    A test asserts that the live `deployment()` output lacks that var.
- **`alchemy dev`:**
  - No Access, no bypass application, and the document route answers 404.
  - DCR registers `http://localhost:<port>/oauth/mcp/callback` with `application_type: native`.
  - There are two app origins, `http://localhost:1337` (workerd) and `http://localhost:5173` (Vite with `strictPort`, which proxies all of `/oauth/mcp/`). The Worker accepts a request's origin only from that set (from `Host`, or Vite's forwarded host if Vite rewrites `Host`: checked during implementation), and the redirect URI follows the origin the sign-in started on. That makes two DCR registrations per authorization server in dev.
- **Stage lifecycle:**
  - A preview's destroy doesn't revoke its grants at the authorization servers. They stay listed under its client name for the owner to revoke.
  - `alchemy dev --stage dev_$USER` deletes the stage's deployed Durable Objects, MCP sign-ins included. The redeploy comes back on the same URL and the same document client, and the owner signs in again.

## Starting and completing a sign-in

- **Where it starts:**
  - the "MCP servers" rows in Settings, at every Scope, Repo rows included;
  - a Sign-in request's card;
  - links wherever a sign-in state already shows: an App View call's error, the prompt catalog's `sign_in` state, completion's "Sign in to …" and `MCP_SIGN_IN_REQUIRED`.

  Nothing sends a Notification without an agent's ask (or cloudpid's, for an MCP task).

- **The link:** `<a target="_blank" rel="noopener">` to `/oauth/mcp/start?environment=<id|all>&server=<name>[&session=…&request=…]&return=<path>`. It needs `Sec-Fetch-Site: same-origin`, and it is a link, not an RPC followed by `window.open`, because popup blockers would stop that. The start answers in that tab with a 303 to the authorization page, the issuer interstitial, or an error page.
- **`startMcpSignIn`** (Registry):
  1. Resolves the entry from that Environment's set.
  2. Discovers from the last reported challenge, else the well-known paths.
  3. Picks the client by the ladder and binds it.
  4. Makes a PKCE verifier and a 256-bit `state`.
  5. Writes one pending row per key; a newer start replaces it. The row expires after 10 min and holds:
     - the `state` hash, the key and the Environment;
     - the redirect URI, issuer, metadata and client;
     - the sealed verifier, the scope, the resource and the step-up flag;
     - the requester, the return path and `awaiting_confirmation`.
- **The callback:**
  - A malformed `state` gets a static page, and the Registry is never called.
  - Otherwise the Worker calls `completeMcpSignIn({ state, path, code, iss, error, errorDescription })`, which:
    1. deletes the pending row first;
    2. checks the path, `error` and `iss` (RFC 9207);
    3. exchanges the code through `guardedFetch` (15 s);
    4. seals the tokens and binds a configured client;
    5. returns the hosts to update and the waiting Sign-in requests to resolve.
  - The page is served with `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and a CSP that allows only its own inline script **by hash** (`script-src 'sha256-…'`; Cloudflare's injected scripts copy a nonce). Its first script calls `history.replaceState`.
- **Page outcomes:**
  - signed in, naming the Environments that use the sign-in;
  - expired or already used;
  - replaced by a newer sign-in;
  - missing `state` or `code`;
  - declined at the server's page ("Nothing changed");
  - an authorization server error (its code, and the escaped description ≤300);
  - an `iss` mismatch ("nothing saved");
  - an exchange failure.

  A failure leaves the old tokens as they were. A pending Sign-in request stays open and shows the last failure. Every page says "You can close this tab" and offers Back and Start again. No page ever redirects on its own: on the installed iOS PWA the sign-in opens in an in-app sheet.

- **Learning the outcome:**
  - The page posts on `BroadcastChannel("cloudpid:mcp-sign-in")`.
  - Settings refetches when that message arrives and on focus or `visibilitychange`.
  - Sessions with an open Sign-in request for the key learn of it from whoever completed it, never from the Registry ([The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382) D6.3): the main Worker carries `completeMcpSignIn`'s answer to them, and they resolve the requests and re-send `mcp_sign_in_requests`. Left to implementation: that call's shape. A request's re-check at resume is the backstop.
  - Nothing polls.

## Refresh and step-up

- **When:** a refresh happens when a host asks and the token is at `exp − 60 s`. On a 401 that isn't `insufficient_scope`, the host asks again with `stale` and retries once. No timers.
- **Single-flight:** one refresh at a time per sign-in, behind the Registry's own in-flight guard. A Durable Object's input gate opens on `fetch`, and a second refresh racing with the same rotating refresh token gets `invalid_grant`. Refresh uses pi-mcp's `refreshAuthorization` at the recorded endpoint. If the response has no new refresh token, the old one is kept; the same goes for the scope. `expires_in` is trusted from each response: Sentry's lifetime goes from 3600 s to about 30 days after a refresh.
- **A 401 again with a fresh token:** the status becomes `rejected`, and the challenge's `error` and description are kept. **The tokens are kept**, and that token drives no further 401 refresh. Calls still try the current token, and a `working` report clears the status and resolves open requests.
- **Authorization server answers:**
  - `invalid_grant` or `invalid_scope`: tokens dropped, `required`.
  - `invalid_client` or `unauthorized_client`:
    - a registered client: the registration and the tokens are dropped, `required`;
    - a configured client: the tokens are dropped, `required`, with a problem;
    - a document client: treated as transient.
- **Transient failures:** network errors, the 15 s timeout, 408, 429, 5xx, `server_error`, `temporarily_unavailable`, and a document client's `invalid_client`.
  - One retry after 1 s, then the status becomes `refresh_failing` with the reason.
  - Backoff starts at 10 s and doubles up to 5 min, resetting on success.
  - The tokens are kept, and the access token is used while it is still valid.
  - A refresh once sent is never cancelled. If an eviction loses a rotated refresh token, the owner signs in again.
- **Step-up:**
  - A 403 `insufficient_scope` fails the call at once.
  - The wanted scope becomes granted ∪ challenged ∪ configured, the status `step_up`, and the old tokens keep serving.
  - The step-up is a start with `skipRefresh`, offered on the card and on the Settings row.
  - After 3 completed step-ups re-challenged for the same scope set, `mcp_sign_in_ask` answers `step_up_failed`. A sign-in from Settings resets the count.

## Sign-out

- **From** any server row, or the Sign-ins list. The confirm dialog names the Environments that use the sign-in.
- **Revocation:** RFC 7009 when the server advertises it: the refresh token, then the access token, 5 s each. It is best effort, and a failure is reported. Sign-out deletes the row and its pending row, and keeps the registration and the binding.
- **Effect on the hosts that use it** (`signed_out`):
  - they drop the cached token and close the server's HTTP session and streams;
  - they end its Resource watches ("signed out"), which also happens when a server becomes `required`;
  - calls in flight finish, and the MCP inventory is kept.

  A Modern question waiting on that server fails fast at its resume with the sign-in error ([Elicitation in form and URL modes as durable requests](https://github.com/ian-pascoe/cloudpid/issues/388) D13; see [_The waiting-question record_](mcp-server-requests.md#the-waiting-question-record)).

- **Signing in again or stepping up** replaces the tokens without revocation, because RFC 7009 §2.1 may revoke the whole grant. No account is shown, since there is no standard claim for it; rows show the issuer host, scopes and times.
- **The agent never signs out.** Removing an entry leaves its sign-in, listed as unused.

## Client Credentials

The extension `io.modelcontextprotocol/oauth-client-credentials` ([Signing in](https://github.com/ian-pascoe/cloudpid/issues/390) D8):

- **Configuration:** `grantType: "client_credentials"` needs:
  - `clientId`;
  - a pin: `oauth.issuer` with discovery through the protected resource metadata, or `authServerMetadataUrl` (with both, they must agree);
  - `clientSecret` or `privateKey`.

  It refuses `clientRegistration` and `clientName`.

- **No owner step:** the Registry gets a token on first use and seals it in the sign-in row (kind `client_grant`, no refresh token). It gets a new one at `exp − 60 s`, or once on a 401 after the token's first use.
- **Client authentication:**
  - With a secret: `client_secret_post` if the server lists it, else `client_secret_basic` if listed or if the field is absent, else a problem.
  - With a key: RFC 7523 §2.2. The request carries `grant_type=client_credentials`, `client_assertion_type=…jwt-bearer`, `client_assertion`, `resource` and `scope`, and no `client_id`. The assertion is signed RS256 (RSA ≥2048) or ES256 (P-256), whichever the server lists. Its claims are `iss` = `sub` = the client id, `aud` = the token endpoint as in the metadata, `iat`, `exp` = +60 s and a 128-bit `jti`, with `kid` = `keyId`. Every request gets a fresh assertion.
- **Declared only on such connections:** `_meta` `io.modelcontextprotocol/clientCapabilities.extensions` in `2026-07-28`, and `initialize` `capabilities.extensions` in `2025-11-25`.
- **Failures** make the server `failed` with a problem, never `sign_in`. `mcp_sign_in_ask` answers `not_applicable`, and the row shows "Signs in on its own · <issuer host>", with no Sign in or Sign out.
- **Not built:** Enterprise-Managed Authorization is neither built nor advertised ([Enterprise-Managed Authorization for MCP servers (future version)](https://github.com/ian-pascoe/cloudpid/issues/404)), and neither is `private_key_jwt` for authorization-code clients, which is left for later.

## Sign-in requests

- **What the agent sees:**
  - In `mcp_servers`, a server that needs sign-in and was never discovered shows `- mcp__<server> (needs sign-in): …` in place of `(connecting)`. A server with an inventory keeps its line.
  - The section's intro gains one sentence naming `mcp_sign_in_ask`, and changes arrive as the section's change notice (see [_The prompt cache and the `mcp_servers` section_](mcp-in-a-session.md#the-prompt-cache-and-the-mcp_servers-section)).
- **Calls fail fast:** direct calls, script calls, resource tools and App View calls all fail at once. The `isError` text is "<server> needs the owner to sign in (<why>). Ask with `mcp_sign_in_ask`, or go on without it.", with `details.sign_in { status: "required" | "step_up" | "rejected" | "unavailable", scope? }`.
  - A transient refresh failure says "try again shortly".
  - A subagent's error adds "report it to your parent".
  - `complete()` answers `sign_in`.
- **`mcp_sign_in_ask({ server, reason })`:**
  - **Registration:** it is in the `mcp` extension and registered in its rebuild only when the set has an OAuth-capable HTTP entry. It is deferred, callable by the model only (not from scripts), not named in `deferred_tools`, and root conversation only.
  - **Immediate answers:** `signed_in`, or `not_applicable` (a client grant, an `Authorization` header, stdio).
  - **Otherwise a durable Sign-in request:**
    - The Session sends `mcp_sign_in_requests` to every client.
    - The card shows the server, its source, the URL host, the authorization server's host, the agent's reason marked as the agent's, and any step-up scopes.
    - The owner signs in from the card, or declines with `mcp_sign_in_answer` (an optional reason).
    - There is no deadline, and Stop withdraws the request. It survives eviction and re-checks the sign-in on resume.
    - Parallel asks in one conversation join one request.
  - **Results:**
    - `signed_in`, after `servers` with `waitMs: 10000` (`serverStatus`): "N tools from your next request" or "still connecting";
    - `declined`;
    - `withdrawn`: the server was removed, disabled or hidden;
    - `step_up_failed`.
- **Waiters and Notifications:** each open request is a waiter row in `mcp_sign_in_waiters`. The first open waiter for a key sends one `input` Notification ("Sign-in needed: <server> — <reason>") tagged `mcp-sign-in:<key hash>`; later waiters send none while one is open. A sign-in completed from anywhere, Settings included, resolves every open request for the key. A decline ends only its own request.
- **cloudpid's own asks:** a followed MCP task whose server is `sign_in`, `rejected` or `step_up` pauses polling and raises a Sign-in request "to keep following MCP task …". Polling resumes after the sign-in (see [_MCP tasks_](mcp-server-requests.md#mcp-tasks)).
- **The agent never:**
  - starts, confirms or completes a sign-in, or signs out;
  - sees a URL, code, token, secret or key.

  What `settings_mcp_list` shows of a sign-in, and what a `settings_mcp_*` change that ends at `needs_sign_in` says, are in [_Lists_](mcp-configuration.md#lists) and [_Results_](mcp-configuration.md#results). Approving and signing in on one card is left for later.

- **The MCP endpoint** shows waiting Sign-in requests to a Local agent as `waiting` entries (`kind: sign_in`) with a link, and never answers them (see [_Waiting requests_](mcp-endpoint.md#waiting-requests)).
- **Not sign-ins:** URL-mode elicitation and Legacy `-32042` are the server's own flows and never MCP sign-ins. A server cannot ask for a sign-in through elicitation, and an elicitation URL on cloudpid's own hosts is declined unseen (see [_Elicitation requests_](mcp-server-requests.md#elicitation-requests)).

## Settings

- **Server rows:** in "MCP servers" (`mcp`), every HTTP row at every Scope gets:
  - a state chip: `Signed in · <issuer host>`, `Needs sign-in`, `More access requested`, `Refused its sign-in`, `Can't refresh: …`, `Signs in on its own` or `Can't open sign-ins`;
  - Sign in, Sign in again and Sign out;
  - the last problem.
- **The Add/Edit form** has a "Sign-in (OAuth)" disclosure with [the `oauth` fields](#the-oauth-fields). Next to them it shows the stage's redirect URI with Copy, and the client name that will actually be registered.
- **Sign-ins:** at Global, a second list (`/settings/all/mcp#sign-ins`), not a Settings section of its own. It shows the server, source, URL host, issuer host, kind, status, scopes, times, the Environments that use each sign-in, unused marks, and Sign out.

## Telemetry and redaction

- **Spans:** `mcp.oauth.start`, `.callback`, `.refresh`, `.client_credentials` and `.revoke`. Their attributes are:
  - the server (normalized), the source kind, the issuer host and the client kind;
  - `registered` and `step_up`;
  - the trigger (`expiry` | `401`) and the outcome;
  - the OAuth error **code** and the HTTP status;
  - `rotated`, and the scope list (≤256 chars).

  The document route adds its fetch attributes (above).

- **Never recorded or logged:** tokens, codes, verifiers, `state`, secrets, keys, assertions, authorization URLs and callback queries. `error_description` is kept only on the row. Fetch errors have their URL queries stripped. Accepted: Workers' own invocation logs keep the callback URL, whose single-use code is useless without the verifier.
- **No Session redaction or Snapshot scan** covers MCP tokens, which never reach those objects. The host's exact-token scrub of results is the only filter.

## Testing

- **Unit:** `deployment()`'s table, covering the label, the flag, the client name and the bypass gate. Routing tests cover capitalisation, doubled slashes, sub-paths, `;` and `%2f` under both public prefixes, all answering 404. The guard's audience, email and `common_name` checks, and the local-mode var's absence from the live `deployment()` output, are tested too.
- **Preview check by the implementing agent** (curl from outside), when the bypass lands:
  - the bypass reaches the Worker, `/oauth/mcp/callback/<hash>` included;
  - other forms get a 404;
  - `/` and `/oauth/mcp/start` get a 302 to Access;
  - a cookieless `/rpc` is refused.
- **The owner's deployed check** gates the merge of the first sign-in slice that completes a document sign-in end to end ([Whether workers.dev stages serve the client document](https://github.com/ian-pascoe/cloudpid/issues/422) D7). The owner revokes the test grants afterwards.
  1. A cookieless GET of the document from at least one hosting network returns 200 `application/json`, with `client_id` equal to its own URL.
  2. Sign in and refresh at Sentry, then at Linear.
  3. On a refusal, record the authorization server's page, then retry with `clientRegistration: "dcr"`.
