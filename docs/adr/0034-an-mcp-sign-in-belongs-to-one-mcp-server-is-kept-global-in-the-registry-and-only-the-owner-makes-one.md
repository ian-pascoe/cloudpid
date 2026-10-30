---
status: accepted
---

# An MCP sign-in belongs to one MCP server, is kept Global in the Registry, and only the owner makes one

An MCP sign-in is keyed by its MCP server's source (the owner, or one Repo), its name (as the `mcp__<server>` part spells it) and its URL, and is kept Global: one sign-in serves every Environment with that server, and two names on one URL are two accounts. A Repo's server never uses the owner's sign-in, even at the same URL; the owner signs it in on its own, and Environments holding that Repo share it. The Registry keeps the tokens sealed (AES-GCM under a key HKDF derives from `SECRETS_ENCRYPTION_KEY` for the purpose `mcp-oauth`, bound to the row), refreshes them with one refresh in flight per sign-in and only on use, and hands short-lived access tokens over Durable Object RPC to each Environment's MCP host object, which holds them in memory only and attaches them only to requests within the token's resource. Tokens never reach a Session, a Workspace or a Container.

Client registrations (DCR) are kept per authorization server issuer and shared by every sign-in there, and a client the owner configures (`oauth.clientId`) is bound to one issuer, as SEP-2352 requires: its secret reaches a new issuer only after the owner confirms it on the sign-in page, or never when the entry pins the issuer. A refresh token only goes back to the token endpoint recorded when it was issued. The agent can only ask, through a Sign-in request (`mcp_sign_in_ask`); its MCP calls fail at once while a server needs sign-in, and the owner signs in on the server's own page.

## Considered options

- **Keyed by issuer and resource** (the map's first note): one account per resource, and any entry at Sentry's URL, a Repo's included, would get the owner's Sentry.
- **pi's name and URL, whatever the source**: a committed `.pi/mcp.json` would quietly reach the owner's accounts in Environments where he never set the server up.
- **Per Environment**: one server signed in N times.
- **A Durable Object per sign-in**: serialises refresh by itself, but adds a class and a binding, and the Registry would still need an index of them for the Settings page and the callback's `state`.
- **The MCP call waiting durably for the sign-in**: a wait inside every call's and every script's timeout, which were not built for one.

## Consequences

- Renaming a server or changing its URL needs a new sign-in; the old one stays listed as unused until the owner signs out.
- A sign-in is not a Secret: ADR-0029's "a Repo's servers get no Secrets" is met by the source in the key and the resource binding, not by refusing Repo servers a sign-in.
- An eviction or deploy that loses a refresh answer loses a rotated refresh token; the owner then signs in again.
