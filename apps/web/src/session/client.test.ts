// @effect-diagnostics preferEffectArray:off -- assertions over what the fake socket recorded, in native arrays.

import { EMPTY_VIEW, SESSION_DELETED_CLOSE_CODE } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  make,
  SessionProbe,
  type SessionClient,
} from "./client.ts";
import { FakeSocket, settle, type Value } from "./client.testing.ts";
import type { OutgoingMessage, Reachability } from "./state.ts";

/** Let `millis` of the test clock pass, and what it woke run. */
const advance = (millis: number) => TestClock.adjust(millis).pipe(Effect.andThen(settle));

const URL = "wss://example.test/sessions/s1/socket";

/** A client on fake sockets, in a scope of its own that `dispose` closes. */
const setup = (
  probe: (socketUrl: string) => Effect.Effect<Reachability> = () => Effect.succeed("reachable"),
) =>
  Effect.gen(function* () {
    const sockets: FakeSocket[] = [];
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const client = yield* make(URL).pipe(
      Scope.provide(scope),
      Effect.provideService(Socket.WebSocketConstructor, (url) => {
        const socket = new FakeSocket(url);

        sockets.push(socket);

        return socket;
      }),
      Effect.provideService(SessionProbe, probe),
    );

    yield* settle;

    return {
      client,
      sockets,
      latest: () => sockets[sockets.length - 1]!,
      state: () => SubscriptionRef.getUnsafe(client.state),
      dispose: Scope.close(scope, Exit.void).pipe(Effect.andThen(settle)),
    };
  });

const entry = (id: number, text: string) => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: text, timestamp: id }],
});

const snapshot = (extra: { readonly [key: string]: Value } = {}) => ({
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
      ...extra,
    },
  ],
});

/** Connect, greet, and answer the watch, as a Session does. */
const watching = (socket: FakeSocket, extra: { readonly [key: string]: Value } = {}) =>
  Effect.gen(function* () {
    yield* socket.open();
    yield* socket.say({ type: "hello", root: 1 });

    const watch = socket.commands().find((command) => command.type === "watch");

    yield* socket.say({ type: "result", id: watch?.id, result: null });
    yield* socket.say(snapshot(extra));
  });

/** Submit `message` and record how it ended in `outcomes`, as the composer hears it. */
const submitTold = (
  client: SessionClient,
  outcomes: Array<string | null>,
  message: string | OutgoingMessage,
  conversationId?: number,
) =>
  client.submitAndAwait(message, "followUp", conversationId).pipe(
    Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }),
    Effect.flatMap((outcome) =>
      Effect.sync(() => {
        outcomes.push(outcome);
      }),
    ),
    Effect.forkChild,
    Effect.andThen(settle),
  );

/** Watch thread `conversationId` in a scope of its own, which `release` closes. */
const openThread = (client: SessionClient, conversationId: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    yield* client.watchThread(conversationId).pipe(Scope.provide(scope));
    yield* settle;

    return scope;
  });

/** Let go of a thread `openThread` watched, as a card does when it closes. */
const release = (scope: Scope.Closeable) =>
  Scope.close(scope, Exit.void).pipe(Effect.andThen(settle));

/** Watch thread `conversationId` until the test ends. */
const watchThread = (client: SessionClient, conversationId: number) =>
  openThread(client, conversationId).pipe(Effect.asVoid);

/** Run a request in the background, as a promise did, so the test can answer it. */
const asking = <A, E>(request: Effect.Effect<A, E>) =>
  request.pipe(Effect.forkChild, Effect.tap(settle));

/** Why a request failed. */
const failureOf = <A>(fiber: Fiber.Fiber<A, { readonly message: string }>) =>
  Fiber.join(fiber).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

describe("a Session connection", () => {
  it.effect(
    "connects, watches the root conversation named by hello, and is live once the snapshot lands",
    () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        expect(latest().url).toBe("wss://example.test/sessions/s1/socket");
        expect(state()).toMatchObject({ status: "connecting", view: EMPTY_VIEW });

        yield* latest().open();

        expect(latest().sent).toEqual([]);

        yield* latest().say({ type: "hello", root: 7 });

        expect(latest().commands()).toEqual([
          { type: "watch", id: expect.any(String), conversationId: 7 },
        ]);
        expect(state().status).toBe("connecting");

        yield* latest().say({ ...snapshot(), conversationId: 7 });

        expect(state().status).toBe("live");
      }),
  );

  it.effect("folds event batches into the view, a snapshot first", () =>
    Effect.gen(function* () {
      const { latest, state } = yield* setup();

      yield* watching(latest(), { entries: [entry(1, "hello")] });

      expect(state().view.messages.map((message) => message.parts)).toEqual([
        [{ type: "text", text: "hello" }],
      ]);

      yield* latest().say({
        type: "events",
        conversationId: 1,
        events: [
          { type: "run_start", inputs: [2] },
          { type: "entry_appended", entry: entry(2, "more") },
        ],
      });

      expect(state().view).toMatchObject({ running: true });
      expect(state().view.messages).toHaveLength(2);
    }),
  );

  it.effect("notifies subscribers of each change, until they unsubscribe", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();
      const listener = vi.fn();

      const subscription = yield* SubscriptionRef.changes(client.state).pipe(
        Stream.runForEach(() => Effect.sync(listener)),
        Effect.forkChild,
      );

      yield* settle;
      // A subscription hears the current state first; a listener did not.
      listener.mockClear();

      yield* latest().open();
      yield* latest().say({ type: "hello", root: 1 });
      yield* latest().say(snapshot());

      expect(listener).toHaveBeenCalled();

      listener.mockClear();
      yield* Fiber.interrupt(subscription);
      yield* latest().say({
        type: "events",
        conversationId: 1,
        events: [{ type: "run_start", inputs: [1] }],
      });

      expect(listener).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "holds a submit until the watch is answered, so run_start is not missed, then sends it with a requestId",
    () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        yield* latest().open();
        yield* latest().say({ type: "hello", root: 1 });
        yield* client.submit("hi", "followUp");

        expect(
          latest()
            .commands()
            .map((command) => command.type),
        ).toEqual(["watch"]);

        const watch = latest().commands()[0];

        yield* latest().say({ type: "result", id: watch?.id, result: null });

        expect(latest().commands()[1]).toEqual({
          type: "submit",
          id: expect.any(String),
          input: "hi",
          whenBusy: "followUp",
          requestId: expect.any(String),
        });
      }),
  );

  it.effect("sends a steer with whenBusy steer", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());
      yield* client.submit("change course", "steer");

      expect(latest().commands().at(-1)).toMatchObject({
        type: "submit",
        input: "change course",
        whenBusy: "steer",
      });
    }),
  );

  it.effect("remembers the text of an answered submit by its submission ID, for the queue", () =>
    Effect.gen(function* () {
      const { client, latest, state } = yield* setup();

      yield* watching(latest());
      yield* client.submit("later", "followUp");

      const submit = latest().commands().at(-1);

      yield* latest().say({ type: "result", id: submit?.id, result: { submissionId: "sub-1" } });
      yield* latest().say({
        type: "events",
        conversationId: 1,
        events: [{ type: "inbox_update", items: [{ id: "sub-1", mode: "followUp" }] }],
      });

      expect(state().queue).toEqual({
        steer: [],
        followUp: [{ id: "sub-1", text: "later" }],
      });
    }),
  );

  it.effect(
    "sends a message with images as its input, and shows what it was given to show in the lanes",
    () =>
      Effect.gen(function* () {
        const { client, latest, state } = yield* setup();

        const input = [
          { type: "text" as const, text: "look\n\n@/workspace/.cloudpid/uploads/s/a.png" },
          { type: "image" as const, mimeType: "image/jpeg", data: "/9j/" },
        ];

        yield* watching(latest());
        yield* client.submit({ input, display: "look · Attached: a.png" }, "followUp");

        expect(state().sending.map((entry) => entry.text)).toEqual(["look · Attached: a.png"]);

        const submit = latest().commands().at(-1);

        expect(submit).toMatchObject({ type: "submit", input, whenBusy: "followUp" });

        yield* latest().say({ type: "result", id: submit?.id, result: { submissionId: "sub-1" } });
        yield* latest().say({
          type: "events",
          conversationId: 1,
          events: [{ type: "inbox_update", items: [{ id: "sub-1", mode: "followUp" }] }],
        });

        expect(state().queue.followUp).toEqual([{ id: "sub-1", text: "look · Attached: a.png" }]);
      }),
  );

  it.effect(
    "lists queued inputs by lane, and shows one it has no text for (sent before a reload) as such",
    () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        yield* watching(latest(), {
          inbox: [
            { id: "a", mode: "steer" },
            { id: "b", mode: "followUp" },
            { id: "c", mode: "write" },
          ],
        });

        expect(state().queue).toEqual({
          steer: [{ id: "a", text: null }],
          followUp: [{ id: "b", text: null }],
        });
      }),
  );

  it.effect("sends an abort", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());
      yield* client.abort();

      expect(latest().commands().at(-1)).toEqual({ type: "abort", id: expect.any(String) });
    }),
  );

  it.effect("sends a configure with the fields given, and null to follow the default", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());
      yield* client.configure({ model: "anthropic/claude-sonnet-5-5", thinkingLevel: "low" });
      yield* client.configure({ model: null });

      expect(latest().commands().slice(-2)).toEqual([
        {
          type: "configure",
          id: expect.any(String),
          model: "anthropic/claude-sonnet-5-5",
          thinkingLevel: "low",
        },
        { type: "configure", id: expect.any(String), model: null },
      ]);
    }),
  );

  it.effect("knows which of the model and thinking level the Session picked, as it says", () =>
    Effect.gen(function* () {
      const { latest, state } = yield* setup();

      expect(state().picked).toEqual({ model: false, thinkingLevel: false });

      yield* watching(latest());
      yield* latest().say({ type: "picked", model: true, thinkingLevel: false });
      expect(state().picked).toEqual({ model: true, thinkingLevel: false });

      yield* latest().say({ type: "picked", model: false, thinkingLevel: false });
      expect(state().picked).toEqual({ model: false, thinkingLevel: false });
    }),
  );

  describe("Secret requests", () => {
    const request = { id: "12", conversationId: 1, names: ["API_KEY"], reason: "deploy" };

    it.effect("shows the requests the Session says are waiting, until it says none are", () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        expect(state().secretRequests).toEqual([]);

        yield* watching(latest());
        yield* latest().say({ type: "secret_requests", lifetimeMinutes: 15, requests: [request] });
        expect(state().secretRequests).toEqual([request]);
        expect(state().secretLifetimeMinutes).toBe(15);

        yield* latest().say({ type: "secret_requests", lifetimeMinutes: 15, requests: [] });
        expect(state().secretRequests).toEqual([]);
      }),
    );

    it.effect("sends the owner's answer, or a cancellation, for a request", () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        yield* watching(latest());
        yield* client.answerSecrets("12", { API_KEY: "value-typed-in" });
        yield* client.answerSecrets("12", null);
        yield* client.answerSecrets("12", { API_KEY: "value-typed-in" }, "all");

        expect(latest().commands().slice(-3)).toEqual([
          {
            type: "secret_answer",
            id: expect.any(String),
            request: "12",
            values: { API_KEY: "value-typed-in" },
          },
          { type: "secret_answer", id: expect.any(String), request: "12", values: null },
          {
            type: "secret_answer",
            id: expect.any(String),
            request: "12",
            values: { API_KEY: "value-typed-in" },
            keep: "all",
          },
        ]);
      }),
    );

    it.effect(
      "forgets the requests of a closed socket, as the next one says again which wait",
      () =>
        Effect.gen(function* () {
          const { latest, state } = yield* setup();

          yield* watching(latest());
          yield* latest().say({
            type: "secret_requests",
            lifetimeMinutes: 15,
            requests: [request],
          });
          yield* latest().drop();

          expect(state().secretRequests).toEqual([]);
        }),
    );
  });

  describe("Approval requests", () => {
    const request = {
      id: "7",
      conversationId: 1,
      tool: "settings_spend_limit_set",
      target: "the Settings",
      change: "Spend limit",
      before: "$5 per Session",
      after: "$25 per Session",
      reason: "The migration needs more requests",
    };

    it.effect("shows the cards the Session says are waiting, until it says none are", () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        expect(state().approvalRequests).toEqual([]);

        yield* watching(latest());
        yield* latest().say({ type: "approval_requests", requests: [request] });
        expect(state().approvalRequests).toEqual([request]);

        yield* latest().say({ type: "approval_requests", requests: [] });
        expect(state().approvalRequests).toEqual([]);
      }),
    );

    it.effect("sends Approve, and a Decline with the owner's reason only when there is one", () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        yield* watching(latest());
        yield* client.answerApproval("7", true, "ignored for an Approve");
        yield* client.answerApproval("7", false, "  Finish the cheap part first ");
        yield* client.answerApproval("7", false, "   ");

        expect(latest().commands().slice(-3)).toEqual([
          { type: "approval_answer", id: expect.any(String), request: "7", approve: true },
          {
            type: "approval_answer",
            id: expect.any(String),
            request: "7",
            approve: false,
            reason: "Finish the cheap part first",
          },
          { type: "approval_answer", id: expect.any(String), request: "7", approve: false },
        ]);
      }),
    );

    it.effect("forgets the cards of a closed socket, as the next one says again which wait", () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        yield* watching(latest());
        yield* latest().say({ type: "approval_requests", requests: [request] });
        yield* latest().drop();

        expect(state().approvalRequests).toEqual([]);
      }),
    );
  });

  describe("Browser Handoffs", () => {
    const request = {
      id: "12",
      conversationId: 1,
      instructions: "Log in, then press Done",
      deadline: 1_800_000,
    };

    it.effect("shows the handoffs the Session says are waiting until it says none are", () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        // Null until the socket lists them: none listed yet is not none waiting.
        expect(state().browserHandoffRequests).toBeNull();

        yield* watching(latest());
        yield* latest().say({ type: "browser_handoff_requests", requests: [request] });
        expect(state().browserHandoffRequests).toEqual([request]);

        yield* latest().say({ type: "browser_handoff_requests", requests: [] });
        expect(state().browserHandoffRequests).toEqual([]);
      }),
    );

    it.effect(
      "forgets the handoffs of a closed socket, as the next one says again which wait",
      () =>
        Effect.gen(function* () {
          const { latest, state } = yield* setup();

          yield* watching(latest());
          yield* latest().say({ type: "browser_handoff_requests", requests: [request] });
          yield* latest().drop();

          expect(state().browserHandoffRequests).toBeNull();
        }),
    );
  });

  it.effect("shows why a configure failed", () =>
    Effect.gen(function* () {
      const { client, latest, state } = yield* setup();

      yield* watching(latest());
      yield* client.configure({ thinkingLevel: "high" });

      const configure = latest().commands().at(-1);

      yield* latest().say({ type: "error", id: configure?.id, message: "Session is gone" });

      expect(state().failure).toBe("Session is gone");
    }),
  );

  it.effect("reports a failed command and drops the submit that failed", () =>
    Effect.gen(function* () {
      const { client, latest, state } = yield* setup();

      yield* watching(latest());
      yield* client.submit("hi", "followUp");

      const submit = latest().commands().at(-1);

      yield* latest().say({ type: "error", id: submit?.id, message: "busy" });

      expect(state().failure).toBe("busy");

      // A reconnect does not send it again.
      yield* latest().drop();
      yield* advance(60_000);
      yield* watching(latest());

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "submit"),
      ).toEqual([]);
    }),
  );

  it.effect(
    "tells whoever submitted a message how it ended (taken, or refused and why), and leaves showing it to them",
    () =>
      Effect.gen(function* () {
        const { client, latest, state } = yield* setup();
        const outcomes: Array<string | null> = [];

        yield* watching(latest());
        yield* submitTold(client, outcomes, "taken");
        yield* latest().say({
          type: "result",
          id: latest().commands().at(-1)?.id,
          result: { submissionId: "sub-1" },
        });

        yield* submitTold(client, outcomes, "too big");
        yield* latest().say({
          type: "error",
          id: latest().commands().at(-1)?.id,
          message: "Too big",
        });

        expect(outcomes).toEqual([null, "Too big"]);
        expect(state().failure).toBeNull();
      }),
  );

  it.effect("tells nobody of a submit sent again after a reconnect until it is answered", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();
      const outcomes: Array<string | null> = [];

      yield* watching(latest());
      yield* submitTold(client, outcomes, "hi");

      // A reconnect sends it again.
      yield* latest().drop();
      yield* advance(60_000);
      yield* watching(latest());
      expect(outcomes).toEqual([]);

      yield* latest().say({ type: "error", id: latest().commands().at(-1)?.id, message: "busy" });
      expect(outcomes).toEqual(["busy"]);
    }),
  );

  it.effect("ignores the heartbeat's pong and text it cannot read", () =>
    Effect.gen(function* () {
      const { latest, state } = yield* setup();

      yield* watching(latest());

      const before = state();

      yield* latest().say("pong");
      yield* latest().say("{not json");
      yield* latest().say({ type: "nope" });

      expect(state()).toBe(before);
    }),
  );

  it.effect("reconnects, after the backoff, when the Session drops the watch", () =>
    Effect.gen(function* () {
      const { sockets, latest, state } = yield* setup();

      yield* watching(latest());
      yield* latest().say({ type: "error", conversationId: 1, message: "watch ended" });

      expect(state()).toMatchObject({ status: "reconnecting", failure: "watch ended" });
      expect(sockets).toHaveLength(1);

      yield* advance(500);

      expect(sockets).toHaveLength(2);

      yield* watching(latest());

      expect(state().status).toBe("live");
    }),
  );

  it.effect(
    "reconnects, after the backoff, when the Session refuses the watch, and shows why",
    () =>
      Effect.gen(function* () {
        const { sockets, latest, state } = yield* setup();

        yield* latest().open();
        yield* latest().say({ type: "hello", root: 1 });

        const watch = latest().commands().at(-1);

        yield* latest().say({ type: "error", id: watch?.id, message: "no such conversation" });

        expect(state()).toMatchObject({
          status: "reconnecting",
          failure: "no such conversation",
        });
        expect(sockets).toHaveLength(1);

        yield* advance(500);

        expect(sockets).toHaveLength(2);
      }),
  );

  it.effect(
    "keeps backing off while watches fail, as a hello alone does not start the delay over",
    () =>
      Effect.gen(function* () {
        const { sockets, latest } = yield* setup();

        const refuse = Effect.gen(function* () {
          yield* latest().open();
          yield* latest().say({ type: "hello", root: 1 });
          yield* latest().say({
            type: "error",
            id: latest().commands().at(-1)?.id,
            message: "no",
          });
        });

        yield* refuse;
        yield* advance(500);

        expect(sockets).toHaveLength(2);

        yield* refuse;
        yield* advance(999);

        expect(sockets).toHaveLength(2);

        yield* advance(1);

        expect(sockets).toHaveLength(3);
      }),
  );

  describe("reconnecting", () => {
    it.effect(
      "opens a new socket after the old one closes, keeping the view until a fresh snapshot replaces it",
      () =>
        Effect.gen(function* () {
          const { sockets, latest, state } = yield* setup();

          yield* watching(latest(), { entries: [entry(1, "kept")] });
          yield* latest().drop();

          expect(state().status).toBe("reconnecting");
          expect(state().view.messages).toHaveLength(1);
          expect(sockets).toHaveLength(1);

          yield* advance(60_000);

          expect(sockets).toHaveLength(2);

          yield* watching(latest(), { entries: [entry(1, "kept"), entry(2, "while away")] });

          expect(state().status).toBe("live");
          expect(state().view.messages).toHaveLength(2);
        }),
    );

    it.effect("backs off between attempts, and starts over once connected", () =>
      Effect.gen(function* () {
        const { sockets, latest } = yield* setup();

        yield* latest().drop();
        yield* advance(499);

        expect(sockets).toHaveLength(1);

        yield* advance(1);

        expect(sockets).toHaveLength(2);

        yield* latest().drop();
        yield* advance(999);

        expect(sockets).toHaveLength(2);

        yield* advance(1);

        expect(sockets).toHaveLength(3);

        yield* watching(latest());
        yield* latest().drop();
        yield* advance(500);

        expect(sockets).toHaveLength(4);
      }),
    );

    it.effect(
      "stops reconnecting once the probe shows the sign-in has lapsed, and keeps the view",
      () =>
        Effect.gen(function* () {
          const probe = vi.fn((_socketUrl: string) => Effect.succeed<Reachability>("signed-out"));
          const { sockets, latest, state } = yield* setup(probe);

          yield* watching(latest(), { entries: [entry(1, "kept")] });
          yield* latest().drop();
          yield* advance(500);

          expect(probe).not.toHaveBeenCalled();

          yield* latest().drop();
          yield* advance(60_000);

          expect(probe).toHaveBeenCalledWith("wss://example.test/sessions/s1/socket");
          expect(sockets).toHaveLength(2);
          expect(state().status).toBe("signed-out");
          expect(state().view.messages).toHaveLength(1);
        }),
    );

    it.effect("stops reconnecting once the probe shows the Session does not exist", () =>
      Effect.gen(function* () {
        const { sockets, latest, state } = yield* setup(() => Effect.succeed("missing"));

        yield* latest().drop();
        yield* advance(500);
        yield* latest().drop();
        yield* advance(60_000);

        expect(sockets).toHaveLength(2);
        expect(state().status).toBe("missing");
      }),
    );

    it.effect(
      "stops at once, without a probe, when the Session closes the socket because it was deleted",
      () =>
        Effect.gen(function* () {
          let probes = 0;

          const { sockets, latest, state } = yield* setup(() =>
            Effect.sync(() => {
              probes += 1;

              return "reachable" as const;
            }),
          );

          yield* latest().drop(SESSION_DELETED_CLOSE_CODE);
          yield* advance(60_000);

          expect(sockets).toHaveLength(1);
          expect(probes).toBe(0);
          expect(state().status).toBe("deleted");
        }),
    );

    it.effect("keeps reconnecting while the probe finds the Session reachable", () =>
      Effect.gen(function* () {
        const probe = vi.fn((_socketUrl: string) => Effect.succeed<Reachability>("reachable"));
        const { sockets, latest, state } = yield* setup(probe);

        yield* latest().drop();
        yield* advance(500);
        yield* latest().drop();
        yield* advance(1_000);

        expect(sockets).toHaveLength(3);
        expect(state().status).toBe("reconnecting");
      }),
    );

    it.effect("does not reconnect from a probe that answers after dispose", () =>
      Effect.gen(function* () {
        const { sockets, latest, state, dispose } = yield* setup();

        yield* latest().drop();
        yield* advance(500);
        yield* latest().drop();
        yield* dispose;
        yield* advance(60_000);

        expect(sockets).toHaveLength(2);
        expect(state().status).toBe("closed");
      }),
    );

    it.effect("lists a submit held while disconnected as sending, until it is answered", () =>
      Effect.gen(function* () {
        const { client, latest, state } = yield* setup();

        yield* watching(latest());
        yield* latest().drop();
        yield* client.submit("offline", "followUp");

        expect(state().sending).toEqual([{ id: expect.any(String), text: "offline" }]);

        yield* advance(500);
        yield* watching(latest());

        const submit = latest()
          .commands()
          .find((command) => command.type === "submit");

        expect(state().sending).toHaveLength(1);

        yield* latest().say({ type: "result", id: submit?.id, result: { submissionId: "s" } });

        expect(state().sending).toEqual([]);
      }),
    );

    it.effect(
      "sends a submit again, with the same requestId, when the socket closed before its answer",
      () =>
        Effect.gen(function* () {
          const { client, latest } = yield* setup();

          yield* watching(latest());
          yield* client.submit("hi", "followUp");

          const first = latest().commands().at(-1);

          yield* latest().drop();
          yield* advance(60_000);
          yield* watching(latest());

          const again = latest()
            .commands()
            .filter((command) => command.type === "submit");

          expect(again).toHaveLength(1);
          expect(again[0]).toMatchObject({ input: "hi", requestId: first?.requestId });
        }),
    );

    it.effect("does not send an answered submit again", () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        yield* watching(latest());
        yield* client.submit("hi", "followUp");

        const submit = latest().commands().at(-1);

        yield* latest().say({ type: "result", id: submit?.id, result: { submissionId: "s" } });
        yield* latest().drop();
        yield* advance(60_000);
        yield* watching(latest());

        expect(
          latest()
            .commands()
            .filter((command) => command.type === "submit"),
        ).toEqual([]);
      }),
    );

    it.effect("holds a submit made while disconnected until it is watching again", () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        yield* watching(latest());
        yield* latest().drop();
        yield* client.submit("offline", "followUp");
        yield* advance(60_000);

        expect(latest().commands()).toEqual([]);

        yield* watching(latest());

        expect(
          latest()
            .commands()
            .filter((command) => command.type === "submit"),
        ).toHaveLength(1);
      }),
    );
  });

  describe("the queue", () => {
    it.effect("keeps the same lanes while the inbox and the remembered texts do not change", () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        yield* watching(latest(), { inbox: [{ id: "a", mode: "followUp" }] });

        const before = state().queue;

        expect(before.followUp).toHaveLength(1);

        yield* latest().say({ type: "result", id: "unknown", result: null });
        yield* latest().say({ type: "error", message: "unrelated" });

        expect(state().queue).toBe(before);

        yield* latest().say({ type: "events", conversationId: 1, events: [] });

        expect(state().queue).toBe(before);
      }),
    );
  });

  describe("the heartbeat", () => {
    it.effect("sends ping at an interval while open", () =>
      Effect.gen(function* () {
        const { latest } = yield* setup();

        yield* watching(latest());
        yield* advance(HEARTBEAT_INTERVAL_MS);

        expect(latest().sent.filter((text) => text === "ping")).toHaveLength(1);
      }),
    );

    it.effect("keeps the socket while pongs come, and replaces it when one does not", () =>
      Effect.gen(function* () {
        const { sockets, latest } = yield* setup();

        yield* watching(latest());
        yield* advance(HEARTBEAT_INTERVAL_MS);
        yield* latest().say("pong");
        yield* advance(PONG_TIMEOUT_MS + 1);

        expect(sockets).toHaveLength(1);

        yield* advance(HEARTBEAT_INTERVAL_MS);
        yield* advance(PONG_TIMEOUT_MS + 1);

        const dead = sockets[0]!;

        expect(dead.closed).toBe(true);

        yield* advance(60_000);

        expect(sockets).toHaveLength(2);
      }),
    );

    it.effect("ignores what a replaced socket still says", () =>
      Effect.gen(function* () {
        const { sockets, latest, state } = yield* setup();

        yield* watching(latest());
        yield* advance(HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS + 1);
        yield* advance(60_000);

        yield* sockets[0]!.say(snapshot({ entries: [entry(9, "stale")] }));

        expect(state().view.messages).toEqual([]);
      }),
    );
  });

  it.effect("closes its socket when disposed, and does not reconnect", () =>
    Effect.gen(function* () {
      const { sockets, latest, state, dispose } = yield* setup();

      yield* watching(latest());
      yield* dispose;

      expect(latest().closed).toBe(true);

      yield* latest().drop();
      yield* advance(60_000);

      expect(sockets).toHaveLength(1);
      expect(state().status).toBe("closed");
    }),
  );
});

/** Answer the watch of conversation `id`, and say its snapshot, as a Session does. */
const watchingThread = (
  socket: FakeSocket,
  id: number,
  extra: { readonly [key: string]: Value } = {},
) =>
  Effect.gen(function* () {
    const watch = socket
      .commands()
      .find((command) => command.type === "watch" && command.conversationId === id);

    yield* socket.say({ type: "result", id: watch?.id, result: null });
    yield* socket.say({ ...snapshot(extra), conversationId: id });
  });

const threadEntry = (conversationId: number, id: number, text: string) => ({
  ...entry(id, text),
  conversationId,
});

describe("a subagent's thread on a Session connection", () => {
  it.effect(
    "is watched on its own conversation, kept apart from the root's view, and dropped when released",
    () =>
      Effect.gen(function* () {
        const { client, latest, state } = yield* setup();

        yield* watching(latest(), { entries: [entry(1, "root text")] });

        const thread = yield* openThread(client, 2);

        expect(latest().commands().at(-1)).toEqual({
          type: "watch",
          id: expect.any(String),
          conversationId: 2,
        });
        expect(state().threads[2]).toMatchObject({ status: "loading", view: EMPTY_VIEW });

        yield* watchingThread(latest(), 2, { entries: [threadEntry(2, 5, "child text")] });

        const now = state();

        expect(now.threads[2]?.status).toBe("live");
        expect(now.threads[2]?.view.messages.map((message) => message.parts)).toEqual([
          [{ type: "text", text: "child text" }],
        ]);
        expect(now.view.messages.map((message) => message.parts)).toEqual([
          [{ type: "text", text: "root text" }],
        ]);

        yield* latest().say({
          type: "events",
          conversationId: 2,
          events: [{ type: "run_start", inputs: [5] }],
        });

        expect(state().threads[2]?.view.running).toBe(true);
        expect(state().view.running).toBe(false);

        yield* release(thread);

        expect(latest().commands().at(-1)).toEqual({
          type: "unwatch",
          id: expect.any(String),
          conversationId: 2,
        });
        expect(state().threads[2]).toBeUndefined();
      }),
  );

  it.effect("is watched once however many cards open it, and unwatched with the last", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());

      const first = yield* openThread(client, 2);
      const second = yield* openThread(client, 2);

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "watch"),
      ).toHaveLength(2);

      yield* release(first);
      yield* release(first);
      expect(
        latest()
          .commands()
          .filter((command) => command.type === "unwatch"),
      ).toHaveLength(0);
      yield* release(second);
      expect(
        latest()
          .commands()
          .filter((command) => command.type === "unwatch"),
      ).toHaveLength(1);
    }),
  );

  it.effect(
    "is watched again, from a fresh snapshot, when the Session says hello on a new socket",
    () =>
      Effect.gen(function* () {
        const { client, sockets, latest, state } = yield* setup();

        yield* watching(latest());
        yield* watchThread(client, 2);
        yield* watchingThread(latest(), 2, { entries: [threadEntry(2, 5, "child text")] });
        yield* latest().drop();
        yield* advance(1_000);

        const reconnected = sockets[1]!;

        yield* reconnected.open();
        yield* reconnected.say({ type: "hello", root: 1 });

        expect(reconnected.commands()).toEqual([
          { type: "watch", id: expect.any(String), conversationId: 1 },
          { type: "watch", id: expect.any(String), conversationId: 2 },
        ]);
        // The last view stays until the snapshot replaces it.
        expect(state().threads[2]?.view.messages).toHaveLength(1);
      }),
  );

  it.effect(
    "takes the owner's input once its watch is answered, with the conversation it is for",
    () =>
      Effect.gen(function* () {
        const { client, latest, state } = yield* setup();

        yield* watching(latest());
        yield* watchThread(client, 2);
        yield* client.submit("take a look", "steer", 2);

        expect(
          latest()
            .commands()
            .some((command) => command.type === "submit"),
        ).toBe(false);
        expect(state().threads[2]?.sending).toEqual([
          { id: expect.any(String), text: "take a look" },
        ]);
        expect(state().sending).toEqual([]);

        yield* watchingThread(latest(), 2);

        expect(
          latest()
            .commands()
            .filter((command) => command.type === "submit"),
        ).toEqual([
          {
            type: "submit",
            id: expect.any(String),
            conversationId: 2,
            input: "take a look",
            whenBusy: "steer",
            requestId: expect.any(String),
          },
        ]);
      }),
  );

  it.effect("lists the thread's queued input by lane, with the text it sent", () =>
    Effect.gen(function* () {
      const { client, latest, state } = yield* setup();

      yield* watching(latest());
      yield* watchThread(client, 2);
      yield* watchingThread(latest(), 2);
      yield* client.submit("later", "followUp", 2);

      const submit = latest()
        .commands()
        .find((command) => command.type === "submit");

      yield* latest().say({ type: "result", id: submit?.id, result: { submissionId: 9 } });
      yield* latest().say({
        type: "events",
        conversationId: 2,
        events: [{ type: "inbox_update", items: [{ id: 9, mode: "followUp" }] }],
      });

      expect(state().threads[2]?.queue.followUp).toEqual([{ id: "9", text: "later" }]);
      expect(state().queue.followUp).toEqual([]);
    }),
  );

  it.effect("shows a refused watch on the thread alone, and does not reconnect", () =>
    Effect.gen(function* () {
      const { client, sockets, latest, state } = yield* setup();

      yield* watching(latest());
      yield* watchThread(client, 2);

      const watch = latest()
        .commands()
        .find((command) => command.conversationId === 2);

      yield* latest().say({ type: "error", id: watch?.id, message: "No such conversation" });
      yield* advance(5_000);

      expect(state().threads[2]).toMatchObject({
        status: "failed",
        failure: "No such conversation",
      });
      expect(state()).toMatchObject({ status: "live", failure: null });
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("shows a refused submit on the thread alone", () =>
    Effect.gen(function* () {
      const { client, latest, state } = yield* setup();

      yield* watching(latest());
      yield* watchThread(client, 2);
      yield* watchingThread(latest(), 2);
      yield* client.submit("hello", "steer", 2);

      const submit = latest()
        .commands()
        .find((command) => command.type === "submit");

      yield* latest().say({ type: "error", id: submit?.id, message: "Not a subagent" });

      expect(state().threads[2]).toMatchObject({
        failure: "Not a subagent",
        sending: [],
      });
      expect(state().failure).toBeNull();
    }),
  );

  it.effect("aborts the root, or a subagent, with or without the agents below it", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());
      yield* client.abort();
      yield* client.abort({ conversationId: 2 });
      yield* client.abort({ subagents: true });
      yield* client.abort({ conversationId: 2, subagents: true });

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "abort"),
      ).toEqual([
        { type: "abort", id: expect.any(String) },
        { type: "abort", id: expect.any(String), conversationId: 2 },
        { type: "abort", id: expect.any(String), subagents: true },
        { type: "abort", id: expect.any(String), conversationId: 2, subagents: true },
      ]);
    }),
  );
});

describe("the task graph on a Session connection", () => {
  const summary = {
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
  } as const;

  it.effect("is watched once asked, and again after a reconnect, and keeps the last summary", () =>
    Effect.gen(function* () {
      const { client, sockets, latest, state } = yield* setup();

      yield* client.watchTaskGraph;
      yield* watching(latest());
      yield* client.watchTaskGraph;

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "watch_task_graph"),
      ).toEqual([{ type: "watch_task_graph", id: expect.any(String) }]);
      expect(state().taskGraph).toBeNull();

      yield* latest().say(summary);

      expect(state().taskGraph?.agents).toMatchObject([{ id: "agent-1", status: "working" }]);

      yield* latest().drop();
      expect(state().taskGraph?.agents).toHaveLength(1);
      yield* advance(1_000);
      yield* sockets[1]!.open();
      yield* sockets[1]!.say({ type: "hello", root: 1 });

      expect(
        sockets[1]!.commands().filter((command) => command.type === "watch_task_graph"),
      ).toHaveLength(1);
    }),
  );
});

describe("the usage on a Session connection", () => {
  const usage = {
    type: "usage",
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 5,
    totalTokens: 125,
    cost: 0.5,
    limit: 2,
  } as const;

  it.effect("is watched once asked, and again after a reconnect, and keeps the last message", () =>
    Effect.gen(function* () {
      const { client, sockets, latest, state } = yield* setup();

      yield* client.watchUsage;
      yield* watching(latest());
      yield* client.watchUsage;

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "watch_usage"),
      ).toEqual([{ type: "watch_usage", id: expect.any(String) }]);
      expect(state().usage).toBeNull();

      yield* latest().say(usage);
      expect(state().usage).toEqual({
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 5,
        totalTokens: 125,
        cost: 0.5,
        limit: 2,
      });

      yield* latest().say({ ...usage, cost: 0.75 });
      expect(state().usage?.cost).toBe(0.75);

      yield* latest().drop();
      expect(state().usage?.cost).toBe(0.75);
      yield* advance(1_000);
      yield* sockets[1]!.open();
      yield* sockets[1]!.say({ type: "hello", root: 1 });

      expect(
        sockets[1]!.commands().filter((command) => command.type === "watch_usage"),
      ).toHaveLength(1);
    }),
  );
});

describe("Todo Lists on a Session connection", () => {
  const tasks = (...titles: string[]) =>
    titles.map((title, index) => ({ id: index + 1, title, status: "pending" }));

  it.effect("keeps the root's list as the Session sends it, each list replacing the last", () =>
    Effect.gen(function* () {
      const { latest, state } = yield* setup();

      expect(state().todos).toEqual([]);

      yield* watching(latest());
      yield* latest().say({ type: "todos", conversationId: 1, tasks: tasks("Write it") });
      expect(state().todos).toEqual(tasks("Write it"));

      yield* latest().say({
        type: "todos",
        conversationId: 1,
        tasks: [{ id: 1, title: "Write it", description: "Soon", status: "completed" }],
      });
      expect(state().todos).toEqual([
        { id: 1, title: "Write it", description: "Soon", status: "completed" },
      ]);
    }),
  );

  it.effect("keeps the last list while reconnecting, until the new socket sends one", () =>
    Effect.gen(function* () {
      const { sockets, latest, state } = yield* setup();

      yield* watching(latest());
      yield* latest().say({ type: "todos", conversationId: 1, tasks: tasks("Write it") });
      yield* latest().drop();
      expect(state().todos).toEqual(tasks("Write it"));

      yield* advance(1_000);
      yield* watching(sockets[1]!);
      yield* sockets[1]!.say({ type: "todos", conversationId: 1, tasks: [] });

      expect(state().todos).toEqual([]);
    }),
  );

  it.effect("keeps a subagent thread's list on the thread, apart from the root's", () =>
    Effect.gen(function* () {
      const { client, latest, state } = yield* setup();

      yield* watching(latest());
      yield* watchThread(client, 2);
      yield* watchingThread(latest(), 2);
      yield* latest().say({ type: "todos", conversationId: 2, tasks: tasks("Child task") });
      yield* latest().say({ type: "todos", conversationId: 1, tasks: tasks("Root task") });

      expect(state().threads["2"]?.todos).toEqual(tasks("Child task"));
      expect(state().todos).toEqual(tasks("Root task"));
    }),
  );
});

describe("the catalog and Slash commands", () => {
  const CATALOG = {
    commands: [{ name: "export", description: "Export", argument: "none" }],
    templates: [{ name: "review", description: "Review", argumentHint: "<ref>" }],
    skills: [{ name: "deploy", description: "Deploy" }],
  };

  it.effect("asks for a conversation's catalog and resolves with the answer", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());
      yield* watchThread(client, 2);
      yield* watchingThread(latest(), 2);

      const root = yield* asking(client.catalog());
      const child = yield* asking(client.catalog(2));

      const [rootAsk, childAsk] = latest()
        .commands()
        .filter((command) => command.type === "catalog");

      expect(rootAsk).toEqual({ type: "catalog", id: rootAsk?.id });
      expect(childAsk).toMatchObject({ type: "catalog", conversationId: 2 });

      yield* latest().say({ type: "result", id: rootAsk?.id, result: CATALOG });
      yield* latest().say({ type: "result", id: childAsk?.id, result: { ...CATALOG, skills: [] } });

      expect(yield* Fiber.join(root)).toEqual(CATALOG);
      expect(yield* Fiber.join(child)).toEqual({ ...CATALOG, skills: [] });
    }),
  );

  it.effect("asks for the files that match a query in a conversation's directory", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());
      yield* watchThread(client, 2);
      yield* watchingThread(latest(), 2);

      const root = yield* asking(client.files("src/"));
      const child = yield* asking(client.files("", 2));

      const [rootAsk, childAsk] = latest()
        .commands()
        .filter((command) => command.type === "files");

      expect(rootAsk).toEqual({ type: "files", id: rootAsk?.id, query: "src/" });
      expect(childAsk).toEqual({ type: "files", id: childAsk?.id, query: "", conversationId: 2 });

      yield* latest().say({
        type: "result",
        id: rootAsk?.id,
        result: { paths: ["src/", "src/app.ts"] },
      });
      yield* latest().say({ type: "result", id: childAsk?.id, result: { nope: true } });

      expect(yield* Fiber.join(root)).toEqual({ paths: ["src/", "src/app.ts"] });
      expect(yield* failureOf(child)).toBe("The session's answer could not be read.");
    }),
  );

  it.effect(
    "mints Live View links for a Browser Handoff, and says why when the handoff is over",
    () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        yield* watching(latest());

        const LINKS = {
          tab: { targetId: "T1", link: "wss://live.example/T1?jwt=a" },
          windows: [
            {
              targetId: "W1",
              openerId: "T1",
              title: "Sign in",
              link: "wss://live.example/W1?jwt=b",
            },
          ],
        };

        const minted = yield* asking(client.liveView("call-1"));
        const over = yield* asking(client.liveView("call-2"));

        const [first, second] = latest()
          .commands()
          .filter((command) => command.type === "live_view");

        expect(first).toEqual({ type: "live_view", id: first?.id, requestId: "call-1" });
        expect(second).toEqual({ type: "live_view", id: second?.id, requestId: "call-2" });

        yield* latest().say({ type: "result", id: first?.id, result: LINKS });
        yield* latest().say({ type: "error", id: second?.id, message: "the handoff is over" });

        expect(yield* Fiber.join(minted)).toEqual(LINKS);
        expect(yield* failureOf(over)).toBe("the handoff is over");
      }),
  );

  it.effect(
    "mints Live View links for the Browser Pane's Owner tab, opening it or not, and says why when it is gone",
    () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        yield* watching(latest());

        const LINKS = {
          ownerTabId: "owner-1",
          tab: { targetId: "T1", link: "wss://live.example/T1?jwt=a" },
          windows: [],
          opened: true,
          replaced: false,
        };

        const opened = yield* asking(client.ownerTabView(true));
        const gone = yield* asking(client.ownerTabView(false));

        const [first, second] = latest()
          .commands()
          .filter((command) => command.type === "owner_tab_view");

        expect(first).toEqual({ type: "owner_tab_view", id: first?.id, open: true });
        expect(second).toEqual({ type: "owner_tab_view", id: second?.id, open: false });

        yield* latest().say({ type: "result", id: first?.id, result: LINKS });
        yield* latest().say({ type: "error", id: second?.id, message: "the Owner tab is gone" });

        expect(yield* Fiber.join(opened)).toEqual(LINKS);
        expect(yield* failureOf(gone)).toBe("the Owner tab is gone");
      }),
  );

  const OWNER_TAB_COMMANDS = new Set<unknown>([
    "owner_tab_list",
    "owner_tab_open",
    "owner_tab_show",
    "owner_tab_close",
  ]);

  it.effect(
    "lists, opens, shows and closes the Browser Pane's Owner tabs, and keeps the tabs it is told of",
    () =>
      Effect.gen(function* () {
        const { client, latest, state } = yield* setup();

        yield* watching(latest());

        expect(state().ownerTabs).toBeNull();

        const listed = yield* asking(client.ownerTabs(false));
        const heartbeat = yield* asking(client.ownerTabs(true));
        const opened = yield* asking(client.openOwnerTab);
        const shown = yield* asking(client.showOwnerTab("a"));
        const closed = yield* asking(client.closeOwnerTab("b"));

        const [list, beat, open, show, close] = latest()
          .commands()
          .filter((command) => OWNER_TAB_COMMANDS.has(command.type));

        expect(list).toEqual({ type: "owner_tab_list", id: list?.id });
        // In view, the same listing says so: it is the Pane's heartbeat, with no second command.
        expect(beat).toEqual({ type: "owner_tab_list", id: beat?.id, watching: true });
        expect(open).toEqual({ type: "owner_tab_open", id: open?.id });
        expect(show).toEqual({ type: "owner_tab_show", id: show?.id, ownerTabId: "a" });
        expect(close).toEqual({ type: "owner_tab_close", id: close?.id, ownerTabId: "b" });

        const one = { tabs: [{ id: "a", title: "Docs" }], shown: "a" };

        yield* latest().say({ type: "result", id: list?.id, result: one });
        expect(yield* Fiber.join(listed)).toEqual(one);
        expect(state().ownerTabs).toEqual(one);

        yield* latest().say({ type: "result", id: beat?.id, result: one });
        expect(yield* Fiber.join(heartbeat)).toEqual(one);

        // Another device opened a tab: the Session sends every client the tabs.
        const two = {
          tabs: [
            { id: "a", title: "Docs" },
            { id: "b", title: "" },
          ],
          shown: "b",
        };

        yield* latest().say({ type: "owner_tabs", ...two });
        expect(state().ownerTabs).toEqual(two);

        yield* latest().say({ type: "result", id: open?.id, result: two });
        yield* latest().say({ type: "result", id: show?.id, result: { ...two, shown: "a" } });
        yield* latest().say({ type: "error", id: close?.id, message: "boom" });

        expect(yield* Fiber.join(opened)).toEqual(two);
        expect((yield* Fiber.join(shown)).shown).toBe("a");
        expect(yield* failureOf(closed)).toBe("boom");
        expect(state().ownerTabs?.shown).toBe("a");
      }),
  );

  it.effect(
    "loads a page of earlier History into the view of the conversation it was asked for",
    () =>
      Effect.gen(function* () {
        const { client, latest, state } = yield* setup();

        const reset = (conversationId: number, id: number) => ({
          ...threadEntry(conversationId, id, "handoff"),
          kind: "pi.reset",
          head: id,
        });

        yield* watching(latest(), { entries: [reset(1, 5), entry(6, "new")] });
        yield* watchThread(client, 2);
        yield* watchingThread(latest(), 2, { entries: [reset(2, 9)] });

        expect(state().view.before).toBe(5);

        const root = yield* asking(client.loadEarlier(5));
        const child = yield* asking(client.loadEarlier(9, 2));

        const [rootAsk, childAsk] = latest()
          .commands()
          .filter((command) => command.type === "history");

        expect(rootAsk).toEqual({ type: "history", id: rootAsk?.id, before: 5 });
        expect(childAsk).toEqual({
          type: "history",
          id: childAsk?.id,
          before: 9,
          conversationId: 2,
        });

        yield* latest().say({
          type: "result",
          id: rootAsk?.id,
          result: { entries: [entry(3, "old")], before: 3 },
        });
        yield* latest().say({
          type: "result",
          id: childAsk?.id,
          result: { entries: [threadEntry(2, 8, "child")], before: null },
        });
        yield* Fiber.join(root);
        yield* Fiber.join(child);

        expect(state().view.earlier.map((message) => message.id)).toEqual(["3"]);
        expect(state().view.before).toBe(3);
        expect(state().threads["2"]?.view.earlier.map((message) => message.id)).toEqual(["8"]);
        expect(state().threads["2"]?.view.before).toBeNull();
      }),
  );

  it.effect("runs a command and resolves with what it did, or rejects with why it could not", () =>
    Effect.gen(function* () {
      const { client, latest, state } = yield* setup();

      yield* watching(latest());

      const done = yield* asking(client.command("compact", "the API"));
      const refused = yield* asking(client.command("todo", ""));

      const [first, second] = latest()
        .commands()
        .filter((command) => command.type === "command");

      expect(first).toEqual({ type: "command", id: first?.id, name: "compact", args: "the API" });

      yield* latest().say({
        type: "result",
        id: first?.id,
        result: { notice: "Compacting the context." },
      });
      yield* latest().say({ type: "error", id: second?.id, message: "/todo takes clear." });

      expect(yield* Fiber.join(done)).toEqual({ notice: "Compacting the context." });
      expect(yield* failureOf(refused)).toBe("/todo takes clear.");
      // A command's failure is the composer's to show, not the Session's.
      expect(state().failure).toBeNull();
    }),
  );

  it.effect(
    "rejects a request made while disconnected, and one the socket's close leaves unanswered",
    () =>
      Effect.gen(function* () {
        const { client, latest } = yield* setup();

        expect((yield* Effect.flip(client.command("export", ""))).message).toMatch(/not connected/);

        yield* watching(latest());

        const waiting = yield* asking(client.catalog());
        const running = yield* asking(client.command("todo", "clear"));

        yield* latest().drop();

        expect(yield* failureOf(waiting)).toBe(
          "The connection was lost; try again once it is back.",
        );
        // A command may have reached the Session before the socket went.
        expect(yield* failureOf(running)).toMatch(/the command may have run/);
      }),
  );
});

describe("a Session's tree", () => {
  it.effect(
    "follows the active branch: the branch left is unwatched, and the new one watched",
    () =>
      Effect.gen(function* () {
        const { latest, state } = yield* setup();

        yield* watching(latest());

        expect(state()).toMatchObject({ activeBranch: 1, treeVersion: 0, copying: false });

        latest().sent.length = 0;
        yield* latest().say({ type: "active_branch", conversationId: 7 });

        const [unwatch, watch] = latest().commands();

        expect(unwatch).toMatchObject({ type: "unwatch", conversationId: 1 });
        expect(watch).toMatchObject({ type: "watch", conversationId: 7 });
        expect(state()).toMatchObject({ activeBranch: 7, treeVersion: 1 });

        // The new branch's events are the root view's; the old one's are not.
        yield* latest().say({ type: "result", id: watch?.id, result: null });
        yield* latest().say({ ...snapshot({ entries: [entry(3, "other")] }), conversationId: 7 });
        yield* latest().say({ ...snapshot({ entries: [entry(2, "old")] }), conversationId: 1 });

        expect(state().view.messages.map((message) => message.id)).toEqual(["3"]);

        // A branch made that is the active one already only makes the tree stale.
        latest().sent.length = 0;
        yield* latest().say({ type: "active_branch", conversationId: 7 });

        expect(latest().commands()).toEqual([]);
        expect(state().treeVersion).toBe(2);
      }),
  );

  it.effect("says when the Session is still being copied, as its hello does", () =>
    Effect.gen(function* () {
      const { latest, state } = yield* setup();

      yield* latest().open();
      yield* latest().say({ type: "hello", root: 1, copying: true });

      expect(state().copying).toBe(true);
    }),
  );

  it.effect("asks for the tree, navigates and switches branches, with the Session's answers", () =>
    Effect.gen(function* () {
      const { client, latest } = yield* setup();

      yield* watching(latest());
      latest().sent.length = 0;

      const tree = yield* asking(client.tree);

      const went = yield* asking(
        client.navigate({ entryId: 4, position: "before" }, { instructions: "tests" }),
      );

      const switched = yield* asking(client.switchBranch(9));
      const [asked, navigate, switching] = latest().commands();

      expect(asked).toEqual({ type: "tree", id: asked?.id });
      expect(navigate).toEqual({
        type: "navigate",
        id: navigate?.id,
        entryId: 4,
        position: "before",
        summary: { instructions: "tests" },
      });
      expect(switching).toEqual({ type: "switch_branch", id: switching?.id, conversationId: 9 });

      const answer = { nodes: [], active: 1, leaf: null, branches: [] };

      yield* latest().say({ type: "result", id: asked?.id, result: answer });
      yield* latest().say({
        type: "result",
        id: navigate?.id,
        result: { conversationId: 5, text: "second" },
      });
      yield* latest().say({ type: "error", id: switching?.id, message: "A Run is in progress" });

      expect(yield* Fiber.join(tree)).toEqual(answer);
      expect(yield* Fiber.join(went)).toEqual({ conversationId: 5, text: "second" });
      expect(yield* failureOf(switched)).toBe("A Run is in progress");
    }),
  );
});
