// @effect-diagnostics preferEffectArray:off -- in-memory fakes of the Registry recording what they were asked in native arrays.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, beforeEach, vi } from "vitest";
import { FILE_SEARCH_DEBOUNCE_MS } from "./chat/file-search.ts";
import {
  draftCatalogAtom,
  draftFileSearchAtom,
  draftLookups,
  draftPlace,
  draftPlaceAtom,
} from "./draft-lookups.ts";
import { draftEnvironmentAtom, draftWorkspaceAtom } from "./draft-state.ts";
import { environmentsAtom, workspacesAtom } from "./environments-state.ts";
import { RegistryClient } from "./registry.ts";
import { fakeRegistryLayer, settled } from "./registry.testing.ts";
import { settle } from "./session/client.testing.ts";
import { keyValueStoreLayer } from "./storage.ts";

const WORKSPACE = {
  id: "0a1b2c3d",
  environment: "work",
  branch: "fix/build",
  base: null,
  repos: ["app"],
  directory: "/workspace/app",
  createdAt: 1,
};

/** A registry whose Registry has two Environments and a Workspace, and records what the draft's lookups ask. */
const lookingUp = () => {
  const asked: unknown[] = [];
  const items = new Map<string, string>();

  const storage = {
    length: 0,
    clear: () => {
      items.clear();
    },
    getItem: (key: string) => items.get(key) ?? null,
    key: () => null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  } satisfies Storage;

  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        keyValueStoreLayer,
        KeyValueStore.layerStorage(() => storage),
      ),
      Atom.initialValue(
        RegistryClient.runtime.layer,
        fakeRegistryLayer({
          listEnvironments: () =>
            Effect.succeed([
              { id: "default", name: "Default", repos: [], createdAt: 1 },
              { id: "work", name: "Work", repos: [], createdAt: 1 },
            ]),
          listWorkspaces: () => Effect.succeed([WORKSPACE]),
          draftCatalog: (payload) =>
            Effect.sync(() => {
              asked.push({ catalog: payload });

              return {
                commands: [],
                templates: [],
                skills: [{ name: `${payload.environment}-skill`, description: "A skill" }],
              };
            }),
          draftFiles: (payload) =>
            Effect.sync(() => {
              asked.push({ files: payload });

              return { paths: [`${payload.query}/index.ts`] };
            }),
        }),
      ),
    ],
  });

  const loaded = Effect.gen(function* () {
    registry.mount(draftPlaceAtom);
    yield* settled(registry, environmentsAtom);
    yield* settled(registry, workspacesAtom);
  });

  return { registry, asked, loaded };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the draft composer's lookups", () => {
  it.effect("ask the Registry for the catalog of the place the draft is made in", () =>
    Effect.gen(function* () {
      const { registry, asked, loaded } = lookingUp();

      yield* loaded;
      // As the draft composer does: each place's catalog is kept while it is read.
      registry.mount(draftCatalogAtom(draftPlace("default", "new")));
      registry.mount(draftCatalogAtom(draftPlace("work", WORKSPACE.id)));
      registry.mount(draftLookups.askCatalog);
      registry.set(draftLookups.askCatalog, undefined);
      yield* settle;

      expect(asked).toEqual([{ catalog: { environment: "default", workspace: "new" } }]);
      expect(registry.get(draftCatalogAtom(draftPlace("default", "new")))?.skills).toEqual([
        { name: "default-skill", description: "A skill" },
      ]);

      registry.set(draftEnvironmentAtom, "work");
      registry.set(draftWorkspaceAtom, WORKSPACE.id);
      registry.set(draftLookups.askCatalog, undefined);
      yield* settle;

      expect(asked).toEqual([
        { catalog: { environment: "default", workspace: "new" } },
        { catalog: { environment: "work", workspace: WORKSPACE.id } },
      ]);
      expect(
        registry.get(draftCatalogAtom(draftPlace("work", WORKSPACE.id)))?.skills[0]?.name,
      ).toBe("work-skill");
    }),
  );

  it.effect("take a Workspace of another Environment for a new one", () =>
    Effect.gen(function* () {
      const { registry, loaded } = lookingUp();

      yield* loaded;
      registry.set(draftWorkspaceAtom, WORKSPACE.id);

      expect(registry.get(draftPlaceAtom)).toEqual(draftPlace("default", "new"));
    }),
  );

  it.effect("search the files of the place the draft is made in, once the owner pauses", () =>
    Effect.gen(function* () {
      const { registry, asked, loaded } = lookingUp();
      const place = draftPlace("default", "new");

      yield* loaded;
      // As the draft composer does: the search runs while its answers are read.
      registry.mount(draftFileSearchAtom(place));
      registry.mount(draftLookups.searchFiles);
      registry.set(draftLookups.searchFiles, "src");
      yield* settle;

      expect(asked).toEqual([]);

      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS));
      yield* settle;

      expect(asked).toEqual([
        { files: { environment: "default", workspace: "new", query: "src" } },
      ]);
      expect(registry.get(draftFileSearchAtom(place)).held?.paths).toEqual(["src/index.ts"]);
    }),
  );
});
