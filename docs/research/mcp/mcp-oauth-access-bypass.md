# Can two paths of the main Worker's host bypass Access? (MCP OAuth sign-in)

Research date: 2026-10-30. Question: cloudpid's main Worker sits behind the Access application that alchemy's `access` prop creates. The MCP OAuth sign-in needs `GET /oauth/mcp/client.json` (a Client ID Metadata Document, fetched server-to-server by the authorization server) and `GET /oauth/mcp/callback` reachable without Access. The plan is a second `self_hosted` Access application on those two paths with a Bypass ("Everyone") policy. Does that work on `pi.ianpascoe.dev` and on `*.workers.dev`, how do I declare it in alchemy, and does bot or WAF protection get in the way?

Labels: **[V]** verified against a primary source (cited), **[E]** verified by an experiment I ran, **[I]** inference, **[?]** unknown. No experiment was run: nothing was deployed and no Cloudflare resource was created, so there is no **[E]** in this file. Sources are Cloudflare's docs, Cloudflare's API reference, Cloudflare's changelog, and alchemy's source (`@alchemy.run/cloudflare` 2.0.0-beta.84, the repo's pinned version) and docs.

## Answer in brief

1. **Custom domain (`pi.ianpascoe.dev`): yes, a path-scoped self-hosted application beats the Worker-level one, and Bypass skips the identity check entirely.**
   - Precedence is "most specific first": hostname/path application, then Worker-level application, then account-level (`all_workers`) application [V: [Workers → Cloudflare Access → Understand Access hierarchy](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)]. The API reference says the same: "The `preview_worker` and `public` destination types takes precedence, so you can create separate applications to override the policies for the Worker's previews or specific paths" [V: [Add an Access application](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/), `WorkerDestination`].
   - Bypass "disables Access enforcement for specific traffic" and "does not enforce any Access security controls and requests are not logged" [V: [Access policies → Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)], so a cookie-less server-to-server GET passes [I: follows from the Bypass definition; no doc walks through a cookie-less fetch, and I did not run one].
   - A trailing wildcard works syntactically, but prefer two exact destinations. Query strings are not part of the path match, so they cannot break an exact destination [I]. Application paths do not support query strings in a destination at all [V: [Application paths → Unsupported URLs](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)]. A public destination's `host/path` implicitly covers sub-paths [V: API reference, `DestinationOverride.path_pattern`], so `pi.ianpascoe.dev/oauth/mcp/callback` alone covers `/oauth/mcp/callback/...`.
2. **`*.workers.dev`: yes, the same mechanism works, and Cloudflare documents it.**
   - The Workers docs say hostname-based Access can protect "a `workers.dev` hostname, a Custom Domain, a subdomain, or a path", with `my-worker.example.workers.dev` as the example, and that it "applies first" over Worker-level Access [V: [Workers → Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)].
   - Worker-level Access itself has no path exemption in the dashboard flow. The API does: a `worker` destination takes `overrides: [{ behavior: "public", path_pattern }]`, "supported for public destinations and Worker destinations" [V: API reference]. That is a second way to open the two paths, with no second application, and it works the same on both host types.
   - Not verified: that the self-hosted-application page's "Domains must belong to an active zone in your Cloudflare account" is satisfied by a `workers.dev` hostname. The Workers page says it is, and the self-hosted page predates it [?: no doc shows the API accepting a `workers.dev` `uri`; check with one non-prod stage before relying on it].
3. **alchemy**:
   - `access: { policies }` creates one `self_hosted` Access application per Worker (`<Worker>/Access`) and enrolls the Worker by pushing `worker` and `preview_worker` destinations (by `workerId`) onto it [V].
   - Declare the extra application with `Cloudflare.Access.Application("McpOAuthPublic", { type: "self_hosted", destinations: [{ type: "public", uri: "<host>/oauth/mcp/client.json" }, ...], policies: [{ decision: "bypass", include: ["everyone"] }] })` [V: types and examples in `Access/Application.ts`, `Access/Policy.ts`].
   - alchemy's docs and source both say "Hostname policies beat Worker policies beat account policies" [V].
   - alchemy's `ApplicationDestination` type does **not** expose `overrides`, so the override route needs a cast or an upstream change [V].
4. **Bot Fight Mode / Super Bot Fight Mode / WAF managed rules**:
   - Bot Fight Mode "may challenge API or mobile app traffic" and **cannot be skipped** by WAF custom rules or Page Rules (Free plan).
   - Super Bot Fight Mode, managed rules and rate limiting are exempted with a WAF custom rule with the Skip action, scoped by an expression on host and path.
   - Access Bypass does not turn any of these off (it only disables Access; "security settings revert to the defaults configured for the zone") [V].
   - Whether zone-level bot and WAF products apply to `*.workers.dev` is not stated in any page I read [?].

Side finding that matters for the plan: Cloudflare documents that **Worker-level Access policies do not support WebSocket connections** (upgrade requests get a 403) and says to use a hostname-based application instead [V: Workers → Cloudflare Access → Protect one Worker]. alchemy's `access` prop is exactly a Worker-level (`worker` destination) application [V]. I did not check whether cloudpid's main Worker receives WebSocket upgrades; if it does, that is a separate problem from this ticket (see [Side finding: WebSockets](#side-finding-websockets)).

## 1. Custom domain: precedence, Bypass, wildcards

### What alchemy attaches [V]

`apps/server/src/deployment.ts` passes `access: { policies: [{ decision: "allow", include: [{ email: OWNER_EMAIL }] }] }` and, for `prod`, `domain: "pi.ianpascoe.dev"`. alchemy turns that into an application of `type: "self_hosted"` with `destinations: [{ type: "worker", workerId }, { type: "preview_worker", workerId }]` and no hostname (`Workers/WorkerAsyncBindings.ts`, "Access enrollment (`access` prop)" block: `Application("Access", { type: "self_hosted", policies, ... })` then `application.bind("enroll:...", { destinations: [worker, preview_worker] })`). So the main Worker's Access application is a **Worker-level** application, not a hostname one.

Cloudflare's wording for the same thing: a `worker` destination "automatically protects every domain associated with the Worker, including its routes, Custom Domains, `workers.dev` hostname, and previews" [V: [Workers → Cloudflare Access → Protect one Worker](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)].

### Precedence [V]

From the same page, "Understand Access hierarchy":

> A Worker can be protected by more than one Access rule. When multiple rules could apply to the same request, the most specific rule takes effect first:
> 1. **Hostname or path-based Access**: Applies first when the request matches that hostname or path, such as `admin.example.com` or `example.com/login`.
> 2. **Worker-level Access**: Applies next for the selected Worker across its routes, Custom Domains, `workers.dev` hostname, and previews.
> 3. **Account-level Worker Access**: Applies last as the fallback for all Workers or all Worker previews on the account.
>
> … If a matching hostname or path-based Access app also exists, that hostname or path rule controls the matching URL.

The API reference states the rule on the destination type: the `worker` destination "will be protected … The `preview_worker` and `public` destination types takes precedence, so you can create separate applications to override the policies for the Worker's previews or specific paths" ([Add an Access application](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/), `WorkerDestination`). The `public` destination is what a `host/path` entry of a self-hosted application becomes.

Among hostname/path applications, "when multiple rules are set for a common root path, the more specific rule takes precedence" and nothing is inherited from the broader one ([Application paths → Policy inheritance](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)) [V]. So `pi.ianpascoe.dev/oauth/mcp/client.json` wins over the Worker-level application for that URL, and every other path keeps the owner-only policy.

The Cloudflare changelog entry that introduced Worker-level Access ([2026-08-14](https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/)) says only that Access "attaches the policy to the Worker itself" and that a Worker-level bypass can exempt a Worker from an account-level application. It does not describe hostname-vs-Worker precedence [V]; the docs page above is the source for it.

### Does Bypass skip the identity check? [V+I]

- "The Bypass action in Cloudflare Access disables Access enforcement for specific traffic." "Bypass does not enforce any Access security controls and requests are not logged." Bypass policies "do not support identity-based rule types" ([Access policies → Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)) [V].
- The page's own example is a public `/admin/...` endpoint inside an otherwise protected app: an application on `test.example.com/admin/<your-url>` with Bypass, Include, Everyone [V]. That is the plan's shape.
- The policy order of execution puts "Bypass and Service Auth policies … evaluated first" [V]. An Everyone Bypass therefore matches before any login is considered [I].
- A request with no cookie and no service token gets through, because no check is run [I]. Not shown by a doc example or by me.
- The Worker then sees no `ctx.access` on those requests ("`ctx.access` is `undefined` if Access did not authenticate the request", Workers → Cloudflare Access) [V]. cloudpid's handlers for the two paths must not require it, and the rest of the Worker should keep treating a missing `ctx.access` as unauthenticated [I].
- "When applying a Bypass action, security settings revert to the defaults configured for the zone and any configured Page Rules", and HTTP→HTTPS follows the zone's "Always use HTTPS" [V]. Both URLs are HTTPS already.

### Wildcards, query strings and sub-paths

- **Query strings**: "Query strings (such as `?foo=bar`) are not supported in Access application paths" (Application paths → Unsupported URLs) [V]. That is about what you can write in a destination. That the request's query is ignored when matching the path is [I]: the callback's `?code=…&state=…&iss=…` does not need a wildcard.
- **Sub-paths**: for a public destination, `host/path` implicitly covers sub-paths; override `path_pattern`s do not ("Unlike the `uri` in public destinations, override path patterns do not implicitly cover subpaths; to do that, use a wildcard") [V: API reference]. This agrees with the app-paths page where `example.com` or `example.com/*` covers every path, and `example.com/alpha/*` covers `alpha/one` but **not** `alpha` itself [V].
- **Trailing wildcard in a segment**: allowed syntactically ("at most one wildcard in between each slash in the Path"); the docs' example is a mid-path `example.com/foo*/bar`, which "covers multiple segments" [V]. They give no example of a trailing `callback*`. By analogy it matches `/oauth/mcp/callback`, `/oauth/mcp/callbackX` and probably `/oauth/mcp/callback/x` [I]. A wildcard widens what is public, with no benefit here, so use the exact paths:
  - `pi.ianpascoe.dev/oauth/mcp/client.json`
  - `pi.ianpascoe.dev/oauth/mcp/callback`
- Port numbers and `#` anchors are not supported in destinations (same page) [V]. Path matching is case-sensitivity-unspecified [?]; the routes are lowercase.

## 2. `*.workers.dev`

### Hostname/path applications on workers.dev [V, one gap]

The Workers page lists, as an option to protect, "A specific hostname — can be `workers.dev`, a Custom Domain, or a path", and says: "Use hostname-based Access when only a specific URL that routes to your Worker should require sign-in, such as a `workers.dev` hostname, a Custom Domain, a subdomain, or a path … For example with hostname-based Access, you can protect `my-worker.example.workers.dev`, `admin.example.com`, or a single path such as `example.com/login` to make only part of your Worker private" ([Workers → Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)). The hierarchy says the hostname/path rule "applies first" and the Worker-level rule applies "across its routes, Custom Domains, `workers.dev` hostname, and previews" [V].

So for `<worker>.<subdomain>.workers.dev/oauth/mcp/callback` a `self_hosted` application with a `public` destination of exactly that string, plus Bypass, should win over the Worker-level application [V for the documented precedence; the mechanism for a `workers.dev` `uri` has not been run, see below].

Gap [?]: the self-hosted application guide says "Domains must belong to an active zone in your Cloudflare account" ([Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)); `workers.dev` is not a zone in the account. The Workers page is newer (Oct 2026 vs Apr 2026) and lists `workers.dev` explicitly. I found no page that shows the create call with a `workers.dev` `uri` succeeding. Check with one `dev_$USER` or preview stage before relying on it.

Per-stage cost [I]: the hostname includes the stage's Worker name, so each `dev_$USER` and `pr-<n>` stage needs its own destinations, built from the Worker's `url`. A stage that cannot resolve its URL at plan time needs the override route below, which is keyed by `workerId`, not hostname.

### Does Worker-level Access itself exempt paths? [V]

- In the dashboard flow, no: the Worker-level options are Previews only / All traffic, and a Worker-level bypass that makes the **whole Worker** public (Workers → Cloudflare Access → "Make a Worker public when all Workers are protected").
- In the API, yes. Each destination of a `self_hosted` application takes `overrides: [{ behavior: "public", path_pattern: "/oauth/mcp/client.json" }]`: "Each rule can make a matching path public, bypassing Access authentication. Overrides are supported for public destinations and Worker destinations. … Wildcards (`*`) are supported, but each path segment may have at most one wildcard" (API reference; present on `worker`, `preview_worker`, `all_workers`, `all_preview_workers` and `public` destinations) [V]. The Workers docs page does not mention overrides [V: absent].
- Override vs second-application, side by side [I]:

| | Second `self_hosted` application, `public` destinations + Bypass policy | `overrides` on the `worker` destination |
| --- | --- | --- |
| Documented on Workers docs page | Yes (hierarchy section) | No (API reference only) |
| Works on `pi.ianpascoe.dev` and `workers.dev` alike | Yes, if `workers.dev` `uri` is accepted [?] | Yes, keyed by `workerId` [I] |
| Needs hostname at plan time | Yes | No |
| Bypass policy to declare | Yes | No (`behavior: "public"`) |
| In alchemy 2.0.0-beta.84 | Yes, as a normal resource | Not exposed (type has no `overrides`) |
| Logged | Bypass "requests are not logged" | Not documented [?] |

### Alternatives if neither works [I]

1. **Serve the two public paths from a separate Worker with no `access` prop** (own `workers.dev` hostname, and for `prod` its own custom domain or a route). `redirect_uri` and the CIMD URL then live on a different origin from the web app. A redirect URI on another origin cannot rely on the app's `CF_Authorization` cookie, but the callback does not need it if the other Worker only stores the code and `state` and the main Worker, behind Access, picks them up (a design change, not researched here). Never leave a public Worker's route that forwards to the Access-protected Worker: Access does not propagate through Service Binding calls ("`ctx.access` … does not propagate through Service Binding HTTP requests or RPC", Workers → Cloudflare Access) [V], and the public Worker has to authenticate the call itself.
2. **Do not use Worker-level Access on non-`prod` stages**; protect the stage's hostname with a hostname application whose destinations are the Worker's host minus the two paths. Access applications have no "exclude path" and more-specific-wins is the only mechanism [V: Application paths], so this means listing every path, which does not work for a catch-all `/*` host. Not recommended.
3. **Application-level auth for the two paths** (ADR-0025 anticipated a webhook bypass): leave them public and have the Worker authenticate the request itself (the CIMD document is public by design; the callback checks a `state` that only the owner's sign-in could have created) [I].

## 3. alchemy

Source: `node_modules/.bun/@alchemy.run+cloudflare@2.0.0-beta.84+42fe2cbb58eea9e3/node_modules/@alchemy.run/cloudflare/src/` (the repo pins `alchemy` and `@alchemy.run/cloudflare` to `2.0.0-beta.84`; `patches/@alchemy.run__cloudflare@2.0.0-beta.84.patch` does not touch Access [V: `grep -c Access` is 0]). Paths below are relative to that `src/`.

### What `access` creates [V]

- `Workers/Worker.ts` (prop `access?: WorkerAccessConfig`, ~l.578-610) and `Workers/WorkerAccess.ts` (`WorkerAccessConfig = Application | WorkerAccessApplication`).
- Dedicated form `{ policies, name?, sessionDuration?, allowedIdps?, autoRedirectToIdentity?, appLauncherVisible?, previews? }` is turned into `Application("Access", { type: "self_hosted", name, policies, sessionDuration, allowedIdps, autoRedirectToIdentity, appLauncherVisible })` in the Worker's namespace (`<Worker>/Access`), by `bindWorkerAsyncBindings` in `Workers/WorkerAsyncBindings.ts` (the "Access enrollment" block, ~l.84-135).
- It then calls `application.bind("enroll:<FQN>", { destinations: [{ type: "worker", workerId }, ...(previews ? [{ type: "preview_worker", workerId }] : [])] })`. `Application.reconcile` (`Access/Application.ts` ~l.676-686) appends the bound destinations to the declared `destinations`.
- Skipped in `alchemy dev` (local mode): "Access cannot front a localhost URL" (same block).
- No `domain` or `public` destination is set: the application has only Worker destinations. cloudpid's `deployment.ts` therefore creates a Worker-level application on every stage [V], which is why the precedence rules for `worker` destinations are the ones that apply.

### Declaring an extra application and Bypass policy [V for the API; I for the exact call]

`Access/Application.ts`:

- `ApplicationDestination` (l.58-72): `{ type: "public"; uri: string } | { type: "private"; … } | { type: "worker"; workerId } | { type: "preview_worker"; workerId } | { type: "all_workers" } | { type: "all_preview_workers" } | …`. The doc comment on `public` is "a public hostname/URI you own in Cloudflare (the legacy `domain` field … covers the simple case)".
- `ApplicationProps` has `type`, `domain`, `destinations`, `policies`, `name`, `sessionDuration`, … (l.170-205). `policies` accepts inline bodies `{ decision, include, … }`, reusable `Cloudflare.Access.Policy` resources, or ids; inline and reusable cannot be mixed on one application (l.270-320, enforced in `reconcile`).
- `Access/Policy.ts`: `PolicyDecision` includes `"bypass"` ("skip Access entirely", l.133-140); the `everyone` rule has the bare-string spelling `"everyone"` (→ `{ everyone: {} }`, l.42, l.100).

```ts
// infra: same stack as the main Worker, after `deployment(stage)`
const host = stage === "prod" ? PRODUCTION_DOMAIN : `${workerName}.${accountSubdomain}.workers.dev`;

yield* Cloudflare.Access.Application("McpOAuthPublic", {
  type: "self_hosted",
  name: `cloudpid ${stage} MCP OAuth (public)`,
  destinations: [
    { type: "public", uri: `${host}/oauth/mcp/client.json` },
    { type: "public", uri: `${host}/oauth/mcp/callback` },
  ],
  policies: [{ decision: "bypass", include: ["everyone"] }],
});
```

- `host` must be known at plan time: `PRODUCTION_DOMAIN` for `prod`; for `workers.dev` stages it is `<name>.<account subdomain>.workers.dev` [I]. Whether the Worker's `url` output can feed a `uri` string is not checked [?].
- Application `domain` + `destinations` are not mutually exclusive: "Cloudflare treats `domain` as a shorthand for adding a single `{ type: "public" }` destination" (l.186-196). Use `destinations` for two paths.
- Drift: `Application.reconcile` compares `JSON.stringify(desired.destinations)` against the observed list (l.1568-1578) [V]; order matters, so keep the destination order stable.
- Unlike the Worker's application, a standalone `Application` has no automatic enrollment, so it never receives `worker`/`preview_worker` destinations [V: only `bind` from `access` adds them].

### `overrides` on the Worker destination [V that it is missing]

The SDK alchemy builds on (`@distilled.cloud/cloudflare` 1.0.0-rc.17, `src/services/zero_trust.ts`) has `overrides?: [{ behavior: "public", pathPattern }]` on its destination types, but alchemy's own `ApplicationDestination` (above) has no `overrides` field, and the Worker's enrollment builds `{ type: "worker", workerId }` without one. Using overrides would need either an upstream alchemy change or a cast on the application's `destinations`; the Worker's enrolled destination is generated inside alchemy and cannot take it [V]. [?] whether `toAttributes`/drift checks keep unknown fields.

### Does alchemy say hostname beats Worker? [V]

Yes, twice:

- `Access/Application.ts` l.53-56 (doc on `ApplicationDestination`): "`all_workers` / `all_preview_workers` — every Worker on the account … Hostname-level policies take precedence over Worker-level policies, which take precedence over these account-level policies." l.508-512 repeats it in the `AllWorkers` example.
- `Access/WorkerDestination.ts` (doc on `AllWorkers`): the same sentence, "so an individual Worker can still be opened up with its own application".
- alchemy's guide [Protect a Worker with Access](https://v2.alchemy.run/cloudflare/security/access/): "Hostname policies beat Worker policies beat account policies, so an individual Worker can still be opened up (or locked down tighter) with its own application." and "`access` is `undefined` when the request did not come through Cloudflare Access (for example a route you deliberately left open)."
- These sentences are about the account-level example; alchemy has no doc or code for a hostname application layered on a Worker's own application [V: absent]. Cloudflare's page is the authority for that case (section 1).

## 4. Bot Fight Mode, Super Bot Fight Mode, WAF managed rules

Brief, only what the docs say [V]:

- **Bot Fight Mode** (Free): "they may challenge API or mobile app traffic". It "cannot be customized, adjusted, or reconfigured via WAF custom rules", and "You cannot bypass or skip Bot Fight Mode using WAF custom rules or Page Rules … Skip, Bypass, and Allow actions have no effect"; for exceptions "use Super Bot Fight Mode instead" ([Bot Fight Mode → Limitations](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)). The Skip-action page repeats "you cannot skip Bot Fight Mode" ([WAF custom rules → Skip](https://developers.cloudflare.com/waf/custom-rules/skip/)). If the zone has it on, a server-to-server GET without a browser fingerprint (an authorization server's fetcher) can be challenged on the bypassed path and Access Bypass cannot prevent that. The only documented remedies are turning it off for the zone or moving to Super Bot Fight Mode [V].
- **Super Bot Fight Mode** (Pro and up): "Custom rules are executed before Super Bot Fight Mode"; to exempt a path, make a custom rule with the Skip action that skips "All Super Bot Fight Mode rules" (API: `phases: ["http_request_sbfm"]`) ([SBFM → Configure exceptions](https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/), [Skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/)). The same page says "Definitely automated" traffic can be set to Allow, and "Use the Rules language … to configure a scoped rule for approved automated traffic".
- **Managed rules, rate limiting**: the same Skip action, phases `http_request_firewall_managed` (managed rules) and `http_ratelimit` (rate limiting); "Skipping a phase does not skip security products that run outside the Ruleset Engine, such as Browser Integrity Check or Zone Lockdown" (use "Skip products", API `products`) ([Skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/)). Managed rules examples: "exempt an internal monitoring service from Managed Rules" (Skip page).
- A scoped skip rule for the two paths, expressed as a Rules-language expression, would be on the lines of `http.host eq "pi.ianpascoe.dev" and http.request.uri.path in {"/oauth/mcp/client.json" "/oauth/mcp/callback"}` [I: built from the documented `http.host` and `http.request.uri.path` fields, which the rate-limiting troubleshooting page names; not run].
- **Does any of this apply to `*.workers.dev`?** Zone settings (Bot Fight Mode, custom rules) belong to a zone; a `workers.dev` hostname is not in the account's zones. The Workers docs say it is "treated as a Free website" (workers.dev page) [V], which is not an answer. No page I read says whether zone-level bot or WAF products run on it [?]. Verify by fetching a bypassed `workers.dev` URL with a bare HTTP client on a test stage before concluding.
- **The callback** is a browser navigation, so it behaves as normal browser traffic for bot products [I]. The CIMD fetch is the one at risk.

## Side finding: WebSockets

[V] "Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a `403` error. If your Worker uses WebSockets (including Durable Objects, real-time applications …), protect it with a hostname-based Access application instead" ([Workers → Cloudflare Access → Protect one Worker](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)). The `access` prop is a Worker-level application (section 3). Whether the main Worker accepts WebSocket upgrades was not checked here: `grep -rli websocket apps/*/src` finds only `apps/browser` (the CDP socket of the browser Worker) and the architecture docs describe Container WebSockets. [?] If the client protocol uses a WebSocket on the main Worker, the existing Access setup has this limit, and the fix for it (a hostname-based application) would also make precedence over the two bypassed paths a hostname-vs-hostname question, answered by the "more specific path wins" rule in section 1.

## Recommended shape [I]

- `prod`: add the `McpOAuthPublic` application with two exact `public` destinations on `pi.ianpascoe.dev` and one Bypass/Everyone policy. The precedence rule is documented and covers the case.
- Other stages: try the same application with the `workers.dev` hostname on one stage first. If Cloudflare rejects a `workers.dev` `uri`, fall back to `overrides` on the `worker` destination (needs an alchemy change or cast) or serve the two paths from an Access-free Worker.
- Keep the two routes' handlers free of `ctx.access` assumptions, and make the Access-free callback check the `state` it issued.
- Before relying on a bypassed path for the CIMD fetch, check the zone's Bot Fight Mode / Super Bot Fight Mode setting (the one product with no documented skip is Bot Fight Mode).

## Sources

- Cloudflare Workers docs: [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) (updated 2026-10-12), [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
- Cloudflare One docs: [Policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/), [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Self-hosted public app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).
- Cloudflare API reference: [Add an Access application](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/) (`destinations`, `WorkerDestination`, `DestinationOverride`).
- Cloudflare changelog: [2026-08-14, You can now enable Access on a Worker or all Workers at once](https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/).
- Cloudflare bots and WAF docs: [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/), [Super Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/), [Skip action](https://developers.cloudflare.com/waf/custom-rules/skip/), [Skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/).
- alchemy: `@alchemy.run/cloudflare` 2.0.0-beta.84 `src/Access/Application.ts`, `src/Access/Policy.ts`, `src/Access/WorkerDestination.ts`, `src/Workers/WorkerAccess.ts`, `src/Workers/WorkerAsyncBindings.ts`, `src/Workers/Worker.ts`; `@distilled.cloud/cloudflare` 1.0.0-rc.17 `src/services/zero_trust.ts`; docs [Protect a Worker with Access](https://v2.alchemy.run/cloudflare/security/access/).
- Repo: `apps/server/src/deployment.ts`, `docs/architecture/operations.md`.
