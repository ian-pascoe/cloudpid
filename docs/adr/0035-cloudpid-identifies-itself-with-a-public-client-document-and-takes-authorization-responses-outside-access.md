---
status: accepted
---

# cloudpid identifies itself to authorization servers with a public client document and takes their answers on a public callback, outside Access

On `prod`, `https://pi.ianpascoe.dev/oauth/mcp/client.json` is cloudpid's client id at every authorization server that supports Client ID Metadata Documents, public clients and the `iss` response parameter, and `/oauth/mcp/callback` receives every authorization response. Both are exact paths of an Access application with a Bypass policy, which a path-scoped application's precedence puts ahead of the Worker's own; the rest of the stage, `/oauth/mcp/start` included, stays behind Access. A configured client comes first and DCR is the fallback; previews and `alchemy dev` serve no document, use DCR, and keep the callback behind Access.

The callback's safety rests on a single-use 256-bit `state` valid for 10 minutes, a PKCE verifier only the Registry holds, an exact redirect path, and the `iss` check (RFC 9207). Being public, it never depends on the Access cookie, its SameSite setting, a re-login keeping the query string, or the browser the authorization server returns to (an installed PWA's sign-in opens in Safari, with its own cookies). Changing the document's URL voids every document-based sign-in, which is why this is recorded.

## Considered options

- **DCR only**: no public path, but DCR is deprecated in MCP `2026-07-28`, and each stage leaves registrations at every authorization server.
- **The callback behind Access**: open to the re-login and cookie-jar failures above, for no protection `state` and PKCE do not already give.
- **The document on another origin** (a separate Worker, or `ianpascoe.app`): an authorization server may require the redirect URI to share the document's origin, and `ianpascoe.app` is kept for App Views.

## Consequences

- An authorization server fetches the document at sign-in and, at some (Sentry), at every refresh, so a bot challenge on the path stops their sign-ins and refreshes; Bot Fight Mode is off on `ianpascoe.dev`, and a document client's `invalid_client` on refresh is treated as transient rather than dropping its tokens.
- The callback page must not leak the code: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, a CSP allowing only its own script, and `history.replaceState` once loaded.
