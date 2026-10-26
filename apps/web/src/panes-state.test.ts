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
  MIN_CHAT_WIDTH,
  MIN_PANE_WIDTH,
  paneWidthAtom,
  paneWidthForKey,
  panesAtom,
  rememberPanesAtom,
  widestPaneIn,
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

const SUBAGENTS = { open: ["subagents"], shown: "subagents", hidden: false };

describe("the Panes open, as atoms over the URL", () => {
  it("are what the URL holds when the page loads", () => {
    stubWindow("/sessions/a?pane=subagents");
    const registry = registryOver();

    expect(registry.get(panesAtom)).toEqual(SUBAGENTS);
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

    registry.set(panesAtom, { type: "replace", key: "new", by: "subagents" });
    expect(browser.history().entries).toEqual(["/sessions/a?pane=subagents"]);

    registry.set(panesAtom, { type: "toggleArea" });
    expect(registry.get(panesAtom).hidden).toBe(true);
    expect(browser.history().entries).toEqual(["/sessions/a?pane=subagents&panes=hidden"]);

    registry.set(panesAtom, { type: "toggleArea" });
    expect(registry.get(panesAtom)).toEqual(SUBAGENTS);
    expect(browser.history().entries).toEqual(["/sessions/a?pane=subagents"]);
  });

  it("survive a reload", () => {
    const browser = stubWindow("/sessions/a");
    const first = registryOver();

    first.mount(panesAtom);
    first.set(panesAtom, { type: "open", key: "subagents" });

    // A reload builds the page again over the same URL.
    expect(browser.history().entries).toEqual(["/sessions/a?pane=subagents"]);
    expect(registryOver().get(panesAtom)).toEqual(SUBAGENTS);
  });

  it("replace the history entry, so Back leaves the Session and not the Pane", () => {
    const browser = stubWindow("/");
    const registry = registryOver();

    registry.mount(panesAtom);

    navigate("/sessions/a");
    registry.set(panesAtom, { type: "open", key: "subagents" });
    registry.set(panesAtom, { type: "close", key: "subagents" });
    registry.set(panesAtom, { type: "open", key: "subagents" });

    expect(browser.history()).toEqual({ entries: ["/", "/sessions/a?pane=subagents"], at: 1 });

    browser.back();
    expect(registry.get(panesAtom).open).toEqual([]);

    // Forward comes back to the Session as it was left, Pane and all.
    browser.forward();
    expect(registry.get(panesAtom)).toEqual(SUBAGENTS);
  });

  it("are heard from the browser's back and forward buttons", () => {
    const browser = stubWindow("/sessions/a");
    const registry = registryOver();

    registry.mount(panesAtom);

    navigate("/sessions/b");
    navigate("/sessions/a?pane=subagents");
    expect(registry.get(panesAtom).open).toEqual(["subagents"]);

    browser.back();
    expect(registry.get(panesAtom).open).toEqual([]);
  });

  it("close when the page moves to another Session", () => {
    stubWindow("/sessions/a?pane=subagents");
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
    registry.set(panesAtom, { type: "close", key: "subagents" });

    expect(browser.history().entries).toEqual(["/sessions/a?x=1"]);
  });
});

describe("the Panes a Session was left with", () => {
  it("open again when the owner comes back to it from another Session", () => {
    stubWindow("/sessions/a");
    const registry = registryOver();

    registry.mount(panesAtom);
    registry.set(panesAtom, { type: "open", key: "subagents" });
    registry.set(panesAtom, { type: "open", key: "tree" });
    registry.set(panesAtom, { type: "hide" });

    navigate("/sessions/b");
    expect(registry.get(panesAtom).open).toEqual([]);

    // Going to a Session drops the query: the layout says what is open.
    navigate("/sessions/a");
    expect(registry.get(panesAtom)).toEqual({
      open: ["subagents", "tree"],
      shown: "tree",
      hidden: true,
    });
  });

  it("are kept on this device, so they come back after a reload without the query", () => {
    const storage = memoryStorage();

    stubWindow("/sessions/a");
    const first = registryOver(storage);

    first.mount(panesAtom);
    first.set(panesAtom, { type: "open", key: "subagents" });
    vi.unstubAllGlobals();

    stubWindow("/sessions/a");
    expect(registryOver(storage).get(panesAtom)).toEqual(SUBAGENTS);
  });

  it("stay closed once the owner closed them all", () => {
    stubWindow("/sessions/a");
    const registry = registryOver();

    registry.mount(panesAtom);
    registry.set(panesAtom, { type: "open", key: "subagents" });
    registry.set(panesAtom, { type: "close", key: "subagents" });

    navigate("/sessions/b");
    navigate("/sessions/a");
    expect(registry.get(panesAtom).open).toEqual([]);
  });

  it("are the ones a link opened, once the page heard of it", () => {
    stubWindow("/sessions/a");
    const registry = registryOver();

    registry.mount(panesAtom);
    registry.set(panesAtom, { type: "open", key: "tree" });

    // A push tap opens the Session with a Pane in its query.
    navigate("/sessions/a?pane=subagents");
    registry.mount(rememberPanesAtom("a"));

    navigate("/sessions/b");
    navigate("/sessions/a");
    expect(registry.get(panesAtom)).toEqual(SUBAGENTS);
  });

  it("are the Session's own, one Session's not showing in another's", () => {
    stubWindow("/sessions/a");
    const registry = registryOver();

    registry.mount(panesAtom);
    registry.set(panesAtom, { type: "open", key: "subagents" });

    navigate("/sessions/b");
    registry.set(panesAtom, { type: "open", key: "tree" });

    navigate("/sessions/a");
    expect(registry.get(panesAtom).open).toEqual(["subagents"]);

    navigate("/sessions/b");
    expect(registry.get(panesAtom).open).toEqual(["tree"]);
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

    registry.set(paneWidthAtom, 50_000);
    expect(registry.get(paneWidthAtom)).toBe(MAX_PANE_WIDTH);

    registry.set(paneWidthAtom, 400.6);
    expect(registry.get(paneWidthAtom)).toBe(401);
  });

  it("falls back to the default for a width that is no number", () => {
    expect(clampPaneWidth(Number.NaN)).toBe(DEFAULT_PANE_WIDTH);
    expect(clampPaneWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PANE_WIDTH);
  });

  it("may take all the page's room but the chat's least width", () => {
    expect(widestPaneIn(1600)).toBe(1600 - MIN_CHAT_WIDTH);
    expect(widestPaneIn(1200.5)).toBe(1200 - MIN_CHAT_WIDTH);
    // A page with no room to spare still shows the area at its narrowest.
    expect(widestPaneIn(400)).toBe(MIN_PANE_WIDTH);
    expect(widestPaneIn(100_000)).toBe(MAX_PANE_WIDTH);
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

  it("widens no further than the page has room for", () => {
    expect(paneWidthForKey(900, "ArrowLeft", true, 920)).toBe(920);
    expect(paneWidthForKey(400, "End", false, 920)).toBe(920);
  });

  it("is none for another key", () => {
    expect(paneWidthForKey(400, "Tab", false)).toBeUndefined();
  });
});
