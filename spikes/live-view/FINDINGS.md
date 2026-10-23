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

## iPhone, first pass (iOS 18.7 Safari)

- **1:** connects from our origin in 602 ms.
- **9:** after 17 s in another app the socket still reported `OPEN` but was dead: the ping on return closed it with
  `1006`. A freshly minted link reconnected in 831 ms. The viewer's socket died the same way. Do not trust
  `readyState` on return. Ping with a short timeout on `visibilitychange` and `pageshow`, and reconnect with a new link
  on no answer. The harness now does this for the check 9 socket and the viewer, with a 1.5 s ping.
- **12:**
  - Focusing the hidden textarea in `pointerup` opens the iOS keyboard, and `inputmode` takes effect.
  - Focusing on every `pointerup` opens it far too often: every tap on a button or link, and the end of every drag,
    brought it up (`visualViewport` 739 → 396), and the after-tap check closed it again about 300 ms later.
- Opening a pop-up from the tab sends the tab `Page.screencastVisibilityChanged {visible: false}`: the window took the
  front.

## Keyboard: decided at `pointerup` from a map of the tab's fields (harness viewer, second version)

1. **Only a tap may focus.** That is one pointer, under 500 ms and under 10 CSS px of movement, and not a long-press
   selection. Drags, scrolls, long presses and multi-touch never change the focus.
2. **A map of the fields.** One `Runtime.evaluate` returns the rects (in the tab's viewport) of every editable element,
   with their `type` and their `inputmode`, `enterkeyhint` and `autocapitalize` attributes:
   - inputs that take text, `<textarea>`, `contenteditable` roots, and `<label>`s of those;
   - in open shadow roots and same-origin iframes too;
   - not disabled or readonly fields, nor `<select>`.

   It is read again when a frame's scroll offset changes (at most every 250 ms), after each tap, after input, and every
   second while the viewer is open. At `pointerup` the tap is hit-tested against it, corrected by how far the frame
   has scrolled since. A hit sets the hints, then focuses synchronously; a miss blurs the textarea if it was focused.
   Each decision is logged with the hit, the number of rects and the map's age.

3. **The keyboard stays up between fields.** The canvas prevents the default of `touchstart`, `touchend` and
   `mousedown`, so touching the frame does not move focus. Going from one field to another keeps the textarea focused
   and only changes the hints. A toggle chooses between blur-then-focus (in case iOS applies `inputmode` only on focus)
   and keeping the focus.
4. **Safety net.** After each tap, `Runtime.evaluate` reads the tab's focused element, through shadow roots and
   iframes:
   - It focused something editable we did not predict (a field focused by script): ⌨︎ is highlighted ("tap to
     type").
   - We predicted a field but it focused nothing editable: blur.

Playwright: Chromium (Pixel 7, touch through CDP) passed 26/26 and WebKit (iPhone 15, taps) passed 19/19:

- **The keyboard opens** on a text, email, number or password field, a label's text, a field beside a button, a
  textarea, a field in an open shadow root, a field in a same-origin iframe, a contenteditable, and fields below the fold
  after scrolling.
- **The hints follow the field:** inputmode `email`, `decimal`, `url`, `tel`, `search`, `numeric` with
  `enterkeyhint=done`, and `enter` for a textarea.
- **Field to field** keeps the focus, with no blur in keep mode.
- **The keyboard stays closed** for a button, a link, a disabled input, a readonly input, a `<select>`, a drag, a long
  press and a two-finger tap. Dragging while typing keeps it open.
- **A field focused by script** gets ⌨︎ highlighted.

Faking `visibilitychange` with a socket whose answers are dropped: the check 9 socket and the viewer both reconnected
with a fresh link (446 ms and 991 ms).

## iPhone, second pass (keyboard decisions)

- The keyboard opened only on taps on fields, and the hints followed the field.
- **Backspace did nothing.** The viewer emptied the textarea after each character, and iOS sends no input event for
  Backspace in an empty field.
- **Tapping a `<select>` showed nothing.** Headless Chrome draws its picker as a pop-up outside the screencast, so the
  forwarded tap opened an invisible picker.

## Typing: Kernel's input sentinel (harness viewer, third version)

Ported from Kernel's live view (`kernel/kernel-images` at `2c3fabc`, Apache-2.0; the licence notice is in
`harness.html`):

- The textarea always holds a sentinel space before the caret, so iOS has something to delete and sends Backspace.
- Each `input` is diffed against what was sent since the last reset: the difference goes to the tab as Backspace key
  events and `Input.insertText` (line breaks as Enter). Deleting the sentinel is one Backspace past the kept text.
- Where the field allows autocorrect, the typed text is kept after the sentinel so the keyboard can replace a word; the
  replacement arrives as Backspaces and the new text. Elsewhere, the textarea is reset after each input.
- A tap, a focus change, an arrow key or a paste resets it, since the tab's caret has moved.

## Native pickers: a local control over the tapped spot

The map also lists `<select>` (single and multiple) and `date`, `time`, `datetime-local`, `month`, `week` and `color`
inputs, with their options or value, min, max and step. The elements are kept in a registry in the tab
(`window[Symbol.for("liveview.pickers")]`), so a choice is written to the same element.

- A tap on one is not forwarded: the tab gets `touchCancel` (a mouse gets a release and Escape).
- A local `<select>` or `<input>` of the same kind opens over the spot, inside the gesture (`focus()`, then
  `showPicker()` where it exists), outlined in orange.
- On `change`, `Runtime.evaluate` sets `option.selected` or `value` on the tab's element and dispatches bubbling `input`
  and `change` events (as Puppeteer's `ElementHandle.select` does), then the map is read again.
- A single select closes after its choice. A multiple select, a date or a colour stays open until it blurs, the frame
  is touched or the tab scrolls.

Playwright `keys.mjs` passed 24/24 on Chromium (Pixel 7, touch through CDP) and 24/24 on WebKit (iPhone 15):

- **Backspace:**
  - `hello` and two Backspaces leave `hel`;
  - six quick Backspaces empty the field;
  - Backspace in an empty field reaches the tab as a `keydown`;
  - it works in an email field and a contenteditable.
- **Autocorrect:** `teh` replaced by `the` in the textarea (a selection over it plus `insertText`) leaves `the` in the
  tab. Typing on and Enter give `the cat\nx`.
- **Pickers:** a fruit select whose handler shows the choice, a 50-option select, a multiple select, date, time,
  colour and the earlier plain select.
  - A tap shows the local control and the tab gets no click.
  - The choice reaches the tab with one `input` and one `change`, and the page's change handler runs.
  - A text field still takes a tap and typing afterwards.

`kbd.mjs` still passes (Chromium 26/26, WebKit 19/19).

## iPhone, third pass (Backspace and pickers)

- Backspace works, also in an empty field.
- Autocorrect works: `Teh` became `The` as two Backspaces and `he`.
- The selects (single, 50 options, multiple) open the iOS picker on the first tap, and the choice reaches the tab
  with its events.
- Date, time and colour: the local control was focused and `showPicker()` called, then it blurred 2 to 3 s later
  without a `change`. It is not known whether the iOS pickers opened.
- The tab offers no Copy or Paste: iOS has nothing to show its edit menu for, since the frame is a picture and the
  textarea is invisible.

## Picker values captured on input, change, blur and close (fourth version)

The change handler used to ignore events once the control had closed. The blur closed it 400 ms later, so a value
that iOS set at or after the blur was dropped. Now each open keeps its own picker. `input`, `change`, `blur`, 400 ms
after the blur, and closing all compare the control's value with the last one written, and write it if it differs.
Each is logged as `phone:pick <event> on pick-input: <value> (unchanged)`. The tab's element is no longer focused when
a value is written: focusing it scrolled the tab, which closed the local control.

Playwright (`menu.mjs`, both engines) passes for a value set with only `input` (date), only `change` (time) and only
`blur` (colour). On Chromium a blur with its own time popup open fired no `blur`, so time is checked with `change`.
Not yet tried on the iPhone.

## Our own edit menu (fourth version)

An iOS-style bar (Copy, Cut, Paste, Select All) over the frame:

- **When:** after a double tap (the tab gets a mouse double press, which selects the word, for text or a field only,
  not a control), after a long-press selection (mouse-select mode, with or without a drag), and after a long press in
  a field even with nothing selected (Paste, Select All). The tab answers with the selection and its rect (a field's
  selected text and its rect, or the range's rect) through shadow roots and same-origin iframes.
- **Where:** above the selection, below it if there is no room, clamped to the frame. It hides on the next touch on
  the frame, a scroll of the tab, or typing.
- **Items:**
  - Copy writes a `ClipboardItem` whose data is a promise of the tab's selection, inside the tap.
  - Cut copies, then sends Backspace.
  - Paste calls `navigator.clipboard.readText()` inside the tap, focuses the target field in the tab (caret at its end
    if it was not focused) and sends `Input.insertText`. If the read is refused, a visible paste box takes a native
    paste and sends that instead. The log says which path was used.
  - Select All selects the field's contents in the tab and shows the menu again.
- **The keyboard:** the menu prevents the default of `touchstart`, `mousedown` and `pointerdown`, so it neither blurs
  the typing textarea nor opens the keyboard. Its items act on `pointerup`, which for a touch counts as a user gesture.

Playwright `menu.mjs`: Chromium 18/18 (Pixel 7, CDP touch, clipboard permission granted), WebKit 15/15 (iPhone 15,
without long press, which Playwright's WebKit touchscreen cannot do, and without a real clipboard read):

- A double tap on text selects the word, and the menu shows Copy only, above the word and inside the frame.
- Copy leaves the word on the clipboard, and the menu hides.
- A touch elsewhere hides the menu.
- A double tap in a focused field selects a word and shows Copy, Cut, Paste and Select All, with the keyboard kept.
- Select All selects `hello world` and shows the menu again.
- Cut leaves `hello world` on the clipboard and empties the field.
- Typing hides the menu.
- A selection at the top of the frame puts the menu below it.
- Chromium only:
  - A long press in an empty field shows Paste and Select All, and Paste puts the clipboard text in the field.
  - A long-press selection with a drag shows Copy.

`keys.mjs` (Chromium 24/24, WebKit 24/24) and `kbd.mjs` (Chromium 26/26, WebKit 19/19) still pass.

Not verified on the iPhone:

- whether the menu's Copy and Paste work under iOS's clipboard rules, including the Paste permission bubble;
- the paste box fallback;
- whether a double tap and a long press on iOS reach the viewer as two taps and a long press;
- what the date, time and colour pickers send.

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
7. **Touch input.** The Pane decides at `pointerup` from a map of the tab's fields, types through a textarea that keeps
   Kernel's input sentinel, and opens native pickers locally instead of forwarding the tap: headless Chrome's own
   pickers are not in the screencast.
