// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import {
  DEFAULT_CONTAINER_SETTINGS,
  INSTANCE_TYPES,
  containerOverridesFrom,
  type ContainerSettings,
} from "@cloudpid/config";
import {
  type AgentChange,
  EnvironmentError,
  type ContainerSettingsState,
  type EnvironmentRecord,
  type EnvironmentSecretRecord,
  type SessionRecord,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { describe, expect, it } from "@effect/vitest";
import { failureOf, settledFailureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { pathAtom } from "./router.ts";
import { REFRESH_INTERVAL, sessionsAtom } from "./sessions.ts";
import {
  addRepoAtom,
  addRepoNameAtom,
  addRepoSourceAtom,
  agentChangesAtom,
  revertAgentChangeAtom,
  createEnvironmentAtom,
  deleteSecretAtom,
  environmentSecretsAtom,
  environmentSecretsErrorAtom,
  saveSecretAtom,
  setSecretBuildAtom,
  secretDialogAtom,
  secretDraftAtom,
  secretsInAtom,
  deleteEnvironmentAtom,
  deleteTypedAtom,
  buildsAtom,
  environmentBuildAtom,
  environmentDialogAtom,
  environmentDraftAtom,
  environmentNamesAtom,
  environmentSettingsAtom,
  environmentListAtom,
  environmentsAtom,
  newEnvironmentNameAtom,
  rebuildEnvironmentAtom,
  removeRepoAtom,
  removeWorkspaceAtom,
  removeWorkspaceTypedAtom,
  restartContainerAtom,
  saveEnvironmentAtom,
  startSessionAtom,
  describeWorkspaceWork,
  subagentWorkspacesBelow,
  subagentWorkspacesOf,
  workspaceBranchesAtom,
  workspaceListAtom,
  workspacesAtom,
} from "./environments-state.ts";
import { EMPTY_SECRET_DRAFT, EVERY_ENVIRONMENT } from "./environments.ts";

describe("Subagent Workspaces on the Environments page", () => {
  it("says what a Workspace has not pushed, per Repo", () => {
    expect(
      describeWorkspaceWork([
        { repo: "app", uncommitted: 1, unpushed: 2 },
        { repo: "docs", uncommitted: 3, unpushed: 0 },
      ]),
    ).toBe("app: 2 commits not pushed, 1 uncommitted change; docs: 3 uncommitted changes");
  });

  it("finds a Session's Subagent Workspaces in the listing", () => {
    const listed = {
      id: "0000abcd",
      environment: "default",
      branch: "cloudpid/0000abcd",
      base: null,
      repos: [],
      directory: "/workspace",
      createdAt: 0,
    };

    const owned = { ...listed, id: "0000beef", subagent: { session: "s1", agent: "agent-1" } };

    expect(subagentWorkspacesOf([listed, owned], "s1")).toEqual([owned]);
    expect(subagentWorkspacesOf(null, "s1")).toEqual([]);

    const below = {
      ...listed,
      id: "0000cafe",
      subagent: { session: "s1", agent: "agent-1.agent-1" },
    };

    const sibling = { ...listed, id: "0000f00d", subagent: { session: "s1", agent: "agent-10" } };
    const elsewhere = { ...below, id: "0000dead", subagent: { session: "s2", agent: "agent-1.x" } };

    expect(
      subagentWorkspacesBelow([listed, owned, below, sibling, elsewhere], {
        session: "s1",
        agent: "agent-1",
      }),
    ).toEqual([below]);
  });
});

const environment = (
  id: string,
  name = id,
  repos: EnvironmentRecord["repos"] = [],
): EnvironmentRecord => ({ id, name, repos, createdAt: 1 });

const session = (id: string, on: string, workspace = "0a1b2c3d"): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  environment: on,
  workspace,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

const workspace = (id: string, branch: string, on = "work"): WorkspaceRecord => ({
  id,
  environment: on,
  branch,
  base: null,
  repos: ["web"],
  directory: "/workspace/web",
  createdAt: 1,
});

const refused = (message: string) => Effect.fail(new EnvironmentError({ message }));

const ids = (result: AsyncResult.AsyncResult<readonly EnvironmentRecord[], unknown>) =>
  AsyncResult.getOrThrow(result).map((known) => known.id);

/** A Registry holding `environments` and `sessions`; deleting `stuck` stops partway, deleting its Sessions only. */
const holding = (environments: EnvironmentRecord[], sessions: SessionRecord[]) =>
  registryWith({
    listEnvironments: () => Effect.sync(() => [...environments]),
    listSessions: () => Effect.sync(() => [...sessions]),
    createEnvironment: ({ name }) =>
      environments.some((known) => known.name === name)
        ? refused(`An environment is already named ${name}.`)
        : Effect.sync(() => {
            const created = environment(name.toLowerCase(), name);

            environments.unshift(created);

            return created;
          }),
    renameEnvironment: ({ environment: id, name }) =>
      environments.some((known) => known.name === name)
        ? refused(`An environment is already named ${name}.`)
        : Effect.sync(() => {
            const index = environments.findIndex((known) => known.id === id);
            const renamed = { ...environments[index]!, name };

            environments[index] = renamed;

            return renamed;
          }),
    deleteEnvironment: ({ environment: id }) =>
      Effect.suspend(() => {
        sessions.splice(
          0,
          sessions.length,
          ...sessions.filter((known) => known.environment !== id),
        );

        if (id === "stuck") return refused("Could not stop it.");

        environments.splice(
          environments.findIndex((known) => known.id === id),
          1,
        );

        return Effect.void;
      }),
    addRepo: ({ environment: id, source, name: named }) => {
      if (source === "bad") return refused("That is not a repo.");

      const name = named ?? source.split("/").pop() ?? source;
      const index = environments.findIndex((known) => known.id === id);
      const known = environments[index]!;

      return known.repos.some((repo) => repo.name === name)
        ? refused(`The environment already has a repo in ${name}: name this one`)
        : Effect.sync(() => {
            environments[index] = {
              ...known,
              repos: [...known.repos, { name, url: `https://github.com/${source}.git` }],
            };

            return name;
          });
    },
    removeRepo: ({ environment: id, repo }) =>
      Effect.sync(() => {
        const index = environments.findIndex((known) => known.id === id);
        const known = environments[index]!;

        environments[index] = {
          ...known,
          repos: known.repos.filter((kept) => kept.name !== repo),
        };
      }),
  });

describe("the Environment list", () => {
  it.effect("lists the Environments the Registry answers with", () =>
    Effect.gen(function* () {
      const registry = holding([environment("work", "Work"), environment("default")], []);

      registry.mount(environmentsAtom);
      registry.mount(environmentNamesAtom);

      expect(ids(yield* settled(registry, environmentsAtom))).toEqual(["work", "default"]);
      expect(registry.get(environmentNamesAtom)).toEqual({ work: "Work", default: "default" });
    }),
  );

  it.effect("asks again after an Environment is created or renamed", () =>
    Effect.gen(function* () {
      const registry = holding([environment("default")], []);

      registry.mount(environmentsAtom);
      yield* settled(registry, environmentsAtom);

      registry.set(createEnvironmentAtom, "work");
      yield* settled(registry, createEnvironmentAtom);
      expect(ids(yield* settled(registry, environmentsAtom))).toEqual(["work", "default"]);

      registry.set(saveEnvironmentAtom("work"), { name: "Work", settings: undefined });
      yield* settled(registry, saveEnvironmentAtom("work"));
      expect(AsyncResult.getOrThrow(yield* settled(registry, environmentsAtom))[0]?.name).toBe(
        "Work",
      );
    }),
  );

  it.live(
    "asks again on the visible-page tick, for what a Session's agent made or renamed",
    () =>
      Effect.gen(function* () {
        const environments = [environment("default")];
        const registry = holding(environments, []);

        registry.mount(environmentsAtom);
        registry.mount(environmentListAtom);
        yield* settled(registry, environmentsAtom);
        expect(registry.get(environmentListAtom)?.map((known) => known.name)).toEqual(["default"]);

        // What the agent's tools do in the Registry, with no call from this page.
        environments.unshift(environment("billing", "Billing"));
        environments[1] = environment("default", "Main");

        // One tick of the page, which asks every few seconds while it is visible.
        yield* Effect.sleep(REFRESH_INTERVAL.pipe(Duration.sum(Duration.millis(500))));

        expect(registry.get(environmentListAtom)?.map((known) => known.name)).toEqual([
          "Billing",
          "Main",
        ]);
        registry.dispose();
      }),
    10_000,
  );

  it.effect("says why a rename was refused", () =>
    Effect.gen(function* () {
      const registry = holding([environment("default"), environment("work")], []);

      registry.set(saveEnvironmentAtom("work"), { name: "default", settings: undefined });

      expect(failureOf(yield* settled(registry, saveEnvironmentAtom("work")))).toBe(
        "An environment is already named default.",
      );
    }),
  );

  it.effect("asks for the Environments and the Sessions again after a delete", () =>
    Effect.gen(function* () {
      const registry = holding(
        [environment("work"), environment("default")],
        [session("a", "work")],
      );

      registry.mount(environmentsAtom);
      registry.mount(sessionsAtom);
      yield* settled(registry, environmentsAtom);
      yield* settled(registry, sessionsAtom);

      registry.set(deleteEnvironmentAtom("work"), undefined);
      yield* settled(registry, deleteEnvironmentAtom("work"));

      expect(ids(yield* settled(registry, environmentsAtom))).toEqual(["default"]);
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
    }),
  );

  it.effect("asks again after a delete that stopped partway, and says why", () =>
    Effect.gen(function* () {
      const registry = holding([environment("stuck")], [session("a", "stuck")]);

      registry.mount(sessionsAtom);
      yield* settled(registry, sessionsAtom);

      registry.set(deleteEnvironmentAtom("stuck"), undefined);

      expect(failureOf(yield* settled(registry, deleteEnvironmentAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
    }),
  );

  it.effect(
    "asks again for the Environment's own settings, the Workspaces, the Secrets and the Builds after a delete",
    () =>
      Effect.gen(function* () {
        const asked = { settings: 0, workspaces: 0, secrets: 0, builds: 0 };

        const registry = registryWith({
          listEnvironments: () => Effect.succeed([environment("work")]),
          listWorkspaces: () =>
            Effect.sync(() => {
              asked.workspaces += 1;

              return [];
            }),
          getEnvironmentSettings: () =>
            Effect.die(asked.settings++ < 0 ? "unreachable" : "The settings are not answering."),
          listEnvironmentSecrets: () =>
            Effect.sync(() => {
              asked.secrets += 1;

              return [];
            }),
          listBuilds: () =>
            Effect.sync(() => {
              asked.builds += 1;

              return [];
            }),
          deleteEnvironment: () => Effect.void,
        });

        registry.mount(workspacesAtom);
        registry.mount(environmentSettingsAtom("work"));
        registry.mount(environmentSecretsAtom);
        registry.mount(buildsAtom);
        yield* settled(registry, workspacesAtom);
        yield* settled(registry, environmentSettingsAtom("work"));
        yield* settled(registry, environmentSecretsAtom);
        yield* settled(registry, buildsAtom);

        expect(asked).toEqual({ settings: 1, workspaces: 1, secrets: 1, builds: 1 });

        registry.set(deleteEnvironmentAtom("work"), undefined);
        yield* settled(registry, deleteEnvironmentAtom("work"));
        yield* settled(registry, workspacesAtom);
        yield* settled(registry, environmentSettingsAtom("work"));
        yield* settled(registry, environmentSecretsAtom);
        yield* settled(registry, buildsAtom);

        expect(asked).toEqual({ settings: 2, workspaces: 2, secrets: 2, builds: 2 });
        registry.dispose();
      }),
  );
});

describe("the new-Environment form", () => {
  it.effect("empties once the Environment is made", () =>
    Effect.gen(function* () {
      const registry = holding([], []);

      registry.mount(newEnvironmentNameAtom);
      registry.set(newEnvironmentNameAtom, "Work");
      registry.set(createEnvironmentAtom, "Work");
      yield* settled(registry, createEnvironmentAtom);

      expect(registry.get(newEnvironmentNameAtom)).toBe("");
    }),
  );

  it.effect("keeps what was typed when the Registry refuses it, and says why", () =>
    Effect.gen(function* () {
      const registry = holding([environment("work", "Work")], []);

      registry.mount(newEnvironmentNameAtom);
      registry.set(newEnvironmentNameAtom, "Work");
      registry.set(createEnvironmentAtom, "Work");

      expect(failureOf(yield* settled(registry, createEnvironmentAtom))).toBe(
        "An environment is already named Work.",
      );
      expect(registry.get(newEnvironmentNameAtom)).toBe("Work");
    }),
  );
});

describe("the Repos of an Environment", () => {
  it.effect("adds one, answers with its directory name, empties the form and lists again", () =>
    Effect.gen(function* () {
      const registry = holding([environment("work")], []);

      registry.mount(environmentsAtom);
      registry.mount(addRepoSourceAtom("work"));
      yield* settled(registry, environmentsAtom);
      registry.set(addRepoSourceAtom("work"), "acme/web");
      registry.set(addRepoAtom("work"), { source: "acme/web", name: "" });

      expect(AsyncResult.getOrThrow(yield* settled(registry, addRepoAtom("work")))).toBe("web");
      expect(registry.get(addRepoSourceAtom("work"))).toBe("");
      expect(AsyncResult.getOrThrow(yield* settled(registry, environmentsAtom))[0]?.repos).toEqual([
        { name: "web", url: "https://github.com/acme/web.git" },
      ]);
    }),
  );

  it.effect(
    "adds a second repo of the same name under the directory the owner names, after saying to name it",
    () =>
      Effect.gen(function* () {
        const registry = holding(
          [environment("work", "work", [{ name: "web", url: "https://github.com/acme/web.git" }])],
          [],
        );

        registry.mount(environmentsAtom);
        registry.mount(addRepoSourceAtom("work"));
        registry.mount(addRepoNameAtom("work"));
        registry.set(addRepoSourceAtom("work"), "other/web");
        registry.set(addRepoAtom("work"), { source: "other/web", name: "" });

        expect(settledFailureOf(yield* settled(registry, addRepoAtom("work")))).toBe(
          "The environment already has a repo in web: name this one",
        );

        registry.set(addRepoNameAtom("work"), " other-web ");
        registry.set(addRepoAtom("work"), { source: "other/web", name: " other-web " });

        expect(AsyncResult.getOrThrow(yield* settled(registry, addRepoAtom("work")))).toBe(
          "other-web",
        );
        expect(registry.get(addRepoSourceAtom("work"))).toBe("");
        expect(registry.get(addRepoNameAtom("work"))).toBe("");
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, environmentsAtom))[0]?.repos.map(
            (repo) => repo.name,
          ),
        ).toEqual(["web", "other-web"]);
      }),
  );

  it.effect("keeps what was typed when the Registry refuses it, and says why", () =>
    Effect.gen(function* () {
      const registry = holding([environment("work")], []);

      registry.mount(addRepoSourceAtom("work"));
      registry.set(addRepoSourceAtom("work"), "bad");
      registry.set(addRepoAtom("work"), { source: "bad", name: "" });

      expect(settledFailureOf(yield* settled(registry, addRepoAtom("work")))).toBe(
        "That is not a repo.",
      );
      expect(registry.get(addRepoSourceAtom("work"))).toBe("bad");
    }),
  );

  it("keeps one Environment's form apart from another's", () => {
    const registry = registryWith({ addRepo: () => Effect.never });

    registry.mount(addRepoAtom("work"));
    registry.mount(addRepoAtom("other"));
    registry.set(addRepoAtom("work"), { source: "acme/web", name: "" });

    expect(registry.get(addRepoAtom("work")).waiting).toBe(true);
    expect(registry.get(addRepoAtom("other")).waiting).toBe(false);
    registry.dispose();
  });

  it.effect("removes one and lists again", () =>
    Effect.gen(function* () {
      const registry = holding(
        [
          environment("work", "work", [
            { name: "api", url: "https://github.com/acme/api.git" },
            { name: "web", url: "https://github.com/acme/web.git" },
          ]),
        ],
        [],
      );

      registry.mount(environmentsAtom);
      yield* settled(registry, environmentsAtom);
      registry.set(removeRepoAtom("work"), "web");
      yield* settled(registry, removeRepoAtom("work"));

      expect(
        AsyncResult.getOrThrow(yield* settled(registry, environmentsAtom))[0]?.repos.map(
          (repo) => repo.name,
        ),
      ).toEqual(["api"]);
    }),
  );

  it.effect("says why a removal failed", () =>
    Effect.gen(function* () {
      const registry = registryWith({ removeRepo: () => refused("No such repo.") });

      registry.set(removeRepoAtom("work"), "web");

      expect(settledFailureOf(yield* settled(registry, removeRepoAtom("work")))).toBe(
        "No such repo.",
      );
    }),
  );
});

const stateOf = (settings: ContainerSettings): ContainerSettingsState => ({
  settings,
  overrides: containerOverridesFrom(settings),
});

/** A Registry holding the settings of Environment `work`; the first `failures` loads fail, and an idle time of 9999 is refused. */
const configured = (failures = 0) => {
  let held = DEFAULT_CONTAINER_SETTINGS;
  let left = failures;
  const saved: unknown[] = [];

  const registry = registryWith({
    getEnvironmentSettings: () =>
      Effect.suspend(() =>
        left-- > 0 ? refused("The settings are not ready.") : Effect.succeed(stateOf(held)),
      ),
    updateEnvironmentSettings: ({ overrides }) =>
      JSON.stringify(overrides).includes("9999")
        ? refused("idleMinutes: at most 1440")
        : Effect.sync(() => {
            saved.push(overrides);
            held = { ...held, instance: "basic" };

            return stateOf(held);
          }),
  });

  return { registry, saved };
};

describe("the settings of an Environment", () => {
  it.effect("loads the settings the Registry answers with", () =>
    Effect.gen(function* () {
      const { registry } = configured();

      registry.mount(environmentSettingsAtom("work"));

      expect(
        AsyncResult.getOrThrow(yield* settled(registry, environmentSettingsAtom("work"))).settings,
      ).toEqual(DEFAULT_CONTAINER_SETTINGS);
    }),
  );

  it.effect("says why they could not load, and loads them again when asked", () =>
    Effect.gen(function* () {
      const { registry } = configured(1);

      registry.mount(environmentSettingsAtom("work"));

      expect(settledFailureOf(yield* settled(registry, environmentSettingsAtom("work")))).toBe(
        "The settings are not ready.",
      );

      registry.refresh(environmentSettingsAtom("work"));

      // The message goes as the new attempt starts.
      expect(settledFailureOf(registry.get(environmentSettingsAtom("work")))).toBeNull();
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, environmentSettingsAtom("work"))).settings,
      ).toEqual(DEFAULT_CONTAINER_SETTINGS);
    }),
  );

  it.effect(
    "saves the overrides of the settings, answers with the new state, and loads again",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = configured();

        registry.mount(environmentSettingsAtom("work"));
        yield* settled(registry, environmentSettingsAtom("work"));
        registry.set(saveEnvironmentAtom("work"), {
          name: undefined,
          settings: {
            ...DEFAULT_CONTAINER_SETTINGS,
            instance: "basic",
            ignore: ["/data"],
            variables: { NODE_ENV: "test" },
            startScript: "make up\n",
          },
        });

        const answer = yield* settled(registry, saveEnvironmentAtom("work"));

        expect(AsyncResult.getOrThrow(answer)?.settings.instance).toBe("basic");
        expect(saved).toEqual([
          {
            instance: "basic",
            ignore: ["/data"],
            variables: { NODE_ENV: "test" },
            startScript: "make up\n",
          },
        ]);
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, environmentSettingsAtom("work"))).settings
            .instance,
        ).toBe("basic");
      }),
  );

  it.effect("says why a save was refused, with the Registry's message", () =>
    Effect.gen(function* () {
      const { registry, saved } = configured();

      registry.set(saveEnvironmentAtom("work"), {
        name: undefined,
        settings: { ...DEFAULT_CONTAINER_SETTINGS, instance: "basic", idleMinutes: 9999 },
      });

      expect(failureOf(yield* settled(registry, saveEnvironmentAtom("work")))).toBe(
        "idleMinutes: at most 1440",
      );
      expect(saved).toEqual([]);
    }),
  );
});

/** A Registry for the page's dialogs: Environment `work`, which refuses a rename to `bad`, and `stuck`, which refuses deletes. */
const paging = (
  settingsGate?: Deferred.Deferred<void>,
  initial: ContainerSettings = DEFAULT_CONTAINER_SETTINGS,
) => {
  const saved: unknown[] = [];
  const renamed: string[] = [];
  let held = initial;

  const registry = registryWith({
    listEnvironments: () => Effect.succeed([environment("work", "Work")]),
    renameEnvironment: ({ name }) =>
      name === "bad"
        ? refused("That name is taken.")
        : Effect.sync(() => {
            renamed.push(name);

            return environment("work", name);
          }),
    deleteEnvironment: ({ environment: id }) =>
      id === "stuck" ? refused("Could not stop it.") : Effect.void,
    getEnvironmentSettings: () =>
      (settingsGate === undefined ? Effect.void : Deferred.await(settingsGate)).pipe(
        Effect.map(() => stateOf(held)),
      ),
    updateEnvironmentSettings: ({ overrides }) =>
      Effect.sync(() => {
        saved.push(overrides);
        held = { ...held, instance: "basic" };

        return stateOf(held);
      }),
  });

  return { registry, saved, renamed };
};

describe("the dialogs of an Environment's card", () => {
  it("keeps one Environment's open dialog apart from another's", () => {
    const { registry } = paging();

    registry.mount(environmentDialogAtom("work"));
    registry.mount(environmentDialogAtom("other"));
    registry.set(environmentDialogAtom("work"), "edit");

    expect(registry.get(environmentDialogAtom("work"))).toBe("edit");
    expect(registry.get(environmentDialogAtom("other"))).toBeNull();
    registry.dispose();
  });

  it.effect("closes the Edit dialog once the edit is saved", () =>
    Effect.gen(function* () {
      const { registry, saved, renamed } = paging();

      registry.mount(environmentDialogAtom("work"));
      registry.set(environmentDialogAtom("work"), "edit");
      registry.set(saveEnvironmentAtom("work"), {
        name: "Renamed",
        settings: { ...DEFAULT_CONTAINER_SETTINGS, instance: "basic", idleMinutes: 30 },
      });
      yield* settled(registry, saveEnvironmentAtom("work"));

      expect(renamed).toEqual(["Renamed"]);
      expect(saved).toEqual([{ instance: "basic", idleMinutes: 30 }]);
      expect(registry.get(environmentDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the Edit dialog open, saving nothing more, when the rename is refused", () =>
    Effect.gen(function* () {
      const { registry, saved } = paging();

      registry.mount(environmentDialogAtom("work"));
      registry.set(environmentDialogAtom("work"), "edit");
      registry.set(saveEnvironmentAtom("work"), {
        name: "bad",
        settings: { ...DEFAULT_CONTAINER_SETTINGS, instance: "basic", idleMinutes: 30 },
      });

      expect(settledFailureOf(yield* settled(registry, saveEnvironmentAtom("work")))).toBe(
        "That name is taken.",
      );
      expect(saved).toEqual([]);
      expect(registry.get(environmentDialogAtom("work"))).toBe("edit");
    }),
  );

  it.effect("closes the Delete dialog once the Environment is deleted", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(environmentDialogAtom("work"));
      registry.set(environmentDialogAtom("work"), "delete");
      registry.set(deleteEnvironmentAtom("work"), undefined);
      yield* settled(registry, deleteEnvironmentAtom("work"));

      expect(registry.get(environmentDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the Delete dialog open when the delete is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(environmentDialogAtom("stuck"));
      registry.set(environmentDialogAtom("stuck"), "delete");
      registry.set(deleteEnvironmentAtom("stuck"), undefined);

      expect(settledFailureOf(yield* settled(registry, deleteEnvironmentAtom("stuck")))).toBe(
        "Could not stop it.",
      );
      expect(registry.get(environmentDialogAtom("stuck"))).toBe("delete");
    }),
  );

  it.effect("keeps one Environment's save apart from another's, and forgets it when reset", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(saveEnvironmentAtom("work"));
      registry.mount(saveEnvironmentAtom("other"));
      registry.set(saveEnvironmentAtom("work"), { name: "bad", settings: undefined });
      yield* settled(registry, saveEnvironmentAtom("work"));

      expect(AsyncResult.isInitial(registry.get(saveEnvironmentAtom("other")))).toBe(true);

      registry.set(saveEnvironmentAtom("work"), Atom.Reset);

      expect(AsyncResult.isInitial(registry.get(saveEnvironmentAtom("work")))).toBe(true);
    }),
  );

  it.live("empties the typed name of the Delete dialog once nothing shows it", () =>
    Effect.gen(function* () {
      const { registry } = paging();
      const unmount = registry.mount(deleteTypedAtom("work"));

      registry.set(deleteTypedAtom("work"), "Wor");
      expect(registry.get(deleteTypedAtom("work"))).toBe("Wor");
      unmount();
      yield* Effect.sleep("10 millis");

      expect(registry.get(deleteTypedAtom("work"))).toBe("");
    }),
  );
});

describe("the Edit dialog's draft", () => {
  /** Mount the atoms the dialog reads, and wait for the list of Environments, so the draft starts with a name. */
  const opened = (registry: ReturnType<typeof paging>["registry"]) =>
    Effect.gen(function* () {
      registry.mount(environmentNamesAtom);
      registry.mount(environmentSettingsAtom("work"));
      yield* settled(registry, environmentsAtom);
      registry.mount(environmentDraftAtom("work"));
    });

  it.effect("starts with the Environment's name, and fills in the settings when they answer", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const { registry } = paging(gate);

      yield* opened(registry);

      // The dialog is open and the settings have not answered.
      expect(registry.get(environmentDraftAtom("work"))).toEqual({
        name: "Work",
        instance: undefined,
        maxInstance: undefined,
        idle: undefined,
        ignore: undefined,
        variables: undefined,
        setupScript: undefined,
        startScript: undefined,
        toolchains: undefined,
      });

      yield* Deferred.succeed(gate, undefined);
      yield* settled(registry, environmentSettingsAtom("work"));

      expect(registry.get(environmentDraftAtom("work"))).toEqual({
        name: "Work",
        instance: DEFAULT_CONTAINER_SETTINGS.instance,
        maxInstance: DEFAULT_CONTAINER_SETTINGS.maxInstance,
        idle: String(DEFAULT_CONTAINER_SETTINGS.idleMinutes),
        ignore: "",
        variables: "",
        setupScript: "",
        startScript: "",
        toolchains: "",
      });
    }),
  );

  it.effect(
    "keeps the idle field empty once the owner clears it, when the settings are loaded again",
    () =>
      Effect.gen(function* () {
        const { registry } = paging();

        yield* opened(registry);
        yield* settled(registry, environmentSettingsAtom("work"));
        registry.set(environmentDraftAtom("work"), {
          ...registry.get(environmentDraftAtom("work")),
          idle: "",
        });
        registry.refresh(environmentSettingsAtom("work"));
        yield* settled(registry, environmentSettingsAtom("work"));

        expect(registry.get(environmentDraftAtom("work")).idle).toBe("");
      }),
  );

  it.effect(
    "shows the saved variables as NAME=value lines, and the scripts and Toolchains as they are",
    () =>
      Effect.gen(function* () {
        const { registry } = paging(undefined, {
          ...DEFAULT_CONTAINER_SETTINGS,
          variables: { NODE_ENV: "test", QUERY: "a=b" },
          setupScript: "pnpm install\n",
          startScript: "docker start db\n",
          toolchains: '[tools]\nnode = "22.20.0"\n',
        });

        yield* opened(registry);
        yield* settled(registry, environmentSettingsAtom("work"));

        expect(registry.get(environmentDraftAtom("work"))).toMatchObject({
          variables: "NODE_ENV=test\nQUERY=a=b",
          setupScript: "pnpm install\n",
          startScript: "docker start db\n",
          toolchains: '[tools]\nnode = "22.20.0"\n',
        });
      }),
  );

  it.effect("keeps what was typed when the settings answer after it", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const { registry } = paging(gate);

      yield* opened(registry);

      const other = INSTANCE_TYPES.find((type) => type !== DEFAULT_CONTAINER_SETTINGS.instance)!;

      registry.set(environmentDraftAtom("work"), {
        name: "Renamed",
        instance: other,
        maxInstance: "standard-4",
        idle: undefined,
        ignore: "/data",
        variables: "A=1",
        setupScript: undefined,
        startScript: "typed\n",
        toolchains: undefined,
      });
      yield* Deferred.succeed(gate, undefined);
      yield* settled(registry, environmentSettingsAtom("work"));

      expect(registry.get(environmentDraftAtom("work"))).toEqual({
        name: "Renamed",
        instance: other,
        maxInstance: "standard-4",
        idle: String(DEFAULT_CONTAINER_SETTINGS.idleMinutes),
        ignore: "/data",
        variables: "A=1",
        setupScript: "",
        startScript: "typed\n",
        toolchains: "",
      });
    }),
  );

  it.effect("keeps what was picked when the settings are loaded again", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      yield* opened(registry);
      yield* settled(registry, environmentSettingsAtom("work"));
      registry.set(environmentDraftAtom("work"), {
        name: "Work",
        instance: "lite",
        maxInstance: "basic",
        idle: "20",
        ignore: "",
        variables: "",
        setupScript: "",
        startScript: "",
        toolchains: "",
      });
      registry.refresh(environmentSettingsAtom("work"));
      yield* settled(registry, environmentSettingsAtom("work"));

      expect(registry.get(environmentDraftAtom("work"))).toEqual({
        name: "Work",
        instance: "lite",
        maxInstance: "basic",
        idle: "20",
        ignore: "",
        variables: "",
        setupScript: "",
        startScript: "",
        toolchains: "",
      });
    }),
  );
});

describe("the Workspaces", () => {
  /** A Registry holding Workspaces and the Sessions in them; removing or restarting `deadbeef` fails. */
  const holdingWorkspaces = () => {
    const workspaces = [workspace("0a1b2c3d", "fix/build"), workspace("deadbeef", "stuck")];
    const sessions = [session("a", "work", "0a1b2c3d"), session("b", "work", "deadbeef")];
    const removed: string[] = [];
    const restarted: string[] = [];

    const registry = registryWith({
      listWorkspaces: () => Effect.sync(() => [...workspaces]),
      listSessions: () => Effect.sync(() => [...sessions]),
      removeWorkspace: ({ id }) => {
        removed.push(id);

        if (id === "deadbeef") return refused("Could not remove the files.");

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
      restartContainer: ({ workspace: id }) => {
        restarted.push(id);

        return id === "deadbeef" ? refused("Could not stop it.") : Effect.void;
      },
      createSession: ({ environment: on, workspace: id }) =>
        id === "deadbeef"
          ? refused("The workspace is being removed.")
          : Effect.sync(() => {
              const created = session("c", on ?? "default", id);

              sessions.unshift(created);

              return created;
            }),
    });

    return { registry, removed, restarted };
  };

  it.effect("starts a Session in one, opens it and lists it", () =>
    Effect.gen(function* () {
      const { registry } = holdingWorkspaces();

      registry.mount(pathAtom);
      registry.mount(sessionsAtom);
      yield* settled(registry, sessionsAtom);
      registry.set(startSessionAtom("work"), "0a1b2c3d");

      const started = AsyncResult.getOrThrow(yield* settled(registry, startSessionAtom("work")));

      expect(started).toMatchObject({ id: "c", environment: "work", workspace: "0a1b2c3d" });
      expect(registry.get(pathAtom)).toBe("/sessions/c");
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom)).map((known) => known.id),
      ).toEqual(["c", "a", "b"]);
    }),
  );

  it.effect("says why a Session could not start, on its Environment's card only", () =>
    Effect.gen(function* () {
      const { registry } = holdingWorkspaces();

      registry.mount(pathAtom);
      registry.mount(startSessionAtom("other"));
      registry.set(startSessionAtom("work"), "deadbeef");

      expect(settledFailureOf(yield* settled(registry, startSessionAtom("work")))).toBe(
        "The workspace is being removed.",
      );
      expect(AsyncResult.isInitial(registry.get(startSessionAtom("other")))).toBe(true);
      expect(registry.get(pathAtom)).toBe("/");
    }),
  );

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

      registry.mount(environmentDialogAtom("work"));
      registry.mount(sessionsAtom);
      registry.mount(workspacesAtom);
      yield* settled(registry, sessionsAtom);
      yield* settled(registry, workspacesAtom);
      registry.set(environmentDialogAtom("work"), { removeWorkspace: "0a1b2c3d" });
      registry.set(removeWorkspaceAtom("work"), "0a1b2c3d");
      yield* settled(registry, removeWorkspaceAtom("work"));

      expect(removed).toEqual(["0a1b2c3d"]);
      expect(registry.get(environmentDialogAtom("work"))).toBeNull();
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

      registry.mount(environmentDialogAtom("work"));
      registry.set(environmentDialogAtom("work"), { removeWorkspace: "deadbeef" });
      registry.set(removeWorkspaceAtom("work"), "deadbeef");

      expect(failureOf(yield* settled(registry, removeWorkspaceAtom("work")))).toBe(
        "Could not remove the files.",
      );
      expect(registry.get(environmentDialogAtom("work"))).toEqual({ removeWorkspace: "deadbeef" });
    }),
  );

  it.effect("restarts a Container and closes the dialog", () =>
    Effect.gen(function* () {
      const { registry, restarted } = holdingWorkspaces();

      registry.mount(environmentDialogAtom("work"));
      registry.set(environmentDialogAtom("work"), { restart: "0a1b2c3d" });
      registry.set(restartContainerAtom("work"), "0a1b2c3d");
      yield* settled(registry, restartContainerAtom("work"));

      expect(restarted).toEqual(["0a1b2c3d"]);
      expect(registry.get(environmentDialogAtom("work"))).toBeNull();
    }),
  );

  it.effect("keeps the restart dialog open when it is refused, and says why", () =>
    Effect.gen(function* () {
      const { registry } = holdingWorkspaces();

      registry.mount(environmentDialogAtom("work"));
      registry.set(environmentDialogAtom("work"), { restart: "deadbeef" });
      registry.set(restartContainerAtom("work"), "deadbeef");

      expect(settledFailureOf(yield* settled(registry, restartContainerAtom("work")))).toBe(
        "Could not stop it.",
      );
      expect(registry.get(environmentDialogAtom("work"))).toEqual({ restart: "deadbeef" });
    }),
  );

  it("keeps the typed branch of one Workspace apart from another's", () => {
    const { registry } = holdingWorkspaces();

    registry.mount(removeWorkspaceTypedAtom("0a1b2c3d"));
    registry.mount(removeWorkspaceTypedAtom("deadbeef"));
    registry.set(removeWorkspaceTypedAtom("0a1b2c3d"), "fix/build");

    expect(registry.get(removeWorkspaceTypedAtom("deadbeef"))).toBe("");
    registry.dispose();
  });
});

describe("an Environment's Build", () => {
  it.effect("shows where each Environment's Build stands, and none for one not listed", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        listBuilds: () =>
          Effect.succeed([
            { environment: "work", build: { status: "ready" as const, at: 5 } },
            { environment: "home", build: { status: "none" as const } },
          ]),
      });

      registry.mount(environmentBuildAtom("work"));
      yield* settled(registry, buildsAtom);

      expect(registry.get(environmentBuildAtom("work"))).toEqual({ status: "ready", at: 5 });
      expect(registry.get(environmentBuildAtom("gone"))).toBeNull();
      registry.dispose();
    }),
  );

  it.effect(
    "asks for a Build again and lists the Builds again, so the line shows it under way",
    () =>
      Effect.gen(function* () {
        const rebuilt: string[] = [];
        let building = false;

        const registry = registryWith({
          listBuilds: () =>
            Effect.sync(() => [
              {
                environment: "work",
                build: building
                  ? { status: "building" as const, since: 7, lastGoodAt: 5 }
                  : { status: "ready" as const, at: 5 },
              },
            ]),
          rebuildEnvironment: ({ environment }) =>
            Effect.sync(() => {
              rebuilt.push(environment);
              building = true;
            }),
        });

        registry.mount(environmentBuildAtom("work"));
        yield* settled(registry, buildsAtom);
        registry.mount(rebuildEnvironmentAtom("work"));
        registry.set(rebuildEnvironmentAtom("work"), undefined);
        yield* settled(registry, rebuildEnvironmentAtom("work"));
        yield* settled(registry, buildsAtom);

        expect(rebuilt).toEqual(["work"]);
        expect(registry.get(environmentBuildAtom("work"))).toEqual({
          status: "building",
          since: 7,
          lastGoodAt: 5,
        });
        registry.dispose();
      }),
  );

  it.effect("says why a Rebuild was refused", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        rebuildEnvironment: () => refused("There is nothing to build."),
      });

      registry.mount(rebuildEnvironmentAtom("work"));
      registry.set(rebuildEnvironmentAtom("work"), undefined);

      expect(settledFailureOf(yield* settled(registry, rebuildEnvironmentAtom("work")))).toBe(
        "There is nothing to build.",
      );
      registry.dispose();
    }),
  );
});

describe("the Agent changes", () => {
  const change = (id: number, revertedBy: number | null = null): AgentChange => ({
    id,
    scope: "work",
    at: 1,
    actor: "agent",
    session: "s-1",
    conversation: 1,
    tool: "environment_variable_set",
    reason: "The tests read it",
    field: "variables.API_URL",
    before: null,
    after: "https://api.test",
    reverts: null,
    revertedBy,
  });

  it.effect("are listed, and a revert loads them and the settings again", () =>
    Effect.gen(function* () {
      const reverted: Array<{ environment: string; change: number }> = [];
      let settingsAsked = 0;

      const registry = registryWith({
        listAgentChanges: ({ environment }) =>
          Effect.succeed(
            environment === "work" ? [change(1, reverted.length === 0 ? null : 2)] : [],
          ),
        revertAgentChange: (input) =>
          Effect.sync(() => {
            reverted.push(input);

            return { ...change(2), actor: "owner" as const, reverts: 1 };
          }),
        getEnvironmentSettings: () =>
          Effect.sync(() => {
            settingsAsked += 1;

            return { settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} };
          }),
        listBuilds: () => Effect.succeed([]),
      });

      registry.mount(environmentSettingsAtom("work"));
      registry.mount(agentChangesAtom("work"));
      expect(AsyncResult.getOrThrow(yield* settled(registry, agentChangesAtom("work")))).toEqual([
        change(1),
      ]);

      registry.mount(revertAgentChangeAtom("work"));
      registry.set(revertAgentChangeAtom("work"), 1);
      yield* settled(registry, revertAgentChangeAtom("work"));
      yield* settled(registry, agentChangesAtom("work"));

      expect(reverted).toEqual([{ environment: "work", change: 1 }]);
      expect(AsyncResult.getOrThrow(registry.get(agentChangesAtom("work")))).toEqual([
        change(1, 2),
      ]);
      expect(settingsAsked).toBe(2);
      registry.dispose();
    }),
  );

  it.effect(
    "of the Secrets kept for every Environment load by the scope *, and a revert loads the Secrets again",
    () =>
      Effect.gen(function* () {
        const asked: string[] = [];
        let build = true;
        let secretsAsked = 0;

        const registry = registryWith({
          listAgentChanges: ({ environment }) =>
            Effect.sync(() => {
              asked.push(environment);

              return [];
            }),
          revertAgentChange: () =>
            Effect.sync(() => {
              build = false;

              return { ...change(2), actor: "owner" as const, reverts: 1 };
            }),
          listEnvironmentSecrets: () =>
            Effect.sync(() => {
              secretsAsked += 1;

              return [{ environment: null, name: "NPM_TOKEN", build, updatedAt: 1 }];
            }),
          listBuilds: () => Effect.succeed([]),
        });

        registry.mount(agentChangesAtom(EVERY_ENVIRONMENT));
        registry.mount(environmentSecretsAtom);
        yield* settled(registry, agentChangesAtom(EVERY_ENVIRONMENT));
        expect(asked).toEqual(["*"]);
        expect(AsyncResult.getOrThrow(yield* settled(registry, environmentSecretsAtom))).toEqual([
          { environment: null, name: "NPM_TOKEN", build: true, updatedAt: 1 },
        ]);

        registry.mount(revertAgentChangeAtom(EVERY_ENVIRONMENT));
        registry.set(revertAgentChangeAtom(EVERY_ENVIRONMENT), 1);
        yield* settled(registry, revertAgentChangeAtom(EVERY_ENVIRONMENT));
        yield* settled(registry, environmentSecretsAtom);

        expect(secretsAsked).toBe(2);
        expect(AsyncResult.getOrThrow(registry.get(environmentSecretsAtom))).toEqual([
          { environment: null, name: "NPM_TOKEN", build: false, updatedAt: 1 },
        ]);
        registry.dispose();
      }),
  );

  it.effect("say why a revert was refused", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        revertAgentChange: () =>
          refused(
            'variables.API_URL has changed since: it is "x" now, so the change is not reverted',
          ),
      });

      registry.mount(revertAgentChangeAtom("work"));
      registry.set(revertAgentChangeAtom("work"), 1);

      expect(settledFailureOf(yield* settled(registry, revertAgentChangeAtom("work")))).toBe(
        'variables.API_URL has changed since: it is "x" now, so the change is not reverted',
      );
      registry.dispose();
    }),
  );
});

describe("the kept Secrets", () => {
  /** A Registry keeping Secrets in memory, and what it was asked to keep. */
  const keeping = () => {
    const records: EnvironmentSecretRecord[] = [
      { environment: "work", name: "NPM_KEY", build: true, updatedAt: 1 },
      { environment: null, name: "SHARED", build: false, updatedAt: 1 },
    ];

    const values: Array<{
      environment: string | null;
      name: string;
      value: string;
      build?: boolean;
    }> = [];

    const registry = registryWith({
      listEnvironmentSecrets: () => Effect.sync(() => [...records]),
      setEnvironmentSecret: (payload) =>
        payload.value === "refused"
          ? refused("At most 100 Secrets are kept for every environment: delete one first")
          : Effect.sync(() => {
              values.push({ ...payload });

              const index = records.findIndex(
                (known) => known.environment === payload.environment && known.name === payload.name,
              );

              const record = {
                environment: payload.environment,
                name: payload.name,
                build: payload.build ?? records[index]?.build ?? false,
                updatedAt: 2,
              };

              if (index === -1) records.push(record);
              else records[index] = record;

              return record;
            }),
      setEnvironmentSecretBuild: ({ environment: scope, name, build }) =>
        Effect.sync(() => {
          const index = records.findIndex(
            (known) => known.environment === scope && known.name === name,
          );

          const record = { ...records[index]!, build };

          records[index] = record;

          return record;
        }),
      deleteEnvironmentSecret: ({ environment: scope, name }) =>
        name === "STUCK"
          ? refused("No Secret STUCK is kept for every environment")
          : Effect.sync(() => {
              records.splice(
                records.findIndex((known) => known.environment === scope && known.name === name),
                1,
              );
            }),
      listBuilds: () => Effect.succeed([]),
    });

    return { registry, records, values };
  };

  it.effect("are listed by section: an Environment's, and those for every Environment", () =>
    Effect.gen(function* () {
      const { registry } = keeping();

      registry.mount(secretsInAtom("work"));
      registry.mount(secretsInAtom(EVERY_ENVIRONMENT));
      yield* settled(registry, environmentSecretsAtom);

      expect(registry.get(secretsInAtom("work"))?.map((record) => record.name)).toEqual([
        "NPM_KEY",
      ]);
      expect(registry.get(secretsInAtom(EVERY_ENVIRONMENT))?.map((record) => record.name)).toEqual([
        "SHARED",
      ]);
      expect(registry.get(environmentSecretsErrorAtom)).toBeNull();
    }),
  );

  it.effect(
    "keeps a new one for every Environment, then empties the form so the value is held nowhere",
    () =>
      Effect.gen(function* () {
        const { registry, values } = keeping();
        const draft = { name: "API_KEY", value: "sk-live-0123", build: true };

        registry.mount(secretsInAtom(EVERY_ENVIRONMENT));
        registry.mount(secretDraftAtom(EVERY_ENVIRONMENT));
        registry.set(secretDraftAtom(EVERY_ENVIRONMENT), draft);
        registry.set(saveSecretAtom(EVERY_ENVIRONMENT), undefined);

        expect(
          AsyncResult.getOrThrow(yield* settled(registry, saveSecretAtom(EVERY_ENVIRONMENT))),
        ).toMatchObject({ environment: null, name: "API_KEY", build: true });
        expect(values).toEqual([
          { environment: null, name: "API_KEY", value: "sk-live-0123", build: true },
        ]);
        expect(registry.get(secretDraftAtom(EVERY_ENVIRONMENT))).toEqual(EMPTY_SECRET_DRAFT);
      }),
  );

  it.effect("replaces the value of one kept under the name, leaving its build flag as it is", () =>
    Effect.gen(function* () {
      const { registry, values } = keeping();

      registry.mount(secretsInAtom("work"));
      registry.mount(secretDraftAtom("work"));
      yield* settled(registry, environmentSecretsAtom);
      registry.set(secretDraftAtom("work"), { name: "NPM_KEY", value: "npm_new", build: false });
      registry.set(saveSecretAtom("work"), undefined);
      yield* settled(registry, saveSecretAtom("work"));

      expect(values).toEqual([{ environment: "work", name: "NPM_KEY", value: "npm_new" }]);
      expect(registry.get(secretsInAtom("work"))?.[0]?.build).toBe(true);
    }),
  );

  it.effect(
    "keeps what was typed when the Registry refuses it, and says why without the value",
    () =>
      Effect.gen(function* () {
        const { registry } = keeping();
        const draft = { name: "API_KEY", value: "refused", build: false };

        registry.mount(secretDraftAtom("work"));
        registry.set(secretDraftAtom("work"), draft);
        registry.set(saveSecretAtom("work"), undefined);

        const problem = settledFailureOf(yield* settled(registry, saveSecretAtom("work")));

        expect(problem).toMatch(/At most 100/);
        expect(registry.get(secretDraftAtom("work"))).toEqual(draft);
      }),
  );

  it.effect("switches whether one reaches the Build", () =>
    Effect.gen(function* () {
      const { registry, records } = keeping();

      registry.mount(secretsInAtom("work"));
      registry.set(setSecretBuildAtom("work"), { name: "NPM_KEY", build: false });
      yield* settled(registry, setSecretBuildAtom("work"));

      expect(records[0]?.build).toBe(false);
    }),
  );

  it.effect("deletes one and closes its dialog; a refusal keeps it open and says why", () =>
    Effect.gen(function* () {
      const { registry, records } = keeping();

      registry.mount(secretDialogAtom(EVERY_ENVIRONMENT));
      registry.set(secretDialogAtom(EVERY_ENVIRONMENT), "SHARED");
      registry.set(deleteSecretAtom(EVERY_ENVIRONMENT), "SHARED");
      yield* settled(registry, deleteSecretAtom(EVERY_ENVIRONMENT));

      expect(records.map((record) => record.name)).toEqual(["NPM_KEY"]);
      expect(registry.get(secretDialogAtom(EVERY_ENVIRONMENT))).toBeNull();

      registry.set(secretDialogAtom(EVERY_ENVIRONMENT), "STUCK");
      registry.set(deleteSecretAtom(EVERY_ENVIRONMENT), "STUCK");

      expect(
        settledFailureOf(yield* settled(registry, deleteSecretAtom(EVERY_ENVIRONMENT))),
      ).toMatch(/No Secret STUCK/);
      expect(registry.get(secretDialogAtom(EVERY_ENVIRONMENT))).toBe("STUCK");
    }),
  );
});
