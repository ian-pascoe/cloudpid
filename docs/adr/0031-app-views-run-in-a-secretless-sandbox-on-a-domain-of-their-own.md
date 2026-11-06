---
status: accepted (non-prod app origins and the sandbox's owner: amended by #421; one origin per Session for Visuals: amended by ADR-0045)
---

# App Views run in a public, secretless sandbox on a domain of their own, one origin per Environment's MCP server

An MCP App is a third party's HTML, and the MCP Apps spec requires a web host to run it in a proxy iframe on an origin other than its own, with the content security policy the server declares. So App Views run on `ianpascoe.app`, a registrable domain kept for nothing else, served by one public sandbox Worker for every stage (a Worker route on `*.ianpascoe.app` with a wildcard DNS record, covered by Universal SSL). Each View's origin is `<hash>.ianpascoe.app` (`<hash>--<stage>.ianpascoe.app` off prod), where the hash is of the Environment, the server's source (the owner's Settings or a Repo) and its name, so Views of different servers, Environments or Repos never share storage, and editing a server's URL or headers keeps its Views' storage. The Worker serves only the spec's proxy page: no Access, no cookie read or set, no secret, its CSP sent as a header never looser than the server's `ui.csp` and never naming cloudpid's own hosts, and framing allowed only from that stage's app origin. The View's HTML and all its traffic go through the owner's Session socket, never from the sandbox to cloudpid.

The sandbox learns a stage's app origin from its own hostname alone. `<hash>` is prod's, `https://pi.ianpascoe.dev`. `<hash>--<label>` is the stage whose label it is: the stage lowercased, `_` made `-`, at most 35 characters. A stage whose label would be empty, longer, start or end with `-`, or hold other characters fails its deploy instead of being truncated. Every non-prod stage names its main Worker `cloudpid-server-<label>`, so its app origin is `https://cloudpid-server-<label>.<account subdomain>.workers.dev`; prod keeps the name alchemy gave it. A hostname that doesn't parse gets a 404. Only the `prod` stage deploys the sandbox Worker, its route and the wildcard record; every other stage frames prod's sandbox.

## Considered options

- **A subdomain of `ianpascoe.dev`** (`*.sbx.ianpascoe.dev`): same-site with the app and the model proxy, so a View could set `Domain=ianpascoe.dev` cookies that shadow the Access cookie on `pi.ianpascoe.dev`, browsers would put Views in the app's process, and a two-level wildcard needs Advanced Certificate Manager ($10 a month).
- **A sandbox on each stage's `workers.dev`**: `workers.dev` is a public suffix whose sites are accounts, so it is same-site with that stage's own app, with the same cookie risk, and `workers.dev` documents no wildcard subdomains for per-server origins.
- **Inside the Access application**: puts the Access cookie on the sandbox, and needs third-party cookies in an iframe, which iOS and installed web apps drop.
- **An opaque-origin `srcdoc` iframe with a `<meta>` CSP**: breaks the spec's requirements for a separate origin and a header CSP.
- **Honouring a server's requested `_meta.ui.domain`**: would let two servers claim one origin and read each other's storage.
- **The stage's app origin in the sandbox's URL**: any page could name itself and frame a View, the attack `frame-ancestors` exists to stop.
- **`frame-ancestors https://*.<account subdomain>.workers.dev` off prod**: admits every Worker on the account, the `codemode` sandbox and other projects included.
- **A registry of stage origins written by each deploy**: a store prod owns and previews must find, a read on every View load, and stale entries whenever a destroy fails, for what a pure function of the hostname gives.
- **Checking the request's `Referer` against the main Worker's name pattern**: fails whenever a browser or extension strips the `Referer`.
- **A sandbox per stage on `*--<label>.ianpascoe.app/*`**: would bind each stage's exact URL and let previews try sandbox changes, but gives a token any branch can use route permissions on the zone and leaves a Worker and a route for every destroy to clean up.
- **Renaming prod's main Worker too**: a renamed Worker is replaced, destroying its Durable Objects' storage, and prod's origin is its custom domain anyway.

## Consequences

- `ianpascoe.app` must never host anything else: whatever it served would be same-site with untrusted Views.
- Views of different servers share one site, so one could set cookies the other's own scripts read; the sandbox reads none, and Views' backends are on their own sites.
- A change to the proxy page, or to how a hostname maps to an app origin, is only tried on a deployed stage once it is merged; `alchemy dev` serves it from a second local port with one shared origin.
- Open previews frame prod's sandbox, so the label rule and the mapping change only additively: the sandbox accepts the old and new forms until no preview uses the old one. Changing the label rule renames every non-prod main Worker again.
- Giving an existing non-prod stage its fixed name replaces its main Worker and wipes its Durable Objects once; a `dev_$USER` stage is destroyed and redeployed rather than redeployed.
- The account's workers.dev subdomain is a constant, and every deploy checks its main Worker's URL against the derived app origin.
- The prod deploy token holds Zone Read, DNS Write and Workers Routes Write on `ianpascoe.app`; the preview token holds nothing on it.
