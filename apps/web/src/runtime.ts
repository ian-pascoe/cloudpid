// The web app's one Effect runtime (ADR-0011): every atom that runs an Effect runs on it, with the browser's services and
// the Registry client.

import * as BrowserSocket from "@effect/platform-browser/BrowserSocket";
import * as Clipboard from "@effect/platform-browser/Clipboard";
import * as Layer from "effect/Layer";
import * as Atom from "effect/reactivity/Atom";
import { ImageEncoderLive } from "./chat/image-encode.ts";
import { UploadsLive } from "./chat/uploads.ts";
import { PushManagerLive } from "./push.ts";
import { RegistryClient } from "./registry.ts";
import { layerSessionProbe } from "./session/client.ts";
import { keyValueStoreLayer } from "./storage.ts";

/** The browser's own services: the WebSocket constructor, the clipboard, and the Session probe over `fetch`. */
export const BrowserLayer = Layer.mergeAll(
  BrowserSocket.layerWebSocketConstructor,
  Clipboard.layer,
  layerSessionProbe,
);

/**
 * The app's runtime. It takes the Registry client's layer from that client's own runtime: both come from the default
 * factory, which builds a layer once per registry, so there is one client, and one `Reactivity` that a mutation here
 * invalidates the client's queries through. Web Push (`PushManagerLive`), the composer's uploads (`UploadsLive`) and its
 * image encoder (`ImageEncoderLive`) touch the page only when an operation runs, so building the layer is safe where
 * there is none (a test). The device's key-value store (`keyValueStoreLayer`) reads `localStorage` only when an atom
 * asks. A test replaces the Registry client's layer or the store's through the registry's `initialValues`.
 */
export const appRuntime = Atom.runtime((get) =>
  Layer.mergeAll(
    BrowserLayer,
    PushManagerLive,
    UploadsLive,
    ImageEncoderLive,
    get(RegistryClient.runtime.layer),
    get(keyValueStoreLayer),
  ),
);
