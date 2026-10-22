// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import {
  DEFAULT_WORKSPACE_SETTINGS,
  INSTANCE_TYPES,
  workspaceOverridesFrom,
  type WorkspaceSettings,
} from "@cloudpid/config";
import {
  WorkspaceError,
  type SessionRecord,
  type WorkspaceRecord,
  type WorkspaceSettingsState,
} from "@cloudpid/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { describe, expect, it } from "@effect/vitest";
import { failureOf, settledFailureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { sessionsAtom } from "./sessions.ts";
import {
  cloneRepoAtom,
  cloneSourceAtom,
  createWorkspaceAtom,
  deleteTypedAtom,
  deleteWorkspaceAtom,
  newWorkspaceSlugAtom,
  removeRepoAtom,
  removeTypedAtom,
  reposAtom,
  resetTypedAtom,
  resetWorkspaceAtom,
  restartContainerAtom,
  saveWorkspaceAtom,
  workspaceDialogAtom,
  workspaceDraftAtom,
  workspaceNamesAtom,
  workspaceSettingsAtom,
  workspacesAtom,
} from "./workspaces-state.ts";

const workspace = (slug: string, name = slug): WorkspaceRecord => ({ slug, name, createdAt: 1 });

const session = (id: string, on: string): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  workspace: on,
  repo: null,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

const slugs = (result: AsyncResult.AsyncResult<readonly WorkspaceRecord[], unknown>) =>
  AsyncResult.getOrThrow(result).map((known) => known.slug);

/** A Registry holding `workspaces` and `sessions`; deleting `stuck` stops partway, deleting its Sessions only. */
const holding = (workspaces: WorkspaceRecord[], sessions: SessionRecord[]) =>
  registryWith({
    listWorkspaces: () => Effect.sync(() => [...workspaces]),
    listSessions: () => Effect.sync(() => [...sessions]),
    createWorkspace: ({ slug }) =>
      Effect.sync(() => {
        const created = workspace(slug);

        workspaces.unshift(created);

        return created;
      }),
    renameWorkspace: ({ workspace: slug, name }) =>
      workspaces.some((known) => known.name === name)
        ? Effect.fail(new WorkspaceError({ message: `A workspace is already named ${name}.` }))
        : Effect.sync(() => {
            const index = workspaces.findIndex((known) => known.slug === slug);
            const renamed = { ...workspaces[index]!, name };

            workspaces[index] = renamed;

            return renamed;
          }),
    deleteWorkspace: ({ workspace: slug }) =>
      Effect.suspend(() => {
        sessions.splice(
          0,
          sessions.length,
          ...sessions.filter((known) => known.workspace !== slug),
        );

        if (slug === "stuck")
          return Effect.fail(new WorkspaceError({ message: "Could not stop it." }));

        workspaces.splice(
          workspaces.findIndex((known) => known.slug === slug),
          1,
        );

        return Effect.void;
      }),
  });

describe("the Workspace list", () => {
  it.effect("lists the Workspaces the Registry answers with", () =>
    Effect.gen(function* () {
      const registry = holding([workspace("work"), workspace("default")], []);

      registry.mount(workspacesAtom);

      expect(slugs(yield* settled(registry, workspacesAtom))).toEqual(["work", "default"]);
    }),
  );

  it.effect("asks again after a Workspace is created or renamed", () =>
    Effect.gen(function* () {
      const registry = holding([workspace("default")], []);

      registry.mount(workspacesAtom);
      yield* settled(registry, workspacesAtom);

      registry.set(createWorkspaceAtom, "work");
      yield* settled(registry, createWorkspaceAtom);
      expect(slugs(yield* settled(registry, workspacesAtom))).toEqual(["work", "default"]);

      registry.set(saveWorkspaceAtom("work"), { name: "Work", settings: undefined });
      yield* settled(registry, saveWorkspaceAtom("work"));
      expect(AsyncResult.getOrThrow(yield* settled(registry, workspacesAtom))[0]?.name).toBe(
        "Work",
      );
    }),
  );

  it.effect("says why a rename was refused", () =>
    Effect.gen(function* () {
      const registry = holding([workspace("default"), workspace("work")], []);

      registry.set(saveWorkspaceAtom("work"), { name: "default", settings: undefined });

      expect(failureOf(yield* settled(registry, saveWorkspaceAtom("work")))).toBe(
        "A workspace is already named default.",
      );
    }),
  );

  it.effect("asks for the Workspaces and the Sessions again after a delete", () =>
    Effect.gen(function* () {
      const registry = holding([workspace("work"), workspace("default")], [session("a", "work")]);

      registry.mount(workspacesAtom);
      registry.mount(sessionsAtom);
      yield* settled(registry, workspacesAtom);
      yield* settled(registry, sessionsAtom);

      registry.set(deleteWorkspaceAtom("work"), undefined);
      yield* settled(registry, deleteWorkspaceAtom("work"));

      expect(slugs(yield* settled(registry, workspacesAtom))).toEqual(["default"]);
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
    }),
  );

  it.effect("asks again after a delete that stopped partway, and says why", () =>
    Effect.gen(function* () {
      const registry = holding([workspace("stuck")], [session("a", "stuck")]);

      registry.mount(sessionsAtom);
      yield* settled(registry, sessionsAtom);

      registry.set(deleteWorkspaceAtom("stuck"), undefined);

      expect(failureOf(yield* settled(registry, deleteWorkspaceAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
    }),
  );
});

/** A Registry whose Workspace `work` holds `repos`; cloning `bad` fails with git's message, and `slow` never ends. */
const cloning = (repos: string[]) => {
  const registry = registryWith({
    listRepos: ({ workspace: slug }) =>
      slug === "down"
        ? Effect.fail(new WorkspaceError({ message: "The Workspace is down." }))
        : Effect.sync(() => (slug === "work" ? [...repos] : [])),
    cloneRepo: ({ source }) =>
      Effect.suspend(() => {
        if (source === "bad") {
          return Effect.fail(new WorkspaceError({ message: "fatal: repository 'bad' not found" }));
        }

        if (source === "slow") return Effect.never;

        const name = source.split("/").pop() ?? source;

        repos.push(name);

        return Effect.succeed(name);
      }),
  });

  return registry;
};

describe("deleting a Workspace", () => {
  it.effect("asks again for its repos and its own settings, as well as the lists", () =>
    Effect.gen(function* () {
      const asked = { repos: 0, settings: 0 };

      const registry = registryWith({
        listWorkspaces: () => Effect.succeed([workspace("work")]),
        listSessions: () => Effect.succeed([]),
        listRepos: () =>
          Effect.sync(() => {
            asked.repos += 1;

            return [];
          }),
        getWorkspaceSettings: () =>
          Effect.die(asked.settings++ < 0 ? "unreachable" : "The Workspace is not answering."),
        deleteWorkspace: () => Effect.void,
      });

      registry.mount(reposAtom("work"));
      registry.mount(workspaceSettingsAtom("work"));
      yield* settled(registry, reposAtom("work"));
      yield* settled(registry, workspaceSettingsAtom("work"));

      expect(asked).toEqual({ repos: 1, settings: 1 });

      registry.set(deleteWorkspaceAtom("work"), undefined);
      yield* settled(registry, deleteWorkspaceAtom("work"));
      yield* settled(registry, reposAtom("work"));
      yield* settled(registry, workspaceSettingsAtom("work"));

      expect(asked).toEqual({ repos: 2, settings: 2 });
    }),
  );
});

describe("the repos of a Workspace", () => {
  it.effect("lists the repos the Workspace holds, each Workspace its own", () =>
    Effect.gen(function* () {
      const registry = cloning(["api", "web"]);

      registry.mount(reposAtom("work"));
      registry.mount(reposAtom("other"));

      expect(AsyncResult.getOrThrow(yield* settled(registry, reposAtom("work")))).toEqual([
        "api",
        "web",
      ]);
      expect(AsyncResult.getOrThrow(yield* settled(registry, reposAtom("other")))).toEqual([]);
    }),
  );

  it.effect("says why when the Registry cannot list them", () =>
    Effect.gen(function* () {
      const registry = cloning([]);

      registry.mount(reposAtom("down"));

      expect(failureOf(yield* settled(registry, reposAtom("down")))).toBe("The Workspace is down.");
    }),
  );

  it.effect("lists them again after a clone, and answers with the directory it went to", () =>
    Effect.gen(function* () {
      const registry = cloning(["api"]);

      registry.mount(reposAtom("work"));
      yield* settled(registry, reposAtom("work"));
      registry.set(cloneRepoAtom("work"), "acme/web");

      expect(AsyncResult.getOrThrow(yield* settled(registry, cloneRepoAtom("work")))).toBe("web");
      expect(AsyncResult.getOrThrow(yield* settled(registry, reposAtom("work")))).toEqual([
        "api",
        "web",
      ]);
    }),
  );

  it.effect("says why a clone failed, in git's words, until the next clone starts", () =>
    Effect.gen(function* () {
      const registry = cloning(["api"]);

      registry.mount(reposAtom("work"));
      yield* settled(registry, reposAtom("work"));
      registry.set(cloneRepoAtom("work"), "bad");

      expect(settledFailureOf(yield* settled(registry, cloneRepoAtom("work")))).toBe(
        "fatal: repository 'bad' not found",
      );

      registry.set(cloneRepoAtom("work"), "slow");

      expect(registry.get(cloneRepoAtom("work")).waiting).toBe(true);
      expect(settledFailureOf(registry.get(cloneRepoAtom("work")))).toBeNull();
      registry.dispose();
    }),
  );

  it("keeps one Workspace's clone apart from another's", () => {
    const registry = cloning([]);

    registry.mount(cloneRepoAtom("work"));
    registry.mount(cloneRepoAtom("other"));
    registry.set(cloneRepoAtom("work"), "slow");

    expect(registry.get(cloneRepoAtom("work")).waiting).toBe(true);
    expect(registry.get(cloneRepoAtom("other")).waiting).toBe(false);
    registry.dispose();
  });
});

const stateOf = (settings: WorkspaceSettings): WorkspaceSettingsState => ({
  settings,
  overrides: workspaceOverridesFrom(settings),
});

/** A Registry holding the settings of Workspace `work`; the first `failures` loads fail, and an idle time of 9999 is refused. */
const configured = (failures = 0) => {
  let held = DEFAULT_WORKSPACE_SETTINGS;
  let left = failures;
  const saved: unknown[] = [];

  const registry = registryWith({
    getWorkspaceSettings: () =>
      Effect.suspend(() =>
        left-- > 0
          ? Effect.fail(new WorkspaceError({ message: "The Workspace is waking up." }))
          : Effect.succeed(stateOf(held)),
      ),
    updateWorkspaceSettings: ({ overrides }) =>
      JSON.stringify(overrides).includes("9999")
        ? Effect.fail(new WorkspaceError({ message: "idleMinutes: at most 1440" }))
        : Effect.sync(() => {
            saved.push(overrides);
            held = { ...held, instance: "basic" };

            return stateOf(held);
          }),
  });

  return { registry, saved };
};

describe("the settings of a Workspace", () => {
  it.effect("loads the settings the Workspace answers with", () =>
    Effect.gen(function* () {
      const { registry } = configured();

      registry.mount(workspaceSettingsAtom("work"));

      expect(
        AsyncResult.getOrThrow(yield* settled(registry, workspaceSettingsAtom("work"))).settings,
      ).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    }),
  );

  it.effect("says why they could not load, and loads them again when asked", () =>
    Effect.gen(function* () {
      const { registry } = configured(1);

      registry.mount(workspaceSettingsAtom("work"));

      expect(settledFailureOf(yield* settled(registry, workspaceSettingsAtom("work")))).toBe(
        "The Workspace is waking up.",
      );

      registry.refresh(workspaceSettingsAtom("work"));

      // The message goes as the new attempt starts.
      expect(settledFailureOf(registry.get(workspaceSettingsAtom("work")))).toBeNull();
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, workspaceSettingsAtom("work"))).settings,
      ).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    }),
  );

  it.effect(
    "saves the overrides of the settings, answers with the new state, and loads again",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = configured();

        registry.mount(workspaceSettingsAtom("work"));
        yield* settled(registry, workspaceSettingsAtom("work"));
        registry.set(saveWorkspaceAtom("work"), {
          name: undefined,
          settings: { instance: "basic", idleMinutes: 5, ignore: ["/data"] },
        });

        const answer = yield* settled(registry, saveWorkspaceAtom("work"));

        expect(AsyncResult.getOrThrow(answer)?.settings.instance).toBe("basic");
        expect(saved).toEqual([{ instance: "basic", ignore: ["/data"] }]);
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, workspaceSettingsAtom("work"))).settings
            .instance,
        ).toBe("basic");
      }),
  );

  it.effect("says why a save was refused, with the Workspace's message", () =>
    Effect.gen(function* () {
      const { registry, saved } = configured();

      registry.set(saveWorkspaceAtom("work"), {
        name: undefined,
        settings: { instance: "basic", idleMinutes: 9999, ignore: [] },
      });

      expect(failureOf(yield* settled(registry, saveWorkspaceAtom("work")))).toBe(
        "idleMinutes: at most 1440",
      );
      expect(saved).toEqual([]);
    }),
  );
});

/** A Registry for the page's forms and dialogs: Workspace `work`, which refuses what is named `bad` or `stuck`. */
const paging = (settingsGate?: Deferred.Deferred<void>) => {
  const workspaces = [workspace("work", "Work")];
  const repos: string[] = [];
  const saved: unknown[] = [];
  const renamed: string[] = [];
  let held = DEFAULT_WORKSPACE_SETTINGS;

  const registry = registryWith({
    listWorkspaces: () => Effect.sync(() => [...workspaces]),
    createWorkspace: ({ slug }) =>
      slug === "bad"
        ? Effect.die(new Error("That slug is taken."))
        : Effect.sync(() => workspace(slug)),
    renameWorkspace: ({ name }) =>
      name === "bad"
        ? Effect.fail(new WorkspaceError({ message: "That name is taken." }))
        : Effect.sync(() => {
            renamed.push(name);

            return workspace("work", name);
          }),
    deleteWorkspace: ({ workspace: slug }) =>
      slug === "stuck"
        ? Effect.fail(new WorkspaceError({ message: "Could not stop it." }))
        : Effect.void,
    listRepos: () => Effect.sync(() => [...repos]),
    cloneRepo: ({ source }) =>
      source === "bad"
        ? Effect.fail(new WorkspaceError({ message: "fatal: repository 'bad' not found" }))
        : Effect.sync(() => {
            repos.push(source);

            return source;
          }),
    getWorkspaceSettings: () =>
      (settingsGate === undefined ? Effect.void : Deferred.await(settingsGate)).pipe(
        Effect.map(() => stateOf(held)),
      ),
    updateWorkspaceSettings: ({ overrides }) =>
      Effect.sync(() => {
        saved.push(overrides);
        held = { ...held, instance: "basic" };

        return stateOf(held);
      }),
  });

  return { registry, saved, renamed };
};

describe("the new-Workspace form", () => {
  it.effect("empties once the Workspace is registered", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(newWorkspaceSlugAtom);
      registry.set(newWorkspaceSlugAtom, "api");
      registry.set(createWorkspaceAtom, "api");
      yield* settled(registry, createWorkspaceAtom);

      expect(registry.get(newWorkspaceSlugAtom)).toBe("");
    }),
  );

  it.effect("keeps what was typed when the Registry refuses it, and says why", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(newWorkspaceSlugAtom);
      registry.set(newWorkspaceSlugAtom, "bad");
      registry.set(createWorkspaceAtom, "bad");

      expect(failureOf(yield* settled(registry, createWorkspaceAtom))).toBe("That slug is taken.");
      expect(registry.get(newWorkspaceSlugAtom)).toBe("bad");
    }),
  );
});

describe("the clone form of a Workspace", () => {
  it.effect("empties once the repo is cloned", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(cloneSourceAtom("work"));
      registry.set(cloneSourceAtom("work"), "acme/web");
      registry.set(cloneRepoAtom("work"), "acme/web");
      yield* settled(registry, cloneRepoAtom("work"));

      expect(registry.get(cloneSourceAtom("work"))).toBe("");
    }),
  );

  it.effect("keeps what was typed when git refuses it", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(cloneSourceAtom("work"));
      registry.set(cloneSourceAtom("work"), "bad");
      registry.set(cloneRepoAtom("work"), "bad");
      yield* settled(registry, cloneRepoAtom("work"));

      expect(registry.get(cloneSourceAtom("work"))).toBe("bad");
    }),
  );

  it.effect("keeps one Workspace's source apart from another's", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(cloneSourceAtom("work"));
      registry.mount(cloneSourceAtom("other"));
      registry.set(cloneSourceAtom("work"), "acme/web");
      registry.set(cloneSourceAtom("other"), "acme/api");
      registry.set(cloneRepoAtom("work"), "acme/web");
      yield* settled(registry, cloneRepoAtom("work"));

      expect(registry.get(cloneSourceAtom("work"))).toBe("");
      expect(registry.get(cloneSourceAtom("other"))).toBe("acme/api");
    }),
  );
});

describe("the dialogs of a Workspace's card", () => {
  it("keeps one Workspace's open dialog apart from another's", () => {
    const { registry } = paging();

    registry.mount(workspaceDialogAtom("work"));
    registry.mount(workspaceDialogAtom("other"));
    registry.set(workspaceDialogAtom("work"), "edit");

    expect(registry.get(workspaceDialogAtom("work"))).toBe("edit");
    expect(registry.get(workspaceDialogAtom("other"))).toBeNull();
    registry.dispose();
  });

  it.effect("closes the Edit dialog once the edit is saved", () =>
    Effect.gen(function* () {
      const { registry, saved, renamed } = paging();

      registry.mount(workspaceDialogAtom("work"));
      registry.set(workspaceDialogAtom("work"), "edit");
      registry.set(saveWorkspaceAtom("work"), {
        name: "Renamed",
        settings: { instance: "basic", idleMinutes: 30, ignore: [] },
      });
      yield* settled(registry, saveWorkspaceAtom("work"));

      expect(renamed).toEqual(["Renamed"]);
      expect(saved).toEqual([{ instance: "basic", idleMinutes: 30 }]);
      expect(registry.get(workspaceDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the Edit dialog open, saving nothing more, when the rename is refused", () =>
    Effect.gen(function* () {
      const { registry, saved } = paging();

      registry.mount(workspaceDialogAtom("work"));
      registry.set(workspaceDialogAtom("work"), "edit");
      registry.set(saveWorkspaceAtom("work"), {
        name: "bad",
        settings: { instance: "basic", idleMinutes: 30, ignore: [] },
      });

      expect(settledFailureOf(yield* settled(registry, saveWorkspaceAtom("work")))).toBe(
        "That name is taken.",
      );
      expect(saved).toEqual([]);
      expect(registry.get(workspaceDialogAtom("work"))).toBe("edit");
    }),
  );

  it.effect("closes the Delete dialog once the Workspace is deleted", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(workspaceDialogAtom("work"));
      registry.set(workspaceDialogAtom("work"), "delete");
      registry.set(deleteWorkspaceAtom("work"), undefined);
      yield* settled(registry, deleteWorkspaceAtom("work"));

      expect(registry.get(workspaceDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the Delete dialog open when the delete is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(workspaceDialogAtom("stuck"));
      registry.set(workspaceDialogAtom("stuck"), "delete");
      registry.set(deleteWorkspaceAtom("stuck"), undefined);

      expect(settledFailureOf(yield* settled(registry, deleteWorkspaceAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(registry.get(workspaceDialogAtom("stuck"))).toBe("delete");
    }),
  );

  it.effect("keeps one Workspace's save apart from another's", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(saveWorkspaceAtom("work"));
      registry.mount(saveWorkspaceAtom("other"));
      registry.set(saveWorkspaceAtom("work"), { name: "bad", settings: undefined });
      yield* settled(registry, saveWorkspaceAtom("work"));

      expect(AsyncResult.isInitial(registry.get(saveWorkspaceAtom("other")))).toBe(true);
    }),
  );

  it.effect("forgets a failed save once the dialog is opened again", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(saveWorkspaceAtom("work"));
      registry.set(saveWorkspaceAtom("work"), { name: "bad", settings: undefined });
      yield* settled(registry, saveWorkspaceAtom("work"));
      registry.set(saveWorkspaceAtom("work"), Atom.Reset);

      expect(AsyncResult.isInitial(registry.get(saveWorkspaceAtom("work")))).toBe(true);
    }),
  );

  it.live("empties the typed slug of the Delete dialog once nothing shows it", () =>
    Effect.gen(function* () {
      const { registry } = paging();
      const unmount = registry.mount(deleteTypedAtom("work"));

      registry.set(deleteTypedAtom("work"), "wor");
      expect(registry.get(deleteTypedAtom("work"))).toBe("wor");
      unmount();
      yield* Effect.sleep("10 millis");

      expect(registry.get(deleteTypedAtom("work"))).toBe("");
    }),
  );
});

describe("the Edit dialog's draft", () => {
  /** Mount the atoms the dialog reads, and wait for the list of Workspaces, so the draft starts with a name. */
  const opened = (registry: ReturnType<typeof paging>["registry"]) =>
    Effect.gen(function* () {
      registry.mount(workspaceNamesAtom);
      registry.mount(workspaceSettingsAtom("work"));
      yield* settled(registry, workspacesAtom);
      registry.mount(workspaceDraftAtom("work"));
    });

  it.effect("starts with the Workspace's name, and fills in the settings when they answer", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const { registry } = paging(gate);

      yield* opened(registry);

      // The dialog is open and the settings have not answered.
      expect(registry.get(workspaceDraftAtom("work"))).toEqual({
        name: "Work",
        instance: undefined,
        idle: "",
        ignore: undefined,
      });

      yield* Deferred.succeed(gate, undefined);
      yield* settled(registry, workspaceSettingsAtom("work"));

      expect(registry.get(workspaceDraftAtom("work"))).toEqual({
        name: "Work",
        instance: DEFAULT_WORKSPACE_SETTINGS.instance,
        idle: String(DEFAULT_WORKSPACE_SETTINGS.idleMinutes),
        ignore: "",
      });
    }),
  );

  it.effect("keeps what was typed when the settings answer after it", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const { registry } = paging(gate);

      yield* opened(registry);

      const other = INSTANCE_TYPES.find((type) => type !== DEFAULT_WORKSPACE_SETTINGS.instance)!;

      registry.set(workspaceDraftAtom("work"), {
        name: "Renamed",
        instance: other,
        idle: "",
        ignore: "/data",
      });
      yield* Deferred.succeed(gate, undefined);
      yield* settled(registry, workspaceSettingsAtom("work"));

      expect(registry.get(workspaceDraftAtom("work"))).toEqual({
        name: "Renamed",
        instance: other,
        idle: String(DEFAULT_WORKSPACE_SETTINGS.idleMinutes),
        ignore: "/data",
      });
    }),
  );

  it.effect("keeps what was picked when the settings are loaded again", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      yield* opened(registry);
      yield* settled(registry, workspaceSettingsAtom("work"));
      registry.set(workspaceDraftAtom("work"), {
        name: "Work",
        instance: "lite",
        idle: "20",
        ignore: "",
      });
      registry.refresh(workspaceSettingsAtom("work"));
      yield* settled(registry, workspaceSettingsAtom("work"));

      expect(registry.get(workspaceDraftAtom("work"))).toEqual({
        name: "Work",
        instance: "lite",
        idle: "20",
        ignore: "",
      });
    }),
  );
});

/** A Registry that records what it is asked to reset, restart and remove, and refuses what is on `stuck`. */
const destructive = () => {
  const calls: unknown[] = [];
  const sessions = [{ ...session("a", "work"), repo: "web" }, session("b", "work")];
  const repos = ["api", "web"];
  const stuck = (message: string) => Effect.fail(new WorkspaceError({ message }));

  const registry = registryWith({
    listSessions: () => Effect.sync(() => [...sessions]),
    listRepos: () => Effect.sync(() => [...repos]),
    resetWorkspace: (payload) => {
      calls.push(["resetWorkspace", payload]);

      return payload.workspace === "stuck"
        ? stuck("Could not reset it.")
        : Effect.sync(() => {
            sessions.length = 0;
            repos.length = 0;
          });
    },
    restartContainer: (payload) => {
      calls.push(["restartContainer", payload]);

      return payload.workspace === "stuck" ? stuck("Could not stop it.") : Effect.void;
    },
    removeRepo: (payload) => {
      calls.push(["removeRepo", payload]);

      return payload.workspace === "stuck"
        ? stuck("Could not remove it.")
        : Effect.sync(() => {
            sessions.splice(
              0,
              sessions.length,
              ...sessions.filter((known) => known.repo !== payload.repo),
            );
            repos.splice(repos.indexOf(payload.repo), 1);
          });
    },
  });

  return { registry, calls };
};

describe("resetting a Workspace", () => {
  it.effect("resets it, closes the dialog and asks for the Sessions and repos again", () =>
    Effect.gen(function* () {
      const { registry, calls } = destructive();

      registry.mount(workspaceDialogAtom("work"));
      registry.mount(sessionsAtom);
      registry.mount(reposAtom("work"));
      yield* settled(registry, sessionsAtom);
      yield* settled(registry, reposAtom("work"));
      registry.set(workspaceDialogAtom("work"), "reset");
      registry.set(resetWorkspaceAtom("work"), undefined);
      yield* settled(registry, resetWorkspaceAtom("work"));

      expect(calls).toEqual([["resetWorkspace", { workspace: "work" }]]);
      expect(registry.get(workspaceDialogAtom("work"))).toBeNull();
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
      expect(AsyncResult.getOrThrow(yield* settled(registry, reposAtom("work")))).toEqual([]);
    }),
  );

  it.effect("keeps the dialog open when it is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = destructive();

      registry.mount(workspaceDialogAtom("stuck"));
      registry.set(workspaceDialogAtom("stuck"), "reset");
      registry.set(resetWorkspaceAtom("stuck"), undefined);

      expect(settledFailureOf(yield* settled(registry, resetWorkspaceAtom("stuck")))).toBe(
        "Could not reset it.",
      );
      expect(registry.get(workspaceDialogAtom("stuck"))).toBe("reset");
    }),
  );

  it.live("keeps the typed slug apart from the Delete dialog's", () =>
    Effect.gen(function* () {
      const { registry } = destructive();

      registry.mount(resetTypedAtom("work"));
      registry.mount(deleteTypedAtom("work"));
      registry.set(resetTypedAtom("work"), "work");

      expect(registry.get(deleteTypedAtom("work"))).toBe("");
      registry.dispose();
      yield* Effect.void;
    }),
  );
});

describe("restarting a Workspace's Container", () => {
  it.effect("restarts it and closes the dialog", () =>
    Effect.gen(function* () {
      const { registry, calls } = destructive();

      registry.mount(workspaceDialogAtom("work"));
      registry.set(workspaceDialogAtom("work"), "restart");
      registry.set(restartContainerAtom("work"), undefined);
      yield* settled(registry, restartContainerAtom("work"));

      expect(calls).toEqual([["restartContainer", { workspace: "work" }]]);
      expect(registry.get(workspaceDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the dialog open when it is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = destructive();

      registry.mount(workspaceDialogAtom("stuck"));
      registry.set(workspaceDialogAtom("stuck"), "restart");
      registry.set(restartContainerAtom("stuck"), undefined);

      expect(settledFailureOf(yield* settled(registry, restartContainerAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(registry.get(workspaceDialogAtom("stuck"))).toBe("restart");
    }),
  );
});

describe("removing a repo", () => {
  it.effect("removes it, closes the dialog and asks for the Sessions and repos again", () =>
    Effect.gen(function* () {
      const { registry, calls } = destructive();

      registry.mount(workspaceDialogAtom("work"));
      registry.mount(sessionsAtom);
      registry.mount(reposAtom("work"));
      yield* settled(registry, sessionsAtom);
      yield* settled(registry, reposAtom("work"));
      registry.set(workspaceDialogAtom("work"), { removeRepo: "web" });
      registry.set(removeRepoAtom("work"), "web");
      yield* settled(registry, removeRepoAtom("work"));

      expect(calls).toEqual([["removeRepo", { workspace: "work", repo: "web" }]]);
      expect(registry.get(workspaceDialogAtom("work"))).toBeNull();
      expect(AsyncResult.getOrThrow(yield* settled(registry, reposAtom("work")))).toEqual(["api"]);
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom)).map((known) => known.id),
      ).toEqual(["b"]);
    }),
  );

  it.effect("keeps the dialog open when it is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = destructive();

      registry.mount(workspaceDialogAtom("stuck"));
      registry.set(workspaceDialogAtom("stuck"), { removeRepo: "web" });
      registry.set(removeRepoAtom("stuck"), "web");

      expect(settledFailureOf(yield* settled(registry, removeRepoAtom("stuck")))).toBe(
        "Could not remove it.",
      );
      expect(registry.get(workspaceDialogAtom("stuck"))).toEqual({ removeRepo: "web" });
    }),
  );

  it("keeps the typed name apart from the other dialogs' and other Workspaces'", () => {
    const { registry } = destructive();

    registry.mount(removeTypedAtom("work"));
    registry.mount(removeTypedAtom("other"));
    registry.mount(resetTypedAtom("work"));
    registry.set(removeTypedAtom("work"), "web");

    expect(registry.get(removeTypedAtom("other"))).toBe("");
    expect(registry.get(resetTypedAtom("work"))).toBe("");
    registry.dispose();
  });
});
