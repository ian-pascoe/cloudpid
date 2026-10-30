# MCP Apps sandbox host: hosting one origin per MCP server on Cloudflare (2026-10 research)

Question: can the sandbox Worker serve `<26-char-hash>.<sandbox zone>` (one origin per MCP server) with CSP as a response header, and what do Cloudflare DNS/TLS, the Public Suffix List, cookie rules, permission rules and the MCP Apps spec imply for that design?

Sources are primary only: Cloudflare docs (`developers.cloudflare.com`), the PSL file (`publicsuffix.org`), IETF/W3C specs, and `modelcontextprotocol/ext-apps` on GitHub. Where a primary source did not settle a point, it is marked **unverified**.

Snapshot details: the PSL file read is `// VERSION: 2026-10-28_13-15-55_UTC`. The ext-apps listing was read from `main` at the time of research.

## Answers

1. **Wildcard subdomains served by one Worker.** Yes, with a Worker **route** `*.<zone>/*` plus a **proxied wildcard DNS record** `*` in that zone. Workers Custom Domains do **not** support wildcards (one hostname per Custom Domain, max 100 per zone). Routes and wildcard DNS are available on the Free plan as far as the docs show (no plan gating listed for routes, custom domains or wildcard DNS). Confidence: **high** for the mechanics; **medium-high** for "Free" (inferred from absence of plan gating, not an explicit "Free: yes" line).
2. **TLS.** Confirmed: Universal SSL covers the zone apex and **one** level (`<zone>`, `*.<zone>`), not two levels. So if the sandbox zone is a plain registrable domain (`<hash>.<sandbox-zone>.tld`), Universal SSL already covers each hash. If the sandbox zone is itself a subdomain (`<hash>.views.example.com`), a two-level certificate is needed: **Advanced Certificate Manager (ACM)**, with `*.views.example.com` as a SAN (a wildcard covers one level only). Total TLS also requires ACM. **Cost:** ACM is a "Paid add-on" on every plan, but the docs I could fetch do **not** publish a price; confirm in the dashboard. Confidence: **high** on coverage; **low** on price. Alternative without ACM: a Custom Domain per hash (Cloudflare says the Custom Domain certificate covers multi-level hosts without ACM), but that needs one API call per MCP server and is capped at 100 Custom Domains per zone. Confidence: **medium-high**.
3. **workers.dev and the PSL.** Yes. `workers.dev` and `pages.dev` are both in the PSL's **PRIVATE** section. The public suffix of `<worker>.<account>.workers.dev` is `workers.dev`, so the registrable domain ("site") is **`<account>.workers.dev`**. Two Workers in one account are therefore **same-site** (though cross-origin). Wildcard sub-subdomains (`<hash>.<worker>.<account>.workers.dev`): **not documented**; the zone is Cloudflare-owned and the docs describe only `<worker>.<account>.workers.dev`. Treat as **not available** (unverified). `pages.dev`: same PSL entry; Pages custom domains do not support wildcards. Confidence: **high** on PSL and site computation; **medium** on "no wildcards" for workers.dev (absence of documentation).
4. **Cookie tossing / same-site.** Confirmed. RFC 6265 §4.1.2.3 says a `Domain=example.com` cookie is sent to `example.com`, `www.example.com` and `www.corp.example.com`, and the user agent "will reject cookies unless the Domain attribute specifies a scope ... that would include the origin server". Across registrable domains, the PSL is the guard: RFC 6265bis §8.9 says "The boundaries of cookies depend on a site's 'registrable domain' which in turn depends on the public suffix of the domain" and "Failure to do so could allow malicious or sensitive cookies to leak between registrable domains." Consequence for the design: all `<hash>.<sandbox zone>` origins share one site if the zone is a single registrable domain, so a View can tamper with cookies of sibling Views unless it only uses host-only or `__Host-` cookies. Confidence: **high**.
5. **Iframe permissions.** The W3C Permissions spec keys grants by the **top-level origin** by default: the default permission key algorithm "Return origin", called with `settings's top-level origin` as the origin argument. The Permissions Policy spec's own example says "users grant permissions to the domain they perceive they are interacting with in the browser, which is the top-level domain." Chromium's deprecation proposal says "permission prompts appear to be coming from the top-level origin." I did **not** find primary documentation for the exact Firefox or Safari behaviour; treat their behaviour as **unverified**. Practical rule: assume a grant made in an iframe on `<hash>.sandbox` is attributed to the embedding top-level origin (the host), so grants leak across Views of one host. Confidence: **high** for spec; **medium** for Chromium; **low** for Firefox and Safari.
6. **MCP Apps revisions.** The `specification/` directory contains exactly two entries: **`2026-01-26`** (dated, marked "Status: Stable (2026-01-26)") and **`draft`** (marked "Status: Draft"). No dated revision is newer than `2026-01-26`. Stable (`2026-01-26`) includes `ui/notifications/tool-input-partial`, host-initiated `ui/resource-teardown`, `tools/call`, and `UIResourceMeta.domain` (dedicated view origin). **Draft only:** `ui/download-file`, view-side sampling (`sampling/createMessage`, `hostCapabilities.sampling`), and View-initiated teardown (`ui/notifications/request-teardown`). Host→View tool invocation: no method for it appears in either revision (the host→View primitives are `tool-input`, `tool-input-partial`, `tool-result`, `tool-cancelled`, `host-context-changed`, `resource-teardown`). Confidence: **high** for the listing and method names; **medium** on "no host→View tools" (absence from a name grep, not a full read).

**Design implications (for the sandbox Worker):**

- The stable spec already defines the origin model: "The Host and the Sandbox MUST have different origins", and the sandbox needs `allow-scripts` and `allow-same-origin`. `UIResourceMeta.domain` is "Host-dependent" with examples like `a904794854a047f6.claudemcpcontent.com`, which matches the planned hash scheme.
- Use a sandbox zone whose registrable domain is **not** the production one (`ianpascoe.dev`), so Views are cross-site with `pi.ianpascoe.dev`.
- If the sandbox zone is a plain registrable domain, each hash is one level deep and Universal SSL covers it (no ACM).
- Set `__Host-` cookies for anything a View stores (RFC 6265bis §4.1.3 and §5.4: no `Domain` attribute), and never set `Domain=<sandbox zone>`.
- Do not rely on permission grants to isolate Views; they are per top-level origin.

## Details

### 1. Wildcard subdomains (Cloudflare)

- Routes: "Cloudflare evaluates Workers routes within the zone where you create them." Wildcard hostnames are supported: "If a route pattern hostname begins with `*.`, then it only matches all subhosts." Example: `*.example.com/*` matches `https://www.example.com/` but not `https://example.com/`. Source: https://developers.cloudflare.com/workers/configuration/routing/routes/
- The DNS prerequisite for routes: "All domains and subdomains must have a DNS record to be proxied on Cloudflare and used to invoke a Worker." Same source.
- Wildcard DNS: "To create a wildcard DNS record, create a DNS record with an `*` in the **Name** field." and "Customers on all plans can create and proxy wildcard DNS records." Source: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/
- Custom Domains: "Custom Domains do not support wildcard DNS records. An incoming request must exactly match the domain or subdomain your Custom Domain is registered to." Source: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Limits (single value per row, no plan split): Routes per zone 1,000; Custom domains per zone 100; Routed zones per Worker 1,000. Source: https://developers.cloudflare.com/workers/platform/limits/#routes-and-domains
- Plan: "By default, users have access to the Workers Free plan." Source: https://developers.cloudflare.com/workers/platform/pricing/ . Free-plan request cap: "daily request limit of 100,000 requests ... Error 1027" (https://developers.cloudflare.com/workers/platform/limits/).
- Note: Pages custom domains: "If your project is on Cloudflare Pages, note that wildcard custom domains are not supported." (wildcard DNS doc, above.)

### 2. TLS

- Universal SSL: "On a full setup, Universal SSL certificates cover your root domain (for example, `example.com`) and first-level subdomains (for example, `www.example.com`)." Source: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/
- Limitations: "Deeper subdomains — such as `dev.www.example.com` or `app3.dev.www.example.com` — are **not** covered and will not serve a valid certificate." Source: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
- Partial (CNAME) setup: "each proxied subdomain receives its own certificate regardless of depth." Source: universal-ssl page above.
- ACM: "To order advanced certificates, you must purchase the Advanced Certificate Manager add-on." Availability table: "Paid add-on" for Free, Pro, Business, Enterprise. Multi-level: "Wildcard certificates only cover **one subdomain level**: A certificate for `*.example.com` covers `www.example.com` ... but **not** `api.staging.example.com`. To cover multiple levels, you must explicitly add a wildcard for each level." Limit: "up to 50 hosts (SANs) total." Source: https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
- Total TLS: "Total TLS is available for domains that have purchased Advanced Certificate Manager and are currently using a full DNS setup." Individual certificates for proxied hostnames, 90-day validity. Source: https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
- Custom Domains: "This includes multi-level subdomains such as `realms.app.example.com`. Universal SSL covers the apex and one level of subdomain only ... The certificate generated for the Custom Domain covers it instead, and no separate Advanced Certificate Manager subscription is required." Source: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Price: not published in the pages fetched (ACM page, Cloudflare plans page). **Unverified**; check the dashboard.
- DCV note for wildcard certs on Universal: TXT validation; for Advanced: Delegated DCV is usually possible. Source: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/

### 3. workers.dev / pages.dev and the PSL

- PSL file: https://publicsuffix.org/list/public_suffix_list.dat (header: `// VERSION: 2026-10-28_13-15-55_UTC`). The ICANN section ends before `// ===BEGIN PRIVATE DOMAINS===`; the PRIVATE section contains, in order: `pages.dev`, `r2.dev`, `workers.dev` (near the Cloudflare entries, lines ~12760–12765 of the file). `example.com` is not an entry.
- Cloudflare's own description: "`workers.dev` subdomains take the format: `<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev`" and "All Workers are assigned a `workers.dev` route ... `<YOUR_WORKER_NAME>.<YOUR_SUBDOMAIN>.workers.dev`." Also: "Your `workers.dev` subdomain is treated as a Free website ... intended for personal or hobby projects that aren't business-critical." Source: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Site computation: RFC 6265bis §5.2: "A domain's 'registrable domain' is the domain's public suffix plus the label to its left." Example from the draft: for `https://www.site.example`, the public suffix is `example` and the registrable domain `site.example`. Applied: public suffix `workers.dev` → registrable domain `<account>.workers.dev`. Source: https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/ (Internet-Draft, Dec 2025, not yet an RFC).
- Cross-Worker communication: "On the same zone, the only way for a Worker to communicate with another Worker running on a route, or on a `workers.dev` subdomain, is via service bindings." Source: custom-domains page above.
- Chrome on subdomains: "Different subdomains ... are considered same-site but cross-origin." Source: https://developer.chrome.com/docs/privacy-security/permissions-policy
- Wildcard sub-subdomains on workers.dev: no documentation found. **Unverified / treat as unsupported.**

### 4. Cookies

- RFC 6265 §4.1.2.3 (https://www.rfc-editor.org/rfc/rfc6265.txt): "if the value of the Domain attribute is "example.com", the user agent will include the cookie in the Cookie header when making HTTP requests to example.com, www.example.com, and www.corp.example.com." And: "The user agent will reject cookies unless the Domain attribute specifies a scope for the cookie that would include the origin server."
- RFC 6265 note on public suffixes: "many user agents are configured to reject Domain attributes that correspond to 'public suffixes'. For example, some user agents will reject Domain attributes of 'com' or 'co.uk'." (§4.1.2.3, §5.3)
- RFC 6265bis (draft, https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/) §8.9: "Whenever possible, user agents SHOULD use an up-to-date public suffix list, such as the one maintained by the Mozilla project at [PSL]. Failure to do so could allow malicious or sensitive cookies to leak between registrable domains."
- RFC 6265bis §4.1.3 / §5.4: `__Host-` and `__Secure-` prefixes. Requirements are in the storage model (§5.7). **Note:** I cite §4.1.3 from the section list without re-quoting its text.
- Same-site: 6265bis §5.2 "Same-site" requests are defined by the SAMESITE criteria; §5.6.7 defines `SameSite`.

### 5. Permissions in iframes

- W3C Permissions (https://www.w3.org/TR/permissions/): "Let key be the result of generating a permission key for descriptor with settings's top-level origin and settings's origin." Default algorithm: "The default permission key generation algorithm, given an origin origin and an origin embedded origin, runs the following steps: Return origin." The stored grant key therefore uses the top-level origin. The spec notes custom key generation is possible per feature.
- W3C Permissions Policy (https://www.w3.org/TR/permissions-policy-1/): "Geolocation is disabled by default in all cross-origin frames... `<iframe src="https://other.com/map" allow="geolocation"></iframe>`". Its example: "This is necessary since users grant permissions to the domain they perceive they are interacting with in the browser, which is the top-level domain." And: "JSPlaygroundCorp should avoid iframing user-generated web applications using the allow attribute from its own domain in this case, as this would grant its domain permissions to all of them."
- Chromium (https://www.chromium.org/Home/chromium-security/deprecating-permissions-in-cross-origin-iframes/): "Often permission prompts appear to be coming from the top-level origin. As a result, users can be misled into granting permission to third-party content." and "even if a user has previously granted persistent permission to an origin, they are unlikely to be aware when that origin is loaded in an iframe."
- Chrome developer docs (https://developer.chrome.com/docs/privacy-security/permissions-policy): "Since the permissions applied to the parent page are delegated to the embedded iframes, the feature must be enabled for same-origin if the feature is to be allowed for cross-origin."
- Firefox and Safari: no primary source found in this research. Safari behaviour was reported in a Stack Overflow thread (2019, Safari 12.1 change, WebKit bug 210104), which is not primary. **Unverified.**

### 6. MCP Apps revisions (`github.com/modelcontextprotocol/ext-apps`)

- Listing: `specification/` → `2026-01-26` (dir) and `draft` (dir). API: https://api.github.com/repos/modelcontextprotocol/ext-apps/contents/specification?ref=main . Both contain a single `apps.mdx`.
- `specification/2026-01-26/apps.mdx`: `**Status:** Stable (2026-01-26)`. Source: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- `specification/draft/apps.mdx`: `**Status:** Draft`. Source: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx
- `ui/notifications/tool-input-partial`: in stable (`- Host MAY send this notification zero or more times while the agent is streaming tool arguments, before ui/notifications/tool-input is sent.`). In draft too.
- `ui/download-file`: **draft only** (`ui/download-file` - Request host to download a file; capability `downloadFile`).
- View sampling (`sampling/createMessage`, `hostCapabilities.sampling`): **draft only**. The stable file mentions "sampling" only as future compatibility prose.
- View-initiated teardown (`ui/notifications/request-teardown`, "View requests host to tear it down"): **draft only**. Stable has host-initiated `ui/resource-teardown` ("Host notifies View before teardown").
- Host→View tools: no such method in stable or draft by name search. Stable host→View notifications: `tool-input`, `tool-input-partial`, `tool-result`, `tool-cancelled`, `host-context-changed`, `resource-teardown`, `sandbox-resource-ready`. Confidence **medium** (not a full read).
- Sandbox requirements (stable): "1. The Host and the Sandbox MUST have different origins. 2. The Sandbox MUST have the following permissions: `allow-scripts`, `allow-same-origin`." and the sandbox "MUST load the raw HTML of the View with CSP settings that: Enforce the domains declared in `ui.csp` metadata ... Block dangerous features (`object-src 'none'`)." Source: stable apps.mdx, "Sandbox proxy" section.
- Dedicated origin (stable): `UIResourceMeta.domain?: string` — "Optional domain for the view's sandbox origin... **Host-dependent:** The format and validation rules for this field are determined by each host... Hash-based subdomains (e.g., `{hash}.claudemcpcontent.com`)." Same file.
- Draft `ui/notifications/request-teardown` text: "This enables View-initiated teardown flows (e.g., user clicks a 'Done' button in the View)." Source: draft apps.mdx.

## Open items

- Confirm ACM price in the Cloudflare dashboard before deciding between ACM and per-hash Custom Domains.
- Test whether a `*` proxied record plus route `*.<zone>/*` is accepted on the Free plan (not documented as explicitly allowed).
- Check Firefox and Safari behaviour for iframe permission keys directly (MDN compat, WebKit / Mozilla sources) before relying on per-View isolation.
- Decide whether the sandbox zone should be its own registrable domain (recommended; see Answers, Design implications).
