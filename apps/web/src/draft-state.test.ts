// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry and a Storage over native arrays.

import * as Clipboard from "@effect/platform-browser/Clipboard";
import { EnvironmentError, type SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, vi } from "vitest";
import { addDraftAttachmentsAtom, draftAttachmentsAtom } from "./chat/attachments-state.ts";
import { fakeImages, fakeUploads } from "./chat/chat.testing.ts";
import {
  drainFirstMessageAtom,
  draftBaseAtom,
  type FirstMessage,
  draftBranchAtom,
  draftEnvironmentAtom,
  draftTextAtom,
  draftWorkspaceAtom,
  pendingFirstMessagesAtom,
  refusedFirstMessagesAtom,
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
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s1: { text: "Fix the build" } });
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
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s1: { text: "Fix the build" } });
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

describe("the draft's Attachments", () => {
  /** A registry whose uploads the test drives, with the draft's Attachments read as the page reads them. */
  const attaching = () => {
    const uploads = fakeUploads();
    const told: unknown[] = [];

    const registry = AtomRegistry.make({
      initialValues: [
        Atom.initialValue(
          appRuntime.layer,
          Layer.mergeAll(
            Clipboard.layer,
            uploads.layer,
            fakeImages().layer,
            fakeRegistryLayer({
              listSessions: () => Effect.succeed([]),
              listWorkspaces: () => Effect.succeed([]),
              createSession: (payload) =>
                Effect.sync(() => {
                  told.push(payload);

                  return created("s1", payload.environment ?? "default");
                }),
            }),
          ),
        ),
      ],
    });

    registry.mount(pathAtom);
    registry.mount(pendingFirstMessagesAtom);
    registry.mount(refusedFirstMessagesAtom);
    registry.mount(draftAttachmentsAtom);
    registry.mount(addDraftAttachmentsAtom);
    registry.mount(sendDraftAtom);

    const add = (...files: File[]) =>
      Effect.sync(() => {
        registry.set(addDraftAttachmentsAtom, files);
      }).pipe(Effect.andThen(settle));

    const summary = () =>
      registry.get(draftAttachmentsAtom).items.map((item) => `${item.name} ${item.status}`);

    return { registry, uploads, told, add, summary };
  };

  const file = (name: string) => new File(["x"], name, { type: "text/plain" });

  it.effect("upload to the Session once Send has made it, and go with the first message", () =>
    Effect.gen(function* () {
      const { registry, uploads, add, summary } = attaching();

      yield* add(file("notes.txt"));

      // Nowhere to go before the Session is made.
      expect(summary()).toEqual(["notes.txt queued"]);
      expect(uploads.started).toEqual([]);

      registry.set(sendDraftAtom, draft({ text: "Read this" }));
      yield* settle;

      expect(uploads.started.map((upload) => `${upload.sessionId}/${upload.name}`)).toEqual([
        "s1/notes.txt",
      ]);
      expect(summary()).toEqual(["notes.txt uploading"]);
      // The page stays on the draft while it uploads.
      expect(registry.get(pathAtom)).toBe("/");

      yield* uploads.started[0]!.finish();
      yield* settled(registry, sendDraftAtom);

      expect(registry.get(pendingFirstMessagesAtom)).toMatchObject({
        s1: {
          text: "Read this",
          message: {
            input: [
              { type: "text", text: "Read this" },
              { type: "text", text: "@/workspace/.uploads/s1/notes.txt" },
            ],
          },
        },
      });
      expect(registry.get(pathAtom)).toBe("/sessions/s1");
      // The next draft starts with none.
      expect(summary()).toEqual([]);
    }),
  );

  it.effect("make a message on their own", () =>
    Effect.gen(function* () {
      const { registry, uploads, told, add } = attaching();

      yield* add(file("notes.txt"));
      registry.set(sendDraftAtom, draft({ text: "  " }));
      yield* settle;
      yield* uploads.started[0]!.finish();
      yield* settled(registry, sendDraftAtom);

      expect(told).toHaveLength(1);
      expect(registry.get(pendingFirstMessagesAtom)).toMatchObject({
        s1: {
          text: "",
          message: { input: [{ type: "text", text: "@/workspace/.uploads/s1/notes.txt" }] },
        },
      });
    }),
  );

  it.effect("go back to the Session's composer with the text when one does not upload", () =>
    Effect.gen(function* () {
      const { registry, uploads, add } = attaching();
      const notes = file("notes.txt");

      yield* add(notes);
      registry.set(sendDraftAtom, draft({ text: "Read this" }));
      yield* settle;
      yield* uploads.started[0]!.fail("The upload failed (500).");
      yield* settled(registry, sendDraftAtom);

      expect(registry.get(pendingFirstMessagesAtom)).toEqual({});
      expect(registry.get(refusedFirstMessagesAtom)).toEqual({
        s1: {
          text: "Read this",
          reason:
            "The session was made, but not every attachment uploaded: notes.txt (The upload failed (500).). Send the message again.",
          files: [notes],
        },
      });
      expect(registry.get(pathAtom)).toBe("/sessions/s1");
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
  const setup = (pending: Readonly<{ [sessionId: string]: string }>) => {
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
        Atom.initialValue(
          pendingFirstMessagesAtom,
          Record.map(pending, (text): FirstMessage => ({ text })),
        ),
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

  /** The submits the client sent on `socket`. */
  const submitsOn = (socket: FakeSocket) =>
    socket.commands().filter((command) => command.type === "submit");

  it.effect(
    "is sent as a follow-up once the Session's client is built, and cleared once it takes it",
    () =>
      Effect.gen(function* () {
        const { registry, latest } = setup({ s1: "Fix the build", s2: "Another" });

        registry.mount(drainFirstMessageAtom("s1"));
        yield* settle;
        yield* live(latest());
        yield* settle;

        const submits = submitsOn(latest());

        expect(submits).toHaveLength(1);
        expect(submits[0]).toMatchObject({ input: "Fix the build", whenBusy: "followUp" });
        // Until the Session answers, the message is still waiting.
        expect(registry.get(pendingFirstMessagesAtom)).toEqual({
          s1: { text: "Fix the build" },
          s2: { text: "Another" },
        });

        yield* latest().say({
          type: "result",
          id: submits[0]?.id,
          result: { submissionId: "sub-1" },
        });
        yield* settle;

        expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s2: { text: "Another" } });
        expect(registry.get(refusedFirstMessagesAtom)).toEqual({});
      }),
  );

  it.effect("stays waiting when the page is left before the Session greets", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup({ s1: "Fix the build" });

      const unmount = registry.mount(drainFirstMessageAtom("s1"));

      yield* settle;
      unmount();
      yield* settle;

      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s1: { text: "Fix the build" } });

      registry.mount(drainFirstMessageAtom("s1"));
      yield* settle;
      yield* live(latest());
      yield* settle;

      expect(submitsOn(latest())).toHaveLength(1);
    }),
  );

  it.effect(
    "is sent again under the same requestId when the page is left before the Session answered",
    () =>
      Effect.gen(function* () {
        const { registry, latest } = setup({ s1: "Fix the build" });

        const unmount = registry.mount(drainFirstMessageAtom("s1"));

        yield* settle;
        yield* live(latest());
        yield* settle;

        const first = submitsOn(latest())[0];

        unmount();
        yield* settle;
        expect(registry.get(pendingFirstMessagesAtom)).toEqual({ s1: { text: "Fix the build" } });

        registry.mount(drainFirstMessageAtom("s1"));
        yield* settle;
        yield* live(latest());
        yield* settle;

        const again = submitsOn(latest());

        expect(again).toHaveLength(1);
        expect(again[0]).toMatchObject({ input: "Fix the build", requestId: first?.requestId });
      }),
  );

  it.effect("goes into the Session's composer with the reason when the Session refuses it", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup({ s1: "Fix the build" });

      registry.mount(refusedFirstMessagesAtom);
      registry.mount(drainFirstMessageAtom("s1"));
      yield* settle;
      yield* live(latest());
      yield* settle;

      const submit = submitsOn(latest())[0];

      yield* latest().say({
        type: "error",
        id: submit?.id,
        message: "The spend limit is reached.",
      });
      yield* settle;

      expect(registry.get(pendingFirstMessagesAtom)).toEqual({});
      expect(registry.get(refusedFirstMessagesAtom)).toEqual({
        s1: { text: "Fix the build", reason: "The spend limit is reached." },
      });
    }),
  );

  it.effect("is not sent twice when the atom is mounted again", () =>
    Effect.gen(function* () {
      const { registry, latest } = setup({ s1: "Fix the build" });

      const unmount = registry.mount(drainFirstMessageAtom("s1"));

      yield* settle;
      yield* live(latest());
      yield* settle;

      const submit = submitsOn(latest())[0];

      yield* latest().say({ type: "result", id: submit?.id, result: { submissionId: "sub-1" } });
      yield* settle;
      unmount();
      registry.mount(drainFirstMessageAtom("s1"));
      yield* settle;

      expect(submitsOn(latest())).toHaveLength(1);
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
      expect(registry.get(pendingFirstMessagesAtom)).toEqual({ other: { text: "Not mine" } });
    }),
  );
});
