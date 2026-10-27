// @effect-diagnostics preferEffectArray:off -- assertions over what the fake socket recorded, in native arrays.

import * as Clipboard from "@effect/platform-browser/Clipboard";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, vi } from "vitest";
import { fakeRegistryLayer } from "../registry.testing.ts";
import { appRuntime } from "../runtime.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import { SessionProbe } from "../session/client.ts";
import { FakeSocket, settle, type Value } from "../session/client.testing.ts";
import { conversationKey } from "../session/conversation-key.ts";
import { CHANGES_SOURCE, RUN_SOURCE } from "./branch.ts";
import { paneAtomsOf } from "./pane-atoms.ts";
import { diffTargetAtom } from "./target.ts";

const START = "1".repeat(40);
const END = "2".repeat(40);

const lastRun = (extra: Record<string, Value> = {}) => ({
  type: "last_run",
  lastRun: {
    run: "run1abc",
    conversationId: 1,
    startedAt: 1,
    endedAt: null,
    firstCall: "call_1",
    until: null,
    repos: [{ repo: "app", start: START, end: null }],
    ...extra,
  },
});

const diff = (live: boolean, paths: string[]) => ({
  run: "run1abc",
  live,
  repos: [
    {
      repo: "app",
      head: { commit: START, branch: "main" },
      files: paths.map((path) => ({ path, status: "modified", additions: 1, deletions: 0 })),
      more: 0,
      stale: false,
    },
  ],
});

/** An atom registry whose runtime dials fake sockets, the Session live and a Diff pane's atoms made. */
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
  const pane = paneAtomsOf(conversationKey("s1", undefined));

  const live = Effect.gen(function* () {
    registry.mount(pane.files);
    registry.mount(pane.runView);
    registry.mount(pane.lastRun);
    registry.mount(sessionStatusAtom("s1"));
    yield* settle;
    yield* latest().open();
    yield* latest().say({ type: "hello", root: 1 });

    const watch = latest()
      .commands()
      .find((command) => command.type === "watch");

    yield* latest().say({ type: "result", id: watch?.id, result: null });
  });

  const asks = () =>
    latest()
      .commands()
      .filter((command) => command.type === "run_diff");

  /** Answer the `n`th `run_diff` the client sent. */
  const answer = (n: number, result: Value) =>
    Effect.gen(function* () {
      yield* settle;
      yield* latest().say({ type: "result", id: asks()[n]?.id, result });
      yield* settle;
    });

  return { registry, pane, latest, live, asks, answer };
};

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Diff pane's Last run", () => {
  it.effect(
    "is the Session page's: a Subagent page's Pane has none, and 'Show changes' there shows the Changes",
    () =>
      Effect.gen(function* () {
        const { registry, pane, live, latest } = setup();
        const key = conversationKey("s1", 3);
        const sub = paneAtomsOf(key);

        yield* live;
        registry.mount(sub.lastRun);
        registry.mount(sub.source);
        registry.mount(pane.source);
        yield* latest().say(lastRun());
        yield* settle;

        expect(registry.get(pane.lastRun)).toMatchObject({ run: "run1abc" });
        expect(registry.get(sub.lastRun)).toBeNull();

        // What "Show changes" asks for.
        registry.set(diffTargetAtom(key), { file: null, at: 1, source: "run" });
        registry.set(diffTargetAtom(conversationKey("s1", undefined)), {
          file: null,
          at: 2,
          source: "run",
        });
        expect(registry.get(sub.source)).toEqual(CHANGES_SOURCE);
        expect(registry.get(pane.source)).toEqual(RUN_SOURCE);
      }),
  );

  it.effect("asks for the Run diff only while it shows the Last run, and lists its files", () =>
    Effect.gen(function* () {
      const { registry, pane, asks, answer, live, latest } = setup();

      yield* live;
      registry.mount(pane.followingRun);
      yield* settle;

      // On the Changes it asks nothing.
      expect(asks()).toHaveLength(0);

      yield* latest().say(lastRun());
      registry.set(pane.source, RUN_SOURCE);
      yield* settle;
      expect(asks()).toHaveLength(1);

      yield* answer(0, diff(true, ["src/a.ts"]));
      expect(registry.get(pane.files).map((file) => file.entry.path)).toEqual(["src/a.ts"]);
      expect(registry.get(pane.files)[0]?.run).toMatchObject({ run: "run1abc", end: null });
      expect(registry.get(pane.list).run?.run).toBe("run1abc");
    }),
  );

  it.effect("asks again as the Run ends, and freezes its files with the end copy", () =>
    Effect.gen(function* () {
      const { registry, pane, asks, answer, live, latest } = setup();

      yield* live;
      registry.mount(pane.followingRun);
      yield* latest().say(lastRun());
      registry.set(pane.source, RUN_SOURCE);
      yield* settle;
      yield* answer(0, diff(true, ["src/a.ts"]));

      yield* latest().say(
        lastRun({
          endedAt: 5,
          until: 9,
          repos: [{ repo: "app", start: START, end: END }],
        }),
      );
      yield* settle;
      expect(asks()).toHaveLength(2);

      yield* answer(1, diff(false, ["src/a.ts", "src/b.ts"]));
      expect(registry.get(pane.files).map((file) => file.entry.path)).toEqual([
        "src/a.ts",
        "src/b.ts",
      ]);
      expect(registry.get(pane.files)[0]?.run).toMatchObject({ end: END });
      // An ended Run's diff never changes: listing counts stay put.
      expect(registry.get(pane.list).listing).toBe(0);
    }),
  );

  it.effect(
    "shows nothing, saying so, when no Run has written, and why when it could not be listed",
    () =>
      Effect.gen(function* () {
        const { registry, pane, asks, answer, live, latest } = setup();

        yield* live;
        registry.mount(pane.followingRun);
        registry.set(pane.source, RUN_SOURCE);
        yield* settle;
        yield* answer(0, null);

        expect(registry.get(pane.runView)).toMatchObject({ kind: "ready", diff: null });
        expect(registry.get(pane.files)).toEqual([]);

        yield* latest().say(lastRun());
        yield* settle;
        expect(asks()).toHaveLength(2);

        yield* settle;
        yield* latest().say({ type: "error", id: asks()[1]?.id, message: "the Workspace is gone" });
        yield* settle;
        expect(registry.get(pane.runView)).toMatchObject({
          kind: "failed",
          message: expect.stringContaining("the Workspace is gone"),
        });
      }),
  );
});
