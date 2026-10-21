import { SESSION_DELETED_CLOSE_CODE } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import { noticeAtom } from "../app-state.ts";
import { pathAtom } from "../router.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import { settle } from "../session/client.testing.ts";
import { chatRegistry, live } from "./chat.testing.ts";
import { leaveWhenDeletedAtom } from "./session-gone.ts";

/** A page showing Session `s1`, with the History API's part the router uses. */
const stubPage = () => {
  const location = { pathname: "/sessions/s1", href: "https://example.test/sessions/s1" };
  const listeners = new Set<() => void>();

  vi.stubGlobal("window", {
    location,
    history: {
      pushState: (_state: null, _title: string, path: string) => {
        location.pathname = path;
      },
    },
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => {
      for (const listener of listeners) listener();

      return true;
    },
  });
  vi.stubGlobal(
    "PopStateEvent",
    class {
      constructor(readonly type: string) {}
    },
  );
};

beforeEach(stubPage);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a deleted Session's page", () => {
  it.effect("leaves for the list, saying the Session was deleted elsewhere", () =>
    Effect.gen(function* () {
      const { registry, latest } = chatRegistry();

      registry.mount(pathAtom);
      registry.mount(noticeAtom);
      registry.mount(sessionStatusAtom("s1"));
      registry.mount(leaveWhenDeletedAtom("s1"));
      yield* settle;
      yield* live(latest());

      expect(registry.get(pathAtom)).toBe("/sessions/s1");

      yield* latest().drop(SESSION_DELETED_CLOSE_CODE);
      yield* settle;

      expect(registry.get(pathAtom)).toBe("/");
      expect(registry.get(noticeAtom)).toBe("That session was deleted.");
    }),
  );
});
