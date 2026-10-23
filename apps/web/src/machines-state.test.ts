// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import {
  DEFAULT_CONTAINER_SETTINGS,
  INSTANCE_TYPES,
  containerOverridesFrom,
  type ContainerSettings,
} from "@cloudpid/config";
import {
  MachineError,
  type WorkspaceRecord,
  type SessionRecord,
  type MachineRecord,
  type MachineSettingsState,
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
  createMachineAtom,
  deleteTypedAtom,
  deleteMachineAtom,
  newMachineSlugAtom,
  removeRepoAtom,
  removeTypedAtom,
  removeWorkspaceAtom,
  workspaceBranchesAtom,
  workspaceListAtom,
  workspacesAtom,
  reposAtom,
  resetTypedAtom,
  resetMachineAtom,
  restartContainerAtom,
  saveMachineAtom,
  machineDialogAtom,
  machineDraftAtom,
  machineNamesAtom,
  machineSettingsAtom,
  machinesAtom,
} from "./machines-state.ts";

const machine = (slug: string, name = slug): MachineRecord => ({ slug, name, createdAt: 1 });

const session = (id: string, on: string): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  machine: on,
  repo: null,
  workspace: null,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

const slugs = (result: AsyncResult.AsyncResult<readonly MachineRecord[], unknown>) =>
  AsyncResult.getOrThrow(result).map((known) => known.slug);

/** A Registry holding `machines` and `sessions`; deleting `stuck` stops partway, deleting its Sessions only. */
const holding = (machines: MachineRecord[], sessions: SessionRecord[]) =>
  registryWith({
    listMachines: () => Effect.sync(() => [...machines]),
    listSessions: () => Effect.sync(() => [...sessions]),
    createMachine: ({ slug }) =>
      Effect.sync(() => {
        const created = machine(slug);

        machines.unshift(created);

        return created;
      }),
    renameMachine: ({ machine: slug, name }) =>
      machines.some((known) => known.name === name)
        ? Effect.fail(new MachineError({ message: `A machine is already named ${name}.` }))
        : Effect.sync(() => {
            const index = machines.findIndex((known) => known.slug === slug);
            const renamed = { ...machines[index]!, name };

            machines[index] = renamed;

            return renamed;
          }),
    deleteMachine: ({ machine: slug }) =>
      Effect.suspend(() => {
        sessions.splice(0, sessions.length, ...sessions.filter((known) => known.machine !== slug));

        if (slug === "stuck")
          return Effect.fail(new MachineError({ message: "Could not stop it." }));

        machines.splice(
          machines.findIndex((known) => known.slug === slug),
          1,
        );

        return Effect.void;
      }),
  });

describe("the Machine list", () => {
  it.effect("lists the Machines the Registry answers with", () =>
    Effect.gen(function* () {
      const registry = holding([machine("work"), machine("default")], []);

      registry.mount(machinesAtom);

      expect(slugs(yield* settled(registry, machinesAtom))).toEqual(["work", "default"]);
    }),
  );

  it.effect("asks again after a Machine is created or renamed", () =>
    Effect.gen(function* () {
      const registry = holding([machine("default")], []);

      registry.mount(machinesAtom);
      yield* settled(registry, machinesAtom);

      registry.set(createMachineAtom, "work");
      yield* settled(registry, createMachineAtom);
      expect(slugs(yield* settled(registry, machinesAtom))).toEqual(["work", "default"]);

      registry.set(saveMachineAtom("work"), { name: "Work", settings: undefined });
      yield* settled(registry, saveMachineAtom("work"));
      expect(AsyncResult.getOrThrow(yield* settled(registry, machinesAtom))[0]?.name).toBe("Work");
    }),
  );

  it.effect("says why a rename was refused", () =>
    Effect.gen(function* () {
      const registry = holding([machine("default"), machine("work")], []);

      registry.set(saveMachineAtom("work"), { name: "default", settings: undefined });

      expect(failureOf(yield* settled(registry, saveMachineAtom("work")))).toBe(
        "A machine is already named default.",
      );
    }),
  );

  it.effect("asks for the Machines and the Sessions again after a delete", () =>
    Effect.gen(function* () {
      const registry = holding([machine("work"), machine("default")], [session("a", "work")]);

      registry.mount(machinesAtom);
      registry.mount(sessionsAtom);
      yield* settled(registry, machinesAtom);
      yield* settled(registry, sessionsAtom);

      registry.set(deleteMachineAtom("work"), undefined);
      yield* settled(registry, deleteMachineAtom("work"));

      expect(slugs(yield* settled(registry, machinesAtom))).toEqual(["default"]);
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
    }),
  );

  it.effect("asks again after a delete that stopped partway, and says why", () =>
    Effect.gen(function* () {
      const registry = holding([machine("stuck")], [session("a", "stuck")]);

      registry.mount(sessionsAtom);
      yield* settled(registry, sessionsAtom);

      registry.set(deleteMachineAtom("stuck"), undefined);

      expect(failureOf(yield* settled(registry, deleteMachineAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
    }),
  );
});

/** A Registry whose Machine `work` holds `repos`; cloning `bad` fails with git's message, and `slow` never ends. */
const cloning = (repos: string[]) => {
  const registry = registryWith({
    listRepos: ({ machine: slug }) =>
      slug === "down"
        ? Effect.fail(new MachineError({ message: "The Machine is down." }))
        : Effect.sync(() => (slug === "work" ? [...repos] : [])),
    cloneRepo: ({ source }) =>
      Effect.suspend(() => {
        if (source === "bad") {
          return Effect.fail(new MachineError({ message: "fatal: repository 'bad' not found" }));
        }

        if (source === "slow") return Effect.never;

        const name = source.split("/").pop() ?? source;

        repos.push(name);

        return Effect.succeed(name);
      }),
  });

  return registry;
};

describe("deleting a Machine", () => {
  it.effect("asks again for its repos and its own settings, as well as the lists", () =>
    Effect.gen(function* () {
      const asked = { repos: 0, settings: 0 };

      const registry = registryWith({
        listMachines: () => Effect.succeed([machine("work")]),
        listSessions: () => Effect.succeed([]),
        listRepos: () =>
          Effect.sync(() => {
            asked.repos += 1;

            return [];
          }),
        getMachineSettings: () =>
          Effect.die(asked.settings++ < 0 ? "unreachable" : "The Machine is not answering."),
        deleteMachine: () => Effect.void,
      });

      registry.mount(reposAtom("work"));
      registry.mount(machineSettingsAtom("work"));
      yield* settled(registry, reposAtom("work"));
      yield* settled(registry, machineSettingsAtom("work"));

      expect(asked).toEqual({ repos: 1, settings: 1 });

      registry.set(deleteMachineAtom("work"), undefined);
      yield* settled(registry, deleteMachineAtom("work"));
      yield* settled(registry, reposAtom("work"));
      yield* settled(registry, machineSettingsAtom("work"));

      expect(asked).toEqual({ repos: 2, settings: 2 });
    }),
  );
});

describe("the repos of a Machine", () => {
  it.effect("lists the repos the Machine holds, each Machine its own", () =>
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

      expect(failureOf(yield* settled(registry, reposAtom("down")))).toBe("The Machine is down.");
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

  it("keeps one Machine's clone apart from another's", () => {
    const registry = cloning([]);

    registry.mount(cloneRepoAtom("work"));
    registry.mount(cloneRepoAtom("other"));
    registry.set(cloneRepoAtom("work"), "slow");

    expect(registry.get(cloneRepoAtom("work")).waiting).toBe(true);
    expect(registry.get(cloneRepoAtom("other")).waiting).toBe(false);
    registry.dispose();
  });
});

const stateOf = (settings: ContainerSettings): MachineSettingsState => ({
  settings,
  overrides: containerOverridesFrom(settings),
});

/** A Registry holding the settings of Machine `work`; the first `failures` loads fail, and an idle time of 9999 is refused. */
const configured = (failures = 0) => {
  let held = DEFAULT_CONTAINER_SETTINGS;
  let left = failures;
  const saved: unknown[] = [];

  const registry = registryWith({
    getMachineSettings: () =>
      Effect.suspend(() =>
        left-- > 0
          ? Effect.fail(new MachineError({ message: "The Machine is waking up." }))
          : Effect.succeed(stateOf(held)),
      ),
    updateMachineSettings: ({ overrides }) =>
      JSON.stringify(overrides).includes("9999")
        ? Effect.fail(new MachineError({ message: "idleMinutes: at most 1440" }))
        : Effect.sync(() => {
            saved.push(overrides);
            held = { ...held, instance: "basic" };

            return stateOf(held);
          }),
  });

  return { registry, saved };
};

describe("the settings of a Machine", () => {
  it.effect("loads the settings the Machine answers with", () =>
    Effect.gen(function* () {
      const { registry } = configured();

      registry.mount(machineSettingsAtom("work"));

      expect(
        AsyncResult.getOrThrow(yield* settled(registry, machineSettingsAtom("work"))).settings,
      ).toEqual(DEFAULT_CONTAINER_SETTINGS);
    }),
  );

  it.effect("says why they could not load, and loads them again when asked", () =>
    Effect.gen(function* () {
      const { registry } = configured(1);

      registry.mount(machineSettingsAtom("work"));

      expect(settledFailureOf(yield* settled(registry, machineSettingsAtom("work")))).toBe(
        "The Machine is waking up.",
      );

      registry.refresh(machineSettingsAtom("work"));

      // The message goes as the new attempt starts.
      expect(settledFailureOf(registry.get(machineSettingsAtom("work")))).toBeNull();
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, machineSettingsAtom("work"))).settings,
      ).toEqual(DEFAULT_CONTAINER_SETTINGS);
    }),
  );

  it.effect(
    "saves the overrides of the settings, answers with the new state, and loads again",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = configured();

        registry.mount(machineSettingsAtom("work"));
        yield* settled(registry, machineSettingsAtom("work"));
        registry.set(saveMachineAtom("work"), {
          name: undefined,
          settings: { instance: "basic", idleMinutes: 5, ignore: ["/data"] },
        });

        const answer = yield* settled(registry, saveMachineAtom("work"));

        expect(AsyncResult.getOrThrow(answer)?.settings.instance).toBe("basic");
        expect(saved).toEqual([{ instance: "basic", ignore: ["/data"] }]);
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, machineSettingsAtom("work"))).settings
            .instance,
        ).toBe("basic");
      }),
  );

  it.effect("says why a save was refused, with the Machine's message", () =>
    Effect.gen(function* () {
      const { registry, saved } = configured();

      registry.set(saveMachineAtom("work"), {
        name: undefined,
        settings: { instance: "basic", idleMinutes: 9999, ignore: [] },
      });

      expect(failureOf(yield* settled(registry, saveMachineAtom("work")))).toBe(
        "idleMinutes: at most 1440",
      );
      expect(saved).toEqual([]);
    }),
  );
});

/** A Registry for the page's forms and dialogs: Machine `work`, which refuses what is named `bad` or `stuck`. */
const paging = (settingsGate?: Deferred.Deferred<void>) => {
  const machines = [machine("work", "Work")];
  const repos: string[] = [];
  const saved: unknown[] = [];
  const renamed: string[] = [];
  let held = DEFAULT_CONTAINER_SETTINGS;

  const registry = registryWith({
    listMachines: () => Effect.sync(() => [...machines]),
    createMachine: ({ slug }) =>
      slug === "bad"
        ? Effect.die(new Error("That slug is taken."))
        : Effect.sync(() => machine(slug)),
    renameMachine: ({ name }) =>
      name === "bad"
        ? Effect.fail(new MachineError({ message: "That name is taken." }))
        : Effect.sync(() => {
            renamed.push(name);

            return machine("work", name);
          }),
    deleteMachine: ({ machine: slug }) =>
      slug === "stuck"
        ? Effect.fail(new MachineError({ message: "Could not stop it." }))
        : Effect.void,
    listRepos: () => Effect.sync(() => [...repos]),
    cloneRepo: ({ source }) =>
      source === "bad"
        ? Effect.fail(new MachineError({ message: "fatal: repository 'bad' not found" }))
        : Effect.sync(() => {
            repos.push(source);

            return source;
          }),
    getMachineSettings: () =>
      (settingsGate === undefined ? Effect.void : Deferred.await(settingsGate)).pipe(
        Effect.map(() => stateOf(held)),
      ),
    updateMachineSettings: ({ overrides }) =>
      Effect.sync(() => {
        saved.push(overrides);
        held = { ...held, instance: "basic" };

        return stateOf(held);
      }),
  });

  return { registry, saved, renamed };
};

describe("the new-Machine form", () => {
  it.effect("empties once the Machine is registered", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(newMachineSlugAtom);
      registry.set(newMachineSlugAtom, "api");
      registry.set(createMachineAtom, "api");
      yield* settled(registry, createMachineAtom);

      expect(registry.get(newMachineSlugAtom)).toBe("");
    }),
  );

  it.effect("keeps what was typed when the Registry refuses it, and says why", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(newMachineSlugAtom);
      registry.set(newMachineSlugAtom, "bad");
      registry.set(createMachineAtom, "bad");

      expect(failureOf(yield* settled(registry, createMachineAtom))).toBe("That slug is taken.");
      expect(registry.get(newMachineSlugAtom)).toBe("bad");
    }),
  );
});

describe("the clone form of a Machine", () => {
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

  it.effect("keeps one Machine's source apart from another's", () =>
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

describe("the dialogs of a Machine's card", () => {
  it("keeps one Machine's open dialog apart from another's", () => {
    const { registry } = paging();

    registry.mount(machineDialogAtom("work"));
    registry.mount(machineDialogAtom("other"));
    registry.set(machineDialogAtom("work"), "edit");

    expect(registry.get(machineDialogAtom("work"))).toBe("edit");
    expect(registry.get(machineDialogAtom("other"))).toBeNull();
    registry.dispose();
  });

  it.effect("closes the Edit dialog once the edit is saved", () =>
    Effect.gen(function* () {
      const { registry, saved, renamed } = paging();

      registry.mount(machineDialogAtom("work"));
      registry.set(machineDialogAtom("work"), "edit");
      registry.set(saveMachineAtom("work"), {
        name: "Renamed",
        settings: { instance: "basic", idleMinutes: 30, ignore: [] },
      });
      yield* settled(registry, saveMachineAtom("work"));

      expect(renamed).toEqual(["Renamed"]);
      expect(saved).toEqual([{ instance: "basic", idleMinutes: 30 }]);
      expect(registry.get(machineDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the Edit dialog open, saving nothing more, when the rename is refused", () =>
    Effect.gen(function* () {
      const { registry, saved } = paging();

      registry.mount(machineDialogAtom("work"));
      registry.set(machineDialogAtom("work"), "edit");
      registry.set(saveMachineAtom("work"), {
        name: "bad",
        settings: { instance: "basic", idleMinutes: 30, ignore: [] },
      });

      expect(settledFailureOf(yield* settled(registry, saveMachineAtom("work")))).toBe(
        "That name is taken.",
      );
      expect(saved).toEqual([]);
      expect(registry.get(machineDialogAtom("work"))).toBe("edit");
    }),
  );

  it.effect("closes the Delete dialog once the Machine is deleted", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(machineDialogAtom("work"));
      registry.set(machineDialogAtom("work"), "delete");
      registry.set(deleteMachineAtom("work"), undefined);
      yield* settled(registry, deleteMachineAtom("work"));

      expect(registry.get(machineDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the Delete dialog open when the delete is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(machineDialogAtom("stuck"));
      registry.set(machineDialogAtom("stuck"), "delete");
      registry.set(deleteMachineAtom("stuck"), undefined);

      expect(settledFailureOf(yield* settled(registry, deleteMachineAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(registry.get(machineDialogAtom("stuck"))).toBe("delete");
    }),
  );

  it.effect("keeps one Machine's save apart from another's", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(saveMachineAtom("work"));
      registry.mount(saveMachineAtom("other"));
      registry.set(saveMachineAtom("work"), { name: "bad", settings: undefined });
      yield* settled(registry, saveMachineAtom("work"));

      expect(AsyncResult.isInitial(registry.get(saveMachineAtom("other")))).toBe(true);
    }),
  );

  it.effect("forgets a failed save once the dialog is opened again", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(saveMachineAtom("work"));
      registry.set(saveMachineAtom("work"), { name: "bad", settings: undefined });
      yield* settled(registry, saveMachineAtom("work"));
      registry.set(saveMachineAtom("work"), Atom.Reset);

      expect(AsyncResult.isInitial(registry.get(saveMachineAtom("work")))).toBe(true);
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
  /** Mount the atoms the dialog reads, and wait for the list of Machines, so the draft starts with a name. */
  const opened = (registry: ReturnType<typeof paging>["registry"]) =>
    Effect.gen(function* () {
      registry.mount(machineNamesAtom);
      registry.mount(machineSettingsAtom("work"));
      yield* settled(registry, machinesAtom);
      registry.mount(machineDraftAtom("work"));
    });

  it.effect("starts with the Machine's name, and fills in the settings when they answer", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const { registry } = paging(gate);

      yield* opened(registry);

      // The dialog is open and the settings have not answered.
      expect(registry.get(machineDraftAtom("work"))).toEqual({
        name: "Work",
        instance: undefined,
        idle: "",
        ignore: undefined,
      });

      yield* Deferred.succeed(gate, undefined);
      yield* settled(registry, machineSettingsAtom("work"));

      expect(registry.get(machineDraftAtom("work"))).toEqual({
        name: "Work",
        instance: DEFAULT_CONTAINER_SETTINGS.instance,
        idle: String(DEFAULT_CONTAINER_SETTINGS.idleMinutes),
        ignore: "",
      });
    }),
  );

  it.effect("keeps what was typed when the settings answer after it", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const { registry } = paging(gate);

      yield* opened(registry);

      const other = INSTANCE_TYPES.find((type) => type !== DEFAULT_CONTAINER_SETTINGS.instance)!;

      registry.set(machineDraftAtom("work"), {
        name: "Renamed",
        instance: other,
        idle: "",
        ignore: "/data",
      });
      yield* Deferred.succeed(gate, undefined);
      yield* settled(registry, machineSettingsAtom("work"));

      expect(registry.get(machineDraftAtom("work"))).toEqual({
        name: "Renamed",
        instance: other,
        idle: String(DEFAULT_CONTAINER_SETTINGS.idleMinutes),
        ignore: "/data",
      });
    }),
  );

  it.effect("keeps what was picked when the settings are loaded again", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      yield* opened(registry);
      yield* settled(registry, machineSettingsAtom("work"));
      registry.set(machineDraftAtom("work"), {
        name: "Work",
        instance: "lite",
        idle: "20",
        ignore: "",
      });
      registry.refresh(machineSettingsAtom("work"));
      yield* settled(registry, machineSettingsAtom("work"));

      expect(registry.get(machineDraftAtom("work"))).toEqual({
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
  const stuck = (message: string) => Effect.fail(new MachineError({ message }));

  const registry = registryWith({
    listSessions: () => Effect.sync(() => [...sessions]),
    listRepos: () => Effect.sync(() => [...repos]),
    resetMachine: (payload) => {
      calls.push(["resetMachine", payload]);

      return payload.machine === "stuck"
        ? stuck("Could not reset it.")
        : Effect.sync(() => {
            sessions.length = 0;
            repos.length = 0;
          });
    },
    restartContainer: (payload) => {
      calls.push(["restartContainer", payload]);

      return payload.machine === "stuck" ? stuck("Could not stop it.") : Effect.void;
    },
    removeRepo: (payload) => {
      calls.push(["removeRepo", payload]);

      return payload.machine === "stuck"
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

describe("resetting a Machine", () => {
  it.effect("resets it, closes the dialog and asks for the Sessions and repos again", () =>
    Effect.gen(function* () {
      const { registry, calls } = destructive();

      registry.mount(machineDialogAtom("work"));
      registry.mount(sessionsAtom);
      registry.mount(reposAtom("work"));
      yield* settled(registry, sessionsAtom);
      yield* settled(registry, reposAtom("work"));
      registry.set(machineDialogAtom("work"), "reset");
      registry.set(resetMachineAtom("work"), undefined);
      yield* settled(registry, resetMachineAtom("work"));

      expect(calls).toEqual([["resetMachine", { machine: "work" }]]);
      expect(registry.get(machineDialogAtom("work"))).toBeNull();
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
      expect(AsyncResult.getOrThrow(yield* settled(registry, reposAtom("work")))).toEqual([]);
    }),
  );

  it.effect("keeps the dialog open when it is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = destructive();

      registry.mount(machineDialogAtom("stuck"));
      registry.set(machineDialogAtom("stuck"), "reset");
      registry.set(resetMachineAtom("stuck"), undefined);

      expect(settledFailureOf(yield* settled(registry, resetMachineAtom("stuck")))).toBe(
        "Could not reset it.",
      );
      expect(registry.get(machineDialogAtom("stuck"))).toBe("reset");
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

describe("restarting a Machine's Container", () => {
  it.effect("restarts it and closes the dialog", () =>
    Effect.gen(function* () {
      const { registry, calls } = destructive();

      registry.mount(machineDialogAtom("work"));
      registry.set(machineDialogAtom("work"), "restart");
      registry.set(restartContainerAtom("work"), undefined);
      yield* settled(registry, restartContainerAtom("work"));

      expect(calls).toEqual([["restartContainer", { machine: "work" }]]);
      expect(registry.get(machineDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the dialog open when it is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = destructive();

      registry.mount(machineDialogAtom("stuck"));
      registry.set(machineDialogAtom("stuck"), "restart");
      registry.set(restartContainerAtom("stuck"), undefined);

      expect(settledFailureOf(yield* settled(registry, restartContainerAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(registry.get(machineDialogAtom("stuck"))).toBe("restart");
    }),
  );
});

describe("removing a repo", () => {
  it.effect("removes it, closes the dialog and asks for the Sessions and repos again", () =>
    Effect.gen(function* () {
      const { registry, calls } = destructive();

      registry.mount(machineDialogAtom("work"));
      registry.mount(sessionsAtom);
      registry.mount(reposAtom("work"));
      yield* settled(registry, sessionsAtom);
      yield* settled(registry, reposAtom("work"));
      registry.set(machineDialogAtom("work"), { removeRepo: "web" });
      registry.set(removeRepoAtom("work"), "web");
      yield* settled(registry, removeRepoAtom("work"));

      expect(calls).toEqual([["removeRepo", { machine: "work", repo: "web" }]]);
      expect(registry.get(machineDialogAtom("work"))).toBeNull();
      expect(AsyncResult.getOrThrow(yield* settled(registry, reposAtom("work")))).toEqual(["api"]);
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom)).map((known) => known.id),
      ).toEqual(["b"]);
    }),
  );

  it.effect("keeps the dialog open when it is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = destructive();

      registry.mount(machineDialogAtom("stuck"));
      registry.set(machineDialogAtom("stuck"), { removeRepo: "web" });
      registry.set(removeRepoAtom("stuck"), "web");

      expect(settledFailureOf(yield* settled(registry, removeRepoAtom("stuck")))).toBe(
        "Could not remove it.",
      );
      expect(registry.get(machineDialogAtom("stuck"))).toEqual({ removeRepo: "web" });
    }),
  );

  it("keeps the typed name apart from the other dialogs' and other Machines'", () => {
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

describe("a repo's Workspaces", () => {
  const workspace = (id: string, branch: string): WorkspaceRecord => ({
    id,
    machine: "work",
    repo: "pi",
    branch,
    directory: `/workspace/.worktrees/pi/${id}`,
    createdAt: 1,
  });

  /** A Registry holding Workspaces and the Sessions in them; removing `stuck` fails. */
  const holdingWorkspaces = () => {
    const workspaces = [workspace("0a1b2c3d", "fix/build"), workspace("deadbeef", "stuck")];

    const sessions = [
      { ...session("a", "work"), repo: "pi", workspace: "0a1b2c3d" },
      { ...session("b", "work"), repo: "pi" },
    ];

    const removed: string[] = [];

    const registry = registryWith({
      listWorkspaces: () => Effect.sync(() => [...workspaces]),
      listSessions: () => Effect.sync(() => [...sessions]),
      removeWorkspace: ({ id }) => {
        removed.push(id);

        if (id === "deadbeef")
          return Effect.fail(new MachineError({ message: "Could not remove the worktree." }));

        return Effect.sync(() => {
          workspaces.splice(
            workspaces.findIndex((known) => known.id === id),
            1,
          );
          sessions.splice(
            sessions.findIndex((known) => known.workspace === id),
            1,
          );
        });
      },
    });

    return { registry, removed };
  };

  it.effect("lists them, and names each by its branch", () =>
    Effect.gen(function* () {
      const { registry } = holdingWorkspaces();

      registry.mount(workspaceBranchesAtom);
      yield* settled(registry, workspacesAtom);

      expect(registry.get(workspaceListAtom)?.map((known) => known.id)).toEqual([
        "0a1b2c3d",
        "deadbeef",
      ]);
      expect(registry.get(workspaceBranchesAtom)).toEqual({
        "0a1b2c3d": "fix/build",
        deadbeef: "stuck",
      });
    }),
  );

  it.effect("removes one, closes the dialog and asks for the Workspaces and Sessions again", () =>
    Effect.gen(function* () {
      const { registry, removed } = holdingWorkspaces();

      registry.mount(machineDialogAtom("work"));
      registry.mount(sessionsAtom);
      registry.mount(workspacesAtom);
      yield* settled(registry, sessionsAtom);
      yield* settled(registry, workspacesAtom);
      registry.set(machineDialogAtom("work"), { removeWorkspace: "0a1b2c3d" });
      registry.set(removeWorkspaceAtom("work"), "0a1b2c3d");
      yield* settled(registry, removeWorkspaceAtom("work"));

      expect(removed).toEqual(["0a1b2c3d"]);
      expect(registry.get(machineDialogAtom("work"))).toBeNull();
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, workspacesAtom)).map((known) => known.id),
      ).toEqual(["deadbeef"]);
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom)).map((known) => known.id),
      ).toEqual(["b"]);
    }),
  );

  it.effect("keeps the dialog open when the removal fails, and says why", () =>
    Effect.gen(function* () {
      const { registry } = holdingWorkspaces();

      registry.mount(machineDialogAtom("work"));
      registry.set(machineDialogAtom("work"), { removeWorkspace: "deadbeef" });
      registry.set(removeWorkspaceAtom("work"), "deadbeef");

      const result = yield* settled(registry, removeWorkspaceAtom("work"));

      expect(failureOf(result)).toBe("Could not remove the worktree.");
      expect(registry.get(machineDialogAtom("work"))).toEqual({ removeWorkspace: "deadbeef" });
    }),
  );
});
