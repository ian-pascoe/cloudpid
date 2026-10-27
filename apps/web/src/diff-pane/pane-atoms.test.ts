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
import { paneAtomsOf } from "./pane-atoms.ts";

const MERGE_BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const NEXT = "c".repeat(40);

const comparison = (head: string, extra: Record<string, Value> = {}) => ({
  repo: "app",
  base: "main",
  branch: "feat",
  mergeBase: MERGE_BASE,
  head,
  commits: 2,
  files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
  more: 0,
  ...extra,
});

const changes = (head: string) => ({
  type: "changes",
  repos: [
    { repo: "app", head: { commit: head, branch: "feat" }, files: [], more: 0, stale: false },
  ],
  startingContainer: false,
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
  const pane = paneAtomsOf("s1");

  const live = Effect.gen(function* () {
    // What the Pane's components read while it is open.
    registry.mount(pane.branchView);
    registry.mount(pane.compare);
    registry.mount(pane.files);
    registry.mount(pane.totals);
    registry.mount(sessionStatusAtom("s1"));
    yield* settle;
    yield* latest().open();
    yield* latest().say({ type: "hello", root: 1 });

    const watch = latest()
      .commands()
      .find((command) => command.type === "watch");

    yield* latest().say({ type: "result", id: watch?.id, result: null });
  });

  const compares = () =>
    latest()
      .commands()
      .filter((command) => command.type === "compare");

  /** Answer the `n`th `compare` the client sent. */
  const answer = (n: number, result: Value) =>
    Effect.gen(function* () {
      yield* settle;
      yield* latest().say({ type: "result", id: compares()[n]?.id, result });
      yield* settle;
    });

  return { registry, pane, latest, live, compares, answer };
};

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Diff pane's This branch", () => {
  it.effect(
    "is asked for without the Container, which starts only for the owner's own action",
    () =>
      Effect.gen(function* () {
        const { registry, pane, compares, answer, live } = setup();

        yield* live;
        registry.mount(pane.following);

        // The owner picked it: the first ask may not start the Container, and says so by asking again when it must.
        registry.set(pane.source, { kind: "branch", repo: "app" });
        registry.set(pane.compare, { repo: "app", manual: true, fetch: false });
        yield* settle;

        expect(compares()).toMatchObject([{ repo: "app", source: "branch" }]);
        expect(compares()[0]).toMatchObject({ startContainer: false });
        expect(registry.get(pane.branchView)).toEqual({ kind: "loading", repo: "app" });

        yield* answer(0, {
          status: "error",
          error: { kind: "needs_container", message: "stopped", base: "main" },
        });

        expect(registry.get(pane.branchView)).toEqual({ kind: "starting", repo: "app" });
        expect(compares()).toHaveLength(2);
        expect(compares()[1]).toMatchObject({ startContainer: true });

        yield* answer(1, { status: "ok", comparison: comparison(HEAD) });

        expect(registry.get(pane.branchView)).toMatchObject({ kind: "ready" });
        expect(registry.get(pane.files).map((file) => file.id)).toEqual(["app/src/a.ts"]);
        expect(registry.get(pane.files)[0]?.branch).toEqual({
          kind: "branch",
          repo: "app",
          branch: "feat",
          base: "main",
          mergeBase: MERGE_BASE,
          head: HEAD,
        });
        expect(registry.get(pane.totals)).toMatchObject({ files: 1, additions: 1 });
      }),
  );

  it.effect("never starts the Container for what the owner did not ask", () =>
    Effect.gen(function* () {
      const { registry, pane, compares, answer, live } = setup();

      yield* live;
      registry.set(pane.source, { kind: "branch", repo: "app" });
      registry.set(pane.compare, { repo: "app", manual: false, fetch: false });
      yield* settle;
      yield* answer(0, {
        status: "error",
        error: { kind: "needs_container", message: "stopped" },
      });

      expect(compares()).toHaveLength(1);
      expect(registry.get(pane.branchView)).toEqual({
        kind: "error",
        repo: "app",
        error: { kind: "needs_container", message: "stopped" },
      });
      expect(registry.get(pane.files)).toEqual([]);
    }),
  );

  it.effect("keeps showing a Comparison while the next is made, and shows each error state", () =>
    Effect.gen(function* () {
      const { registry, pane, answer, live } = setup();

      yield* live;
      registry.set(pane.source, { kind: "branch", repo: "app" });
      registry.set(pane.compare, { repo: "app", manual: true, fetch: false });
      yield* answer(0, { status: "ok", comparison: comparison(HEAD) });
      registry.set(pane.compare, { repo: "app", manual: true, fetch: true });
      yield* settle;

      expect(registry.get(pane.branchView)).toMatchObject({ kind: "ready" });

      yield* answer(1, { status: "error", error: { kind: "no_base", message: "", base: "main" } });

      expect(registry.get(pane.branchView)).toEqual({
        kind: "error",
        repo: "app",
        error: { kind: "no_base", message: "", base: "main" },
      });
    }),
  );

  it.effect("compares again, without the Container, when the repo's HEAD moves", () =>
    Effect.gen(function* () {
      const { registry, pane, latest, compares, answer, live } = setup();

      yield* live;
      registry.mount(pane.following);
      yield* latest().say(changes(HEAD));
      registry.set(pane.source, { kind: "branch", repo: "app" });
      registry.set(pane.compare, { repo: "app", manual: true, fetch: false });
      yield* answer(0, { status: "ok", comparison: comparison(HEAD) });
      expect(compares()).toHaveLength(1);

      // The agent committed: the Changes say so, and the Pane asks again, never starting the Container.
      yield* latest().say(changes(NEXT));
      yield* settle;

      expect(compares()).toHaveLength(2);
      expect(compares()[1]).toMatchObject({ startContainer: false });

      // Container stopped: the last list, marked behind the new HEAD, is not asked for again.
      yield* answer(1, { status: "ok", comparison: comparison(HEAD, { behind: NEXT }) });
      yield* latest().say(changes(NEXT));
      yield* settle;

      expect(compares()).toHaveLength(2);
      expect(registry.get(pane.list).comparison?.behind).toBe(NEXT);
    }),
  );

  it.effect("starts the Container for the owner's Refresh of a list that is behind", () =>
    Effect.gen(function* () {
      const { registry, pane, latest, compares, answer, live } = setup();

      yield* live;
      registry.mount(pane.following);
      yield* latest().say(changes(NEXT));
      registry.set(pane.source, { kind: "branch", repo: "app" });
      registry.set(pane.compare, { repo: "app", manual: false, fetch: false });
      yield* answer(0, { status: "ok", comparison: comparison(HEAD, { behind: NEXT }) });

      // "New commits: Refresh": the stopped Container answered the old list, and the owner's action starts it.
      registry.set(pane.compare, { repo: "app", manual: true, fetch: false });
      yield* answer(1, { status: "ok", comparison: comparison(HEAD, { behind: NEXT }) });

      expect(registry.get(pane.branchView)).toEqual({ kind: "starting", repo: "app" });
      expect(compares()).toHaveLength(3);
      expect(compares()[1]).toMatchObject({ startContainer: false });
      expect(compares()[2]).toMatchObject({ startContainer: true });

      yield* answer(2, { status: "ok", comparison: comparison(NEXT) });

      expect(registry.get(pane.list).comparison?.head).toBe(NEXT);
      expect(registry.get(pane.list).comparison?.behind).toBeUndefined();
    }),
  );

  it.effect("does not interrupt the owner's own compare to follow a HEAD", () =>
    Effect.gen(function* () {
      const { registry, pane, latest, compares, answer, live } = setup();

      yield* live;
      registry.mount(pane.following);
      yield* latest().say(changes(HEAD));
      registry.set(pane.source, { kind: "branch", repo: "app" });
      registry.set(pane.compare, { repo: "app", manual: true, fetch: false });
      yield* answer(0, { status: "ok", comparison: comparison(HEAD) });

      // The owner's Refresh fetches; a commit lands meanwhile.
      registry.set(pane.compare, { repo: "app", manual: true, fetch: true });
      yield* settle;
      yield* latest().say(changes(NEXT));
      yield* settle;

      expect(compares()).toHaveLength(2);

      // It ends, and the HEAD that moved meanwhile is followed.
      yield* answer(1, { status: "ok", comparison: comparison(HEAD) });
      yield* settle;

      expect(compares()).toHaveLength(3);
      expect(compares()[2]).toMatchObject({ startContainer: false, fetch: false });
    }),
  );

  it.effect("follows a HEAD again after an owner's compare was cut off by the next", () =>
    Effect.gen(function* () {
      const { registry, pane, latest, compares, answer, live } = setup();

      yield* live;
      registry.mount(pane.following);
      yield* latest().say(changes(HEAD));
      registry.set(pane.source, { kind: "branch", repo: "app" });

      // A double-click on Refresh: the second compare interrupts the first.
      registry.set(pane.compare, { repo: "app", manual: true, fetch: true });
      yield* settle;
      registry.set(pane.compare, { repo: "app", manual: true, fetch: true });
      yield* settle;
      yield* answer(1, { status: "ok", comparison: comparison(HEAD) });

      expect(compares()).toHaveLength(2);

      yield* latest().say(changes(NEXT));
      yield* settle;

      expect(compares()).toHaveLength(3);
      expect(compares()[2]).toMatchObject({ startContainer: false, fetch: false });
    }),
  );

  it.effect("asks for the picker's repos again only when a HEAD moves, not at every listing", () =>
    Effect.gen(function* () {
      const { registry, pane, latest, live } = setup();

      yield* live;
      registry.mount(pane.sources);
      yield* latest().say(changes(HEAD));
      yield* settle;

      const asked = () =>
        latest()
          .commands()
          .filter((command) => command.type === "comparison_sources");

      const before = asked().length;

      yield* latest().say(changes(HEAD));
      yield* settle;
      expect(asked()).toHaveLength(before);

      yield* latest().say(changes(NEXT));
      yield* settle;
      expect(asked()).toHaveLength(before + 1);
    }),
  );
});
