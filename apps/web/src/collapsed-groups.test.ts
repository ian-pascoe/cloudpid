// @effect-diagnostics preferEffectArray:off -- an in-memory Storage and Session list over native arrays.

import type { SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { groupCollapsedAtom, groupKey, revealShownAtom } from "./collapsed-groups.ts";
import { RegistryClient } from "./registry.ts";
import { fakeRegistryLayer, settled } from "./registry.testing.ts";
import { pathAtom, sessionPath } from "./router.ts";
import { sessionsAtom } from "./sessions.ts";
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

const session = (
  id: string,
  workspace: string,
  archivedAt: number | null = null,
): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  workspace,
  repo: null,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt,
});

/** An atom registry over `storage` whose Registry lists `list`. */
const registryOver = (storage: Storage, list: SessionRecord[] = []) =>
  AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        keyValueStoreLayer,
        KeyValueStore.layerStorage(() => storage),
      ),
      Atom.initialValue(
        RegistryClient.runtime.layer,
        fakeRegistryLayer({ listSessions: () => Effect.sync(() => [...list]) }),
      ),
    ],
  });

describe("a Workspace group", () => {
  it("starts expanded", () => {
    const registry = registryOver(memoryStorage());

    expect(registry.get(groupCollapsedAtom(groupKey("active", "work")))).toBe(false);
  });

  it("stays collapsed on this device after a reload, and expands again", () => {
    const storage = memoryStorage();
    const key = groupKey("active", "work");

    registryOver(storage).set(groupCollapsedAtom(key), true);
    expect(registryOver(storage).get(groupCollapsedAtom(key))).toBe(true);

    registryOver(storage).set(groupCollapsedAtom(key), false);
    expect(registryOver(storage).get(groupCollapsedAtom(key))).toBe(false);
  });

  it("collapses apart from the same Workspace's archived group and from other Workspaces", () => {
    const registry = registryOver(memoryStorage());

    registry.set(groupCollapsedAtom(groupKey("active", "work")), true);

    expect(registry.get(groupCollapsedAtom(groupKey("archived", "work")))).toBe(false);
    expect(registry.get(groupCollapsedAtom(groupKey("active", "default")))).toBe(false);
  });
});

describe("the shown Session's group", () => {
  it.effect("expands when the Session is shown, and stays expanded after a reload", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const key = groupKey("active", "work");
      const registry = registryOver(storage, [session("a", "work")]);

      registry.set(groupCollapsedAtom(key), true);
      registry.mount(pathAtom);
      registry.mount(revealShownAtom);
      registry.set(pathAtom, sessionPath("a"));
      yield* settled(registry, sessionsAtom);

      expect(registry.get(groupCollapsedAtom(key))).toBe(false);
      expect(registryOver(storage).get(groupCollapsedAtom(key))).toBe(false);
    }),
  );

  it.effect("can be collapsed again while the Session is shown, as the list refreshes", () =>
    Effect.gen(function* () {
      const key = groupKey("active", "work");
      const list = [session("a", "work")];
      const registry = registryOver(memoryStorage(), list);

      registry.mount(pathAtom);
      registry.mount(revealShownAtom);
      registry.set(pathAtom, sessionPath("a"));
      yield* settled(registry, sessionsAtom);

      registry.set(groupCollapsedAtom(key), true);
      // The refresh answers with a changed record, as when the Session starts running.
      list[0] = { ...list[0]!, status: "running", updatedAt: 2 };
      registry.refresh(sessionsAtom);
      yield* Effect.yieldNow;
      const refreshed = yield* settled(registry, sessionsAtom);

      expect(AsyncResult.getOrThrow(refreshed)[0]?.status).toBe("running");
      expect(registry.get(groupCollapsedAtom(key))).toBe(true);
    }),
  );

  it.effect("expands again when the Session is shown again after the owner left it", () =>
    Effect.gen(function* () {
      const key = groupKey("active", "work");
      const registry = registryOver(memoryStorage(), [session("a", "work")]);

      registry.mount(pathAtom);
      registry.mount(revealShownAtom);
      registry.set(pathAtom, sessionPath("a"));
      yield* settled(registry, sessionsAtom);

      // The list alone, as on a phone: the owner collapses the group, then a notification opens the Session again.
      registry.set(pathAtom, "/");
      registry.set(groupCollapsedAtom(key), true);
      registry.set(pathAtom, sessionPath("a"));

      expect(registry.get(groupCollapsedAtom(key))).toBe(false);
    }),
  );

  it.effect("is the archived group for an archived Session, leaving the active one as it was", () =>
    Effect.gen(function* () {
      const registry = registryOver(memoryStorage(), [session("a", "work", 5)]);

      registry.set(groupCollapsedAtom(groupKey("active", "work")), true);
      registry.set(groupCollapsedAtom(groupKey("archived", "work")), true);
      registry.mount(pathAtom);
      registry.mount(revealShownAtom);
      registry.set(pathAtom, sessionPath("a"));
      yield* settled(registry, sessionsAtom);

      expect(registry.get(groupCollapsedAtom(groupKey("archived", "work")))).toBe(false);
      expect(registry.get(groupCollapsedAtom(groupKey("active", "work")))).toBe(true);
    }),
  );
});
