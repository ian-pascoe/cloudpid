// The web app's one Effect runtime (ADR-0011): every atom that runs an Effect runs on it, with the browser's services.

import * as BrowserSocket from "@effect/platform-browser/BrowserSocket";
import * as Clipboard from "@effect/platform-browser/Clipboard";
import * as Layer from "effect/Layer";
import * as Atom from "effect/reactivity/Atom";

/** The browser's own services: the WebSocket constructor and the clipboard. */
export const BrowserLayer = Layer.mergeAll(
  BrowserSocket.layerWebSocketConstructor,
  Clipboard.layer,
);

export const appRuntime = Atom.runtime(BrowserLayer);
