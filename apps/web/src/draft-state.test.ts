// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry and a Storage over native arrays.

import * as Clipboard from "@effect/platform-browser/Clipboard";
import { EnvironmentError, type SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, vi } from "vitest";
import {
  drainFirstMessageAtom,
  draftBaseAtom,
  draftBranchAtom,
  draftEnvironmentAtom,
  draftTextAtom,
  draftWorkspaceAtom,
  pendingFirstMessagesAtom,
  sendDraftAtom,
} from "./draft-state.ts";
import type { DraftInput } from "./draft.ts";
import { environmentsAtom } from "./environments-state.ts";
import { failureOf, RegistryClient, settledFailureOf } from "./registry.ts";
import { fakeRegistryLayer, settled } from "./registry.testing.ts";
import { pathAtom } from "./router.ts";
import { appRuntime } from "./runtime.ts";
import { SessionProbe } from "./session/client.ts";
import { FakeSocket, settle } from "./session/client.testing.ts";
import { keyValueStoreLayer } from "./storage.ts";

const memoryStorage = (): Storage => {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

const created = (id: string, environment: string): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  environment,
  workspace: "0a1b2c3d",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

const draft = (changes: Partial<DraftInput> = {}): DraftInput => ({
  text: "Fix the build",
  environment: "work",
  workspace: "new",
  branch: "",
  base: "",
  ...changes,
});

/** A registry whose Registry records what `createSession` is told; a branch named `taken` is refused. */
const sending = (storage: Storage = memoryStorage()) => {
  const told: unknown[] = [];

  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        keyValueStoreLayer,
        KeyValueStore.layerStorage(() => storage),
      ),
      Atom.initialValue(
        RegistryClient.runtime.layer,
        fakeRegistryLayer({
          listEnvironments: () =>
            Effect.succeed([
              { id: "default", name: "Default", repos: [], createdAt: 1 },
              { id: "work", name: "Work", repos: [], createdAt: 1 },
            ]),
          listSessions: () => Effect.succeed([]),
          createSession: (payload) =>
            Effect.suspend(() => {
              told.push(payload);

              return payload.branch === "taken"
                ? Effect.fail(new EnvironmentError({ message: "That branch is taken." }))
                : Effect.succeed(created("s1", payload.environment ?? "default"));
            }),
        }),
      ),
    ],
  });

  return { registry, told };
};

describe("sending the draft", () => {
  it.effect("creates the Session, sets its first message, empties the draft and opens it", () =>
    Effect.gen(function* () {
      const { registry, told } = sending();

      registry.mount(pathAtom);
      registry.mount(pendingFirstMessagesAtom);
      registry.set(draftTextAtom, "  Fix the build \n");
      registry.set(draftBranchAtom, "fix/build");
      registry.set(draftBaseAtom, "main");
      registry.set(
        sendDraftAtom,
        draft({ text: "  Fix the build \n", branch: "fix/build", base: "main" }),
      );

      expect(AsyncResult.getOrThrow(yield* settled(registry, sendDraftAtom)).id).toBe("s1");
      expect(told).toEqual([
        { environment: "work", workspace: "new", branch: "fix/build", base: "main" },
      ]);
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s1: "Fix the build" });
      expect(registry.get(pathAtom)).toBe("/sessions/s1");
      expect(registry.get(draftTextAtom)).toBe("");
      expect(registry.get(draftBranchAtom)).toBe("");
      expect(registry.get(draftBaseAtom)).toBe("");
    }),
  );

  it.effect("starts in an existing Workspace by its id", () =>
    Effect.gen(function* () {
      const { registry, told } = sending();

      registry.set(sendDraftAtom, draft({ workspace: "0a1b2c3d", branch: "ignored" }));
      yield* settled(registry, sendDraftAtom);

      expect(told).toEqual([{ environment: "work", workspace: "0a1b2c3d" }]);
    }),
  );

  it.effect("keeps the text, sets nothing and stays put when the Registry refuses it", () =>
    Effect.gen(function* () {
      const { registry } = sending();

      registry.mount(pathAtom);
      registry.mount(pendingFirstMessagesAtom);
      registry.set(draftTextAtom, "Fix the build");
      registry.set(sendDraftAtom, draft({ branch: "taken" }));

      const result = yield* settled(registry, sendDraftAtom);

      expect(failureOf(result)).toBe("That branch is taken.");
      expect(settledFailureOf(result)).toBe("That branch is taken.");
      expect(registry.get(draftTextAtom)).toBe("Fix the build");
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({});
      expect(registry.get(pathAtom)).toBe("/");
    }),
  );

  it.effect("can be sent again after a refusal", () =>
    Effect.gen(function* () {
      const { registry, told } = sending();

      registry.mount(pendingFirstMessagesAtom);
      registry.set(sendDraftAtom, draft({ branch: "taken" }));
      yield* settled(registry, sendDraftAtom);
      registry.set(sendDraftAtom, draft({ branch: "other" }));
      yield* settled(registry, sendDraftAtom);

      expect(told).toHaveLength(2);
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s1: "Fix the build" });
    }),
  );

  it.effect("sends nothing for a draft without a message", () =>
    Effect.gen(function* () {
      const { registry, told } = sending();

      registry.set(sendDraftAtom, draft({ text: "   " }));
      yield* settled(registry, sendDraftAtom);

      expect(told).toEqual([]);
    }),
  );
});

describe("the Environment of the draft", () => {
  it.effect(
    "is the default one at first, and the last one chosen on this device after a reload",
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage();
        const first = sending(storage).registry;

        first.mount(draftEnvironmentAtom);
        yield* settled(first, environmentsAtom);
        expect(first.get(draftEnvironmentAtom)).toBe("default");

        first.set(draftEnvironmentAtom, "work");
        expect(first.get(draftEnvironmentAtom)).toBe("work");

        const second = sending(storage).registry;

        second.mount(draftEnvironmentAtom);
        yield* settled(second, environmentsAtom);
        expect(second.get(draftEnvironmentAtom)).toBe("work");
      }),
  );

  it.effect("falls back to the default one when the one chosen is gone", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const registry = sending(storage).registry;

      registry.mount(draftEnvironmentAtom);
      registry.set(draftEnvironmentAtom, "deleted");
      yield* settled(registry, environmentsAtom);

      expect(registry.get(draftEnvironmentAtom)).toBe("default");
    }),
  );

  it("goes back to a new Workspace when another Environment is chosen", () => {
    const { registry } = sending();

    registry.mount(draftWorkspaceAtom);
    registry.set(draftWorkspaceAtom, "0a1b2c3d");
    registry.set(draftEnvironmentAtom, "work");

    expect(registry.get(draftWorkspaceAtom)).toBe("new");
  });
});

describe("the first message of a Session", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** An atom registry whose runtime dials fake sockets, recorded in `sockets`, holding `pending`. */
  const setup = (pending: Record<string, string>) => {
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
        Atom.initialValue(pendingFirstMessagesAtom, pending),
      ],
    });

    return { registry, latest: () => sockets[sockets.length - 1]! };
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

  it.effect("is sent as a follow-up once the Session's client is built, and cleared", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup({ s1: "Fix the build", s2: "Another" });

      registry.mount(drainFirstMessageAtom("s1"));
      yield* settle;
      yield* live(latest());
      yield* settle;

      const submits = latest()
        .commands()
        .filter((command) => command.type === "submit");

      expect(submits).toHaveLength(1);
      expect(submits[0]).toMatchObject({ input: "Fix the build", whenBusy: "followUp" });
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s2: "Another" });
    }),
  );

  it.effect("is not sent twice when the atom is mounted again", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup({ s1: "Fix the build" });

      const unmount = registry.mount(drainFirstMessageAtom("s1"));

      yield* settle;
      yield* live(latest());
      yield* settle;
      unmount();
      registry.mount(drainFirstMessageAtom("s1"));
      yield* settle;

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "submit"),
      ).toHaveLength(1);
    }),
  );

  it.effect("sends nothing for a Session with no first message", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup({ other: "Not mine" });

      registry.mount(drainFirstMessageAtom("s1"));
      yield* settle;
      yield* live(latest());
      yield* settle;

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "submit"),
      ).toHaveLength(0);
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ other: "Not mine" });
    }),
  );
});
