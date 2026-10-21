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
import {
  sessionPickedAtom,
  sessionStateAtom,
  sessionStatusAtom,
  sessionViewAtom,
  submitAtom,
  taskGraphAtom,
  threadAtom,
} from "./atoms.ts";
import { SessionProbe } from "./client.ts";
import { FakeSocket, settle } from "./client.testing.ts";

/** An atom registry whose runtime dials fake sockets, recorded in `sockets`. */
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

  return { registry, sockets, latest: () => sockets[sockets.length - 1]! };
};

/** Greet and answer the root's watch, as a Session does. */
const live = (socket: FakeSocket) =>
  Effect.gen(function* () {
    yield* socket.open();
    yield* socket.say({ type: "hello", root: 1 });

    const watch = socket.commands().find((command) => command.type === "watch");

    yield* socket.say({ type: "result", id: watch?.id, result: null });
    yield* socket.say({
      type: "events",
      conversationId: 1,
      events: [
        {
          type: "snapshot",
          entries: [],
          tools: [],
          nestedTools: [],
          compactions: [],
          inbox: [],
          agent: {},
          usage: {},
        },
      ],
    });
  });

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Session's atoms", () => {
  it.effect("build the Session's client on its socket, and follow what the socket says", () =>
    Effect.gen(function* () {
      const { registry, sockets, latest } = setup();

      registry.mount(sessionStatusAtom("s1"));
      yield* settle;

      expect(sockets.map((socket) => socket.url)).toEqual([
        "wss://example.test/sessions/s1/socket",
      ]);
      expect(registry.get(sessionStatusAtom("s1"))).toBe("connecting");

      yield* live(latest());

      expect(registry.get(sessionStatusAtom("s1"))).toBe("live");
      expect(registry.get(sessionStateAtom("s1")).status).toBe("live");
      expect(registry.get(sessionViewAtom("s1")).running).toBe(false);

      yield* latest().say({
        type: "events",
        conversationId: 1,
        events: [{ type: "run_start", inputs: [1] }],
      });

      expect(registry.get(sessionViewAtom("s1")).running).toBe(true);
    }),
  );

  it.effect("tell a slice's readers only of changes to its field", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup();
      const picked = vi.fn();

      registry.mount(sessionStatusAtom("s1"));
      // Read at once, as a component does: a node nothing has read hears no change.
      registry.subscribe(sessionPickedAtom("s1"), picked, { immediate: true });
      picked.mockClear();
      yield* settle;
      yield* live(latest());

      expect(picked).not.toHaveBeenCalled();

      yield* latest().say({
        type: "events",
        conversationId: 1,
        events: [{ type: "run_start", inputs: [1] }],
      });

      expect(picked).not.toHaveBeenCalled();

      yield* latest().say({ type: "picked", model: true, thinkingLevel: false });

      expect(picked).toHaveBeenCalledExactlyOnceWith({ model: true, thinkingLevel: false });
    }),
  );

  it.effect("close the Session's socket once nothing reads them", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup();

      const unmount = registry.mount(sessionStatusAtom("s1"));

      yield* settle;
      yield* live(latest());

      expect(latest().closed).toBe(false);

      unmount();
      yield* settle;

      expect(latest().closed).toBe(true);
    }),
  );

  it.effect("watch the task graph, and a subagent's thread, while they are read", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup();

      registry.mount(sessionStatusAtom("s1"));
      registry.mount(taskGraphAtom("s1"));

      // Keyed by value: every reader of a thread shares one atom, and so one watch.
      expect(threadAtom({ sessionId: "s1", conversationId: 2 })).toBe(
        threadAtom({ sessionId: "s1", conversationId: 2 }),
      );

      const thread = registry.mount(threadAtom({ sessionId: "s1", conversationId: 2 }));

      yield* settle;
      yield* live(latest());

      const sent = () => latest().commands();

      expect(sent().filter((command) => command.type === "watch_task_graph")).toHaveLength(1);
      expect(
        sent().filter((command) => command.type === "watch" && command.conversationId === 2),
      ).toHaveLength(1);
      expect(registry.get(threadAtom({ sessionId: "s1", conversationId: 2 }))?.status).toBe(
        "loading",
      );

      yield* latest().say({
        type: "task_graph",
        agents: [
          {
            id: "agent-1",
            parent: "root",
            conversationId: 2,
            role: null,
            model: "anthropic/claude-haiku-5",
            status: "working",
          },
        ],
        background: [],
      });

      expect(registry.get(taskGraphAtom("s1"))?.agents).toHaveLength(1);

      thread();
      yield* settle;

      expect(
        sent().filter((command) => command.type === "unwatch" && command.conversationId === 2),
      ).toHaveLength(1);
    }),
  );

  it.effect("submit through the Session's client", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup();

      registry.mount(sessionStatusAtom("s1"));
      registry.mount(submitAtom("s1"));
      yield* settle;
      yield* live(latest());

      registry.set(submitAtom("s1"), { message: "hi", whenBusy: "followUp" });
      yield* settle;

      expect(latest().commands().at(-1)).toMatchObject({
        type: "submit",
        input: "hi",
        whenBusy: "followUp",
      });
    }),
  );
});
