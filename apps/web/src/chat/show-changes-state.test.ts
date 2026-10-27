// @effect-diagnostics preferEffectArray:off -- assertions over what the fake socket recorded, in native arrays.

import * as Clipboard from "@effect/platform-browser/Clipboard";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, vi } from "vitest";
import { fakeRegistryLayer } from "../registry.testing.ts";
import { appRuntime } from "../runtime.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import { SessionProbe } from "../session/client.ts";
import { FakeSocket, settle } from "../session/client.testing.ts";
import { runTotalsAtom } from "./show-changes-state.ts";

const START = "1".repeat(40);

const ended = (run: string) => ({
  run,
  live: false,
  repos: [
    {
      repo: "app",
      head: { commit: START, branch: "main" },
      files: [{ path: "src/a.ts", status: "modified", additions: 13, deletions: 0 }],
      more: 0,
      stale: false,
    },
  ],
});

/** An atom registry whose runtime dials fake sockets, with the Session live. */
const setup = () => {
  const sockets: FakeSocket[] = [];

  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        appRuntime.layer,
        Layer.mergeAll(
          Layer.succeed(Socket.WebSocketConstructor)((url) => {
            const socket = new FakeSocket(url);

            sockets.push(socket);

            return socket;
          }),
          Layer.succeed(SessionProbe)(() => Effect.succeed("reachable")),
          Clipboard.layer,
          fakeRegistryLayer({}),
        ),
      ),
    ],
  });

  const latest = () => sockets[sockets.length - 1]!;

  const live = Effect.gen(function* () {
    registry.mount(sessionStatusAtom("s1"));
    yield* settle;
    yield* latest().open();
    yield* latest().say({ type: "hello", root: 1 });
  });

  const asks = () =>
    latest()
      .commands()
      .filter((command) => command.type === "run_diff");

  return { registry, latest, live, asks };
};

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what Show changes sums up", () => {
  it.effect(
    "asks the Session for the Run diff once while shown, and sums up its files and lines",
    () =>
      Effect.gen(function* () {
        const { registry, latest, live, asks } = setup();
        const totals = runTotalsAtom({ sessionId: "s1", run: "run1abc" });

        yield* live;
        registry.mount(totals);
        yield* settle;
        expect(asks()).toHaveLength(1);
        expect(AsyncResult.isSuccess(registry.get(totals))).toBe(false);

        yield* latest().say({ type: "result", id: asks()[0]?.id, result: ended("run1abc") });
        yield* settle;

        const result = registry.get(totals);

        expect(AsyncResult.isSuccess(result) ? result.value : undefined).toEqual({
          files: 1,
          additions: 13,
          deletions: 0,
          approximate: false,
          stale: false,
        });
        expect(asks()).toHaveLength(1);
      }),
  );

  it.effect("sums up nothing when the Session answers another Run's diff", () =>
    Effect.gen(function* () {
      const { registry, latest, live, asks } = setup();
      const totals = runTotalsAtom({ sessionId: "s1", run: "run1abc" });

      yield* live;
      registry.mount(totals);
      yield* settle;
      yield* latest().say({ type: "result", id: asks()[0]?.id, result: ended("run2def") });
      yield* settle;

      const result = registry.get(totals);

      expect(AsyncResult.isSuccess(result) ? result.value : undefined).toBeNull();
    }),
  );
});
