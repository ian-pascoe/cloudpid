// The device's key-value store: the page's `localStorage`, for view preferences kept per device.

import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";

/**
 * The page's `localStorage`, looked up at each call rather than when the runtime is built, so building it where there is
 * none (a test under Node) touches nothing. Where it is missing or refuses (storage turned off), a call fails and the
 * store's reader keeps its value in memory.
 */
const pageStorage: Storage = {
  get length() {
    return globalThis.localStorage.length;
  },
  clear: () => {
    globalThis.localStorage.clear();
  },
  getItem: (key) => globalThis.localStorage.getItem(key),
  key: (index) => globalThis.localStorage.key(index),
  removeItem: (key) => {
    globalThis.localStorage.removeItem(key);
  },
  setItem: (key, value) => {
    globalThis.localStorage.setItem(key, value);
  },
};

/**
 * The `KeyValueStore` the app's runtime holds: `localStorage`. A test replaces it through the registry's
 * `initialValues`.
 */
export const keyValueStoreLayer = Atom.make<Layer.Layer<KeyValueStore.KeyValueStore>>(
  KeyValueStore.layerStorage(() => pageStorage),
).pipe(Atom.keepAlive);
