# Visuals

A **Visual** is a page the agent writes and shows the owner inline in a conversation (a chart, a diagram, an explainer, a mockup), on desktop and phone: the Session keeps it as it was shown, outside History, so it shows the same after a reload, on another device, in a Fork or Clone and in an archived Session, and it runs in the App sandbox, display only, unable to call tools or tell the model anything. Visuals are first-party and kept apart from MCP Apps, sharing only the App sandbox and the frame's components ([ADR-0046](../adr/0046-visuals-are-first-party-and-kept-apart-from-mcp-apps-sharing-only-the-app-sandbox-and-the-frames-components.md)), and run at one origin per Session with no connections and resources only from cdnjs and Google Fonts ([ADR-0045](../adr/0045-visuals-run-in-the-app-sandbox-one-origin-per-session-with-no-connections-and-resources-only-from-cdnjs-and-google-fonts.md)). The idea is T3 Code's `html_render`, which shows an agent's finished HTML page inline in its thread; before Visuals, the agent's HTML could not be seen in cloudpid at all.

- **Done for v1:** a Visual shows inline where its call is, fits its content, follows the theme live, looks the same after a reload, on another device, in a Fork or Clone and archived, cannot reach cloudpid, can be checked by the agent before it is shown, can pop out into a Visual Pane, and is written by `/export` and `session_transcript` as "Visual: <title> — <summary> (not rendered)". Desktop-only or client-cached Visuals were rejected: cloudpid is always on and used from a phone.
- **Out of scope:** general apps and mini-apps that drive the Session (that is MCP Apps' job, and would double the surface), owner editing, versions, sharing and downloads.
- **Display only:** scripts run, and the host channel carries only the style variables and theme, the page's size, link opens and Escape. Nothing a page shows can steer the model or act: an App View's calls skip Approval and hooks, and a Visual's page may be an injected agent's. App messages are left out for now; they could be added later over the same channel.
- **Owner controls:** none in v1, and no Setting. The owner's Instructions can steer the agent; a later off switch would be an extension option, not an `enabled` option now, which is speculative and which the agent could flip.

## Tools

- **Where they live:** the `visuals` extension (`packages/extensions/src/visuals/`) defines `visual_show` and `visual_check` and hands each shown page to the Session's `VisualRecorder`, which keeps it in `apps/server/src/session/visuals-store.ts` ([_The copy_](#the-copy)); `packages/protocol/src/visuals.ts` holds the types, the socket messages, the CDN list, the library table, the style-variable table and the shim; the Browsers Worker's `BrowserHost.checkVisual` runs the check ([_The check_](#the-check)).
- **Who calls them:** every conversation, the root and each subagent, and `codemode` scripts, as nested calls (a script is the natural place to build a chart from data); a child has them when its grant does, by the usual rules ([_Subagents_](agent-capabilities.md#subagents)). A child shows a Visual only when asked to, and says so in its report. Root-only was rejected: the child would hand the page up to be sent twice, with no safety gain.
- **`visual_show({ path | html, title, summary })`:** shows a page in the call's card. Exactly one of `path` (a file in the calling conversation's Workspace) or `html`; a `title` of at most 200 characters; a required `summary` of at most 300, which is the frame's accessible description and stands for the page wherever it is not rendered: Details, `/export`, `session_transcript` and the evicted card (an optional one would be missing exactly there, and restating the page in the reply would duplicate the chat). It never depends on `visual_check`, and every call shows a new Visual ([_The copy_](#the-copy) → Revisions).
  - **Text result:** `Shown "<title>". Don't restate it.`, then any warnings.
  - **Value** (for scripts): `{ id, title, bytes, source_path, supersedes, warnings }`, where `id` is the Visual's id, its call's id (`callId`), and `supersedes` is the id of the earlier Visual from the same file in the conversation that now shows collapsed, if any.
  - **Fails** only when nothing faithful can show: no source or both; a file that is missing, unreadable or not UTF-8; an empty page; a page over 2 MiB after inlining; viewport-height units (`vh`, `svh`, `lvh`, `dvh`) in the page's own CSS; a bad `title` or `summary`. Failing on every defect was rejected: one bad image would cost the whole page.
  - **Warns** on: a local asset that is missing or too large; a host not on the list ([_Network and isolation_](#network-and-isolation)); `fetch`, XHR, `WebSocket` or `EventSource` in a script; an `<iframe>` or a `<form>`; `touch-action`, `overscroll-behavior` or a non-passive touch listener; Secrets replaced; a fragment wrapped into a document.
- **`visual_check({ path | html, width?, theme?, top? })`:** read-only. It renders the page in a throwaway context of the Session's Browser Run browser with the theme, shim and CSP a frame gives it, and returns a JPEG screenshot with what it measured and saw: the content height, whether the screenshot was clipped, the growth probe's finding, console messages, CSP violations and failed loads. `width` defaults to 736 px, the thread's column (`max-w-3xl` less `px-4`, one constant tested against the layout), about 360 for a phone; `theme` to `light`; `top` is where the 3,000 px screenshot starts. A browser that is unavailable fails the call ("not checked"); a Browsers Worker that predates `checkVisual` fails it as "unavailable"; a partial result warns. It is a tool of its own because Browser Run is the only real browser: `browser` cannot read the Workspace or apply the theme, shim and CSP, and a `check` mode of `visual_show` would have parameters that mean nothing for showing.
- **No rate limit:** the model sets the pace, and storage is bounded ([_The copy_](#the-copy) → Bounds).

## Guidance

- **Deferred:** both tools are deferred by default ([_Tool discovery_](agent-capabilities.md#tool-discovery)). Offering them would put about 1.5k tokens of description on every request.
- **The `visuals` section:** a static system prompt section of two lines, shown whenever either tool is granted, loaded or not, and frozen per Context Window: it says when to show a Visual and how to load the tools. It holds nothing that changes, so the provider's prompt cache keeps hitting; the rules are not in it, since conversations that never load the tools would pay for them.
- **The description:** the page rules, layout, style variables and libraries live in `visual_show`'s static description, and `visual_check`'s points at it.
- **Page rules:** one HTML document, its scripts and styles inline or from the list; no viewport-height units; no network calls, forms or frames; never ask the owner for credentials; `alt` on images, titles in SVGs, real text, and `prefers-reduced-motion` respected; `touch-action` and touch listeners only where a gesture needs them. Prefer `path`, at the scratch path ([_The copy_](#the-copy)), for anything that will be revised: after a compaction an inline page is recoverable only through `context_history`. Check with `visual_check` first, and check `dark` too when the page sets its own colors.
- **Layout:** the frame is the thread's width (736 px on a desktop, about 360 on a phone) and fits its height to the content, so a long explainer is one tall page, not a scroll box ([_The frame_](#the-frame) → Height).
- **Style variables:** the ext-apps spec's names that cloudpid already maps for App Views (`TOKENS` and `CONSTANTS`, in one table in `packages/protocol/src/style-variables.ts`, which `apps/web/src/sandbox-frame/host-context.ts` reads); names are only ever added. The client reads their values live, so a Visual follows the theme as it changes. `visual_check`'s light and dark values are a shared table that a drift test holds to `apps/web/src/styles.css`. cloudpid's own token names were rejected (a redesign could rename them under stored Visuals), and so was generating the table (a drift test is the repo's pattern).
- **Libraries:** the description names eight pinned cdnjs files, each pin avoiding a trap found by testing each library under this CSP in Chrome (left to `visual_check`, every trap would cost a check, one Visual at a time):
  - Mermaid `mermaid/11.17.2/mermaid.esm.min.mjs` (its chunks load from the same directory);
  - Chart.js `Chart.js/4.6.1/chart.umd.min.js`;
  - ECharts `echarts/6.1.0/echarts.min.js`;
  - D3 `d3/7.9.2/d3.min.js`;
  - Cytoscape `cytoscape/3.34.4/cytoscape.umd.min.js`;
  - KaTeX `KaTeX/0.19.1/katex.min.js` with `katex.min.css`;
  - highlight.js `highlight.js/11.11.2/highlight.min.js`;
  - three.js `three.js/0.187.0/three.module.min.js`, through an import map (it loads `three.core.js` beside it).
- **Known failures,** named in the description: Vega, Vega-Lite and vega-embed (they need eval); D3's `csvParse` and `tsvParse` (embed JSON, or parse in the page's own code); the full Plotly build (use `plotly-strict.min.js`, with no map traces); map tiles (no live maps); Chart.js's ESM build (it imports a chunk cdnjs does not serve); and "latest": every URL names a version.
- **Freshness:** pins do not change, so staying current is not a goal. The table is one constant in the static description, bumped by a deliberate deploy. A unit test holds every URL to an exact version; an opt-in test (`VISUAL_LIBS_CHECK=1`), run when bumping, fetches each pin and scans it for eval. A network check in CI was rejected as flaky.

## The copy

- **Sources:** `visual_show` takes exactly one of `path` or `html`, and the Session keeps the page as shown, outside History; the client loads only that copy. `path` makes check, fix, show cheap, and the agent has often just written the file; inline-only would re-send the page with each check and the show, and path-only would make a one-off need a scratch write. The copy is never a live link to the file: Workspaces are shared, mutable and removable.
- **The scratch path:** `/workspace/.cloudpid/tmp/visuals/<distinctive-name>.html`, absolute. It sits beside the Repos, is always synced (`withHarnessKept`), is on both backends and in every Subagent Workspace, and search skips it. A relative `.cloudpid/` was rejected, since a one-Repo cwd would put it in the Repo's committed `.cloudpid/`, and so was a folder per Session, since the agent does not know its Session's ID and a collision is harmless once the page is shown.
- **Inlining** (a `path` source, at show time): local images (PNG, JPEG, WebP, GIF, SVG; at most 1 MiB each), stylesheets and single-file scripts, relative to the file or absolute, become part of the page. A module graph is reported, not resolved. So pages work offline and stay faithful, and multi-file pages, self-bundled libraries and visual-explainer's kit work, which inlining images alone would not allow.
- **Secrets:** the copy is redacted of the Session's held Secrets before images are inlined, and a replaced value is a warning, not a failure: the agent cannot see the value to remove it. Values never enter durable state.
- **Bounds:**
  - a page is at most 2 MiB of UTF-8 after inlining, which holds two screenshots and is well under the 32 MiB socket message (T3 Code's 10 MiB an image and 25 MiB a page were rejected: a Visual lives in Session storage and travels over the socket);
  - each Session keeps at most 32 MiB of Visuals, in a bound of their own, apart from App records', with at most 1000 Visuals kept and 2000 stubs;
  - past a bound the least recently mounted Visual becomes a stub, never the one just written; answering `visual_page` with a page marks that Visual the most recently mounted, as `mcp_app_mount` does for an App record;
  - an evicted Visual's card shows its title, summary, source, time and size, with Open file for a `path` source.
- **The record** holds the `callId`, the conversation, the parent call (the `codemode` script's, for a nested call), the title, the summary, the source (`path`, or inline), the redacted page with its assets inlined, its size in bytes, the warnings given at the show, and the time. The origin is computed from the Session, never stored ([_Network and isolation_](#network-and-isolation)).
- **The store:** `visuals-store.ts`, in the Session's storage, built on a chunked-record primitive extracted from the App record store (`mcp-apps-store.ts`; [_App records_](mcp-apps.md#app-records)). A kind of App record was rejected: every App reader would branch on the kind, and Visuals would evict App data within one bound. Sharing the `mcp_app_*` messages was rejected too: a Visual's page lives in the Session, not in `McpHost`.
- **Revisions:** every show is a new Visual. An earlier Visual from the same file in the same conversation shows collapsed, "A newer version is below", with Reopen, worked out from the transcript; `supersedes` in the result names it. Replacing a Visual by its ID was rejected: an earlier card would then show what was not shown at the time, and a Fork would be ambiguous.

## Socket messages

Additive; old tabs skip messages they do not know.

- **Session → client:** `visuals { conversationId, visuals }`, per conversation on `watch`, as `mcp_apps` is ([_Socket messages_](mcp-apps.md#socket-messages)).
- **Client → Session:** `visual_page { id, callId }`, answered through the socket's `id`/`result` reply with the page, `evicted` or `none`.
- **`hello.visuals`:** a Session says it keeps Visuals. A client shows a `visual_show` call to a Session that does not say so as an ordinary tool card.

## The frame

- **Components:** `apps/web/src/visual/` renders Visuals; `apps/web/src/sandbox-frame/` takes what App Views and Visuals share out of `apps/web/src/app-view/`: `frame-url`, the frame-protocol half of the bridge, the style variables, `open-link`, `focus` and `places` (keys `app:` and `visual:`). Both `app-view/` and `visual/` import it; importing from `app-view/` was rejected, since shared code should not live inside one feature. Visuals need no teardown.
- **The shim:** the web client injects it into the page at mount, and it is never stored, so a fix to it reaches every stored Visual. It speaks a subset of the ext-apps frame protocol: initialize, size, host context (the style variables and theme), open link, and Escape. The sandbox Worker does not change, so a preview stage can test Visuals end to end; a shim served by the sandbox, which only `prod` deploys, could be tried only after a merge.
- **Sandbox flags:** the client passes the flags and the CSP. The inner frame is `allow-scripts allow-same-origin` with `referrerPolicy="no-referrer"`: no forms, pop-ups, downloads or clipboard, none of which display needs (T3 Code's pop-ups and downloads were rejected as open doors for no gain). A frame is never delegated `local-network`, `loopback-network` or `cross-origin-isolated`.
- **Origin and CSP:** one origin per Session on the App sandbox, sent the fixed policy through the proxy's existing `?csp=` ([_Network and isolation_](#network-and-isolation); [_The App sandbox_](mcp-apps.md#the-app-sandbox)). Under `alchemy dev`, Visuals share the one local sandbox origin with App Views (dev only).
- **Height:** the frame fits its content from 160 px up to 20,000 px, then scrolls inside and offers Pop out; the height is remembered per device. So an ordinary page gets no nested scroll; a 640 px cap was rejected, since long explainers would become scroll boxes. `visual_show` fails on viewport-height units rather than rewriting them (brittle) or letting the cap absorb them (a looping page would grow to 20,000 px), and a runtime guard freezes a frame whose height grows after 3 consecutive host resizes.
- **Scrolling:** the shim forces `html, body { overscroll-behavior: auto !important }`, so a scroll that reaches the frame's end chains to the chat; `touch-action` and touch listeners are left to the page, with a warning at the show and guidance (stripping them would break legitimate gestures). Whether touch scrolling over a cross-origin frame chains to the page is confirmed for Chrome Android only, and no primary source settles it for iOS Safari. If the iPhone does not chain, a tap-to-interact overlay is added on iOS and iPadOS WebKit only: a pan scrolls the chat, a tap activates the frame, and a sticky Done chip, focus leaving or scrolling away puts the overlay back. That keeps the frame's fit; a height cap was rejected, since scroll boxes still trap at their ends, and so was forwarding touches, which has no fling.
- **Lazy mounting:** frames mount near the viewport and unmount far from it, never while focused. There is no generation rule: a Visual is a fixed copy and never goes stale, so App Views' rule has nothing to protect; only a superseded Visual collapses.
- **Start:** a page that does not complete its handshake within 10 s shows "Visual couldn't start" with Retry, as App Views do.
- **The card:** a Visual shows in its call's card, outside the card's disclosure, under the chrome "Visual · <title>"; a `codemode` script's Visuals show in the strip under the script's card, and a subagent's in its thread. The call's place keeps the turn's narrative: above the final reply would need a moving anchor and lose order, and a Pane by default would take over a phone's screen. While the call streams, the card shows its progress. Its actions:
  - **Collapse** and **Reopen**;
  - **Pop out** to a Visual Pane, and **Show here** to bring it back;
  - **Copy HTML**: the redacted copy, without the shim;
  - **Open file**, for a `path` source, which opens the file as it is now;
  - **Details**: the source, size, time, warnings, origin and summary, and that the page was written by the agent.

  A standalone tab was rejected (a `blob:` URL takes the app's origin, and the sandbox holds no HTML), and so was a re-check by the owner (the check is the agent's tool).

- **The Visual Pane:** Pop out moves a Visual to a Visual Pane, one per Visual, at full size (a sheet on a phone), and the card says where it is shown, through the shared places.
- **Links:** a link the page opens goes through the same confirmation as an App View's `ui/open-link` ([_The bridge_](mcp-apps.md#the-bridge)): nothing opens before the owner chooses.
- **Accessibility:** the frame's `title` is "Visual: <title>", and the summary is its accessible description; a mount never takes focus, and Tab moves in and out natively. The shim posts an Escape the page did not handle, and focus returns to the card, which App Views cannot do. Full conformance is not the aim, since nobody would verify it; the description asks for `alt`, SVG titles, real text and `prefers-reduced-motion`.

## Network and isolation

- **The policy:** `connect-src`, `form-action` and `frame-src` are `'none'`, and there is no `blob:` or eval. Resources load only inline, as `data:`, or from the list. It blocks ordinary requests and keeps a page as it was when shown: an open network would let pages change after the fact, and a CSP the agent declares would be whatever an injected agent wants.
- **The list:** `cdnjs.cloudflare.com`, `fonts.googleapis.com` and `fonts.gstatic.com`, fixed by cloudpid. No Setting sets it and no Repo does: the agent can edit a Repo's files, and the safety of a host rests on facts a Settings page cannot show; any later Setting would be an Override behind Approval. Neither host offers a third party read-back of its requests, publishing to cdnjs is reviewed, and cdnjs carries eval-free builds of the libraries Visuals need. jsDelivr is left out: its public stats API gives daily hits per file of any package, and it serves an attacker's published script at once, so it would be the remaining channel once the channels below close, and removing it then would break every Visual that used it.
- **The origin:** one per Session, from a hash of the Session's ID kept apart from MCP servers' hashes, on the App sandbox with no Worker change. It is a site of its own: the page holds no cookie of cloudpid's, reads no storage of the app's or any App's, cannot loosen the header CSP, and only the app may frame it (`frame-ancestors`). Sessions do not share page storage, which one origin per Environment would. An opaque-origin `srcdoc` frame on cloudpid's page (T3 Code's) was rejected: it is never better on any browser, shares the app's process on desktop Firefox, and `localStorage` throws in it.
- **Process isolation:** the wording everywhere is "its own site; its own process only on desktop Chrome and Firefox". On iOS (Safari and Chrome alike) the page shares the app's process, and on Chrome Android it gets one of its own only by heuristic.
- **Known limits,** shared with App Views:
  - **Channels no CSP governs.** A determined page can still signal out: WebRTC in every browser (CSP's `webrtc` directive ships in no browser), `preconnect` and `dns-prefetch`, and Chrome's `rel=prerender`; each reached an outside host under this policy in Chrome 150. So the promise is: a Visual cannot reach cloudpid or any App's storage, its ordinary requests reach only cdnjs and Google Fonts, and what the owner types into it is not private to cloudpid. That is accepted because an injected agent already has a stronger path: `secret_ask` shows the owner cloudpid's own form, and `web_fetch` sends a value anywhere public.
  - **Spectre on iOS.** A Spectre-class page could read the app page's memory there: the transcript, socket data, and a Live View or Owner-tab link while one is open. Accepted, with no `SharedArrayBuffer`, coarse timers and lazy mounting; no inline Visuals on iOS would fail the feature's purpose.
  - **`Connection-Allowlist`** (Chrome and Edge 152+) closes WebRTC and the hints, but it is Chromium-only, its inheritance by the proxy's inner frame is untested, and a mistake breaks App Views without warning. Adding it on the proxy page is a follow-up for the App sandbox, which protects App Views too.
- **Speed bumps, not a boundary:** static resource-hint links are stripped when the page is prepared, and the shim deletes the WebRTC constructors before the page's scripts run. A fresh `about:blank` realm and script-inserted links bypass both; about ten lines of code, they stop generic payloads. A `MutationObserver` was rejected: it races, and implies a boundary.
- **Provenance:** the card's chrome reads "Visual · <title>" and Details "written by the agent"; the guidance tells the agent never to ask for credentials in a Visual. Focus banners were rejected, since every click focuses the frame.
- **The rules:** neither cloudpid's pages nor the sandbox become cross-origin isolated (COOP and COEP), and no frame is delegated `cross-origin-isolated`, `local-network` or `loopback-network`, which would give a framed page `SharedArrayBuffer`, precise timers or the owner's local network. The list and the CSP apply to every stored Visual when it mounts, so tightening either later breaks the stored Visuals that relied on it; loosening is one header.

## The check

`BrowserHost.checkVisual` (`apps/browser`), on the host's own CDP socket (`openCdpSocket`), never on a conversation's tab or an Owner tab ([_Browser_](browser.md)).

- **The context:** a browser context with `disposeOnDetach`, a target in it, and the viewport (`width`) and color scheme (`theme`) emulated.
- **The page:** `Fetch` fulfils `https://visual.invalid/` with the page and the real CSP header, built by the same `buildCsp` as the sandbox's; requests to the list's hosts pass, and everything else fails. A real header on an https origin matches the frame. `Page.setDocumentContent` with a `<meta>` CSP is kept as the fallback: it lands on an opaque origin, where `localStorage` throws.
- **Measuring:** it waits for the load, the fonts and two frames (at most 10 s), measures the layout, runs the growth probe, and collects console messages, CSP violations and failed loads.
- **The screenshot:** JPEG at quality 80, clipped to 3,000 px from `top`; over 750,000 base64 characters (the bound the transcript holds images to: [_Filesystem and tools_](workspace.md#filesystem-and-tools)) it is retaken at quality 60, then with the clip halved.
- **Bounds:** the context is disposed in a `finally`; one check runs at a time per Session, for at most 20 s in all, and each is noted as a use of the browser, as a `browser` run is, for the idle close.
- **Cost:** the screenshot's tokens count at `Models`, as any input's; browser time does not, as with `browser`, and a context starts no new browser instance. A ledger of browser time was rejected: `browser` has none either.
- **Failures:** a browser that is unavailable fails the call ("not checked"), a partial result warns, and a Browsers Worker without `checkVisual` makes the tool fail as "unavailable".
- **Not yet probed:** nothing of this has been run on Browser Run, whose docs show contexts only by example and say nothing of `Fetch.fulfillRequest`. A spike on a deployed non-prod stage comes first and gates `visual_check` only ([_Risks_](risks-and-spikes.md); [_Slices_](#slices)).

## Fork and Clone

- **The copies:** a page of `ExportPage` gains `visuals?`, and `importEntries` an optional trailing fourth argument, at all four hops: `fork.ts`'s `fillSession`, `worker-init.ts`, `Session.ts` and `fork-host.ts`. A page carries the Visuals of the calls its entries hold, fitted to `MAX_COPY_PAGE_SIZE` as App records are ([_App records_](mcp-apps.md#app-records)), and a copy takes only the calls of the path it copies.
- **Across builds:** `VisualCopy` is a union with a `{ kind: string }` fallback that is skipped, and records change only additively, with no format version (the repo's rule for records). `ExportPage` is a plain RPC value that is never decoded, so every mismatch between the builds of the source and the target degrades to "no longer kept".

## Lifecycle

- **Streaming:** while the call streams, the card shows its progress, and the frame mounts once the copy exists. A partially streamed `html` argument is never rendered: a partial render would flicker.
- **Subagents:** a subagent's Visual renders in its thread, wherever that is open. A closed subagent card has no badge for it: a badge would need counts per conversation outside `watch`.
- **Deletion:** deleting the Session takes its store with it. `subagent_delete` does what it does for App records, which is nothing: they go when they are evicted. A child's History is not deleted either.
- **Archiving:** an archived Session shows its Visuals and keeps serving them.
- **Branch moves:** a move unmounts the Visuals it drops without a guard, since there is no teardown. The records of abandoned branches stay.
- **Compaction and Rollover** do not touch the store; an inline page is still recoverable through `context_history`.
- **Notifications:** a Visual sends no Web Push or Notification.
- **Export and transcript:** `/export` and `session_transcript` write a Visual as "Visual: <title> — <summary> (not rendered)"; `session_transcript` adds a link to its Visual Pane ([_Transcripts_](mcp-endpoint.md#transcripts)).
- **Local agents and imports:** out of scope. `/mcp` drives Sessions, not their tools, and a Session import carries no Visuals: converting an imported HTML file would guess what the conversation showed.

## Telemetry

The existing `pi.tool.visual_show` and `pi.tool.visual_check` spans ([ADR-0010](../adr/0010-telemetry-at-the-seams-the-session-owns.md); [_Operations_](operations.md) → Telemetry) gain counts and fixed values only; no new spans.

- **`visual_show`:** the source kind, bytes, inlined counts, Secrets replaced, evictions, and the kinds of warning and failure.
- **`visual_check`:** width, theme, cold start, outcome, counts, content height, screenshot bytes, and whether it was clipped.
- **Never:** page text, title, summary, path, console text or hosts; a host is content the page chose.

## Testing

Following [`AGENTS.md`](../../AGENTS.md)'s conventions; a Playwright runner was rejected, since one feature does not justify a browser runner.

- **Node unit tests:** the protocol types; the shim's served text, run in a fake window; the preparation of a show and of a check; `visual-check.test.ts`, on a scripted `CdpTransport`; the view hash (the Session's origin); the page fitting in `fork.ts`; the library table (exact-version URLs), and its opt-in fetch and eval scan (`VISUAL_LIBS_CHECK=1`).
- **Workerd tests:** `call-records` (the extracted primitive), the App store's tests as its regression, and `visuals.workerd.test.ts`: the socket messages, a Fork across builds, and a recording tracer for the spans.
- **Web component tests:** the card, the frame, the height, lazy mounting and the places; the `styles.css` drift test of the style-variable values; the 736 px constant against the layout.
- **Real browsers:** the spike ([_The check_](#the-check)), and a hand checklist on a preview stage, on desktop Chrome, Safari and Firefox, iPhone Safari and Android Chrome, which adds touch scrolling over a frame on the phones (the iPhone's result decides S5) and wheel chaining on desktop Firefox and Safari.

## Slices

Each slice ships alone and degrades safely; one big change was rejected, since the refactors and the check carry different risks.

- **S0a:** extract the chunked-record primitive from the App record store; the App store's tests are its regression.
- **S0b:** move the shared frame code from `apps/web/src/app-view/` into `apps/web/src/sandbox-frame/`; App View tests move with it.
- **Spike:** the check on Browser Run, run in parallel from the start ([_Risks_](risks-and-spikes.md)).
- **S1:** `visual_show` end to end: the extension, the store, the socket messages, the shim and the card.
- **S2:** Fork and Clone copies, in parallel with S3.
- **S3:** the Visual Pane, in parallel with S2.
- **S4:** `visual_check`, after the spike and S1.
- **S5:** the tap-to-interact overlay, only if the iPhone check fails.
- **Not a slice:** `Connection-Allowlist` on the proxy page is a separate App sandbox follow-up ([#664](https://github.com/ian-pascoe/cloudpid/issues/664); [_Network and isolation_](#network-and-isolation)).
