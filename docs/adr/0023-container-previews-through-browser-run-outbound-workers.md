---
status: proposed
---

# A Container's dev server opens in the Session's browser through Browser Run's outbound Workers

A Container preview is a dev server in a Workspace's Container, opened in the Session's browser: by the owner in the
Browser Pane, and by the agent with `browser`. But the Session's browser runs in Browser Run, which cannot reach the Container, and refuses `localhost` by policy
(`ERR_BLOCKED_BY_ADMINISTRATOR`). The main Worker sits behind Access, which Browser Run cannot sign in to. So the browser
host acquires the Session's browser with Browser Run's `outboundByHost`: a few made-up hostnames, one per Container
port (`http://5173.cloudpid.internal/`), are sent to an entrypoint of ours instead of the network, which hands each
request to the Workspace DO, which fetches it from the Container's port (`getTcpPort`). There is no public URL and no
token, the route is the browser's (every tab, Owner tabs and the agent's, has it), and it outlives the invocation and
the object that made it. The spike (#244) measured it against a public token route and CDP request interception:
[findings](https://github.com/ian-pascoe/cloudpid/blob/8a58f49a451f74efdc0c18e12044d0111f366b3f/spikes/container-preview/FINDINGS.md)
(on the spike's branch, which is not merged).

- **Hostnames.** Browser Run takes at most eight hostnames, fixed when the browser is acquired, on port 80 and plain
  `http` only (no IP addresses or wildcards; a hostname under an HSTS-preloaded TLD is upgraded to `https` and refused).
  So the port is in the hostname, under `.internal`, for a fixed list of eight common dev-server ports: 3000, 3001, 4173
  (`vite preview`), 4321 (Astro), 5173 (Vite), 5174, 8000 and 8787 (`wrangler dev`). 8080 is computerd's and is never
  on it. All eight reach the Session's Workspace; none is kept for Subagent Workspaces. A port not on the list has no
  Container preview until the list changes and the browser is acquired again. A deploy does not update an existing
  route's code until the browser is acquired again, because the Fetcher keeps the version of the object that made it.
- **The Workspace DO serves the Container preview.** It never starts the Container for one: a stopped Container answers 503, and a
  port with nothing listening 502, saying the dev server must listen on `0.0.0.0` (the Container's port is reached on
  its interface, not its loopback). It refuses computerd's port. Every request is a use of the Container, and an
  open page's socket counts as a running command, so the idle stop waits until the page or the browser closes.
- **WebSockets ride on HTTP.** Browser Run routes only HTTP requests, so HMR's WebSocket would fail. The Workspace DO
  puts a small script at the start of each HTML page it serves, which replaces `WebSocket` for the page's own host with
  one carried as a server-sent event stream and POSTs. The Workspace DO holds the real socket to the Container. Vite's
  HMR worked through it with no reload and no added delay. The script also hides `SharedWorker`, because Vite pings for
  a restarted server from one, where the script does not reach.
- **The agent** is told that `localhost` is refused and that a dev server on port N is at `http://N.cloudpid.internal/`.
  Nothing secret is in its code or results.

## Considered Options

- **A public route to the Container preview** behind a short-lived signed token, outside Access. It worked best of the three for the page
  (an `https` origin, a secure context, HMR's socket direct). It was rejected for its exposure. The token is a bearer
  credential to everything the dev server serves (the source, the config), from any machine, until it expires, and it
  cannot be revoked. It would be in the agent's code and results, the browser's history and cookie jar, and any
  screenshot of the URL bar. And unlike a 60-second Live View link, it must last as long as someone works. It also
  needs a hostname of its own outside Access, and one per Container preview to keep Workspaces' cookies and storage apart: a
  wildcard DNS record and certificate. Kept as the fallback if outbound Workers go away or an app needs a secure context.
- **CDP request interception** (`Fetch.enable` in the browser host). It has no URL either. But it does not see
  WebSockets. Every byte passes base64-encoded through the browser host's 128 MB isolate, three to four times slower.
  It only works while the browser host holds its CDP connection, and the spike's host was evicted about 73 s after its
  last request, which silently ended the interception. It covers only tabs the host attached to, so the agent's new
  tabs are missed.

## Consequences

- The page's origin is `http://<port>.cloudpid.internal`, not `localhost` and not a secure context. There are no service
  workers, `crypto.subtle` or clipboard API, and an app that expects `localhost` (OAuth redirect URIs, CORS allow-lists,
  hard-coded URLs) sees another origin.
- A dev server must listen on `0.0.0.0` and not on 8080 (computerd's). The port list and the eight-hostname limit decide
  what can have a Container preview, and changing the list needs a new browser, which loses its logins. A browser
  acquired before this ships has no routes until it is acquired again, and neither does one after a deploy that changes
  the entrypoint's code.
- The hostnames reach the Session's Workspace. A Subagent Workspace's dev server (ADR-0021) is out of reach unless some
  of the eight hostnames are given to it.
- A restart of the Workspace DO drops every Container preview's socket, and Vite then reloads the page, losing its state. The
  spike saw one four minutes into a page, with nothing deployed. A restart of the Container does the same.
- An open Container preview keeps its Container running (about $0.03 an hour on `custom-1` for memory and disk, plus CPU
  as used, as Vite's client pings every 30 s anyway) until the page or the browser closes. Requests themselves cost little: a page load is about a dozen.
- Exposure (`docs/spec.md` → _Risks_ → Exposure of the shared browser session): only pages in the Session's browser
  reach a dev server. From an `https` page, requests to it are blocked as mixed content. A page with an `http` origin can
  send it blind requests but not read the answers. That is a laptop's `localhost`, less its mixed-content exemption. The
  shim's endpoints must not let such a page write into an open socket.
- It depends on a Browser Run feature from September 2026 that routes only `http`, not WebSockets. The shim covers what
  the spike tried (Vite); a dev server whose client opens sockets from a worker, or to another host, needs more of it.
- Not tested by the spike (#244):
  - the real Workspace DO and computer's idle stop: the spike used a stand-in Box that no connection pins as computer's
    does;
  - a Container started from a Build (or a snapshot): neither holds processes, so it should be as a start from the
    image, but this was not run;
  - pages open longer than about 15 minutes;
  - `keep_alive` closing a browser with a Container preview open.
