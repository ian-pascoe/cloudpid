---
status: proposed (the spike confirms Browser Run accepts a connection from our origin)
---

# Our own Live View, connecting with links minted when it opens

Browser Run's hosted Live View (`live.browser.run/ui/view`) is a desktop screencast: it has no touch input, and on a phone the keyboard never opens, since no element of our page takes focus. So a Browser Handoff opens our own Live View, a Pane of the web app, which speaks CDP to the handed-over tab itself (screencast, touch and key input through a focused proxy text field, device metrics) and sends Done or Failed as `Cloudflare.handoffComplete` the way the hosted page does. It connects straight from the owner's browser to the `wss` endpoint inside a `Cloudflare.getLiveView` link, not through the Session, so frames never cross the Session socket or wake the Session DO.

The link is minted when a Live View opens, not when the handoff starts: the client asks the Session, the browser host sends `Cloudflare.getLiveView` with Browser Run's minimum `expiresInMs` (60 s), and only that client gets it; a reconnect asks again. No link is stored, broadcast to every client, or put in a push. Browser Run cannot revoke a link and its expiry only bounds when a connection may start, so a 30-minute link held in two Durable Objects and on the owner's devices was the larger part of the exposure ADR-0007's handoff carried; a one-minute link held by one page is not.

## Considered Options

- **Keep the hosted Live View and the 30-minute link.** No code, but unusable on the phone, where a handoff's push is most often answered.
- **Relay frames and input through the browser host and the Session.** Works whatever origin checks Browser Run adds, but every frame crosses two Durable Objects and the Session socket. The fallback if the spike finds the direct connection refused.
