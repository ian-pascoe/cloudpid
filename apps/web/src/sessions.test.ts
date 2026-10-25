// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import { SessionNotFound, type SessionRecord } from "@cloudpid/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { callIn, callOf } from "./calls.ts";
import { exitFailure, failureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import {
  archiveSessionAtom,
  createSessionAtom,
  deleteSessionAtom,
  lastInWorkspace,
  newSessionPlace,
  workspaceLabel,
  sameWorkspacePlace,
  renameSessionAtom,
  sessionsAtom,
  unarchiveSessionAtom,
} from "./sessions.ts";

const session = (id: string, title: string | null = null): SessionRecord => ({
  id,
  title,
  titleSource: title === null ? null : "owner",
  environment: "default",
  workspace: "0a1b2c3d",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

/** A Registry whose Session list is `list`, which the mutations given change. */
const listed = (list: SessionRecord[]) => {
  let calls = 0;

  const registry = registryWith({
    listSessions: () =>
      Effect.sync(() => {
        calls += 1;

        return [...list];
      }),
    createSession: ({ environment }) =>
      Effect.sync(() => {
        const created = { ...session(`new-${list.length}`), environment: environment ?? "default" };

        list.unshift(created);

        return created;
      }),
    renameSession: ({ id, title }) =>
      Effect.sync(() => {
        const index = list.findIndex((known) => known.id === id);
        const renamed = { ...list[index]!, title, titleSource: "owner" as const };

        list[index] = renamed;

        return renamed;
      }),
    archiveSession: ({ id }) =>
      Effect.sync(() => {
        const index = list.findIndex((known) => known.id === id);
        const archived = { ...list[index]!, archivedAt: 2 };

        list[index] = archived;

        return archived;
      }),
    unarchiveSession: ({ id }) =>
      id === "gone"
        ? Effect.fail(new SessionNotFound({ message: "No such session." }))
        : Effect.sync(() => {
            const index = list.findIndex((known) => known.id === id);
            const back = { ...list[index]!, archivedAt: null };

            list[index] = back;

            return back;
          }),
    deleteSession: ({ id }) =>
      Effect.sync(() => {
        list.splice(
          list.findIndex((known) => known.id === id),
          1,
        );
      }),
  });

  registry.mount(sessionsAtom);

  return { registry, calls: () => calls };
};

describe("where a new Session starts", () => {
  it("starts in a new Workspace of the shown Session's Environment", () => {
    expect(newSessionPlace({ ...session("a"), environment: "work" })).toEqual({
      environment: "work",
      workspace: "new",
    });
  });

  it("starts in a new Workspace of the default Environment when no Session is shown", () => {
    expect(newSessionPlace(undefined)).toEqual({ environment: "default", workspace: "new" });
  });

  it("starts in the shown Session's own Workspace when asked to share it", () => {
    expect(sameWorkspacePlace({ ...session("a"), workspace: "0a1b2c3d" })).toEqual({
      workspace: "0a1b2c3d",
    });
  });

  it("names a Workspace by its branch, or by its id when the branch is not known", () => {
    const branches = { "0a1b2c3d": "fix/build" };

    expect(workspaceLabel("new", branches)).toBe("New workspace");
    expect(workspaceLabel("0a1b2c3d", branches)).toBe("fix/build");
    expect(workspaceLabel("ffffffff", branches)).toBe("ffffffff");
  });
});

describe("the last Session in a Workspace", () => {
  it("is one no other Session, archived ones counted, shares a Workspace with", () => {
    const alone = { ...session("alone"), workspace: "ffffffff" };
    const first = session("first");
    const archived = { ...session("archived"), archivedAt: 2 };

    expect(lastInWorkspace([alone, first, archived], alone)).toBe(true);
    expect(lastInWorkspace([alone, first, archived], first)).toBe(false);
    expect(lastInWorkspace([alone, first], first)).toBe(true);
    expect(lastInWorkspace([], first)).toBe(true);
  });
});

const ids = (result: AsyncResult.AsyncResult<readonly SessionRecord[], unknown>) =>
  AsyncResult.getOrThrow(result).map((known) => known.id);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Session list", () => {
  it.effect("lists the Sessions the Registry answers with", () =>
    Effect.gen(function* () {
      const { registry } = listed([session("a"), session("b")]);

      expect(ids(yield* settled(registry, sessionsAtom))).toEqual(["a", "b"]);
    }),
  );

  it.effect("says why when the Registry cannot list them", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        listSessions: () => Effect.die(new Error("The Registry is down.")),
      });

      registry.mount(sessionsAtom);

      expect(failureOf(yield* settled(registry, sessionsAtom))).toBe("The Registry is down.");
    }),
  );

  it.effect("asks again after a Session is created, and answers with it", () =>
    Effect.gen(function* () {
      const { registry } = listed([session("a")]);

      yield* settled(registry, sessionsAtom);
      registry.set(createSessionAtom, callOf({ environment: "work" }));

      const created = yield* settled(registry, createSessionAtom);

      expect(AsyncResult.getOrThrow(created).environment).toBe("work");
      expect(ids(yield* settled(registry, sessionsAtom))).toEqual(["new-1", "a"]);
    }),
  );

  it.effect("asks again after a Session is renamed, archived, unarchived or deleted", () =>
    Effect.gen(function* () {
      const { registry } = listed([session("a"), session("b")]);

      yield* settled(registry, sessionsAtom);

      registry.set(renameSessionAtom, callOf({ id: "a", title: "Named" }));
      yield* settled(registry, renameSessionAtom);
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))[0]?.title).toBe(
        "Named",
      );

      registry.set(archiveSessionAtom, callOf("b"));
      yield* settled(registry, archiveSessionAtom);
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))[1]?.archivedAt).toBe(2);

      registry.set(unarchiveSessionAtom, callOf("b"));
      yield* settled(registry, unarchiveSessionAtom);
      expect(AsyncResult.getOrThrow(yield* settled(registry, sessionsAtom))[1]?.archivedAt).toBe(
        null,
      );

      registry.set(deleteSessionAtom("a"), undefined);
      yield* settled(registry, deleteSessionAtom("a"));
      expect(ids(yield* settled(registry, sessionsAtom))).toEqual(["b"]);
    }),
  );

  it.effect("keeps one Session's delete apart from another's, and forgets it when reset", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        deleteSession: ({ id }) =>
          id === "slow"
            ? Effect.never
            : Effect.fail(SessionNotFound.make({ message: "No such session." })),
      });

      registry.mount(deleteSessionAtom("slow"));
      registry.mount(deleteSessionAtom("gone"));
      registry.set(deleteSessionAtom("slow"), undefined);
      registry.set(deleteSessionAtom("gone"), undefined);

      expect(registry.get(deleteSessionAtom("slow")).waiting).toBe(true);
      expect(failureOf(yield* settled(registry, deleteSessionAtom("gone")))).toBe(
        "No such session.",
      );
      expect(registry.get(deleteSessionAtom("slow")).waiting).toBe(true);

      registry.set(deleteSessionAtom("gone"), Atom.Reset);

      expect(AsyncResult.isInitial(registry.get(deleteSessionAtom("gone")))).toBe(true);
      registry.dispose();
    }),
  );

  it.effect("says why a change was refused, with the Registry's message", () =>
    Effect.gen(function* () {
      const { registry } = listed([session("a")]);

      registry.set(unarchiveSessionAtom, callOf("gone"));

      expect(failureOf(yield* settled(registry, unarchiveSessionAtom))).toBe("No such session.");
    }),
  );

  it.effect("answers each of two overlapping renames with its own outcome", () =>
    Effect.gen(function* () {
      const slow = Deferred.makeUnsafe<void>();

      const registry = registryWith({
        renameSession: ({ id, title }) =>
          id === "slow"
            ? Deferred.await(slow).pipe(Effect.as({ ...session(id), title }))
            : Effect.fail(SessionNotFound.make({ message: "No such session." })),
      });

      registry.mount(renameSessionAtom);

      const first = callIn(registry, renameSessionAtom, { id: "slow", title: "Named" });
      const second = callIn(registry, renameSessionAtom, { id: "gone", title: "Named" });

      expect(exitFailure(yield* Effect.promise(() => second))).toBe("No such session.");

      yield* Deferred.succeed(slow, undefined);

      expect(exitFailure(yield* Effect.promise(() => first))).toBe(null);
      registry.dispose();
    }),
  );

  it.effect(
    "asks again every five seconds while the page is visible, and not while it is hidden",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();

        const page = { visibilityState: "visible" };

        vi.stubGlobal("document", page);

        const { registry, calls } = listed([session("a")]);

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect(calls()).toBe(1);

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5_000));
        expect(calls()).toBe(2);

        page.visibilityState = "hidden";
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15_000));
        expect(calls()).toBe(2);

        page.visibilityState = "visible";
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5_000));
        expect(calls()).toBe(3);

        registry.dispose();
      }),
  );
});
