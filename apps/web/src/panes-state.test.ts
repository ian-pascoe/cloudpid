// @effect-diagnostics preferEffectArray:off -- the in-memory Storage below is over native arrays.

import { describe, expect, it } from "@effect/vitest";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, vi } from "vitest";
import {
  clampPaneWidth,
  DEFAULT_PANE_WIDTH,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  paneWidthAtom,
  paneWidthForKey,
  panesAtom,
} from "./panes-state.ts";
import { RegistryClient } from "./registry.ts";
import { fakeRegistryLayer } from "./registry.testing.ts";
import { navigate } from "./router.ts";
import { stubWindow } from "./router.testing.ts";
import { keyValueStoreLayer } from "./storage.ts";

/** A `Storage` over a map, which outlives the registries a test makes over it, as `localStorage` outlives a reload. */
const memoryStorage = (): Storage => {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

const made: AtomRegistry.AtomRegistry[] = [];

const registryOver = (storage: Storage = memoryStorage()) => {
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        keyValueStoreLayer,
        KeyValueStore.layerStorage(() => storage),
      ),
      // The rest of the app's runtime is built from fakes, as it is in the other tests over it.
      Atom.initialValue(RegistryClient.runtime.layer, fakeRegistryLayer({})),
    ],
  });

  made.push(registry);

  return registry;
};

afterEach(() => {
  // Disposed while the window is still stubbed: the atoms over it remove their listeners from it.
  for (const registry of made.splice(0)) registry.dispose();

  vi.unstubAllGlobals();
});

describe("the Panes open, as atoms over the URL", () => {
  it("are what the URL holds when the page loads", () => {
    stubWindow("/sessions/a?pane=tasks");
    const registry = registryOver();

    expect(registry.get(panesAtom)).toEqual({ open: ["tasks"], shown: "tasks", hidden: false });
  });

  it("are closed for a URL with none", () => {
    stubWindow("/sessions/a");
    const registry = registryOver();

    expect(registry.get(panesAtom)).toEqual({ open: [], shown: undefined, hidden: false });
  });

  it("open, hide and show again from the area's button, in the URL", () => {
    const browser = stubWindow("/sessions/a");
    const registry = registryOver();

    registry.mount(panesAtom);

    registry.set(panesAtom, { type: "toggleArea" });
    expect(registry.get(panesAtom).shown).toBe("new");
    expect(browser.history().entries).toEqual(["/sessions/a?pane=new"]);

    registry.set(panesAtom, { type: "replace", key: "new", by: "tasks" });
    expect(browser.history().entries).toEqual(["/sessions/a?pane=tasks"]);

    registry.set(panesAtom, { type: "toggleArea" });
    expect(registry.get(panesAtom).hidden).toBe(true);
    expect(browser.history().entries).toEqual(["/sessions/a?pane=tasks&panes=hidden"]);

    registry.set(panesAtom, { type: "toggleArea" });
    expect(registry.get(panesAtom)).toEqual({ open: ["tasks"], shown: "tasks", hidden: false });
    expect(browser.history().entries).toEqual(["/sessions/a?pane=tasks"]);
  });

  it("survive a reload", () => {
    const browser = stubWindow("/sessions/a");
    const first = registryOver();

    first.mount(panesAtom);
    first.set(panesAtom, { type: "open", key: "tasks" });

    // A reload builds the page again over the same URL.
    expect(browser.history().entries).toEqual(["/sessions/a?pane=tasks"]);
    expect(registryOver().get(panesAtom)).toEqual({
      open: ["tasks"],
      shown: "tasks",
      hidden: false,
    });
  });

  it("replace the history entry, so Back leaves the Session and not the Pane", () => {
    const browser = stubWindow("/");
    const registry = registryOver();

    registry.mount(panesAtom);

    navigate("/sessions/a");
    registry.set(panesAtom, { type: "open", key: "tasks" });
    registry.set(panesAtom, { type: "close", key: "tasks" });
    registry.set(panesAtom, { type: "open", key: "tasks" });

    expect(browser.history()).toEqual({ entries: ["/", "/sessions/a?pane=tasks"], at: 1 });

    browser.back();
    expect(registry.get(panesAtom).open).toEqual([]);

    // Forward comes back to the Session as it was left, Pane and all.
    browser.forward();
    expect(registry.get(panesAtom)).toEqual({ open: ["tasks"], shown: "tasks", hidden: false });
  });

  it("are heard from the browser's back and forward buttons", () => {
    const browser = stubWindow("/sessions/a");
    const registry = registryOver();

    registry.mount(panesAtom);

    navigate("/sessions/b");
    navigate("/sessions/a?pane=tasks");
    expect(registry.get(panesAtom).open).toEqual(["tasks"]);

    browser.back();
    expect(registry.get(panesAtom).open).toEqual([]);
  });

  it("close when the page moves to another Session", () => {
    stubWindow("/sessions/a?pane=tasks");
    const registry = registryOver();

    registry.mount(panesAtom);
    navigate("/sessions/b");

    expect(registry.get(panesAtom).open).toEqual([]);
  });

  it("leave the query alone for an action that changes nothing", () => {
    const browser = stubWindow("/sessions/a?x=1");
    const registry = registryOver();

    registry.mount(panesAtom);
    registry.set(panesAtom, { type: "open", key: "nope" });
    registry.set(panesAtom, { type: "close", key: "tasks" });

    expect(browser.history().entries).toEqual(["/sessions/a?x=1"]);
  });
});

describe("the Pane area's width", () => {
  it("starts at the default", () => {
    expect(registryOver().get(paneWidthAtom)).toBe(DEFAULT_PANE_WIDTH);
  });

  it("is kept on this device across a reload", () => {
    const storage = memoryStorage();

    registryOver(storage).set(paneWidthAtom, 500);

    expect(registryOver(storage).get(paneWidthAtom)).toBe(500);
  });

  it("stays between the narrowest and the widest, in whole pixels", () => {
    const registry = registryOver();

    registry.set(paneWidthAtom, 10);
    expect(registry.get(paneWidthAtom)).toBe(MIN_PANE_WIDTH);

    registry.set(paneWidthAtom, 5000);
    expect(registry.get(paneWidthAtom)).toBe(MAX_PANE_WIDTH);

    registry.set(paneWidthAtom, 400.6);
    expect(registry.get(paneWidthAtom)).toBe(401);
  });

  it("falls back to the default for a width that is no number", () => {
    expect(clampPaneWidth(Number.NaN)).toBe(DEFAULT_PANE_WIDTH);
    expect(clampPaneWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PANE_WIDTH);
  });
});

describe("the width a key sets on the resize handle", () => {
  it("widens with the left arrow and narrows with the right, by a larger step with Shift", () => {
    expect(paneWidthForKey(400, "ArrowLeft", false)).toBe(416);
    expect(paneWidthForKey(400, "ArrowRight", false)).toBe(384);
    expect(paneWidthForKey(400, "ArrowLeft", true)).toBe(464);
    expect(paneWidthForKey(400, "ArrowRight", true)).toBe(336);
  });

  it("goes to the narrowest with Home and the widest with End", () => {
    expect(paneWidthForKey(400, "Home", false)).toBe(MIN_PANE_WIDTH);
    expect(paneWidthForKey(400, "End", false)).toBe(MAX_PANE_WIDTH);
  });

  it("is none for another key", () => {
    expect(paneWidthForKey(400, "Tab", false)).toBeUndefined();
  });
});
