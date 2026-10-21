// The web app's one Effect runtime (ADR-0011): every atom that runs an Effect runs on it, with the browser's services and
// the Registry client.

import * as BrowserSocket from "@effect/platform-browser/BrowserSocket";
import * as Clipboard from "@effect/platform-browser/Clipboard";
import * as Layer from "effect/Layer";
import * as Atom from "effect/reactivity/Atom";
import { RegistryClient } from "./registry.ts";

/** The browser's own services: the WebSocket constructor and the clipboard. */
export const BrowserLayer = Layer.mergeAll(
  BrowserSocket.layerWebSocketConstructor,
  Clipboard.layer,
);

/**
 * The app's runtime. It takes the Registry client's layer from that client's own runtime: both come from the default
 * factory, which builds a layer once per registry, so there is one client, and one `Reactivity` that a mutation here
 * invalidates the client's queries through. A test replaces either layer through the registry's `initialValues`.
 */
export const appRuntime = Atom.runtime((get) =>
  Layer.mergeAll(BrowserLayer, get(RegistryClient.runtime.layer)),
);
