// @effect-diagnostics preferEffectArray:off -- an in-memory Storage over native arrays.

import type { SessionAgent } from "@cloudpid/protocol";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "vitest";
import {
  forgetDismissedAtom,
  indentOf,
  subagentRows,
  subagentsExpandedAtom,
} from "./list-subagents.ts";
import { RegistryClient } from "./registry.ts";
import { fakeRegistryLayer } from "./registry.testing.ts";
import { pathAtom, sessionPath, subagentPath } from "./router.ts";
import { keyValueStoreLayer } from "./storage.ts";

const agent = (
  id: string,
  parent = "root",
  status: SessionAgent["status"] = "idle",
): SessionAgent => ({
  id,
  parent,
  role: null,
  status,
});

const rowsOf = (agents: readonly SessionAgent[]) =>
  subagentRows(agents).map((row) => `${"  ".repeat(row.depth)}${row.agent.id}`);

describe("a Session's subagent rows", () => {
  it("are none for a record without subagents", () => {
    expect(subagentRows(undefined)).toEqual([]);
    expect(subagentRows([])).toEqual([]);
  });

  it("nest each subagent under its parent, the root's children first, siblings in the record's order", () => {
    expect(
      rowsOf([
        agent("agent-1"),
        agent("agent-2"),
        agent("agent-1.a", "agent-1"),
        agent("agent-1.a.x", "agent-1.a"),
        agent("agent-1.b", "agent-1"),
        agent("agent-2.a", "agent-2"),
      ]),
    ).toEqual([
      "agent-1",
      "  agent-1.a",
      "    agent-1.a.x",
      "  agent-1.b",
      "agent-2",
      "  agent-2.a",
    ]);
  });

  it("show a subagent whose parent is not listed at the top level", () => {
    expect(rowsOf([agent("agent-1"), agent("agent-3.a", "agent-3")])).toEqual([
      "agent-1",
      "agent-3.a",
    ]);
  });

  it("show each agent once, even when a malformed record makes a cycle", () => {
    expect(rowsOf([agent("a", "b"), agent("b", "a"), agent("c")])).toEqual(["c", "a", "  b"]);
  });
});

describe("a subagent row's indent", () => {
  it("is one step per level, at most two", () => {
    expect([0, 1, 2, 3, 7].map(indentOf)).toEqual([0, 1, 2, 2, 2]);
  });
});

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

const registryOver = (storage: Storage) => {
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        keyValueStoreLayer,
        KeyValueStore.layerStorage(() => storage),
      ),
      // The app's runtime holds the Registry client too: a fake one keeps it from reaching for the network.
      Atom.initialValue(RegistryClient.runtime.layer, fakeRegistryLayer({})),
    ],
  });

  registry.mount(pathAtom);
  registry.mount(forgetDismissedAtom);

  return registry;
};

describe("a Session's subagents in the list", () => {
  it("are collapsed by default, and stay expanded on this device after a reload", () => {
    const storage = memoryStorage();

    expect(registryOver(storage).get(subagentsExpandedAtom("a"))).toBe(false);

    registryOver(storage).set(subagentsExpandedAtom("a"), true);
    expect(registryOver(storage).get(subagentsExpandedAtom("a"))).toBe(true);
    expect(registryOver(storage).get(subagentsExpandedAtom("b"))).toBe(false);

    registryOver(storage).set(subagentsExpandedAtom("a"), false);
    expect(registryOver(storage).get(subagentsExpandedAtom("a"))).toBe(false);
  });

  it("expand while the Session's page or one of its Subagent pages is shown, and only then", () => {
    const storage = memoryStorage();
    const registry = registryOver(storage);

    registry.set(pathAtom, sessionPath("a"));
    expect(registry.get(subagentsExpandedAtom("a"))).toBe(true);
    expect(registry.get(subagentsExpandedAtom("b"))).toBe(false);

    registry.set(pathAtom, subagentPath("a", "agent-1"));
    expect(registry.get(subagentsExpandedAtom("a"))).toBe(true);

    registry.set(pathAtom, sessionPath("b"));
    expect(registry.get(subagentsExpandedAtom("a"))).toBe(false);
    // Nothing of the reveal is kept on the device.
    expect(registryOver(storage).get(subagentsExpandedAtom("b"))).toBe(false);
  });

  it("can be collapsed while shown, and reveal again once the Session is shown anew", () => {
    const registry = registryOver(memoryStorage());

    registry.set(pathAtom, sessionPath("a"));
    registry.set(subagentsExpandedAtom("a"), false);
    expect(registry.get(subagentsExpandedAtom("a"))).toBe(false);

    // A Subagent page of the same Session keeps the owner's collapse.
    registry.set(pathAtom, subagentPath("a", "agent-1"));
    expect(registry.get(subagentsExpandedAtom("a"))).toBe(false);

    registry.set(pathAtom, sessionPath("b"));
    registry.set(pathAtom, sessionPath("a"));
    expect(registry.get(subagentsExpandedAtom("a"))).toBe(true);
  });

  it("stay expanded after leaving when the owner expanded them while shown", () => {
    const registry = registryOver(memoryStorage());

    registry.set(pathAtom, sessionPath("a"));
    registry.set(subagentsExpandedAtom("a"), false);
    registry.set(subagentsExpandedAtom("a"), true);
    registry.set(pathAtom, sessionPath("b"));

    expect(registry.get(subagentsExpandedAtom("a"))).toBe(true);
  });
});
