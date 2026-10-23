// @effect-diagnostics missingPipeableSignature:off -- plain helpers over text.
// The names a Browser Handoff's Live View is known by on both sides of the Session socket (`docs/spec.md` → Browser):
// its Pane's key and the query that opens it, and the words `live_view` fails with once the handoff is over. No imports,
// so the browser host's Worker can take this module alone (`@cloudpid/protocol/live-view`).

/** What `live_view` fails with once its handoff has ended (or for a handoff the Session does not have), exactly. */
export const LIVE_VIEW_HANDOFF_OVER = "the handoff is over";

/** The key of the Live View Pane of the Browser Handoff `requestId` names: `live-view:<requestId>`, as it is. */
export const liveViewPaneKey = (requestId: string): string => `live-view:${requestId}`;

/**
 * The query of the Session's page that opens that Pane (`?pane=live-view:12`), as the web app writes a Pane key: encoded
 * but for the `:` after the type, so `URLSearchParams` reads back the key `liveViewPaneKey` gives.
 */
export const liveViewPaneQuery = (requestId: string): string =>
  `?pane=${encodeURIComponent(liveViewPaneKey(requestId)).replaceAll("%3A", ":")}`;
