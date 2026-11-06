---
status: accepted
---

# Visuals run in the App sandbox, one origin per Session, with no connections and resources only from cdnjs and Google Fonts

A Visual is a page the agent writes, and the agent can be prompt-injected, so the page is untrusted. It runs in the App sandbox on `ianpascoe.app` ([ADR-0031](0031-app-views-run-in-a-secretless-sandbox-on-a-domain-of-their-own.md)), at an origin derived from its Session (a hash of the Session's id, kept apart from MCP servers' hashes). That origin is a site of its own: the page holds no cookie of cloudpid's, reads no storage of the app's or any App's, cannot loosen the CSP header, and only the app may frame it. It is its own site; its own process only on desktop Chrome and Firefox: on iOS the page shares the app's process, and on Chrome Android it gets one of its own only by heuristic. Its CSP allows no connections, form submissions, frames, `blob:` or eval, and resources only inline, as `data:`, or from `cdnjs.cloudflare.com`, `fonts.googleapis.com` and `fonts.gstatic.com`. cloudpid fixes that list; the agent, a Repo and a Setting cannot change it.

The policy blocks ordinary requests and keeps a Visual as it was shown. It does not stop a determined page from signalling out through channels no CSP governs: WebRTC in every browser, `preconnect` and `dns-prefetch`, and Chrome's `rel=prerender` (each reached an outside host under this policy in Chrome 150; CSP's `webrtc` directive ships in no browser). That is accepted, and shared with App Views, because an injected agent already has a stronger path: `secret_ask` shows the owner cloudpid's own form, and `web_fetch` sends a value anywhere public. What the owner types into a Visual is therefore not private to cloudpid.

## Considered options

- **Open network, or a CSP the agent declares**: a page could fetch live data and change after it was shown, and an injected agent would declare anything.
- **Nothing but inline**: charts and diagrams would be hand-rolled (no Mermaid, Chart.js or D3) for no exfiltration gain while WebRTC is open.
- **jsDelivr on the list**: its public stats API gives daily hits per file for any package, and it serves an attacker's published script at once. It adds no channel while WebRTC is open, but would be the remaining one once those channels close, and the list applies to every stored Visual when it mounts, so removing a host later breaks every Visual that used it. cdnjs carries current, eval-free builds of the libraries Visuals need, and its inclusion is reviewed.
- **An owner Setting or a per-Repo list**: the agent can edit a Repo's files, and the safety of a host rests on facts a Settings page cannot show; nothing needs owner editing now, and any later Setting would be an Override behind Approval.
- **An opaque-origin `srcdoc` frame on cloudpid's page (as T3 Code)**: never better than a site of its own on any browser, shares the app's process on desktop Firefox, and `localStorage` throws in it.
- **`Connection-Allowlist` on the proxy page now**: Chromium 152+ only, an incubation whose syntax may change, untested in the proxy's inner frame, and a wrong allowlist breaks App Views unseen. Left as a follow-up for the App sandbox.

## Consequences

- Tightening the list or the CSP later breaks stored Visuals that relied on it; loosening is one header.
- Neither cloudpid's pages nor the sandbox may become cross-origin isolated (COOP and COEP), and frames are never delegated `cross-origin-isolated`, `local-network` or `loopback-network`: a framed page would gain precise timers, `SharedArrayBuffer` or the owner's local network.
- On iOS a Spectre-class page could read the app page's memory (the transcript, socket data, and a Live View or Owner-tab link while one is open), as an App View could. Accepted, with no `SharedArrayBuffer`, coarse timers and lazy mounting: no inline Visuals on iOS would fail the feature's purpose.
