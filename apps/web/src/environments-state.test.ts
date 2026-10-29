// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import {
  DEFAULT_CONTAINER_SETTINGS,
  INSTANCE_TYPES,
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
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
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
  dismissAgentChangeAtom,
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
  environmentNamesAtom,
  environmentSettingsAtom,
  globalSettingsAtom,
  globalVariablesAtom,
  environmentListAtom,
  environmentsAtom,
  newEnvironmentNameAtom,
  rebuildEnvironmentAtom,
  removeRepoAtom,
  removeWorkspaceAtom,
  removeWorkspaceTypedAtom,
  restartContainerAtom,
  startSessionAtom,
  describeWorkspaceWork,
  subagentWorkspacesBelow,
  subagentWorkspacesOf,
  workspaceBranchesAtom,
  workspaceListAtom,
  workspacesAtom,
} from "./environments-state.ts";
import { EMPTY_SECRET_DRAFT, GLOBAL } from "./environments.ts";
import {
  containerSectionForm,
  environmentNameForm,
  environmentVariablesForm,
  globalVariablesForm,
  setupForm,
} from "./settings/forms.ts";
import type { FormFields } from "./settings/drafts.ts";
import type { Marked } from "./settings/scoped.ts";

describe("Subagent Workspaces in the Workspaces section", () => {
  it("says what a Workspace has not pushed, per Repo", () => {
    expect(
      describeWorkspaceWork([
        { repo: "app", uncommitted: 1, unpushed: 2 },
        { repo: "docs", uncommitted: 3, unpushed: 0 },
      ]),
    ).toBe("app: 2 commits not pushed, 1 uncommitted change; docs: 3 uncommitted changes");
    expect(
      describeWorkspaceWork([
        {
          repo: "app",
          uncommitted: 1,
          unpushed: 0,
          unsettled: "not set up (on cloudpid/spare, not cloudpid/0000abcd)",
        },
      ]),
    ).toBe("app: not set up (on cloudpid/spare, not cloudpid/0000abcd), 1 uncommitted change");
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

      yield* renaming(registry, "Work");
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

      expect(failureOf(yield* renaming(registry, "default"))).toBe(
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

/** The answer for an Environment whose own variables are all of `settings`' and which overrides nothing else. */
const stateOf = (settings: ContainerSettings): ContainerSettingsState => ({
  settings,
  global: DEFAULT_CONTAINER_SETTINGS,
  overrides: { variables: settings.variables },
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
    updateEnvironmentSettings: ({ set, reset }) =>
      JSON.stringify(set).includes("9999")
        ? refused("idleMinutes: at most 1440")
        : Effect.sync(() => {
            saved.push({ set, reset });
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

  it.effect("saves only the fields a section changed, as a patch, and loads again", () =>
    Effect.gen(function* () {
      const { registry, saved } = configured();

      yield* savingContainer(registry, { instance: own("basic"), ignore: own("/data") });

      expect(saved).toEqual([{ set: { instance: "basic", ignore: ["/data"] } }]);
      expect(
        AsyncResult.getOrThrow(yield* settled(registry, environmentSettingsAtom("work"))).settings
          .instance,
      ).toBe("basic");
    }),
  );

  it.effect("says why a save was refused, with the Registry's message", () =>
    Effect.gen(function* () {
      const { registry, saved } = configured();

      const answer = yield* savingContainer(registry, {
        instance: own("basic"),
        idleMinutes: own("9999"),
      });

      expect(failureOf(answer)).toBe("idleMinutes: at most 1440");
      expect(saved).toEqual([]);
    }),
  );
});

/** Save `name` as the draft of the name of Environment `work`, once the Environments have loaded. */
const renaming = (registry: AtomRegistry.AtomRegistry, name: string) =>
  Effect.gen(function* () {
    registry.mount(environmentNameForm.fields("work"));
    yield* settled(registry, environmentNameForm.loaded("work"));
    registry.set(environmentNameForm.draft("work"), { name });
    registry.mount(environmentNameForm.save("work"));
    registry.set(environmentNameForm.save("work"), undefined);

    return yield* settled(registry, environmentNameForm.save("work"));
  });

/** A field's own value: the Environment's Override. */
const own = <const V>(value: V): Marked<V> => ({ value, inherited: false });

/** A field the Environment inherits, showing Global's `value`. */
const inherited = <const V>(value: V): Marked<V> => ({ value, inherited: true });

/**
 * Save the Container section of Environment `work` with `fields` overridden in its draft, once its settings have
 * loaded.
 */
const savingContainer = (
  registry: AtomRegistry.AtomRegistry,
  fields: Partial<FormFields<typeof containerSectionForm>>,
) =>
  Effect.gen(function* () {
    registry.mount(containerSectionForm.fields("work"));
    yield* settled(registry, containerSectionForm.loaded("work"));

    const loaded = registry.get(containerSectionForm.fields("work"));

    if (loaded === null) throw new Error("the Container section did not load");

    registry.set(containerSectionForm.draft("work"), { ...loaded, ...fields });
    registry.mount(containerSectionForm.save("work"));
    registry.set(containerSectionForm.save("work"), undefined);

    return yield* settled(registry, containerSectionForm.save("work"));
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
    updateEnvironmentSettings: ({ set, reset }) =>
      Effect.sync(() => {
        saved.push({ set, reset });
        held = { ...held, instance: "basic" };

        return stateOf(held);
      }),
  });

  /** Change the held settings as an agent would, out of the page's sight. */
  const change = (fields: Partial<ContainerSettings>) => {
    held = { ...held, ...fields };
  };

  return { registry, saved, renamed, change };
};

describe("the dialogs of an Environment", () => {
  it("keeps one Environment's open dialog apart from another's", () => {
    const { registry } = paging();

    registry.mount(environmentDialogAtom("work"));
    registry.mount(environmentDialogAtom("other"));
    registry.set(environmentDialogAtom("work"), "delete");

    expect(registry.get(environmentDialogAtom("work"))).toBe("delete");
    expect(registry.get(environmentDialogAtom("other"))).toBeNull();
    registry.dispose();
  });

  it.effect("saves the Spare Workspace turned off as the one field set", () =>
    Effect.gen(function* () {
      const { registry, saved } = paging();

      yield* savingContainer(registry, { spareWorkspace: own(false) });

      expect(saved).toEqual([{ set: { spareWorkspace: false } }]);
    }),
  );

  it.effect("sends nothing for a draft put back as it began, and drops it", () =>
    Effect.gen(function* () {
      const { registry, saved, change } = paging();

      registry.mount(containerSectionForm.fields("work"));
      yield* settled(registry, containerSectionForm.loaded("work"));

      const began = registry.get(containerSectionForm.fields("work"))!;

      registry.set(containerSectionForm.draft("work"), { ...began, idleMinutes: own("30") });
      registry.set(containerSectionForm.draft("work"), began);
      // An agent turns the Spare Workspace off meanwhile: the draft now differs from what is saved.
      change({ spareWorkspace: false });
      registry.refresh(environmentSettingsAtom("work"));
      yield* settled(registry, containerSectionForm.loaded("work"));
      registry.mount(containerSectionForm.save("work"));
      registry.set(containerSectionForm.save("work"), undefined);
      yield* settled(registry, containerSectionForm.save("work"));

      expect(saved).toEqual([]);
      expect(registry.get(containerSectionForm.draft("work"))).toBeUndefined();
      expect(registry.get(containerSectionForm.fields("work"))?.spareWorkspace.value).toBe(false);
    }),
  );

  it.effect("saves an own variable taken out as a reset, and leaves the others alone", () =>
    Effect.gen(function* () {
      const { registry, saved } = paging(undefined, {
        ...DEFAULT_CONTAINER_SETTINGS,
        variables: { KEEP: "1", DROP: "2" },
      });

      registry.mount(environmentVariablesForm.fields("work"));
      yield* settled(registry, environmentVariablesForm.loaded("work"));
      registry.set(environmentVariablesForm.draft("work"), { variables: "KEEP=1" });
      registry.mount(environmentVariablesForm.save("work"));
      registry.set(environmentVariablesForm.save("work"), undefined);
      yield* settled(registry, environmentVariablesForm.save("work"));

      // The variable kept is not in the payload, nor is any other field.
      expect(saved).toEqual([{ reset: ["variables.DROP"] }]);
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

  it.effect("keeps one Environment's delete apart from another's, and forgets it when reset", () =>
    Effect.gen(function* () {
      const { registry } = paging();

      registry.mount(deleteEnvironmentAtom("stuck"));
      registry.mount(deleteEnvironmentAtom("other"));
      registry.set(deleteEnvironmentAtom("stuck"), undefined);
      yield* settled(registry, deleteEnvironmentAtom("stuck"));

      expect(AsyncResult.isInitial(registry.get(deleteEnvironmentAtom("other")))).toBe(true);

      registry.set(deleteEnvironmentAtom("stuck"), Atom.Reset);

      expect(AsyncResult.isInitial(registry.get(deleteEnvironmentAtom("stuck")))).toBe(true);
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

describe("the drafts of an Environment's Container settings sections", () => {
  it.effect("show nothing until the settings answer, then what they hold", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const { registry } = paging(gate);

      registry.mount(containerSectionForm.fields("work"));

      expect(registry.get(containerSectionForm.fields("work"))).toBeNull();

      yield* Deferred.succeed(gate, undefined);
      yield* settled(registry, containerSectionForm.loaded("work"));

      // The Environment overrides none of them: each shows Global's, inherited.
      expect(registry.get(containerSectionForm.fields("work"))).toEqual({
        instance: inherited(DEFAULT_CONTAINER_SETTINGS.instance),
        idleMinutes: inherited(String(DEFAULT_CONTAINER_SETTINGS.idleMinutes)),
        ignore: inherited(""),
        spareWorkspace: inherited(true),
      });
    }),
  );

  it.effect(
    "show the saved variables as NAME=value lines, and the scripts and Toolchains as they are",
    () =>
      Effect.gen(function* () {
        const { registry } = paging(undefined, {
          ...DEFAULT_CONTAINER_SETTINGS,
          variables: { NODE_ENV: "test", QUERY: "a=b" },
          setupScript: "pnpm install\n",
          startScript: "docker start db\n",
          toolchains: '[tools]\nnode = "22.20.0"\n',
        });

        registry.mount(environmentVariablesForm.fields("work"));
        registry.mount(setupForm.fields("work"));
        yield* settled(registry, setupForm.loaded("work"));

        expect(registry.get(environmentVariablesForm.fields("work"))).toEqual({
          variables: "NODE_ENV=test\nQUERY=a=b",
        });
        expect(registry.get(setupForm.fields("work"))).toEqual({
          setupScript: inherited("pnpm install\n"),
          startScript: inherited("docker start db\n"),
          toolchains: inherited('[tools]\nnode = "22.20.0"\n'),
        });
      }),
  );

  it.effect("show only the Environment's own variables, not the ones it gets from Global", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        getEnvironmentSettings: () =>
          Effect.succeed({
            settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: { OWN: "1", FROM_GLOBAL: "2" } },
            global: { ...DEFAULT_CONTAINER_SETTINGS, variables: { FROM_GLOBAL: "2" } },
            overrides: { variables: { OWN: "1" } },
          }),
      });

      registry.mount(environmentVariablesForm.fields("work"));
      yield* settled(registry, environmentVariablesForm.loaded("work"));

      expect(registry.get(environmentVariablesForm.fields("work"))).toEqual({
        variables: "OWN=1",
      });
      expect(registry.get(environmentVariablesForm.dirty("work"))).toBe(false);
    }),
  );

  it.effect(
    "keep, on a save, what an agent changed meanwhile in a field the owner left alone",
    () =>
      Effect.gen(function* () {
        const { registry, saved, change } = paging(undefined, {
          ...DEFAULT_CONTAINER_SETTINGS,
          variables: { A: "1" },
        });

        registry.mount(containerSectionForm.fields("work"));
        registry.mount(environmentVariablesForm.fields("work"));
        yield* settled(registry, environmentVariablesForm.loaded("work"));
        registry.set(containerSectionForm.draft("work"), {
          ...registry.get(containerSectionForm.fields("work"))!,
          idleMinutes: own("30"),
        });
        registry.set(environmentVariablesForm.draft("work"), { variables: "A=1\nB=2" });
        // An agent sets the size and adds a variable after the drafts began.
        change({ instance: "standard-2", variables: { A: "1", AGENT: "3" } });

        registry.mount(containerSectionForm.save("work"));
        registry.set(containerSectionForm.save("work"), undefined);
        yield* settled(registry, containerSectionForm.save("work"));
        registry.mount(environmentVariablesForm.save("work"));
        registry.set(environmentVariablesForm.save("work"), undefined);
        yield* settled(registry, environmentVariablesForm.save("work"));

        expect(saved).toEqual([{ set: { idleMinutes: 30 } }, { set: { variables: { B: "2" } } }]);
      }),
  );

  it.effect("keep what was typed when the settings are loaded again", () =>
    Effect.gen(function* () {
      const { registry } = paging();
      const other = INSTANCE_TYPES.find((type) => type !== DEFAULT_CONTAINER_SETTINGS.instance)!;

      registry.mount(containerSectionForm.fields("work"));
      yield* settled(registry, containerSectionForm.loaded("work"));

      const typed = {
        instance: own(other),
        idleMinutes: own(""),
        ignore: own("/data"),
        spareWorkspace: own(false),
      };

      registry.set(containerSectionForm.draft("work"), typed);
      registry.refresh(environmentSettingsAtom("work"));
      yield* settled(registry, containerSectionForm.loaded("work"));

      expect(registry.get(containerSectionForm.fields("work"))).toEqual(typed);
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

/** The variables kept Global before a test changes them. */
const API_URL_ONLY = { variables: { API_URL: "https://api.test" } };

/** The variables a patch at Global sets. */
const SetVariables = Schema.Struct({
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

/** What Global answers with when it holds `variables` and nothing else. */
const globalStateOf = (variables: Readonly<Record<string, string>>) => ({
  settings: { ...DEFAULT_CONTAINER_SETTINGS, variables },
  overrides: { variables },
  overriddenIn: {},
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

            return stateOf(DEFAULT_CONTAINER_SETTINGS);
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
    "of the Secrets kept Global load by the scope *, and a revert loads the Secrets again",
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

        registry.mount(agentChangesAtom(GLOBAL));
        registry.mount(environmentSecretsAtom);
        yield* settled(registry, agentChangesAtom(GLOBAL));
        expect(asked).toEqual(["*"]);
        expect(AsyncResult.getOrThrow(yield* settled(registry, environmentSecretsAtom))).toEqual([
          { environment: null, name: "NPM_TOKEN", build: true, updatedAt: 1 },
        ]);

        registry.mount(revertAgentChangeAtom(GLOBAL));
        registry.set(revertAgentChangeAtom(GLOBAL), 1);
        yield* settled(registry, revertAgentChangeAtom(GLOBAL));
        yield* settled(registry, environmentSecretsAtom);

        expect(secretsAsked).toBe(2);
        expect(AsyncResult.getOrThrow(registry.get(environmentSecretsAtom))).toEqual([
          { environment: null, name: "NPM_TOKEN", build: false, updatedAt: 1 },
        ]);
        registry.dispose();
      }),
  );

  it.effect("of the variables kept Global load by the scope *, and a revert loads them again", () =>
    Effect.gen(function* () {
      let held: Readonly<Record<string, string>> = API_URL_ONLY.variables;
      let asked = 0;

      const registry = registryWith({
        listAgentChanges: () => Effect.succeed([{ ...change(1), scope: "*" }]),
        revertAgentChange: () =>
          Effect.sync(() => {
            held = {};

            return { ...change(2), scope: "*", actor: "owner" as const, reverts: 1 };
          }),
        getGlobalContainerSettings: () =>
          Effect.sync(() => {
            asked += 1;

            return globalStateOf(held);
          }),
        listBuilds: () => Effect.succeed([]),
      });

      registry.mount(globalSettingsAtom);
      yield* settled(registry, globalSettingsAtom);
      expect(registry.get(globalVariablesAtom)).toEqual({ API_URL: "https://api.test" });

      registry.mount(revertAgentChangeAtom(GLOBAL));
      registry.set(revertAgentChangeAtom(GLOBAL), 1);
      yield* settled(registry, revertAgentChangeAtom(GLOBAL));
      yield* settled(registry, globalSettingsAtom);

      expect(asked).toBe(2);
      expect(registry.get(globalVariablesAtom)).toEqual({});
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

  it.effect("leave the list once dismissed, which loads it again", () =>
    Effect.gen(function* () {
      const dismissed: Array<{ environment: string; change: number }> = [];

      const registry = registryWith({
        listAgentChanges: () =>
          Effect.sync(() => (dismissed.length === 0 ? [change(2), change(1)] : [change(2)])),
        dismissAgentChange: (input) =>
          Effect.sync(() => {
            dismissed.push(input);
          }),
      });

      registry.mount(agentChangesAtom("work"));
      yield* settled(registry, agentChangesAtom("work"));

      registry.mount(dismissAgentChangeAtom("work"));
      registry.set(dismissAgentChangeAtom("work"), 1);
      yield* settled(registry, dismissAgentChangeAtom("work"));
      yield* settled(registry, agentChangesAtom("work"));

      expect(dismissed).toEqual([{ environment: "work", change: 1 }]);
      expect(AsyncResult.getOrThrow(registry.get(agentChangesAtom("work")))).toEqual([change(2)]);
      registry.dispose();
    }),
  );
});

describe("the variables kept Global", () => {
  /** A Registry keeping them in memory, and the patches it was asked to apply. */
  const keeping = () => {
    let held: Readonly<Record<string, string>> = API_URL_ONLY.variables;
    const saved: unknown[] = [];
    let builds = 0;

    const registry = registryWith({
      getGlobalContainerSettings: () => Effect.sync(() => globalStateOf(held)),
      updateGlobalContainerSettings: (patch) =>
        JSON.stringify(patch).includes("TOO_MANY")
          ? refused("variables: with the 50 variables it would have 51")
          : Schema.decodeUnknownEffect(SetVariables)(patch.set ?? {}).pipe(
              Effect.orDie,
              Effect.map(({ variables: set }) => {
                saved.push(patch);

                const removed = (patch.reset ?? []).map((path) => path.replace("variables.", ""));

                held = Record.filter({ ...held, ...set }, (_, name) => !removed.includes(name));

                return globalStateOf(held);
              }),
            ),
      listBuilds: () =>
        Effect.sync(() => {
          builds += 1;

          return [];
        }),
    });

    return { registry, saved, builds: () => builds };
  };

  /** Save `typed` as Global's Variables section's draft. */
  const saving = (registry: ReturnType<typeof keeping>["registry"], typed: string) =>
    Effect.gen(function* () {
      registry.mount(globalVariablesForm.fields(GLOBAL));
      yield* settled(registry, globalVariablesForm.loaded(GLOBAL));
      registry.set(globalVariablesForm.draft(GLOBAL), { variables: typed });
      registry.mount(globalVariablesForm.save(GLOBAL));
      registry.set(globalVariablesForm.save(GLOBAL), undefined);

      return yield* settled(registry, globalVariablesForm.save(GLOBAL));
    });

  it.effect("load as the Registry has them, and what is typed stays apart from them", () =>
    Effect.gen(function* () {
      const { registry } = keeping();

      registry.mount(globalSettingsAtom);
      registry.mount(globalVariablesForm.fields(GLOBAL));

      yield* settled(registry, globalSettingsAtom);
      expect(registry.get(globalVariablesAtom)).toEqual({ API_URL: "https://api.test" });
      expect(registry.get(globalVariablesForm.draft(GLOBAL))).toBeUndefined();

      registry.set(globalVariablesForm.draft(GLOBAL), { variables: "A=1" });
      registry.refresh(globalSettingsAtom);
      yield* settled(registry, globalSettingsAtom);
      expect(registry.get(globalVariablesForm.fields(GLOBAL))).toEqual({ variables: "A=1" });
      registry.dispose();
    }),
  );

  it.effect(
    "are saved as a patch against the loaded ones, then loaded again with the Builds, and the typed text clears",
    () =>
      Effect.gen(function* () {
        const { registry, saved, builds } = keeping();

        registry.mount(globalSettingsAtom);
        registry.mount(buildsAtom);
        yield* settled(registry, globalSettingsAtom);
        yield* settled(registry, buildsAtom);
        yield* saving(registry, "NODE_ENV=test");
        yield* settled(registry, globalSettingsAtom);
        yield* settled(registry, buildsAtom);

        expect(saved).toEqual([
          { set: { variables: { NODE_ENV: "test" } }, reset: ["variables.API_URL"] },
        ]);
        expect(registry.get(globalVariablesAtom)).toEqual({ NODE_ENV: "test" });
        expect(registry.get(globalVariablesForm.draft(GLOBAL))).toBeUndefined();
        expect(builds()).toBe(2);
        registry.dispose();
      }),
  );

  it.effect("are saved with a changed variable set and a removed one reset", () =>
    Effect.gen(function* () {
      const { registry, saved } = keeping();

      yield* saving(registry, "API_URL=https://new.test\nADDED=1");
      yield* saving(registry, "ADDED=1");

      expect(saved).toEqual([
        { set: { variables: { API_URL: "https://new.test", ADDED: "1" } } },
        { reset: ["variables.API_URL"] },
      ]);
      registry.dispose();
    }),
  );

  it.effect("say why a save was refused", () =>
    Effect.gen(function* () {
      const { registry, saved } = keeping();

      expect(settledFailureOf(yield* saving(registry, "TOO_MANY=1"))).toBe(
        "variables: with the 50 variables it would have 51",
      );
      expect(saved).toEqual([]);
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
          ? refused("At most 100 Secrets are kept Global: delete one first")
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
          ? refused("No Secret STUCK is kept Global")
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

  it.effect("are listed by section: an Environment's, and those at Global", () =>
    Effect.gen(function* () {
      const { registry } = keeping();

      registry.mount(secretsInAtom("work"));
      registry.mount(secretsInAtom(GLOBAL));
      yield* settled(registry, environmentSecretsAtom);

      expect(registry.get(secretsInAtom("work"))?.map((record) => record.name)).toEqual([
        "NPM_KEY",
      ]);
      expect(registry.get(secretsInAtom(GLOBAL))?.map((record) => record.name)).toEqual(["SHARED"]);
      expect(registry.get(environmentSecretsErrorAtom)).toBeNull();
    }),
  );

  it.effect("keeps a new one at Global, then empties the form so the value is held nowhere", () =>
    Effect.gen(function* () {
      const { registry, values } = keeping();
      const draft = { name: "API_KEY", value: "sk-live-0123", build: true };

      registry.mount(secretsInAtom(GLOBAL));
      registry.mount(secretDraftAtom(GLOBAL));
      registry.set(secretDraftAtom(GLOBAL), draft);
      registry.set(saveSecretAtom(GLOBAL), undefined);

      expect(
        AsyncResult.getOrThrow(yield* settled(registry, saveSecretAtom(GLOBAL))),
      ).toMatchObject({ environment: null, name: "API_KEY", build: true });
      expect(values).toEqual([
        { environment: null, name: "API_KEY", value: "sk-live-0123", build: true },
      ]);
      expect(registry.get(secretDraftAtom(GLOBAL))).toEqual(EMPTY_SECRET_DRAFT);
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

      registry.mount(secretDialogAtom(GLOBAL));
      registry.set(secretDialogAtom(GLOBAL), "SHARED");
      registry.set(deleteSecretAtom(GLOBAL), "SHARED");
      yield* settled(registry, deleteSecretAtom(GLOBAL));

      expect(records.map((record) => record.name)).toEqual(["NPM_KEY"]);
      expect(registry.get(secretDialogAtom(GLOBAL))).toBeNull();

      registry.set(secretDialogAtom(GLOBAL), "STUCK");
      registry.set(deleteSecretAtom(GLOBAL), "STUCK");

      expect(settledFailureOf(yield* settled(registry, deleteSecretAtom(GLOBAL)))).toMatch(
        /No Secret STUCK/,
      );
      expect(registry.get(secretDialogAtom(GLOBAL))).toBe("STUCK");
    }),
  );
});
