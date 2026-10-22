# Live View spike (#152): findings

Run on 2026-10-22 against Browser Run from this spike's own `workers.dev` Worker (not the app's stage). The harness ran in
Playwright's headless Chromium (HeadlessChrome 156) and WebKit (27.2), both from the Worker's origin, and the raw
handshakes and long-running connections from Node. The Browser Run tab reports `HeadlessChrome/128` on Linux. Every
CDP message is in the spike object's log (`GET /api/log`). The iPhone checks (1 on iPhone and PWA, 9, 11, 12) and real
desktop Safari are still to do (see the end).

## 1. A link connects from our origin: yes (desktop)

- Chromium and WebKit open `new WebSocket("wss://" + wss)` from the Worker's origin, no subprotocol, and every command
  answers. The server offers `permessage-deflate`.
- Browser Run does not check `Origin`. A raw handshake with a valid link gets `101` with no `Origin`, with ours, with
  `https://evil.example`, `https://live.browser.run`, `null` and `http://localhost:5173`, and with an unknown
  `Sec-WebSocket-Protocol`.
- The JWT is what is checked: a bogus one gets `401 {"code":10000,"message":"Invalid JWT token"}`, none gets
  `401 "Missing JWT token"`, and another browser session's ID in the path gets `401 "Invalid data in JWT"`.
- The `jwt` is a JWE (`alg: dir`, `enc: A256GCM`). Its readable header names the browser session and the account; its
  claims are encrypted.
- `Cloudflare.getLiveView` answers `{ webSocketDebuggerUrl, devtoolsFrontendUrl, id, options }`. `webSocketDebuggerUrl`
  is exactly `wss://` plus the `wss` parameter of `devtoolsFrontendUrl`, `id` is the target ID and `options` is
  `{ mode: "tab" }`. So the host can hand over `webSocketDebuggerUrl` and the client need not parse the frontend URL.

## 2. The link is not bound to the target in its path

- With the handed-over tab's link, putting the other page's target ID in the path connects to that page
  (`location.search` reads `?which=other`). A target ID that does not exist opens, then closes with `1008`.
- Links minted with `targetId` for the other page, sent in the tab's CDP session or on the browser, name that page in the
  path and connect to it.
- Sent on the browser without `targetId`, `Cloudflare.getLiveView` mints a link to the most recently created page, not
  to the handed-over tab. Always pass `targetId`, or send it in the tab's session, as the host does.
- So a link opens every page of its browser session for its 60 s, not just one tab. Minting one link per window, as
  #154 says, still reads more clearly than swapping IDs, which Browser Run does not document.

## 3. Expiry: the deadline only gates new connections

- A link can be used more than once until its deadline: a second connection right away opens and answers, and raw
  handshakes get `101` at 0, 30 and 55 s.
- From 62 s it is refused with `401 "Invalid JWT token"` (also at 70 and 90 s). In a browser that shows as close
  `1006` before open.
- A connection opened in time keeps working: it answers at 65 s, and the long-run test kept two connections open for
  15 minutes (one sending `Cloudflare.getSessionId` every 30 s, one silent and only asked at the checkpoints): both
  still answered at 2, 5, 10 and 15 minutes. The idle gaps were 3 and 5 minutes.

## 4. Commands over the page connection: everything works except long-press selection

- `Page.enable`, `Runtime.enable`, `Page.startScreencast` (JPEG; frames come only when the page changes, each acked),
  `Runtime.evaluate` and `Page.getLayoutMetrics` all work.
- `Input.dispatchTouchEvent`:
  - A tap focuses an input. The page sees `pointerdown`/`touchstart`/`pointerup`/`touchend`/`click` with
    `pointerType: "touch"`.
  - A 12-step drag scrolls (`scrollY` 0 → 465).
- `Input.insertText` types `héllo 👋` into a text input, `a@b.co` into an email input, `42` into a number input, and
  into a `contenteditable`.
- `Input.dispatchKeyEvent`: a char key, Backspace (×3, which removes the emoji as one character), End, and Enter (submits
  the form implicitly).
- `Emulation.setDeviceMetricsOverride {390×844, dpr 3, mobile: true}` makes the page see 390×844 @3.
- `Emulation.setTouchEmulationEnabled` gives `maxTouchPoints: 5` and `pointer: coarse`. `ontouchstart` appears only
  after a reload.
- **A long press does not select text.** We tried touch events held 1.2 s (with and without movement, with mobile and
  touch emulation), `Input.synthesizeTapGesture` with `duration: 1500`, and a touch double tap. None selects anything,
  and no `contextmenu` fires: the headless browser recognizes no long-press gesture from CDP input.
  - Mouse events do select: a double press (`clickCount` 2) selects a word, and a press-move-release selects a range.
  - The harness viewer's "long press: mouse select" mode turns a held touch (500 ms, under 10 px of movement) into a
    `touchCancel`, then a mouse double press, then mouse moves while the finger drags. In mobile-emulated Chromium it
    selected `the lazy dog. Pack my`.
  - Selecting through `Runtime.evaluate` (`caretRangeFromPoint` + `Selection.modify`) also works.
- **A background tab sends no frames.** On a tab that is not in front, `Page.startScreencast` answers, but the
  connection gets `Page.screencastVisibilityChanged {visible: false}` and no frames (`document.visibilityState` is
  `hidden`). `Page.bringToFront` from the Live View connection fixes it: `visible: true`, then frames.

## 5. Device metrics: shared by all connections, and not undone when a connection drops

- **All connections share one override, and the last one set wins.** With A2 at 390×844 and then B at 800×600,
  everyone, the agent's own connection included, sees 800×600.
- **Clearing from a Live View clears the agent's override too.** The agent set 1000×700, the Live View set 390×844 and
  then cleared, and the tab went back to its default 780×493, not to 1000×700.
- **A Live View that ends without clearing leaves its size behind.** This happens on a clean close and when the client
  is killed: `innerWidth`/`innerHeight` stay at the Live View's size (390×844), while the device scale factor (back to 1)
  and touch emulation (`maxTouchPoints` 0) revert. The size was still there 60 s after the kill. The agent would carry
  on in a phone-sized viewport.
- **Restoring the default size afterwards was unreliable:**
  - `Emulation.clearDeviceMetricsOverride` alone from another session (the host's or a new Live View) changes nothing.
  - An override followed by a clear from the host restored 780×493 in 3 of 4 trials (on the second page).
  - On the handed-over tab, after a Playwright browser holding a Live View connection was killed, nothing restored it
    for more than 10 minutes: not a clear, not an override then a clear from the host or from a new Live View (the
    host's own override-then-clear left it at the host's 500×500), and not `Page.reload`. It was back at 780×493 later,
    after more Live View sessions had set and cleared overrides. The cause is not isolated.
  - Setting the size explicitly works: the host sending `setDeviceMetricsOverride {780, 493, 1, mobile: false}` gives
    the agent 780×493. A size that is set stays even after its connection is gone.
- `dontSetVisibleSize: true` is no way out: the page then keeps its own size (780×493), and so do the frames.

## 6. Windows: `Page.windowOpen` and `openerId` both work

Four ways of opening a window were clicked with real mouse input on the page connection: `window.open(url, "pop",
"popup,width=400,height=600")`, `window.open(url, "_blank", "noopener")`, a `target=_blank` link and a
`target=_blank rel=noopener` link.

- Each one sends `Page.windowOpen {url, windowName, windowFeatures, userGesture: true}` on the tab's connection, and
  the tab's connection keeps working.
- `Target.getTargets` on the host's browser-level connection shows each new page with `openerId` equal to the handed-over
  tab, noopener included. `canAccessOpener` is `true` only for the plain `window.open`.
- A pop-up opened by that pop-up (through a link minted for the pop-up's `targetId`) has `openerId` equal to the first
  pop-up, so following `openerId` transitively finds every window. No fallback is needed.
- A pop-up's viewport is 400×565.

## 7. `Cloudflare.handoffComplete` from our origin settles the host's wait

- Sent on the Live View connection, it reaches the host's own connection as the `Cloudflare.handoffComplete` event
  `{targetId, handoffId, instructions, success, reason?, durationMs}`, both for `success: false` with a reason (Failed)
  and `success: true` with `"User clicked 'Done'"`. With no reason given, the event has no `reason` key.
  `apps/browser/src/handoff.ts`'s `Complete` schema reads all of them.
- The command's reply repeats `{targetId, handoffId, instructions, success, reason}`.
- With no handoff active, the reply is `{targetId, success: false, reason: "No active handoff"}`: not an error, and no
  event follows.
- The Live View connection also gets the `Cloudflare.handoff` event `{handoffId, instructions, timeout, durationMs: 0}`
  when a handoff starts while it is open, and every `Cloudflare.handoffComplete` event.

## 8. `Cloudflare.getHandoffState`

- With no handoff: `{targetId, active: false}`.
- During a handoff: `{targetId, active: true, handoffId, instructions, timeout, durationMs}`.

This is the documented `{active, handoffId, durationMs}` plus `targetId`, `instructions` and `timeout`. There is no
`elapsedMs`, so the hosted page's countdown starts from the full timeout every time. The answer is the same on the Live
View connection, in the host's session on the tab, and on the browser with `targetId`.

## 10. The tab's default viewport

- `innerWidth`/`innerHeight` 780×493, `devicePixelRatio` 1, `outerWidth`/`outerHeight` 780×580, `screen` 800×600 (the
  window bounds are 780×580 at 10,10).
- The first screencast frame is 780×493, with metadata `{offsetTop: 0, pageScaleFactor: 1, deviceWidth: 780,
  deviceHeight: 493}`.
- The agent's connection sees the same.

## Pending on a real device

- iPhone Safari and the installed PWA: 1, 9, 11, 12, and touch input generally.
- Real desktop Safari: 1 (the WebKit results above are Playwright's build).

## Preliminary recommendation (before the iPhone checks)

Go ahead with the direct connection in ADR-0013. Browser Run checks only the JWT, not the `Origin`, and both desktop
engines connect from our origin. Change #154 in these places:

1. **Viewport cleanup.** Closing a connection does not give the agent its viewport back. The Pane clears its override
   before Done or Failed and when it closes, and also on `pagehide`, best effort. Because a dropped phone connection
   leaves its size behind, the host puts the agent's viewport back itself when the handoff ends: it sets the size
   explicitly, or does an override and then a clear and checks `innerWidth`. A clear from the Pane also wipes any
   override the agent had set, so the agent must not depend on one.
2. **Long press.** Touch events select nothing in Browser Run's headless Chrome. A long press becomes a mouse double
   press, and a drag after it becomes mouse moves (or the Pane selects through `Runtime.evaluate`).
3. **Background tabs.** Send `Page.bringToFront` when the Pane opens a tab or switches windows; a tab that is not in
   front sends no frames.
4. **Links.** Mint with `targetId` every time, and give the client `webSocketDebuggerUrl` as it is. A link opens every
   page of its browser session (not only its tab) to anyone holding it for 60 s, and several connections can use it in
   that time: correct the exposure wording in the ADR and the spec. One link per Pane open, and one per reconnect after
   60 s, is enough.
5. **Handoff state.** `getHandoffState` answers `{targetId, active, handoffId, instructions, timeout, durationMs}`, so
   the deadline is `timeout - durationMs`. The Pane can also listen for `Cloudflare.handoffComplete` on its own
   connection to close itself when another device finishes the handoff.
6. **Windows.** `openerId`, followed transitively, finds every window, noopener ones included. No fallback is needed.
