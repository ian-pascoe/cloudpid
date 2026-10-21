// @effect-diagnostics preferEffectArray:off -- an in-memory fake of the Registry over native arrays.

import { SessionNotFound, type SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { deletedHereAtom, noticeAtom, pageProblemAtom, sessionGoneAtom } from "./app-state.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { pathAtom, sessionPath, SETTINGS_PATH } from "./router.ts";
import { createSessionAtom, currentSessionAtom, deleteSessionAtom } from "./sessions.ts";

const session = (id: string): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  workspace: "default",
  repo: null,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

/** A Registry holding `list`; deleting `stuck` is refused. The page shows `path`. */
const showing = (path: string, list: SessionRecord[]) => {
  const registry = registryWith({
    listSessions: () => Effect.sync(() => [...list]),
    createSession: () =>
      Effect.sync(() => {
        const created = session("new");

        list.unshift(created);

        return created;
      }),
    deleteSession: ({ id }) =>
      id === "stuck"
        ? Effect.fail(SessionNotFound.make({ message: "No such session." }))
        : Effect.sync(() => {
            list.splice(
              list.findIndex((known) => known.id === id),
              1,
            );
          }),
  });

  registry.mount(pathAtom);
  registry.mount(noticeAtom);
  registry.mount(pageProblemAtom);
  registry.set(pathAtom, path);

  return registry;
};

describe("leaving a Session's page", () => {
  it.effect("leaves the page of a Session deleted here, saying so", () =>
    Effect.gen(function* () {
      const registry = showing(sessionPath("a"), [session("a"), session("b")]);

      registry.set(deleteSessionAtom("a"), undefined);
      yield* settled(registry, deleteSessionAtom("a"));

      expect(registry.get(pathAtom)).toBe("/");
      expect(registry.get(noticeAtom)).toBe("Session deleted.");
    }),
  );

  it.effect("stays on the page when another Session is deleted", () =>
    Effect.gen(function* () {
      const registry = showing(sessionPath("a"), [session("a"), session("b")]);

      registry.set(deleteSessionAtom("b"), undefined);
      yield* settled(registry, deleteSessionAtom("b"));

      expect(registry.get(pathAtom)).toBe(sessionPath("a"));
      expect(registry.get(noticeAtom)).toBe(null);
    }),
  );

  it.effect("stays on the page when the delete is refused, and forgets it asked", () =>
    Effect.gen(function* () {
      const registry = showing(sessionPath("stuck"), [session("stuck")]);

      registry.set(deleteSessionAtom("stuck"), undefined);

      const result = yield* settled(registry, deleteSessionAtom("stuck"));

      expect(AsyncResult.isFailure(result)).toBe(true);
      expect(registry.get(pathAtom)).toBe(sessionPath("stuck"));
      expect(registry.get(deletedHereAtom).has("stuck")).toBe(false);
    }),
  );

  it.effect("says a Session deleted on another device was deleted", () =>
    Effect.gen(function* () {
      const registry = showing(sessionPath("a"), [session("a")]);

      registry.set(sessionGoneAtom, "a");
      yield* settled(registry, sessionGoneAtom);

      expect(registry.get(pathAtom)).toBe("/");
      expect(registry.get(noticeAtom)).toBe("That session was deleted.");
    }),
  );

  it.effect(
    'says no more than "Session deleted." when the socket closes on a delete asked here',
    () =>
      Effect.gen(function* () {
        const registry = showing(sessionPath("a"), [session("a")]);

        registry.set(deletedHereAtom, new Set(["a"]));
        registry.set(sessionGoneAtom, "a");
        yield* settled(registry, sessionGoneAtom);

        expect(registry.get(noticeAtom)).toBe("Session deleted.");
      }),
  );
});

describe("the page's notices", () => {
  it("keeps a notice on the list, and clears it when a Session is opened", () => {
    const registry = showing("/", []);

    registry.set(noticeAtom, "That session was deleted.");
    registry.set(pathAtom, SETTINGS_PATH);
    expect(registry.get(noticeAtom)).toBe("That session was deleted.");

    registry.set(pathAtom, sessionPath("b"));
    expect(registry.get(noticeAtom)).toBe(null);
  });

  it("clears a page's problem when the page changes", () => {
    const registry = showing(sessionPath("a"), []);

    registry.set(pageProblemAtom, "Could not archive it.");
    expect(registry.get(pageProblemAtom)).toBe("Could not archive it.");

    registry.set(pathAtom, sessionPath("b"));
    expect(registry.get(pageProblemAtom)).toBe(null);
  });
});

describe("a new Session", () => {
  it.effect("opens once it is created", () =>
    Effect.gen(function* () {
      const registry = showing("/", []);

      registry.mount(currentSessionAtom);
      registry.set(createSessionAtom, {});
      yield* settled(registry, createSessionAtom);

      expect(registry.get(pathAtom)).toBe(sessionPath("new"));
    }),
  );
});
