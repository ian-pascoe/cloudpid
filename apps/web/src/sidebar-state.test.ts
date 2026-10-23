// @effect-diagnostics preferEffectArray:off -- the in-memory Storage below is over native arrays.

import { describe, expect, it } from "@effect/vitest";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach } from "vitest";
import { RegistryClient } from "./registry.ts";
import { fakeRegistryLayer } from "./registry.testing.ts";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  sidebarCollapsedAtom,
  sidebarWidthAtom,
  sidebarWidthForKey,
} from "./sidebar-state.ts";
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
  for (const registry of made.splice(0)) registry.dispose();
});

describe("the Session list's width", () => {
  it("starts at the default", () => {
    expect(registryOver().get(sidebarWidthAtom)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("is kept on this device across a reload", () => {
    const storage = memoryStorage();

    registryOver(storage).set(sidebarWidthAtom, 400);

    expect(registryOver(storage).get(sidebarWidthAtom)).toBe(400);
  });

  it("stays between the narrowest and the widest, in whole pixels", () => {
    const registry = registryOver();

    registry.set(sidebarWidthAtom, 10);
    expect(registry.get(sidebarWidthAtom)).toBe(MIN_SIDEBAR_WIDTH);

    registry.set(sidebarWidthAtom, 5000);
    expect(registry.get(sidebarWidthAtom)).toBe(MAX_SIDEBAR_WIDTH);

    registry.set(sidebarWidthAtom, 300.6);
    expect(registry.get(sidebarWidthAtom)).toBe(301);
  });

  it("falls back to the default for a width that is no number", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe("whether the Session list is collapsed", () => {
  it("starts expanded", () => {
    expect(registryOver().get(sidebarCollapsedAtom)).toBe(false);
  });

  it("is kept on this device across a reload", () => {
    const storage = memoryStorage();

    registryOver(storage).set(sidebarCollapsedAtom, true);

    expect(registryOver(storage).get(sidebarCollapsedAtom)).toBe(true);
  });
});

describe("the width a key sets on the list's resize handle", () => {
  it("widens with the right arrow and narrows with the left, by a larger step with Shift", () => {
    expect(sidebarWidthForKey(300, "ArrowRight", false)).toBe(316);
    expect(sidebarWidthForKey(300, "ArrowLeft", false)).toBe(284);
    expect(sidebarWidthForKey(300, "ArrowRight", true)).toBe(364);
    expect(sidebarWidthForKey(300, "ArrowLeft", true)).toBe(236);
  });

  it("goes to the narrowest with Home and the widest with End", () => {
    expect(sidebarWidthForKey(300, "Home", false)).toBe(MIN_SIDEBAR_WIDTH);
    expect(sidebarWidthForKey(300, "End", false)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("is none for another key", () => {
    expect(sidebarWidthForKey(300, "Tab", false)).toBeUndefined();
  });
});
