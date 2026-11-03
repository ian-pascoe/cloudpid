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
  - A pending row stores only the SHA-256 of `state`, and is absent once it is 10 min old (the next put sweeps the expired).
- **Bounds:**
  - Sign-ins: 200. At the limit the least recently used row without tokens is evicted; if there is none, the new one is refused with a message naming Global's MCP servers page.
  - Registrations: 100. Bindings: 200. Unreferenced rows are evicted, otherwise the new one is refused.
  - Pending rows: 20, dropping the oldest.
  - Waiters: 100, then refused; each expires after 30 days.
  - Each token ≤16 KiB, a token response ≤64 KiB, recorded metadata ≤64 KiB (each of a sign-in's metadata and discovery, a pending row's metadata and client, and a registration's response).
- **A malformed `SECRETS_ENCRYPTION_KEY`:** rows are kept unopened, token requests answer `unavailable`, and starts are refused with the reason in Settings. A row that does not open under a well-formed key counts as `required`.
- **Lifetime:** deleting an Environment leaves its sign-ins in the Registry, listed as unused, and so does removing an entry. A Repo's sign-in is listed under that Repo.

## Tokens reach the host object

- **Only the Registry holds tokens at rest, and only it refreshes them.** `McpHost` calls `mcpAccessToken({ environment, server, stale? })` before it connects to an OAuth-capable HTTP server. The Registry works out the key from that Environment's own set. The answer is either:
  - `{ status: "ok", token, expiresAt?, resource, signIn, note? }` while the sign-in holds a token that stands, or
  - `{ status: "required" | "step_up" | "rejected" | "refresh_failing" | "unavailable" | "failed", reason, scope? }` when there is none to hand over. `failed` is the client grant's: the Registry could not get a token on its own, and no sign-in can fix it (an older host reads the unknown status as `unavailable`).

  Which is which:

  - **`ok`:** the row holds tokens and the access token stands: it is more than a minute from `expires_at` (or has none), and is not the one the host just found refused (unless the sign-in is `rejected`, or a step-up whose token was rejected). `expiresAt` is absent when the server gave no lifetime. `resource` is the recorded one, else the entry's URL. `signIn` is the sign-in id (below).
  - **`stale?`:** the access token the host's request just carried and the server refused with a 401 that is not `insufficient_scope`. The Registry takes the token as refused only when it is that very token, so a host asking with an older one is handed the current one. A refused token is refreshed once; a `rejected` sign-in's, or a step-up's whose token was rejected, is not (calls still try it).
  - **`ok` with a `note`:** `note: { status, reason?, scope? }` is added while the row's status is `step_up`, `rejected` or `refresh_failing` (before the token expires), yet its token still stands. `reason` is the last error, when there is one; `scope` is the wanted scope, for `step_up`. The host uses the token and may show the note; `note.status` is a string, so a status this build does not know still reads.
  - **A `status` answer:** `required` when there is no token to serve: no row, or one without tokens (`reason` is its last error, else "Not signed in"), tokens that do not open under a well-formed key, or a token that is expired (or in its last minute, or refused) with no refresh token to ask with. A token that is past its time with none also leaves the row `required` with its tokens dropped, so Settings does not show it as signed in, and the revision rises; one in its last minute is withheld but kept. `unavailable` is a server that is not in the Environment's set or does not sign in, or a malformed `SECRETS_ENCRYPTION_KEY`. `refresh_failing` is a refresh that failed once the token no longer stands. `step_up` and `rejected` stand as a status only when their token does not; while it does they are a `note`.

  On `unavailable`, and on `required` for a server whose entry is already `sign_in` or `rejected`, the server's MCP inventory entry becomes (or stays) `unavailable` or `sign_in` with no tools, and no network call is made. A `required` for any other server connects without a token, since `required` is also what a server that needs no sign-in gets (below, _The host's use of the answers_); a 401 then makes it `sign_in`. The engine's `auth(stale)` hook asks the host, which asks the Registry, and the transport gets only an `AuthProvider` over that answer. The SDK's own OAuth is never used ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D6). A background discovery has no `auth` hook, since a function stub lives only as long as the invocation that made it and the discovery outlives it ([_Discovery and the MCP inventory_](mcp-connections.md#discovery-and-the-mcp-inventory)): the host asks `mcpAccessToken` itself and passes the token with the call's target, and a token the server refuses gets one more engine call, with a token asked for with `stale`.

- **The host's cache** is in memory only. It holds a token until `exp − 60 s`, or for 15 min when there is no expiry. It drops the token on a 401, on eviction, or on `apply({ kind: "sign_ins" })`.
- **Resource binding:** a token is attached only to requests that are same-origin with, and within the path of, the sign-in's `resource`. That is the protected resource metadata's resource (through `selectResource`), else the entry's URL.
  - Authorized requests use `redirect: "manual"`, so a redirect outside the resource fails without the token.
  - The engine replaces every token the host gave it for a call, through its `auth` hook or in the target's `headers`, with `[REDACTED]` in that call's result, before the result leaves it ([_The engine_](mcp-connections.md#the-engine)).
  - Tokens never enter a Session, a Workspace DO or a Container.
- **Reports and pushes:**
  - On transitions only, the host calls `reportMcpAuth({ environment, server, event: "needs_sign_in" | "step_up" | "rejected" | "working", challenge?: { resourceMetadataUrl?, scope?, error?, errorDescription? } })`.
  - What each event does: `needs_sign_in` remembers the challenge on a row with no tokens, so a start discovers from it; `step_up` sets the status `step_up` and the wanted scope; `rejected` sets `rejected` with the challenge's error and description, the tokens kept; `working` clears the status and resolves the open Sign-in requests of the key. A pending step-up is left as it is by `working` and `rejected`: calls that work with the old scope do not answer it.
  - The answer is `{ status: "recorded", resolved: [{ session, request }] }`, where `resolved` lists the Sign-in requests a `working` report resolved (none for any other event), or `{ status: "ignored", reason }` for a server that is not in the set or does not sign in, a `step_up` or `rejected` with no sign-in holding tokens, a `needs_sign_in` the store has no room for, or an event this build does not know. `McpAuthEvent` has a fallback member (a string), so a newer host's event is ignored rather than failing at decode.
  - The Registry never calls out to a host. **As built (#454):** when a callback completes, the main Worker takes the change from the Registry's answer and passes it to the host of each Environment that uses the sign-in (`mcp/sign-in-carry.ts`, called from `serveCallback` before the page answers), as `apply({ kind: "sign_ins", change, servers, revision })` ([The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382) D6.3, which replaces the Registry's `mcpSignInsChanged` push of [Signing in](https://github.com/ian-pascoe/cloudpid/issues/390) D4.4).
    - `change` is `"signed_in" | "signed_out" | "replaced" | "rebound"` (a string this build does not know still reads), `servers` the names the sign-in's server goes by in that Environment's set (the host compares them normalized, as the sign-in key does), and `revision` the sign-ins revision the change raised the counter to. The host answers `SignInsTaken { servers }`, the names of the set's servers it reached.
    - The host drops the cached tokens of those servers, keeps the change's revision only when it is exactly the held one plus one (so its next pull does not act on the same change twice, and a push that skips one never hides a lost push: the revision stays, and the pull finds the gap), and for `signed_in`, `replaced` and `rebound` starts a `sign_in` discovery of each of those servers that is not working at once (the set is below). A discovery of such a server that is running was asked for with the token of before: it is interrupted first, as a reload does, the server reads as it did before it started, and the discovery starts again. `signed_out` also drops the servers' discovered sessions and rediscovers nothing.
    - A carry never fails what caused it, and waits at most 5 s for a host before the page answers: a host that is not reached in time, or that does not take the change, is logged (the Environment and the result's tag, never a token) and heals below. Only completion is carried so far: every completed callback is carried as `signed_in` (a replaced or rebound sign-in makes the host do the same), and the sign-out and rebind carriers come with their Registry methods ([#459](https://github.com/ian-pascoe/cloudpid/issues/459), [#469](https://github.com/ian-pascoe/cloudpid/issues/469)) through the same `mcpSignInCarry.carry`. Sign-in requests, which wake a Session on the answer, are [#470](https://github.com/ian-pascoe/cloudpid/issues/470)'s.
  - **The host's use of the answers (`mcp/tokens.ts`, `mcp/discovery-auth.ts`):**
    - `McpTokens` asks `mcpAccessToken` and keeps the token in memory per server, as the cache above says; it hands a token only to a URL within the sign-in's `resource` (anything else is `unavailable` and the token is dropped), and an unreachable Registry makes the server `unavailable`.
    - A discovery passes the token in the call's target `headers` as `Authorization: Bearer …`, since a background call has no `auth` hook. A 401 from the server drops that token and asks again with it as `stale`; the engine call is retried once, and only with a token that is not the one refused. A second 401 reports `rejected` and the server's state is `rejected`; a 401 with no token reports `needs_sign_in`, and a 403 `insufficient_scope` reports `step_up` with the wanted scope. **Only a change of the Registry's own status is reported.** A `rejected` is not sent when the Registry's note on the token says `rejected` (the host's own state is no test: a lost report, or a new sign-in refused again, leaves the Registry at `ok`, and the next discovery tells it), a `needs_sign_in` is sent only for a server not waiting for a sign-in already (one at `sign_in` or `rejected` is not asked), a `step_up` not when the note already names the step-up with every scope the challenge asks for, and a `working` only when the previous state was `sign_in` or `rejected`, or the token's note said `rejected`. A note of `refresh_failing` is not answered with `working`: the server works on a token that still stands while the refresh fails, and only a refresh that succeeds clears the status. Each report carries the challenge of the 401 or 403's `WWW-Authenticate` (`resource_metadata`, `scope`, `error`, `error_description`): the core reads it from the response (`SignInRequired` and `StepUpRequired` carry it as `challenge`, gain-only) and the host passes it on.
    - What the Registry's answer makes of the state, with no network call: `step_up` makes `sign_in` (the token that stood is gone), `rejected` makes `rejected`, `refresh_failing` makes `unavailable` ("Can't refresh the sign-in: …"), `unavailable` makes `unavailable`, and `required` leaves a server that is `sign_in` or `rejected` as it is. **`required` for any other server connects without a token:** a public server that signs nobody in has no sign-in, and blocking it would break it; a 401 then reports `needs_sign_in`, and the server becomes `sign_in`.
    - An entry that sets its own `Authorization` header is left alone: no token is added and no report is made.
    - The request path's `auth(stale)` hook is `engineAuth(tokens, server)`. **As built ([#452](https://github.com/ian-pascoe/cloudpid/issues/452), `requestAccess` in `mcp/discovery-auth.ts`):** `McpHost.request` asks `McpTokens` first, by the same rules: with no token that stands (`step_up`, `rejected`, `refresh_failing`, `unavailable`, or `required` for a server at `sign_in` or `rejected`) the call is not sent, and answers `SignInRequired` or `Unreachable` with the reason; `required` for any other server calls without a token and passes no `auth` hook, and a 401 reports `needs_sign_in`; with a token, the engine gets the hook, never the token in the target, and its connection asks it again with `stale` after a 401 and retries once (`engineAuth` tells the Registry which token was refused). A 401 after that reports `rejected` unless the note on the token it was handed says `rejected`; a 403 for more scope reports `step_up` unless the note names it; a call that works on a token noted `rejected` reports `working`. An entry with its own `Authorization` header gets no hook and makes no report. A request leaves the server's state as it was (the next discovery records the sign-in's state), and a refused `tools/call` never ran, so the retry sends it once more.
  - A lost push heals at the next `windowOpened`, whose `mcpServerSet` answer carries `signInsRevision`; when it differs from the revision the host holds (whatever the set's own revision did), the host drops all its cached tokens and rediscovers the servers that are at `sign_in` or `rejected`, the ones waiting for a sign-in (an `unavailable` or `failed` server is not asked: the change is not known to concern it, and its own retry comes in its time); the Registry's `signInsRevision() → number` answers the same counter alone. It rises with a sign-in, a sign-out, a rebind and a drop of tokens, and with nothing else: a report, a refresh, a first binding and a registration leave it.
  - `signed_in`, `replaced` and `rebound` make the host rediscover the HTTP servers the push names that are not working at once, never waking a Container: those at `sign_in`, `rejected`, `unavailable` or `not_discovered` (a first discovery that was running), and `failed` or `unknown` ones a minute after their last try (the `sign_in` trigger, which also skips a backoff's hold, since the change may be what the server waited for). The host's 401/403 handling is in [_Requests and Legacy sessions_](mcp-connections.md#requests-and-legacy-sessions), its discovery states and backoff in [_Discovery and the MCP inventory_](mcp-connections.md#discovery-and-the-mcp-inventory).
- **The sign-in id:** `McpHost`'s `tasks/*` results carry the MCP sign-in id, so an MCP task's follower can tell "not reachable under the current sign-in" from "expired" ([MCP tasks as durable long-running requests](https://github.com/ian-pascoe/cloudpid/issues/389) D4.3). The id is `signIn` on `mcpAccessToken`'s `ok` answer: the row's grant id, a UUID that is new with each completed sign-in or step-up and the same through refreshes.
- **Version skew:** host → Registry has no gate. New statuses and fields are additive, with a fallback member read as a generic failure ([Deploys under deferred Durable Object code updates](https://github.com/ian-pascoe/cloudpid/issues/423) D1).
- **Code:** the Registry's and the main Worker's sign-in code imports only `@cloudpid/mcp/oauth` (and `@cloudpid/mcp/types`), neither of which loads the SDK (see [_Packages and objects_](mcp.md#packages-and-objects)). `./oauth` names `@earendil-works/pi-mcp/oauth`'s exports one by one (discovery, flow functions, `stepUpScope`, `parseWwwAuthenticate`, errors and types) and holds the size bounds (a token 16 KiB, recorded metadata 64 KiB, which a reader of a token response applies as its 64 KiB limit); a bundle test keeps the SDK, pi-mcp's callback server and provider, and `node:http` out of it. It never uses `McpOAuthProvider`, `OAuthCallbackServer` (`node:http`) or `authorizeMcp`, which drops the client and the tokens on `invalid_client`.
  - cloudpid implements pi-mcp's `OAuthClientProvider` over the Registry.
  - cloudpid's own additions live in `./oauth` too: RFC 7009 revocation, the `client_credentials` grant, `private_key_jwt`, `client_secret_expires_at` and the issuer-pin check. They go to pi as an issue first ([The MCP core](https://github.com/ian-pascoe/cloudpid/issues/394) D6).
  - Every OAuth fetch goes through `guardedFetch` with a 15 s timeout.

## The `oauth` fields

`mcp.servers.<name>.oauth` holds the fields below ([Signing in](https://github.com/ian-pascoe/cloudpid/issues/390) D3). Unknown keys follow [_Entries_](mcp-configuration.md#entries), and pi ignores the keys only cloudpid reads.

- `clientId`: 1–256 printable characters, no whitespace.
- `clientSecret`: needs `clientId`. In Settings it is exactly one `${NAME}`, resolved from Secrets then Variables; a literal is refused.
- `privateKey`: a `${NAME}` holding a PKCS#8 PEM. Only for `client_credentials`, and not together with `clientSecret`.
- `keyId`: 1–256 characters.
- `scope`: ≤64 tokens, ≤1 KiB. The scope requested is configured ∪ challenged, else the protected resource metadata's `scopes_supported`. `offline_access` is added when the authorization server lists it. The authorization request never sends `prompt=consent`: it would force the consent screen at every sign-in, and no server cloudpid signs in to needs it.
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

    Continue is a `POST` with an `Origin` check and the pending row's `state` as its field (single-use in that the callback takes the row, but not until then: see _As built_). The page sends `Referrer-Policy: same-origin` (header and `<meta>`), not `no-referrer`: under `no-referrer` a browser's form POST carries `Origin: null`, which the check refuses, so no Continue would ever work. `same-origin` leaves the page's own `Origin` and sends nothing to another site; a test keeps `null` refused. The form pages also carry no `form-action` in their CSP: Chrome and Safari apply it to every redirect after a submission, so `form-action 'self'` blocks the POST's 303 to the authorization server (whose origin the page cannot list). The POST's protection is the Worker's own (`Origin` and `Sec-Fetch-Site`), and the pages keep `default-src 'none'`, `script-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Pages without a form keep `form-action 'none'`. Checked in Chrome, Firefox and WebKit with Playwright (the real pages and headers, a POST answered with a 303 to another origin). Cancel deletes the pending row. A rebind drops the old issuer's tokens.

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
- **Origin:** `https://pi.ianpascoe.dev` on prod and `appOrigin(stage)` elsewhere (`https://cloudpid-server-<label>.ian-g-pascoe.workers.dev`, from `apps/server/src/deployment.ts`; see [_The App sandbox_](mcp-apps.md#the-app-sandbox) for the fixed names). The Worker gets it as a deploy-time var (`CLOUDPID_APP_ORIGIN`, set on live stages only) and never takes it from `Host`. A live Worker without it refuses to start a sign-in.
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
  - **The exact public paths** are `/oauth/mcp/client.json`, `/oauth/mcp/callback` and `/oauth/mcp/callback/<12-char hash>`, matched case-sensitively. They skip the check and never read identity. Every other form under those two prefixes gets a 404 before the guard and ahead of the single-page app's fallback, asset serving, and any case-insensitive or `%2f`-decoding router. The router is a pure function (`apps/server/src/sign-in-routes.ts`) that reads the path as it was sent: it treats a path as under a prefix after decoding escapes, applying `;` path parameters and dot segments, collapsing slashes and lowercasing, so it refuses more than it serves.
  - **Every other route** (`/`, assets, `/rpc`, the socket, attachments, `/oauth/mcp/start`) needs a valid `Cf-Access-Jwt-Assertion`. The Worker checks it against the `spirit-led-software` team's keys: issuer, signature, `exp`, `nbf`, and an `aud` equal to the Worker's own application's. The `email` must be `OWNER_EMAIL`, with no `common_name`. Anything else gets a 403, and the guard fails closed. `/mcp` takes its own audience (see [_Access and identity_](mcp-endpoint.md#access-and-identity)).
  - The audiences arrive as deploy-time vars from alchemy outputs (`CLOUDPID_ACCESS_AUD` for the main application's; see `docs/development/infra.md` → Stages and Access). The Worker and its own application's `aud` form a cycle in alchemy's graph, which the engine settles through the Worker's precreate stub, so main routes check the audience. A deployed Worker missing them refuses every guarded route. A `fetch` through a service binding carries no assertion and is refused; internal callers use RPC entrypoints.
  - Under `alchemy dev`, a request counts as the owner only when both hold:
    - the Worker was built in local mode, a var only the stack's local branch sets;
    - the host is loopback.

    A test asserts that the live `deployment()` output lacks that var.
- **`alchemy dev`:**
  - No Access, no bypass application, and the document route answers 404.
  - DCR registers `http://localhost:<port>/oauth/mcp/callback` with `application_type: native`.
  - There are two app origins, `http://localhost:1337` (workerd) and `http://localhost:5173` (Vite with `strictPort`, which proxies all of `/oauth/mcp/`). The Worker accepts a request's origin only from that set, read from `Host` and nothing else (a forwarded header is the client's to set), and the redirect URI follows the origin the sign-in started on. Vite's string form of a proxy target sets `changeOrigin` and so rewrites `Host` to `localhost:1337` (checked during #450), which would make every start look like workerd's. The `/oauth/mcp/` proxy in `apps/web/vite.config.ts` therefore sets `changeOrigin: false` and the browser's `Host` (`localhost:5173`) reaches the Worker. That makes two DCR registrations per authorization server in dev.
- **Stage lifecycle:**
  - A preview's destroy doesn't revoke its grants at the authorization servers. They stay listed under its client name for the owner to revoke.
  - `alchemy dev --stage dev_$USER` deletes the stage's deployed Durable Objects, MCP sign-ins included. The redeploy comes back on the same URL and the same document client, and the owner signs in again.

## Starting and completing a sign-in

- **Where it starts:**
  - the "MCP servers" rows in Settings, at every Scope, Repo rows included;
  - a Sign-in request's card;
  - links wherever a sign-in state already shows: an App View call's error, the prompt catalog's `sign_in` state, completion's "Sign in to …" and `MCP_SIGN_IN_REQUIRED`.

  Nothing sends a Notification without an agent's ask (or cloudpid's, for an MCP task).

- **The link:** `<a target="_blank" rel="noopener">` to `/oauth/mcp/start?environment=<id|all>&server=<name>[&step_up=1][&session=…&request=…]&return=<path>` (`all` is Global's own layers: its Secrets and Variables, and sign-ins that every Environment can use; `step_up=1` asks for the wanted scope of a sign-in that is already there; `return` is kept only as a path of this app). It is a link, not an RPC followed by `window.open`, because popup blockers would stop that. A link from a tab of the app (a navigation, `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: navigate`, so a same-origin `<img>` or `fetch` cannot start one) starts at once and the tab gets a 303 to the authorization page, the issuer interstitial, or an error page. Any other `GET` (a typed address, or the navigation back from an Access login, which is cross-site) starts nothing: it shows a page naming the server and the Environment whose Continue is a `POST` of the same values. That `POST` needs `Origin` equal to the origin the start was made on and `Sec-Fetch-Site: same-origin`, so only a click on cloudpid's own page starts it, and a page of another site cannot. This page sends `Referrer-Policy: same-origin` like the interstitial (see _Issuer binding_); the pages without a form keep `no-referrer`. The page cannot be framed (`frame-ancestors 'none'`).
- **`startMcpSignIn`** (Registry):
  1. Resolves the entry from that Environment's set.
  2. Discovers from the last reported challenge, else the well-known paths.
  3. Picks the client by the ladder and binds it.
  4. Makes a PKCE verifier and a 256-bit `state`.
  5. Writes one pending row per key; a newer start replaces it. The row expires after 10 min and holds:
     - the `state` hash, the key and the Environment (`all` or an id);
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
  - expired, already used or replaced by a newer sign-in (one page: a pending row that is gone cannot say which, because only a hash of `state` is kept and the row is deleted first);
  - a `state` that is not one cloudpid makes (`invalid`: a static page, the Registry never called) or a callback with no `code`;
  - declined at the server's page ("Nothing changed");
  - an authorization server error (its code, and the escaped description ≤300);
  - an `iss` mismatch ("nothing saved");
  - a callback at another path than the sign-in's redirect URI (`path_mismatch`), or one whose issuer interstitial was never confirmed (`unconfirmed`), both "nothing saved";
  - an exchange failure;
  - a store that could not be reached ("Nothing was saved", 503).

  A failure leaves the old tokens as they were. A pending Sign-in request stays open and shows the last failure. Every page says "You can close this tab" and offers Back. Start again (back to the same server and Environment) is offered on the signed-in page and on every failure the Registry answers with a server (all but `expired`, whose pending row is gone, and `invalid`, which names none); the start's own error pages and Cancel offer Back only. No page ever redirects on its own: on the installed iOS PWA the sign-in opens in an in-app sheet.

- **As built (#450):**
  - The Registry, not the Worker, does discovery, registration and the exchange, through `guardedFetch` (`apps/server/src/mcp/oauth-fetch.ts`: 15 s, no response read past 64 KiB, every redirect hop checked). The Worker shapes and bounds what reaches it (`mcp/sign-in-http.ts`) and renders the pages (`mcp/sign-in-pages.ts`); the three RPC methods are `startMcpSignIn`, `confirmMcpSignIn` and `completeMcpSignIn`, each with a fallback member on its answer.
  - The `state` is 43 characters (256 random bits, Base64url); only its hash is stored. The PKCE pair and the authorization URL are built here (`mcp/sign-in-client.ts`), so the interstitial's Continue rebuilds the URL from the sealed verifier. The interstitial's field is the `state` of the pending row. It is not strictly one-time: Continue takes the row and puts it back marked confirmed, so Continue can be posted again, to be sent to the same authorization URL, until the callback takes the row, a Cancel deletes it, or its 10 minutes pass. That is harmless: the `state` is in the authorization URL the owner is sent to anyway, and a `POST` needs the owner's own origin and same-origin header. Continue and Cancel are one `POST /oauth/mcp/start`, which needs `Origin` equal to the origin the sign-in started on and `Sec-Fetch-Site: same-origin`.
  - The authorization server must publish metadata (no legacy `/authorize` fallback). `offline_access` is asked for only when the base scope is not empty and the server lists it.
  - A configured client's secret is resolved again at completion, from the entry as it is then, never copied into the pending row.
  - A failure writes `lastError` only on a row with no tokens: a `step_up` row that carried an error would read as "token rejected".
  - A completion raises the revision, and the main Worker carries it to the hosts (see _Reports and pushes_); a host it did not reach takes it at its next pull. The answer lists the Environments and the Sign-in requests it resolved; the Sign-in requests are carried on by [#470](https://github.com/ian-pascoe/cloudpid/issues/470).
  - The span of a callback (`mcp.oauth.callback`) records the outcome, the OAuth error code and the token endpoint's HTTP status; a start's (`mcp.oauth.start`) records its outcome (`redirect`, `confirm` or `problem`) and the error code, when there is one. The 15 s timeout covers the body's read too: a server that drips its body is cut off.
- **Learning the outcome:**
  - The page posts on `BroadcastChannel("cloudpid:mcp-sign-in")`.
  - Settings refetches when that message arrives and on focus or `visibilitychange`.
  - Sessions with an open Sign-in request for the key learn of it from whoever completed it, never from the Registry ([The Environment's MCP host object](https://github.com/ian-pascoe/cloudpid/issues/382) D6.3): the main Worker carries `completeMcpSignIn`'s answer to them, and they resolve the requests and re-send `mcp_sign_in_requests`. Left to implementation: that call's shape. A request's re-check at resume is the backstop.
  - Nothing polls.

## Refresh and step-up

- **When:** a refresh happens when a host asks and the token is at `exp − 60 s`. On a 401 that isn't `insufficient_scope`, the host asks again with `stale` and retries once. No timers.
- **Single-flight:** one refresh at a time per sign-in, behind the Registry's own in-flight guard. A Durable Object's input gate opens on `fetch`, and a second refresh racing with the same rotating refresh token gets `invalid_grant`. Refresh uses pi-mcp's `refreshAuthorization` at the recorded endpoint. If the response has no new refresh token, the old one is kept; the same goes for the scope. `expires_in` is trusted from each response: Sentry's lifetime goes from 3600 s to about 30 days after a refresh.
- **A 401 again with a fresh token:** the status becomes `rejected`, and the challenge's `error` and description are kept. **The tokens are kept**, and that token drives no further 401 refresh. Calls still try the current token, and a `working` report clears the status and resolves open requests. A pending step-up is the exception: it stays `step_up` with the error kept, which is how a rejected token is told there; that token drives no 401 refresh either, and neither `working` nor a refresh of the tokens clears the step-up until the owner completes it.
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
- **As built (#454, `registry/mcp-sign-in-refresh.ts`):**
  - A code the lists above do not name is treated as transient: the owner's tokens are kept, rather than dropped on a code a server made up. The backoff is kept in the Registry's memory, not stored: an eviction ends it, and the next ask refreshes at once.
  - A refresh that is transient while the access token still stands (past `exp − 60 s` but not expired) answers the token with a `note` of `refresh_failing`; once it no longer stands the answer is `refresh_failing` with the reason, which the host shows as the server being `unavailable`.
  - The refresh time is the asking caller's `now` plus the time the request really took, so a slow authorization server does not shorten a lifetime it just granted.
  - The single-flight is a map by the sign-in's key hash, run uninterruptibly, so a caller that is cancelled does not lose a rotated refresh token that was sent.
  - A caller reads the row, opens its tokens, and only then joins or starts the flight: a refresh may have stored rotated tokens and cleared its flight in between, and the late caller's refresh token would be refused as `invalid_grant`, which drops the fresh tokens. So inside the flight the request is read from the row again, and when the tokens are no longer the ones asked about the answer is the row's current token (a refresh again only when that one is itself at its last minute).
  - The same goes for what a refresh writes: a refresh takes a while, and the owner may complete a sign-in or a step-up meanwhile. Before it writes anything (the new tokens and scope, `refresh_failing`, a drop on `invalid_grant`) the flight checks that the row still holds the sealed tokens it asked about. When it does not, nothing is written and the answer is the row's current token, so an old grant never overwrites a new one and its `invalid_grant` never drops it.
- **Step-up:**
  - A 403 `insufficient_scope` fails the call at once. The host reports it `step_up` with the challenge (above), and the server waits at `sign_in`.
  - The wanted scope becomes granted ∪ challenged ∪ configured, the status `step_up`, and the old tokens keep serving.
  - The step-up is a start with `skipRefresh`, offered on the card and on the Settings row.
  - After 3 completed step-ups re-challenged for the same scope set, `mcp_sign_in_ask` answers `step_up_failed`. A sign-in from Settings resets the count. The Registry keeps the count (the tests drive it through `reportMcpAuth`); `step_up_failed` as an answer to `mcp_sign_in_ask` belongs to [#470](https://github.com/ian-pascoe/cloudpid/issues/470), as does the Session's side of a step-up.
  - The count rises only when the owner completed a step-up and the server then challenges for the very scope set it wanted; a `step_up` report while one is pending counts nothing, and one for a different scope set starts the count again. A completed step-up keeps the wanted scope and the count, which the next challenge is compared to.

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
- **As built** ([#464](https://github.com/ian-pascoe/cloudpid/issues/464)):
  - **The seam:** the Registry's `SignInTarget` has a `client_grant` variant, built from an entry whose `oauth.grantType` is `client_credentials`. `signInAskNotApplicable(target)` in `mcp-sign-in-registry.ts` is the rule `mcp_sign_in_ask` reads for its `not_applicable` answer; the tool is [#470](https://github.com/ian-pascoe/cloudpid/issues/470)'s and is not on main, so the rule is tested in the Registry. A `client_grant` row under an entry that is no longer a client grant is treated as a sign-in that is required.
  - **Configuration** is checked in `@cloudpid/config` (`oauthProblems`), where the other `oauth` problems are; `clientSecret` and `privateKey` are resolved like the other `oauth` values (`resolveOauthValue`), and an unresolved one is a problem, not a missing sign-in.
  - **Discovery and the pin** reuse the authorization-code path's: the same protected-resource and authorization-server metadata fetches, the same issuer-pin check, and the same guarded fetch. The token request's `resource` is the canonical resource of the server's URL, and `scope` is the configured `oauth.scope`, else the protected resource metadata's `scopes_supported` (as [_The `oauth` fields_](#the-oauth-fields) says), else none; the row's `wantedScope` holds the configured `oauth.scope` only, so a change of it is a new sign-in while a change of the metadata's is not.
  - **Client authentication rules:** with a secret, `client_secret_post` or `client_secret_basic` as above. With a key, `private_key_jwt` must be listed when the server lists any methods, and a server that lists none is sent the assertion anyway. The algorithm comes from the key: RSA of at least 2048 bits signs RS256, P-256 signs ES256; other keys are a problem. Only PKCS#8 PEM is read. A server that lists neither the method nor an algorithm the key can sign is a problem naming what it listed.
  - **The row:** kind `client_grant`, with the access token sealed, no refresh token, `expiresAt`, and the grant id kept through renewals (the sign-in id of `tasks/*` therefore stays through a renewal). The row's client keeps the `${NAME}` reference the secret or key resolved to, and it follows the entry at each fetch or renewal (a changed secret does not invalidate a token that stands: it takes effect at the token's next renewal). The first `put` of a row raises `signInsRevision`; a renewal does not.
  - **Renewal:** one fetch at a time per key (single flight). A token is renewed at `exp − 60 s`. A 401 from the server, reported with the refused token as `stale`, gets one renewal; an in-memory `afterRefusal` marker keeps a second 401 under the renewed token from asking again, and it reads as `rejected`.
  - **Failure:** a failed fetch answers `failed` with the problem (the OAuth error code and `error_description` scrubbed of the secret, key, assertion and tokens), and holds the next try back by an in-memory backoff of 10 s, doubling to 5 min. The host tries a `failed` server again on a set change, a reload, a sign-in change or a call, at most once a minute per server (no timer polls it), which also bounds how often the Registry is asked. A setup problem (a key that cannot sign, a method the server does not list) is held for the first backoff too, since every ask would otherwise discover the authorization server anew; a fixed entry waits that out at most.
  - **Before a write**, the fetch checks that the row is still the one it began with and that the entry still signs in on its own with the same client, pin and scope: when a sign-in replaced or removed the row, or the entry changed, nothing is written and the answer is the row's own token, else `failed` with why (the guard of a refresh's `changedSince`).
  - **The host** maps `failed` to the server's `failed` state with the problem as its reason, never `sign_in`, `rejected` or `step_up`: it makes no report, and it never connects without a token to a client-grant server.
  - **The request path** ([#452](https://github.com/ian-pascoe/cloudpid/issues/452)'s `requestAccess`) does the same: a client-grant server's call is not sent without a token, and fails as `Unreachable` with the Registry's problem; the engine's `SignInRequired` or `StepUpRequired` after the hook's one renewal fails as `Unreachable` too (a 401 after a renewed token, or a 403 for more scope naming `oauth.scope`), so the Session never says to ask with `mcp_sign_in_ask` and sets no `details.sign_in`; and nothing is reported to the Registry.
  - **Switching** an entry from authorization code to a client grant, or back, does not leave the other kind's row, since the key ignores the grant type:
    - code → client grant: before the first token is fetched, the owner's refresh token and then access token are revoked (RFC 7009, best effort, span `mcp.oauth.revoke` with `mcp.trigger` `switch`) and the row is deleted. The old client's secret is read from the entry as it is now; when it does not resolve, the tokens are revoked as a public client (the client id only), which the server may refuse. There is no owner at hand on a switch, so a failed revocation is reported by a log warning (the kind of token and the status or OAuth code, never a token) and as the new row's last problem ("…did not revoke its refresh token (…)"), which the row's first renewal clears. Sign-out reports to the owner who pressed it; this is what fits where nobody did. A first fetch that fails after the old row was dropped loses the note, and keeps the log line;
    - client grant → code: `mcpAccessToken` deletes the client grant's row and answers `required`. Its access token is short-lived and is not revoked.

    `environmentsUsing` and `usesSignIn` read the row's kind: an Environment uses a client grant's row only through an entry that signs in on its own, and an owner's row only through one that does not.

  - **Environments that disagree:** the key is the entry's source, name and URL whatever its grant type, so Global's `sentry` as a code entry and an Environment's override of it as a client grant share one row. A row of the other kind is revoked and dropped only when no Environment's set still uses it as its own kind (`environmentsUsing`). Otherwise the asking entry's answer is `failed`, naming the Environments and saying to rename one of the entries ("… uses this server's sign-in as the owner's own, and an entry of the other kind would undo it: rename one of the entries"), and the row, its tokens and the revision are left as they are, so the two cannot undo each other. A completed owner sign-in still replaces a client grant's row unseen: that start is not guarded yet.
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
  - As built ([#464](https://github.com/ian-pascoe/cloudpid/issues/464)): the Settings MCP section is [#459](https://github.com/ian-pascoe/cloudpid/issues/459)'s and [#469](https://github.com/ian-pascoe/cloudpid/issues/469)'s and is not on main, so the "Signs in on its own · <issuer host>" row is delivered as a pure data model in `@cloudpid/config`: `signsInOnItsOwn(entry)` and `mcpClientGrantRow(oauth)`, which say the chip, the issuer host and that Sign in, Sign in again and Sign out are absent. The state chip and the row's status and last problem are [#469](https://github.com/ian-pascoe/cloudpid/issues/469)'s: it renders "Signs in on its own · <issuer host>" from this model, with the status it reads from the sign-in list.
- **The Add/Edit form** has a "Sign-in (OAuth)" disclosure with [the `oauth` fields](#the-oauth-fields). Next to them it shows the stage's redirect URI with Copy, and the client name that will actually be registered.
- **Sign-ins:** at Global, a second list (`/settings/all/mcp#sign-ins`), not a Settings section of its own. It shows the server, source, URL host, issuer host, kind, status, scopes, times, the Environments that use each sign-in, unused marks, and Sign out.

## Telemetry and redaction

- **Spans:** `mcp.oauth.start`, `.callback`, `.refresh`, `.client_credentials` and `.revoke`. Their attributes are:
  - the server (normalized), the source kind, the issuer host and the client kind;
  - `registered` and `step_up`;
  - the trigger (`expiry` | `401`, `first` for a client grant's first token, and `switch` for the revocation of an owner's sign-in that a client grant replaced) and the outcome;
  - the OAuth error **code** and the HTTP status;
  - `rotated`, and the scope list (≤256 chars).

  `mcp.oauth.revoke` on a switch records `mcp.outcome` `revoked`, `revocation_failed`, `no_revocation_endpoint` (the server advertises none) or `not_revoked` (the tokens or the recorded metadata could not be read). `mcp.oauth.client_credentials` is made when a token is wanted from the authorization server (a fetch, or one held back by the backoff), never for an answer from the stored row. It records `mcp.auth_method` (`client_secret_post` | `client_secret_basic` | `private_key_jwt`; absent when the server lists no way to send a secret), `mcp.trigger` (`first` | `expiry` | `401`), `mcp.outcome` (`fetched`, or `replaced` for a fetch whose write was overtaken, or `backoff`, `unavailable`, `problem`, `discovery_failed`, `failed`, `refused_by_store`), `http.status_code` and `mcp.oauth_error` (the code), beside the server, source kind and issuer host.

  The document route adds its fetch attributes (above). `mcp.oauth.refresh` records `mcp.server`, `mcp.source_kind`, `mcp.issuer_host`, `mcp.client_kind`, `mcp.trigger`, `mcp.step_up`, then `mcp.outcome` (`refreshed` and the failures), `http.status_code`, `mcp.oauth_error` (the code), `mcp.rotated` and `mcp.scope`. The host's tokens and reports appear in no span or log: its logs say which server and Environment, and the span of a discovery has none of the token.

- **Never recorded or logged:** tokens, codes, verifiers, `state`, secrets, keys, assertions, authorization URLs and callback queries. `error_description` is kept only on the row. Fetch errors have their URL queries stripped. Accepted: Workers' own invocation logs keep the callback URL, whose single-use code is useless without the verifier.
- **No Session redaction or Snapshot scan** covers MCP tokens, which never reach those objects. The engine's exact-value scrub (`apps/mcp-worker/src/scrub.ts`, [_The engine_](mcp-connections.md#the-engine)) is the only filter: it covers the tokens a call's `auth` hook gave and the `Authorization` token in a call's target `headers` (the discovery's), in a call's results, errors, logs and discovered inventory, and in the rows the call changed for the host to keep (`serverInfo` and `instructions` in a session or era row), string values only.

## Testing

- **Unit:** the origin rule, the client name, PKCE (RFC 7636's vector), the authorization URL, the pages (each CSP hash against `crypto.subtle`, escaping, "close this tab" on every outcome), the routes (a malformed `state` never reaches the Registry; `Sec-Fetch-Site` and `Origin` checks) and the guarded fetch. The Registry's start and completion run over real Durable Object storage and a fake network (`mcp-sign-in-flow.workerd.test.ts`). `deployment()`'s table, covering the label, the flag, the client name and the bypass gate. Routing tests cover capitalisation, doubled slashes, sub-paths, `;` and `%2f` under both public prefixes, all answering 404 apart from the two exact paths. The guard's audience, email and `common_name` checks, and the local-mode var's absence from the live `deployment()` output, are tested too.
- **Preview check by the implementing agent** (curl from outside), when the bypass lands:
  - the bypass reaches the Worker, `/oauth/mcp/callback/<hash>` included;
  - other forms get a 404;
  - `/` and `/oauth/mcp/start` get a 302 to Access;
  - a cookieless `/rpc` is refused.
- **Client credentials:** `oauth-client-credentials.test.ts` (golden assertion claims and header, key import and algorithm rules, method choice, the bounded and scrubbed errors), `mcp-sign-in-client-grant.workerd.test.ts` (first use, expiry renewal, one 401 renewal, single flight, backoff, `failed` answers, scrubbing, the row's grant id and revision, the secret reference, a fetch overtaken mid-flight, switches of kind in both directions, over real Durable Object storage and a fake authorization server), `discovery-auth.workerd.test.ts` and `request.workerd.test.ts` (the host's `failed` mapping at discovery and on the request path), `extensions.test.ts` in the Worker (the extension declared only for a known name) and the config tests (`mcp-servers.test.ts`, `mcp-client-grant.test.ts`).
- **The owner's deployed check** gates the merge of the first sign-in slice that completes a document sign-in end to end ([Whether workers.dev stages serve the client document](https://github.com/ian-pascoe/cloudpid/issues/422) D7). The owner revokes the test grants afterwards.
  1. A cookieless GET of the document from at least one hosting network returns 200 `application/json`, with `client_id` equal to its own URL.
  2. Sign in and refresh at Sentry, then at Linear.
  3. On a refusal, record the authorization server's page, then retry with `clientRegistration: "dcr"`.
