---
status: accepted
---

# App Views run in a public, secretless sandbox on a domain of their own, one origin per Environment's MCP server

An MCP App is a third party's HTML, and the MCP Apps spec requires a web host to run it in a proxy iframe on an origin other than its own, with the content security policy the server declares. So App Views run on `ianpascoe.app`, a registrable domain kept for nothing else, served by one public sandbox Worker for every stage (a Worker route on `*.ianpascoe.app` with a wildcard DNS record, covered by Universal SSL). Each View's origin is `<hash>.ianpascoe.app` (`<hash>--<stage>.ianpascoe.app` off prod), where the hash is of the Environment, the server's source (the owner's Settings or a Repo) and its name, so Views of different servers, Environments or Repos never share storage, and editing a server's URL or headers keeps its Views' storage. The Worker serves only the spec's proxy page: no Access, no cookie read or set, no secret, its CSP sent as a header never looser than the server's `ui.csp` and never naming cloudpid's own hosts, and framing allowed only from that stage's app origin. The View's HTML and all its traffic go through the owner's Session socket, never from the sandbox to cloudpid.

## Considered options

- **A subdomain of `ianpascoe.dev`** (`*.sbx.ianpascoe.dev`): same-site with the app and the model proxy, so a View could set `Domain=ianpascoe.dev` cookies that shadow the Access cookie on `pi.ianpascoe.dev`, browsers would put Views in the app's process, and a two-level wildcard needs Advanced Certificate Manager ($10 a month).
- **A sandbox on each stage's `workers.dev`**: `workers.dev` is a public suffix whose sites are accounts, so it is same-site with that stage's own app, with the same cookie risk, and `workers.dev` documents no wildcard subdomains for per-server origins.
- **Inside the Access application**: puts the Access cookie on the sandbox, and needs third-party cookies in an iframe, which iOS and installed web apps drop.
- **An opaque-origin `srcdoc` iframe with a `<meta>` CSP**: breaks the spec's requirements for a separate origin and a header CSP.
- **Honouring a server's requested `_meta.ui.domain`**: would let two servers claim one origin and read each other's storage.

## Consequences

- `ianpascoe.app` must never host anything else: whatever it served would be same-site with untrusted Views.
- Views of different servers share one site, so one could set cookies the other's own scripts read; the sandbox reads none, and Views' backends are on their own sites.
- A change to the proxy page is only tried on a deployed stage once it is merged; `alchemy dev` serves it from a second local port with one shared origin.
