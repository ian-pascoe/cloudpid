// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import {
  DEFAULT_WORKSPACE_SETTINGS,
  workspaceOverridesFrom,
  type WorkspaceSettings,
} from "@cloudpid/config";
import {
  WorkspaceError,
  type SessionRecord,
  type WorkspaceRecord,
  type WorkspaceSettingsState,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "@effect/vitest";
import { failureOf, settledFailureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { sessionsAtom } from "./sessions.ts";
import {
  cloneRepoAtom,
  createWorkspaceAtom,
  deleteWorkspaceAtom,
  renameWorkspaceAtom,
  reposAtom,
  updateWorkspaceSettingsAtom,
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

      registry.set(renameWorkspaceAtom, { workspace: "work", name: "Work" });
      yield* settled(registry, renameWorkspaceAtom);
      expect(AsyncResult.getOrThrow(yield* settled(registry, workspacesAtom))[0]?.name).toBe(
        "Work",
      );
    }),
  );

  it.effect("says why a rename was refused", () =>
    Effect.gen(function* () {
      const registry = holding([workspace("default"), workspace("work")], []);

      registry.set(renameWorkspaceAtom, { workspace: "work", name: "default" });

      expect(failureOf(yield* settled(registry, renameWorkspaceAtom))).toBe(
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

      registry.set(deleteWorkspaceAtom, "work");
      yield* settled(registry, deleteWorkspaceAtom);

      expect(slugs(yield* settled(registry, workspacesAtom))).toEqual(["default"]);
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))).toEqual([]);
    }),
  );

  it.effect("asks again after a delete that stopped partway, and says why", () =>
    Effect.gen(function* () {
      const registry = holding([workspace("stuck")], [session("a", "stuck")]);

      registry.mount(sessionsAtom);
      yield* settled(registry, sessionsAtom);

      registry.set(deleteWorkspaceAtom, "stuck");

      expect(failureOf(yield* settled(registry, deleteWorkspaceAtom))).toBe("Could not stop it.");
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
        registry.set(updateWorkspaceSettingsAtom("work"), { instance: "basic", idleMinutes: 15 });

        const answer = yield* settled(registry, updateWorkspaceSettingsAtom("work"));

        expect(AsyncResult.getOrThrow(answer).settings.instance).toBe("basic");
        expect(saved).toEqual([{ instance: "basic" }]);
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, workspaceSettingsAtom("work"))).settings
            .instance,
        ).toBe("basic");
      }),
  );

  it.effect("says why a save was refused, with the Workspace's message", () =>
    Effect.gen(function* () {
      const { registry, saved } = configured();

      registry.set(updateWorkspaceSettingsAtom("work"), { instance: "basic", idleMinutes: 9999 });

      expect(failureOf(yield* settled(registry, updateWorkspaceSettingsAtom("work")))).toBe(
        "idleMinutes: at most 1440",
      );
      expect(saved).toEqual([]);
    }),
  );
});
