---
status: accepted (stages serving the document, and two facts from the deployed verification: amended by #422)
---

# cloudpid identifies itself to authorization servers with a public client document and takes their answers on a public callback, outside Access

On every deployed stage, `<origin>/oauth/mcp/client.json` is cloudpid's client id at every authorization server that supports Client ID Metadata Documents, public clients and the `iss` response parameter, and `<origin>/oauth/mcp/callback` receives every authorization response. The origin is `https://pi.ianpascoe.dev` on `prod` and the stage's fixed `workers.dev` origin elsewhere ([ADR-0031](0031-app-views-run-in-a-secretless-sandbox-on-a-domain-of-their-own.md)), never the request's `Host`. Both paths are the `public` destinations of an Access application with a Bypass policy. Each stage declares that application while its main Worker is live, and a path-scoped application's precedence puts it ahead of the Worker's own. The rest of the stage, `/oauth/mcp/start` included, stays behind Access. A configured client comes first and DCR is the fallback. A switch set per stage takes the document out of the ladder for new sign-ins, and the routes keep serving. The switch is on for every deployed stage. `alchemy dev` serves no document (an authorization server can't fetch `localhost`), uses DCR on a `localhost` callback, and has no Access.

The callback's safety rests on a single-use 256-bit `state` valid for 10 minutes, a PKCE verifier only the Registry holds, an exact redirect path, and the `iss` check (RFC 9207). Being public, it never depends on:

- the Access cookie or its SameSite setting;
- a re-login keeping the query string;
- the browser or sheet the authorization server returns to. An installed iOS PWA opens the sign-in in an in-app sheet.

Changing the document's URL voids every document-based sign-in, which is why this is recorded.

## Considered options

- **DCR only**: no public path, but DCR is deprecated in MCP `2026-07-28`, and each stage leaves registrations at every authorization server.
- **The callback behind Access**: open to the re-login and cookie-jar failures above, for no protection `state` and PKCE do not already give.
- **The document on another origin** (a separate Worker, or `ianpascoe.app`): an authorization server may require the redirect URI to share the document's origin, and `ianpascoe.app` is kept for App Views.
- **The document on `prod` only, with DCR and the callback behind Access elsewhere**: prod's main sign-in path would first run on prod, and previews would depend on the Access cookie at the callback. A preview's document is a new client per pull request, but so is a DCR registration.
- **`overrides` on the Worker's own Access destination** instead of a second application: alchemy can't declare them, and they match exact paths only, so `/oauth/mcp/callback/<id>` would stay behind Access.

## Consequences

- An authorization server fetches the document at its first sign-in and then caches it for up to `max-age`; neither Sentry nor Linear refetched it at later sign-ins or refreshes. So a bot challenge on the path shows up only once a cache expires, and a change to the document takes up to an hour to reach them. Bot Fight Mode is off on `ianpascoe.dev`. A document client's `invalid_client` on refresh is treated as transient rather than dropping its tokens.
- The callback page must not leak the code: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, a CSP allowing only its own script by hash (Cloudflare's injected scripts copy a nonce), and `history.replaceState` once loaded.
- Access lets through more than the two paths: any sub-path, any capitalisation and doubled slashes. The Worker answers only the exact paths and returns 404 for every other form under them, before any other handler. Every other route verifies the Access assertion instead of trusting that Access ran.
- Previews run unreviewed code on two public paths. A branch gains nothing from this, since the preview token can already create Access applications.
- Off `prod`, each stage is its own client, named `cloudpid (<label>)`. A preview's grants outlive its destroy at the authorization servers until the owner revokes them.
- An authorization server may apply its own domain-trust policy and refuse a client document on `workers.dev`. It shows that only on its own page, never redirecting back. The outs are the per-stage switch and an entry's `clientRegistration: "dcr"`.
