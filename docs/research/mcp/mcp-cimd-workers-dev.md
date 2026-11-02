# Will Sentry's and Linear's MCP authorization servers accept a CIMD `client_id` on `*.workers.dev`?

Issue: #422. Researched against primary sources (specs, source code, vendor docs, live well-known endpoints). Sources were fetched on 2026-11-02, so "latest" and "current draft" mean the text served that day.

Example under test: `client_id` = `https://cloudpid-server-pr-123.ian-g-pascoe.workers.dev/oauth/mcp/client.json`, with a `redirect_uris` entry on the same origin.

## Short answer

| AS | Verdict | Why |
| --- | --- | --- |
| **Sentry** (`mcp.sentry.dev`) | **Likely accepts** | Its AS is `@cloudflare/workers-oauth-provider` 0.10.3 (verified in source), with CIMD on and `global_fetch_strictly_public` set. Neither version of that library has any host allow-list, deny-list, public-suffix rule, or same-origin redirect rule. Sentry's own code adds no client-host policy either. |
| **Linear** (`mcp.linear.app`) | **Unknown, leaning likely** | Linear's source is closed, and no Linear document says which library it uses. Its AS metadata has the same shape as `workers-oauth-provider`'s, but its fetch User-Agent (`linear-mcp/1.0`) differs from that library's, so a fork or custom code is possible. It accepted a `*.ianpascoe.dev` client, so it has no blanket "unregistered domain" block. Whether it has a suffix or host policy can't be read from outside. |

- **The specs permit the setup.** Trust policy is left entirely to the AS, and nothing requires or forbids refusing a shared-hosting domain.
- **`workers.dev` is on the Public Suffix List** (private section, Cloudflare). No CIMD spec text and no implementation found treats the PSL specially. That is an unverified gap, not a negative finding. The PSL is simply never mentioned in the draft or the MCP spec text I read.
- **The Cloudflare same-zone fetch restriction is unlikely to bite.** It only applies when the AS fetches a URL in its *own* zone, and it is lifted by `global_fetch_strictly_public`. Sentry sets that flag. `workers.dev` is not Sentry's or Linear's zone anyway.
- **The `*.ianpascoe.dev` result carries over only partly.** It shows each AS fetches from Cloudflare IPs and has no blanket "unregistered domain" block. It doesn't show how either AS treats a PSL suffix.

## 1. What the specs say

### 1.1 CIMD draft (latest is `-02`, 6 July 2026; MCP still pins `-00`)

The IETF datatracker's latest revision is `draft-ietf-oauth-client-id-metadata-document-02` (expires 7 Jan 2027). Both the 2025-11-25 and draft MCP specs link **`-00`** (8 Oct 2025). Text below is from `-02`, with `-00` equivalents where they exist.
- `-02`: <https://www.ietf.org/archive/id/draft-ietf-oauth-client-id-metadata-document-02.txt>
- `-00`: <https://www.ietf.org/archive/id/draft-ietf-oauth-client-id-metadata-document-00.txt>

**Client Identifier URL (§3, `-02`)** is a pure URL-shape rule:

> "A Client Identifier URL: MUST use the https URL scheme; MUST NOT contain a userinfo component; MAY contain a port; MUST contain a path component; MUST NOT contain single-dot or double-dot path components; SHOULD NOT contain a query component; MUST NOT contain a fragment component."

There is no host rule at all. `https://<x>.workers.dev/oauth/mcp/client.json` satisfies it.

**Redirect URLs (§4.2, `-02`)**:

> "the authorization server MUST require registration of redirect URLs, and MUST ensure that the redirect URL in an authorization request is an exact match, using simple string comparison, of a registered redirect URL."

**Redirect/client_id relationship (§8.1 `-02`; §6.1 `-00`)** says restrictions are optional:

> "An authorization server may impose restrictions or relationships between the redirect_uris and the client_id or client_uri properties, for example to restrict the redirect_uri to the same-origin as the Client ID Metadata Document. Without restrictions like these, there are potential trust and safety issues where the client attempts to impersonate a more well-known client…"

A same-origin redirect is therefore the *recommended-safe* shape, not a problem. `-02` Appendix A adds that an AS imposing such restrictions "RECOMMENDED that it provide at least one CIMD Service which is exempt".

**Domain trust (§8.9 `-02`; §6.8 `-00`)** leaves policy to the AS and says nothing about shared hosting or the PSL:

> "The authorization server may choose to have its own heuristics and policies around the trust of domain names used as client IDs. For example, the authorization server could require that the first 100 users to authorize a client_id see an additional warning screen… check attributes of the domain reputation, such as how recently the domain was registered… An authorization server may also maintain allowlists of trusted domain patterns, such as treating any Client Identifier URL under `*.example.com` as belonging to a known and trusted operator, and apply reduced friction for clients matching such patterns."

The allow-list sentence appears only in `-02`. `-00` has the "heuristics / new domains" text only.

**Phishing (§8.5 `-02`)** says an AS "SHOULD display the hostname of the client_id on the authorization interface".

**SSRF (§8.6 `-02`)** restricts only special-use IPs:

> "Authorization servers MUST NOT fetch a Client ID Metadata Document URL or any URLs contained within a Client ID Metadata Document that resolve to special-use IP addresses as defined in [RFC6890]."

A `workers.dev` host resolves to public Cloudflare anycast IPs, so this does not apply.

**Localhost**: `-02` §8.6 allows loopback fetches only for AS instances in dev/test that are themselves on loopback. `localhost` as a *client_id host* is not otherwise discussed. The MCP spec covers `localhost` as a *redirect* (§1.2).

### 1.2 MCP authorization spec

Sources:
- 2025-11-25: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization.md>
- draft: `.../specification/draft/basic/authorization/client-registration.md` and `.../draft/basic/authorization/security-considerations.md`
- A dated `2026-07-28` version is also published and is near-identical to draft. Both still cite CIMD `-00`.

**AS requirements (2025-11-25 and draft)**:
- SHOULD fetch metadata for URL-formatted client_ids.
- MUST validate that the document's `client_id` matches the URL exactly.
- SHOULD cache per HTTP headers.
- MUST validate request redirect URIs against the document's.
- MUST validate the document structure.

The flow diagram's validation note reads "4. (Optional) Domain allowed via trust policy". There is no same-origin requirement.

**Trust Policies (2025-11-25 §"Client ID Metadata Document Security")**:

> "Authorization servers **MAY** implement domain-based trust policies: Allowlists for trusted domains (for protected servers); Accept any HTTPS `client_id` (for open servers); Reputation checks for unknown domains; Restrictions based on domain age or certificate validation; Display the CIMD and other associated client hostnames prominently to prevent phishing. Servers maintain full control over their access policies."

**Localhost redirect risks** (same section):

> "Authorization servers: SHOULD display additional warnings for `localhost`-only redirect URIs; MAY require additional attestation mechanisms for enhanced security; MUST clearly display the redirect URI hostname during authorization."

The draft's `security-considerations.md` keeps the same three bullets under "Localhost Redirect URI Risks" and a "Trust Policies" subsection. Shared-hosting or public-suffix domains are not mentioned anywhere I read.

**Redirect rule (2025-11-25 §"Communication Security")**: "All redirect URIs **MUST** be either `localhost` or use HTTPS." An `https` redirect on a `workers.dev` host qualifies.

**Takeaway for question 1**: an AS may legitimately apply an allow-list, a reputation check, or a PSL rule. No spec requires it, and none forbids accepting any HTTPS host. The "(for open servers) accept any HTTPS client_id" model is explicitly sanctioned.

## 2. Public Suffix List

`workers.dev` **is on the PSL**, in the PRIVATE DOMAINS section under "Cloudflare, Inc.", alongside `pages.dev`, `r2.dev` and `trycloudflare.com`. In the file I fetched (`publicsuffix/list` `main`), these are at lines 12756–12758: <https://raw.githubusercontent.com/publicsuffix/list/main/public_suffix_list.dat>. The private section begins at line 11240 (`// ===BEGIN PRIVATE DOMAINS===`).

So `ian-g-pascoe.workers.dev` is a registrable domain under the suffix `workers.dev`, and cookies and origin-keyed browser features already treat each account subdomain as separate.

**No special CIMD treatment found.** I grepped the CIMD `-00` and `-02` drafts and the MCP authorization text for "public suffix", "shared hosting" and "workers.dev": no hits. §8.9 in `-02` mentions `*.example.com` patterns in the *allow* direction only. The `-02` abstract-level caution that CIMD "works best for clients that have an established, stable, and publicly accessible web presence" (§1) is the closest thing to a shared-hosting caveat, and it is not normative. No implementation I read (§3–4) consults the PSL.

## 3. Sentry and Linear implementations

### 3.1 Sentry: verified `workers-oauth-provider` 0.10.3, patched

First-party source: `getsentry/sentry-mcp` at commit `b7c23cf40abb42dbddcf8db5b9fe088d5bb09297`.
- `packages/mcp-cloudflare/package.json` depends on `@cloudflare/workers-oauth-provider`.
- `pnpm-workspace.yaml`: catalog `^0.10.3`, plus `patchedDependencies` for `@cloudflare/workers-oauth-provider@0.10.3`.
- `packages/mcp-cloudflare/src/server/index.ts` (~L335–351) builds `new OAuthProvider({… clientIdMetadataDocumentEnabled: true, clientIdMetadataDocuments: CLIENT_ID_METADATA_DOCUMENTS …})`. Its comment says "Requires wrangler `global_fetch_strictly_public` (already set)".
- `packages/mcp-cloudflare/wrangler.jsonc` lists `"global_fetch_strictly_public"` under `compatibility_flags`.
- `docs/cloudflare/oauth-architecture.md` ("Operator-managed client metadata") says "URL-based clients normally use CIMD. The provider fetches and validates the document during authorization, code exchange, and refresh." Only the exact Codex client ID (`https://chatgpt.com/oauth/codex/client.json`) is operator-pinned. "Other URL-based clients still use CIMD". The patch exists because Codex's document returned 403 to the AS's fetch.
- The pnpm patch only adds the `clientIdMetadataDocuments` override. It is not a host policy.
- Sentry's `oauth/routes/authorize.ts` and `oauth/*.ts` contain no client-host allow-list or deny-list. I grepped for `workers.dev`, `allowlist`, `isTrusted` and `hostname`; the only hit was an unrelated resource-URL hostname check in `helpers.ts`.
- Live AS metadata (`https://mcp.sentry.dev/.well-known/oauth-authorization-server`, fetched 2026-11-02) has `"client_id_metadata_document_supported": true`, `registration_endpoint`, `token_endpoint_auth_methods_supported: [client_secret_basic, client_secret_post, none]`.

The user's observation that Sentry's CIMD fetch had an **empty UA** fits 0.10.3, whose `fetchCimdOrigin` sends only `Accept` and `Cache-Control` headers. Newer versions (1.2.4) add `User-Agent: workers-oauth-provider/<version> (+https://github.com/cloudflare/workers-oauth-provider)`.

### 3.2 Linear: not verified

- Linear's docs (<https://linear.app/docs/mcp>, <https://mcp.linear.app/>) say only "OAuth 2.1 with dynamic client registration". They don't name an AS library and don't mention CIMD.
- Live AS metadata (`https://mcp.linear.app/.well-known/oauth-authorization-server`, 2026-11-02) matches the `workers-oauth-provider` output shape:
  - `response_modes_supported`
  - `authorization_response_iss_parameter_supported: true`
  - `revocation_endpoint` equal to the token endpoint
  - `client_id_metadata_document_supported: true`
  - `authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"]`. That URN is `EMA_ID_JAG_GRANT_PROFILE` in the library's `src/ema/constants.ts`.
- The response header is `server: cloudflare` (which only shows Cloudflare is in front).
- Counter-evidence: the user's observed UA `linear-mcp/1.0` is not the library's UA (`workers-oauth-provider/<version> …`). So Linear is either a fork, wraps its own fetch, or uses different code with copied metadata conventions.

**Conclusion**: Linear's use of the library is **circumstantial only**. Treat Linear's CIMD policy as opaque.

### 3.3 `workers-oauth-provider` CIMD source

- Source read (latest): `cloudflare/workers-oauth-provider` `main` @ `b4cec3173079b42e3df2cb9f16a8ff13653709d0`, `package.json` version `1.2.4`. Files: `src/oauth-client-metadata.ts`, `src/oauth-provider.ts`, `docs/authorization-server.md`.
- Source read (what Sentry runs): npm tarball `@cloudflare/workers-oauth-provider@0.10.3`, `dist/oauth-provider.js`.
- Neither read is Sentry's *patched* build. The patch affects only registration overrides, per the Sentry docs.

**Findings, identical in 0.10.3 and 1.2.4 except where noted**:

| Check | Behaviour |
| --- | --- |
| Host allow-list / deny-list | **None.** `grep` for `workers.dev`, `allowlist`, `blocklist`, `denylist`, `publicsuffix` in both: no relevant matches. Only `hostname` uses are loopback detection and endpoint matching. |
| Client ID URL shape (`validateClientIdentifierUrl`, `isClientIdMetadataDocumentUrl`) | Absolute `https://`, non-empty raw path, no userinfo, no fragment, no `.`/`..` segments, no whitespace/control characters. |
| Document checks (`resolveClientIdMetadataDocument`) | `client_id` must equal the URL exactly. `client_name` must be non-empty. `redirect_uris` must be non-empty. No `client_secret` or private JWK material. |
| Redirect URIs in document | Must pass a safe-scheme check. In 1.2.4 any non-dangerous scheme is stored, and the *request's* URI must be `https`, or `http` on loopback. 0.10.3 only rejects dangerous schemes at metadata time. |
| **Same-origin redirect check** | **None** in either version. At authorization time the request's `redirect_uri` must be an exact string match for a listed URI (`isValidRedirectUri`), with loopback port flexibility only. A same-origin `https` redirect is accepted trivially. |
| Fetch | `fetch(url, {headers: Accept, Cache-Control: no-store, [UA in 1.2.4]}, cache: 'no-store', signal})`. **10 s timeout, 5 KB size cap**, UTF-8 JSON. No manual redirect handling. |
| SSRF guard | The library relies on the Workers `global_fetch_strictly_public` flag, and the provider advertises `client_id_metadata_document_supported` only when it is set (`hasGlobalFetchStrictlyPublic()`). 1.2.4 `docs/authorization-server.md`: "The compatibility flag prevents outbound CIMD fetches from using legacy same-zone origin routing, which is necessary for SSRF protection." There is **no explicit refusal of `*.workers.dev` or same-zone URLs**. |
| Caching | Workers Cache API (`caches.open`) keyed by the metadata URL; TTL from `Cache-Control` (`s-maxage` or `max-age`, capped at 7 days; `no-store`, `no-cache` and `private` are not cached; errors are never cached). |
| Consent-side display | 1.2.4 exposes `clientDomain: new URL(clientId).hostname` for CIMD clients (`src/oauth-consent.ts`), for the app's consent page to show. |
| Failure mode | A fetch or validation failure becomes a generic `invalid_client` at the token endpoint. 1.2.4 exports `CimdFetchError`. |

**Caching implication:** the example document's `Cache-Control` decides how long the AS keeps it. Without `max-age` or `s-maxage` it is re-fetched on each use. A PR-preview doc that changes between runs should send `no-store`, or a short TTL.

### 3.4 Cloudflare same-zone fetch restriction

Sources:
- Compatibility flags: <https://developers.cloudflare.com/workers/configuration/compatibility-flags/> ("Global fetch() strictly public").
- Errors: <https://developers.cloudflare.com/workers/observability/errors/> (error 1042).

> "When the `global_fetch_strictly_public` compatibility flag is enabled, the global `fetch()` function will strictly route requests as if they were made on the public Internet. This means requests to a Worker's own zone will loop back to the 'front door' of Cloudflare and will be treated like a request from the Internet, possibly even looping back to the same Worker again. When the `global_fetch_strictly_public` is not enabled, such requests are routed to the zone's origin server, ignoring any Workers mapped to the URL and also bypassing Cloudflare security settings."

> "1042 | Worker tried to fetch from another Worker on the same zone, which is only supported when the global_fetch_strictly_public compatibility flag is used. Also returned for a workers.dev URL with no Worker serving it, such as a Worker with its workers.dev route disabled."

Reading:
- **Sentry**: sets the flag, and the AS is on `mcp.sentry.dev`, not the `workers.dev` zone. A fetch of `*.workers.dev` goes out as a public request, so the 1042-same-zone case should not arise.
- **Linear**: flag state unknown. If Linear's AS runs on Workers *without* the flag, a fetch to a `workers.dev` URL could still be answered with 1042. That is Cloudflare's text for "a workers.dev URL with no Worker serving it", and the docs describe the same-zone rule as concerning the AS's own zone. I found no doc stating that a Worker without the flag is blocked from fetching *other accounts'* `workers.dev` Workers. Treat as unverified.
- **Our side**: the document must be actually served by a deployed Worker with `workers.dev` enabled. A disabled route or an undeployed PR preview gives a 1042 page, not JSON. That would look like an AS rejection but is a deployment gap.

## 4. Other AS implementations (brief)

- **MCP TypeScript SDK** (`modelcontextprotocol/typescript-sdk` @ `1e608caeb5130b2ad0fa067c84b26a038c1c6e36`): references to `client_id_metadata_document_supported` are all client-side (`packages/client/src/client/auth.ts`). No AS-side CIMD fetch or host policy found.
- **Stytch**: supports CIMD, enabled per Connected Apps ([changelog 2025.10.17](https://changelog.stytch.com/announcements/client-id-metadata-documents-cimd-1)). I did not find its domain-trust behaviour in the docs.
- **WorkOS AuthKit**: CIMD is off by default and enabled in the dashboard ([docs](https://workos.com/docs/authkit/mcp)). It cites CIMD `-00`. No domain policy was documented in what I read.
- **Auth0**: CIMD is registered manually or dynamically as a "domain-verified CIMD URL" ([MCP client registration guide](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application)). That implies a stricter, verified-domain model than the open fetch used by `workers-oauth-provider`. I didn't read its CIMD page, so details are unverified.

## What only a live test can settle

1. **Linear's actual policy for a `workers.dev` host.** Run the same flow with the real `workers.dev` `client_id` and see whether Linear fetches the document (check Worker logs for the fetch and its UA), shows the consent page, or returns an error.
2. **Whether either AS has an undocumented suffix/PSL or reputation rule.** Domain-age or reputation checks (CIMD §8.9, MCP "Trust Policies") would also be invisible until tried. A pass on `*.ianpascoe.dev` doesn't answer this.
3. **Whether Sentry's deployed build matches the 0.10.3 source I read.** The npm tarball is not Sentry's patched build, and Sentry's repo state is whatever was current on 2026-11-02, not necessarily what is deployed.
4. **Whether the AS fetch actually reaches our Worker.** Confirm a Cloudflare-served document answers 200 JSON (not 1042/403) to an empty-UA fetch (Sentry) and to `linear-mcp/1.0` (Linear). Cloudflare's bot or WAF rules on `workers.dev` could treat these fetches differently from our custom domain.
5. **Consent UX.** What each AS displays for the client hostname (`<pr>.<account>.workers.dev`) and for the redirect URL. Both are normative display points in MCP, but the exact wording is theirs.
6. **Cache behaviour.** Whether a changed document (PR preview redeploy) is picked up, given Cache API TTLs from our `Cache-Control`.
