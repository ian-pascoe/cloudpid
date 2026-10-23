---
status: accepted (the spike, #152, confirmed Browser Run accepts a connection from our origin, desktop and iPhone)
---

# Our own Live View, connecting with links minted when it opens

Browser Run's hosted Live View (`live.browser.run/ui/view`) is a desktop screencast: it has no touch input, and on a phone the keyboard never opens, since no element of our page takes focus. So a Browser Handoff opens our own Live View, a Pane of the web app, which speaks CDP to the handed-over tab itself (screencast, touch and key input through a focused proxy text field, device metrics) and sends Done or Failed as `Cloudflare.handoffComplete` the way the hosted page does. It connects straight from the owner's browser to the `wss` endpoint inside a `Cloudflare.getLiveView` link, not through the Session, so frames never cross the Session socket or wake the Session DO.

The link is minted when a Live View opens, not when the handoff starts: the client asks the Session (`live_view`), the browser host sends `Cloudflare.getLiveView` with Browser Run's minimum `expiresInMs` (60 s) and an explicit `targetId` for the tab and for each window it opened, and only that client gets them; a reconnect asks again. No link is stored, broadcast to every client, or put in a push, which opens the Pane instead.

A link is still a bearer credential to the whole browser session, not to one tab. For its 60 s it opens **every page of the browser session** (another page's target ID in its path connects to that page) and connects any number of times; Browser Run cannot revoke it, and its expiry only bounds when a connection may start, so a connection opened in time outlives the deadline (the spike kept two open for 15 minutes). A 30-minute link held in two Durable Objects and in a push on the owner's devices was the larger part of the exposure ADR-0007's handoff carried: anyone who read it from storage, a log, or a lock screen within half an hour had the browser. A one-minute link that only the asking page ever holds narrows that to the page itself and the connections it opens, which the owner closes with the Pane.

The Pane sets the tab's size for the device it is on, and that override is shared by every connection and outlives the one that set it (a clear from another connection was unreliable in the spike). So the browser host notes the tab's size when the handoff starts and sets it back explicitly whenever the handoff ends, however it ended, then checks the page's width.

## Considered Options

- **Keep the hosted Live View and the 30-minute link.** No code, but unusable on the phone, where a handoff's push is most often answered.
- **Relay frames and input through the browser host and the Session.** Works whatever origin checks Browser Run adds, but every frame crosses two Durable Objects and the Session socket. Kept as the fallback should Browser Run start refusing connections from our origin; the spike found them accepted.
