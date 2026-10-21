// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import { WorkspaceError, type SessionRecord, type WorkspaceRecord } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "@effect/vitest";
import { failureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { sessionsAtom } from "./sessions.ts";
import {
  createWorkspaceAtom,
  deleteWorkspaceAtom,
  renameWorkspaceAtom,
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
