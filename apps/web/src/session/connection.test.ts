// @effect-diagnostics asyncFunction:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { EMPTY_VIEW, SESSION_DELETED_CLOSE_CODE } from "@cloudpid/protocol";
import * as Predicate from "effect/Predicate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  SessionConnection,
  type SessionProbe,
  type SessionSocket,
} from "./connection.ts";

type Value =
  | undefined
  | string
  | number
  | boolean
  | null
  | readonly Value[]
  | { readonly [key: string]: Value };

/** What the Session says: a message, or the heartbeat's text. */
type Said = string | { readonly [key: string]: Value };

/** A socket the test drives by hand: what the client sent, and what the Session says. */
class FakeSocket implements SessionSocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.(new Event("open"));
  }

  say(message: Said) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: Predicate.isString(message) ? message : JSON.stringify(message),
      }),
    );
  }

  /** The commands sent so far, without heartbeats. */
  commands(): Array<{ readonly [key: string]: Value }> {
    return this.sent.filter((text) => text !== "ping").map((text) => JSON.parse(text));
  }

  /** The network drops the socket, or the Session closes it with `code`. */
  drop(code?: number) {
    this.onclose?.(new CloseEvent("close", code === undefined ? {} : { code }));
  }
}

const setup = (probe: SessionProbe = () => Promise.resolve("reachable")) => {
  const sockets: FakeSocket[] = [];

  const connection = new SessionConnection(
    "wss://example.test/sessions/s1/socket",
    (url) => {
      const socket = new FakeSocket(url);

      sockets.push(socket);

      return socket;
    },
    probe,
  );

  return { connection, sockets, latest: () => sockets[sockets.length - 1]! };
};

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
const watching = (socket: FakeSocket, extra: { readonly [key: string]: Value } = {}) => {
  socket.open();
  socket.say({ type: "hello", root: 1 });

  const watch = socket.commands().find((command) => command.type === "watch");

  socket.say({ type: "result", id: watch?.id, result: null });
  socket.say(snapshot(extra));
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a Session connection", () => {
  it("connects, watches the root conversation named by hello, and is live once the snapshot lands", () => {
    const { connection, latest } = setup();

    expect(latest().url).toBe("wss://example.test/sessions/s1/socket");
    expect(connection.getState()).toMatchObject({ status: "connecting", view: EMPTY_VIEW });

    latest().open();

    expect(latest().sent).toEqual([]);

    latest().say({ type: "hello", root: 7 });

    expect(latest().commands()).toEqual([
      { type: "watch", id: expect.any(String), conversationId: 7 },
    ]);
    expect(connection.getState().status).toBe("connecting");

    latest().say({ ...snapshot(), conversationId: 7 });

    expect(connection.getState().status).toBe("live");
  });

  it("folds event batches into the view, a snapshot first", () => {
    const { connection, latest } = setup();

    watching(latest(), { entries: [entry(1, "hello")] });

    expect(connection.getState().view.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "hello" }],
    ]);

    latest().say({
      type: "events",
      conversationId: 1,
      events: [
        { type: "run_start", inputs: [2] },
        { type: "entry_appended", entry: entry(2, "more") },
      ],
    });

    expect(connection.getState().view).toMatchObject({ running: true });
    expect(connection.getState().view.messages).toHaveLength(2);
  });

  it("notifies subscribers of each change, until they unsubscribe", () => {
    const { connection, latest } = setup();
    const listener = vi.fn();
    const unsubscribe = connection.subscribe(listener);

    latest().open();
    latest().say({ type: "hello", root: 1 });
    latest().say(snapshot());

    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    unsubscribe();
    latest().say({
      type: "events",
      conversationId: 1,
      events: [{ type: "run_start", inputs: [1] }],
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("holds a submit until the watch is answered, so run_start is not missed, then sends it with a requestId", () => {
    const { connection, latest } = setup();

    latest().open();
    latest().say({ type: "hello", root: 1 });
    connection.submit("hi", "followUp");

    expect(
      latest()
        .commands()
        .map((command) => command.type),
    ).toEqual(["watch"]);

    const watch = latest().commands()[0];

    latest().say({ type: "result", id: watch?.id, result: null });

    expect(latest().commands()[1]).toEqual({
      type: "submit",
      id: expect.any(String),
      input: "hi",
      whenBusy: "followUp",
      requestId: expect.any(String),
    });
  });

  it("sends a steer with whenBusy steer", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.submit("change course", "steer");

    expect(latest().commands().at(-1)).toMatchObject({
      type: "submit",
      input: "change course",
      whenBusy: "steer",
    });
  });

  it("remembers the text of an answered submit by its submission ID, for the queue", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.submit("later", "followUp");

    const submit = latest().commands().at(-1);

    latest().say({ type: "result", id: submit?.id, result: { submissionId: "sub-1" } });
    latest().say({
      type: "events",
      conversationId: 1,
      events: [{ type: "inbox_update", items: [{ id: "sub-1", mode: "followUp" }] }],
    });

    expect(connection.getState().queue).toEqual({
      steer: [],
      followUp: [{ id: "sub-1", text: "later" }],
    });
  });

  it("lists queued inputs by lane, and shows one it has no text for (sent before a reload) as such", () => {
    const { connection, latest } = setup();

    watching(latest(), {
      inbox: [
        { id: "a", mode: "steer" },
        { id: "b", mode: "followUp" },
        { id: "c", mode: "write" },
      ],
    });

    expect(connection.getState().queue).toEqual({
      steer: [{ id: "a", text: null }],
      followUp: [{ id: "b", text: null }],
    });
  });

  it("sends an abort", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.abort();

    expect(latest().commands().at(-1)).toEqual({ type: "abort", id: expect.any(String) });
  });

  it("sends a configure with the fields given, and null to follow the default", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.configure({ model: "anthropic/claude-sonnet-5-5", thinkingLevel: "low" });
    connection.configure({ model: null });

    expect(latest().commands().slice(-2)).toEqual([
      {
        type: "configure",
        id: expect.any(String),
        model: "anthropic/claude-sonnet-5-5",
        thinkingLevel: "low",
      },
      { type: "configure", id: expect.any(String), model: null },
    ]);
  });

  it("knows which of the model and thinking level the Session picked, as it says", () => {
    const { connection, latest } = setup();

    expect(connection.getState().picked).toEqual({ model: false, thinkingLevel: false });

    watching(latest());
    latest().say({ type: "picked", model: true, thinkingLevel: false });
    expect(connection.getState().picked).toEqual({ model: true, thinkingLevel: false });

    latest().say({ type: "picked", model: false, thinkingLevel: false });
    expect(connection.getState().picked).toEqual({ model: false, thinkingLevel: false });
  });

  describe("Secret requests", () => {
    const request = { id: "12", conversationId: 1, names: ["API_KEY"], reason: "deploy" };

    it("shows the requests the Session says are waiting, until it says none are", () => {
      const { connection, latest } = setup();

      expect(connection.getState().secretRequests).toEqual([]);

      watching(latest());
      latest().say({ type: "secret_requests", lifetimeMinutes: 15, requests: [request] });
      expect(connection.getState().secretRequests).toEqual([request]);
      expect(connection.getState().secretLifetimeMinutes).toBe(15);

      latest().say({ type: "secret_requests", lifetimeMinutes: 15, requests: [] });
      expect(connection.getState().secretRequests).toEqual([]);
    });

    it("sends the owner's answer, or a cancellation, for a request", () => {
      const { connection, latest } = setup();

      watching(latest());
      connection.answerSecrets("12", { API_KEY: "value-typed-in" });
      connection.answerSecrets("12", null);

      expect(latest().commands().slice(-2)).toEqual([
        {
          type: "secret_answer",
          id: expect.any(String),
          request: "12",
          values: { API_KEY: "value-typed-in" },
        },
        { type: "secret_answer", id: expect.any(String), request: "12", values: null },
      ]);
    });

    it("forgets the requests of a closed socket, as the next one says again which wait", () => {
      const { connection, latest } = setup();

      watching(latest());
      latest().say({ type: "secret_requests", lifetimeMinutes: 15, requests: [request] });
      latest().drop();

      expect(connection.getState().secretRequests).toEqual([]);
    });
  });

  describe("Browser Handoffs", () => {
    const request = {
      id: "12",
      conversationId: 1,
      instructions: "Log in, then press Done",
      url: "https://live.browser.run/ui/view?mode=tab",
      deadline: 1_800_000,
    };

    it("shows the handoffs the Session says are waiting, with their links, until it says none are", () => {
      const { connection, latest } = setup();

      expect(connection.getState().browserHandoffRequests).toEqual([]);

      watching(latest());
      latest().say({ type: "browser_handoff_requests", requests: [request] });
      expect(connection.getState().browserHandoffRequests).toEqual([request]);

      latest().say({ type: "browser_handoff_requests", requests: [] });
      expect(connection.getState().browserHandoffRequests).toEqual([]);
    });

    it("forgets the handoffs of a closed socket, as the next one says again which wait", () => {
      const { connection, latest } = setup();

      watching(latest());
      latest().say({ type: "browser_handoff_requests", requests: [request] });
      latest().drop();

      expect(connection.getState().browserHandoffRequests).toEqual([]);
    });
  });

  it("shows why a configure failed", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.configure({ thinkingLevel: "high" });

    const configure = latest().commands().at(-1);

    latest().say({ type: "error", id: configure?.id, message: "Session is gone" });

    expect(connection.getState().failure).toBe("Session is gone");
  });

  it("reports a failed command and drops the submit that failed", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.submit("hi", "followUp");

    const submit = latest().commands().at(-1);

    latest().say({ type: "error", id: submit?.id, message: "busy" });

    expect(connection.getState().failure).toBe("busy");

    // A reconnect does not send it again.
    latest().drop();
    vi.advanceTimersByTime(60_000);
    watching(latest());

    expect(
      latest()
        .commands()
        .filter((command) => command.type === "submit"),
    ).toEqual([]);
  });

  it("ignores the heartbeat's pong and text it cannot read", () => {
    const { connection, latest } = setup();

    watching(latest());

    const before = connection.getState();

    latest().say("pong");
    latest().say("{not json");
    latest().say({ type: "nope" });

    expect(connection.getState()).toBe(before);
  });

  it("reconnects, after the backoff, when the Session drops the watch", () => {
    const { connection, sockets, latest } = setup();

    watching(latest());
    latest().say({ type: "error", conversationId: 1, message: "watch ended" });

    expect(connection.getState()).toMatchObject({ status: "reconnecting", failure: "watch ended" });
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(500);

    expect(sockets).toHaveLength(2);

    watching(latest());

    expect(connection.getState().status).toBe("live");
  });

  it("reconnects, after the backoff, when the Session refuses the watch, and shows why", () => {
    const { connection, sockets, latest } = setup();

    latest().open();
    latest().say({ type: "hello", root: 1 });

    const watch = latest().commands().at(-1);

    latest().say({ type: "error", id: watch?.id, message: "no such conversation" });

    expect(connection.getState()).toMatchObject({
      status: "reconnecting",
      failure: "no such conversation",
    });
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(500);

    expect(sockets).toHaveLength(2);
  });

  it("keeps backing off while watches fail, as a hello alone does not start the delay over", async () => {
    const { sockets, latest } = setup();

    const refuse = () => {
      latest().open();
      latest().say({ type: "hello", root: 1 });
      latest().say({ type: "error", id: latest().commands().at(-1)?.id, message: "no" });
    };

    refuse();
    vi.advanceTimersByTime(500);

    expect(sockets).toHaveLength(2);

    refuse();
    await vi.advanceTimersByTimeAsync(999);

    expect(sockets).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);

    expect(sockets).toHaveLength(3);
  });

  describe("reconnecting", () => {
    it("opens a new socket after the old one closes, keeping the view until a fresh snapshot replaces it", () => {
      const { connection, sockets, latest } = setup();

      watching(latest(), { entries: [entry(1, "kept")] });
      latest().drop();

      expect(connection.getState().status).toBe("reconnecting");
      expect(connection.getState().view.messages).toHaveLength(1);
      expect(sockets).toHaveLength(1);

      vi.advanceTimersByTime(60_000);

      expect(sockets).toHaveLength(2);

      watching(latest(), { entries: [entry(1, "kept"), entry(2, "while away")] });

      expect(connection.getState().status).toBe("live");
      expect(connection.getState().view.messages).toHaveLength(2);
    });

    it("backs off between attempts, and starts over once connected", async () => {
      const { sockets, latest } = setup();

      latest().drop();
      vi.advanceTimersByTime(499);

      expect(sockets).toHaveLength(1);

      vi.advanceTimersByTime(1);

      expect(sockets).toHaveLength(2);

      latest().drop();
      await vi.advanceTimersByTimeAsync(999);

      expect(sockets).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1);

      expect(sockets).toHaveLength(3);

      watching(latest());
      latest().drop();
      vi.advanceTimersByTime(500);

      expect(sockets).toHaveLength(4);
    });

    it("stops reconnecting once the probe shows the sign-in has lapsed, and keeps the view", async () => {
      const probe = vi.fn<SessionProbe>(() => Promise.resolve("signed-out"));
      const { connection, sockets, latest } = setup(probe);

      watching(latest(), { entries: [entry(1, "kept")] });
      latest().drop();
      vi.advanceTimersByTime(500);

      expect(probe).not.toHaveBeenCalled();

      latest().drop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(probe).toHaveBeenCalledWith("wss://example.test/sessions/s1/socket");
      expect(sockets).toHaveLength(2);
      expect(connection.getState().status).toBe("signed-out");
      expect(connection.getState().view.messages).toHaveLength(1);
    });

    it("stops reconnecting once the probe shows the Session does not exist", async () => {
      const { connection, sockets, latest } = setup(() => Promise.resolve("missing"));

      latest().drop();
      vi.advanceTimersByTime(500);
      latest().drop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets).toHaveLength(2);
      expect(connection.getState().status).toBe("missing");
    });

    it("stops at once, without a probe, when the Session closes the socket because it was deleted", async () => {
      let probes = 0;

      const { connection, sockets, latest } = setup(() => {
        probes += 1;

        return Promise.resolve("reachable");
      });

      latest().drop(SESSION_DELETED_CLOSE_CODE);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets).toHaveLength(1);
      expect(probes).toBe(0);
      expect(connection.getState().status).toBe("deleted");
    });

    it("keeps reconnecting while the probe finds the Session reachable", async () => {
      const probe = vi.fn<SessionProbe>(() => Promise.resolve("reachable"));
      const { connection, sockets, latest } = setup(probe);

      latest().drop();
      vi.advanceTimersByTime(500);
      latest().drop();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(sockets).toHaveLength(3);
      expect(connection.getState().status).toBe("reconnecting");
    });

    it("does not reconnect from a probe that answers after dispose", async () => {
      const { connection, sockets, latest } = setup();

      latest().drop();
      vi.advanceTimersByTime(500);
      latest().drop();
      connection.dispose();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets).toHaveLength(2);
      expect(connection.getState().status).toBe("closed");
    });

    it("lists a submit held while disconnected as sending, until it is answered", () => {
      const { connection, latest } = setup();

      watching(latest());
      latest().drop();
      connection.submit("offline", "followUp");

      expect(connection.getState().sending).toEqual([{ id: expect.any(String), text: "offline" }]);

      vi.advanceTimersByTime(500);
      watching(latest());

      const submit = latest()
        .commands()
        .find((command) => command.type === "submit");

      expect(connection.getState().sending).toHaveLength(1);

      latest().say({ type: "result", id: submit?.id, result: { submissionId: "s" } });

      expect(connection.getState().sending).toEqual([]);
    });

    it("sends a submit again, with the same requestId, when the socket closed before its answer", () => {
      const { connection, latest } = setup();

      watching(latest());
      connection.submit("hi", "followUp");

      const first = latest().commands().at(-1);

      latest().drop();
      vi.advanceTimersByTime(60_000);
      watching(latest());

      const again = latest()
        .commands()
        .filter((command) => command.type === "submit");

      expect(again).toHaveLength(1);
      expect(again[0]).toMatchObject({ input: "hi", requestId: first?.requestId });
    });

    it("does not send an answered submit again", () => {
      const { connection, latest } = setup();

      watching(latest());
      connection.submit("hi", "followUp");

      const submit = latest().commands().at(-1);

      latest().say({ type: "result", id: submit?.id, result: { submissionId: "s" } });
      latest().drop();
      vi.advanceTimersByTime(60_000);
      watching(latest());

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "submit"),
      ).toEqual([]);
    });

    it("holds a submit made while disconnected until it is watching again", () => {
      const { connection, latest } = setup();

      watching(latest());
      latest().drop();
      connection.submit("offline", "followUp");
      vi.advanceTimersByTime(60_000);

      expect(latest().commands()).toEqual([]);

      watching(latest());

      expect(
        latest()
          .commands()
          .filter((command) => command.type === "submit"),
      ).toHaveLength(1);
    });
  });

  describe("the queue", () => {
    it("keeps the same lanes while the inbox and the remembered texts do not change", () => {
      const { connection, latest } = setup();

      watching(latest(), { inbox: [{ id: "a", mode: "followUp" }] });

      const before = connection.getState().queue;

      expect(before.followUp).toHaveLength(1);

      latest().say({ type: "result", id: "unknown", result: null });
      latest().say({ type: "error", message: "unrelated" });

      expect(connection.getState().queue).toBe(before);

      latest().say({ type: "events", conversationId: 1, events: [] });

      expect(connection.getState().queue).toBe(before);
    });
  });

  describe("the heartbeat", () => {
    it("sends ping at an interval while open", () => {
      const { latest } = setup();

      watching(latest());
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(latest().sent.filter((text) => text === "ping")).toHaveLength(1);
    });

    it("keeps the socket while pongs come, and replaces it when one does not", () => {
      const { sockets, latest } = setup();

      watching(latest());
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      latest().say("pong");
      vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);

      expect(sockets).toHaveLength(1);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);

      const dead = sockets[0]!;

      expect(dead.closed).toBe(true);

      vi.advanceTimersByTime(60_000);

      expect(sockets).toHaveLength(2);
    });

    it("ignores what a replaced socket still says", () => {
      const { connection, sockets, latest } = setup();

      watching(latest());
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS + 1);
      vi.advanceTimersByTime(60_000);

      sockets[0]?.say(snapshot({ entries: [entry(9, "stale")] }));

      expect(connection.getState().view.messages).toEqual([]);
    });
  });

  it("closes its socket when disposed, and does not reconnect", () => {
    const { connection, sockets, latest } = setup();

    watching(latest());
    connection.dispose();

    expect(latest().closed).toBe(true);

    latest().drop();
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
    expect(connection.getState().status).toBe("closed");
  });
});

/** Answer the watch of conversation `id`, and say its snapshot, as a Session does. */
const watchingThread = (
  socket: FakeSocket,
  id: number,
  extra: { readonly [key: string]: Value } = {},
) => {
  const watch = socket
    .commands()
    .find((command) => command.type === "watch" && command.conversationId === id);

  socket.say({ type: "result", id: watch?.id, result: null });
  socket.say({ ...snapshot(extra), conversationId: id });
};

const threadEntry = (conversationId: number, id: number, text: string) => ({
  ...entry(id, text),
  conversationId,
});

describe("a subagent's thread on a Session connection", () => {
  it("is watched on its own conversation, kept apart from the root's view, and dropped when released", () => {
    const { connection, latest } = setup();

    watching(latest(), { entries: [entry(1, "root text")] });

    const release = connection.watchThread(2);

    expect(latest().commands().at(-1)).toEqual({
      type: "watch",
      id: expect.any(String),
      conversationId: 2,
    });
    expect(connection.getState().threads[2]).toMatchObject({ status: "loading", view: EMPTY_VIEW });

    watchingThread(latest(), 2, { entries: [threadEntry(2, 5, "child text")] });

    const state = connection.getState();

    expect(state.threads[2]?.status).toBe("live");
    expect(state.threads[2]?.view.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "child text" }],
    ]);
    expect(state.view.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "root text" }],
    ]);

    latest().say({
      type: "events",
      conversationId: 2,
      events: [{ type: "run_start", inputs: [5] }],
    });

    expect(connection.getState().threads[2]?.view.running).toBe(true);
    expect(connection.getState().view.running).toBe(false);

    release();

    expect(latest().commands().at(-1)).toEqual({
      type: "unwatch",
      id: expect.any(String),
      conversationId: 2,
    });
    expect(connection.getState().threads[2]).toBeUndefined();
  });

  it("is watched once however many cards open it, and unwatched with the last", () => {
    const { connection, latest } = setup();

    watching(latest());

    const first = connection.watchThread(2);
    const second = connection.watchThread(2);

    expect(
      latest()
        .commands()
        .filter((command) => command.type === "watch"),
    ).toHaveLength(2);

    first();
    first();
    expect(
      latest()
        .commands()
        .filter((command) => command.type === "unwatch"),
    ).toHaveLength(0);
    second();
    expect(
      latest()
        .commands()
        .filter((command) => command.type === "unwatch"),
    ).toHaveLength(1);
  });

  it("is watched again, from a fresh snapshot, when the Session says hello on a new socket", () => {
    const { connection, sockets, latest } = setup();

    watching(latest());
    connection.watchThread(2);
    watchingThread(latest(), 2, { entries: [threadEntry(2, 5, "child text")] });
    latest().drop();
    vi.advanceTimersByTime(1_000);

    const reconnected = sockets[1]!;

    reconnected.open();
    reconnected.say({ type: "hello", root: 1 });

    expect(reconnected.commands()).toEqual([
      { type: "watch", id: expect.any(String), conversationId: 1 },
      { type: "watch", id: expect.any(String), conversationId: 2 },
    ]);
    // The last view stays until the snapshot replaces it.
    expect(connection.getState().threads[2]?.view.messages).toHaveLength(1);
  });

  it("takes the owner's input once its watch is answered, with the conversation it is for", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.watchThread(2);
    connection.submit("take a look", "steer", 2);

    expect(
      latest()
        .commands()
        .some((command) => command.type === "submit"),
    ).toBe(false);
    expect(connection.getState().threads[2]?.sending).toEqual([
      { id: expect.any(String), text: "take a look" },
    ]);
    expect(connection.getState().sending).toEqual([]);

    watchingThread(latest(), 2);

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
  });

  it("lists the thread's queued input by lane, with the text it sent", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.watchThread(2);
    watchingThread(latest(), 2);
    connection.submit("later", "followUp", 2);

    const submit = latest()
      .commands()
      .find((command) => command.type === "submit");

    latest().say({ type: "result", id: submit?.id, result: { submissionId: 9 } });
    latest().say({
      type: "events",
      conversationId: 2,
      events: [{ type: "inbox_update", items: [{ id: 9, mode: "followUp" }] }],
    });

    expect(connection.getState().threads[2]?.queue.followUp).toEqual([{ id: "9", text: "later" }]);
    expect(connection.getState().queue.followUp).toEqual([]);
  });

  it("shows a refused watch on the thread alone, and does not reconnect", () => {
    const { connection, sockets, latest } = setup();

    watching(latest());
    connection.watchThread(2);

    const watch = latest()
      .commands()
      .find((command) => command.conversationId === 2);

    latest().say({ type: "error", id: watch?.id, message: "No such conversation" });
    vi.advanceTimersByTime(5_000);

    expect(connection.getState().threads[2]).toMatchObject({
      status: "failed",
      failure: "No such conversation",
    });
    expect(connection.getState()).toMatchObject({ status: "live", failure: null });
    expect(sockets).toHaveLength(1);
  });

  it("shows a refused submit on the thread alone", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.watchThread(2);
    watchingThread(latest(), 2);
    connection.submit("hello", "steer", 2);

    const submit = latest()
      .commands()
      .find((command) => command.type === "submit");

    latest().say({ type: "error", id: submit?.id, message: "Not a subagent" });

    expect(connection.getState().threads[2]).toMatchObject({
      failure: "Not a subagent",
      sending: [],
    });
    expect(connection.getState().failure).toBeNull();
  });

  it("aborts the root, or a subagent, with or without the agents below it", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.abort();
    connection.abort({ conversationId: 2 });
    connection.abort({ subagents: true });
    connection.abort({ conversationId: 2, subagents: true });

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
  });
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

  it("is watched once asked, and again after a reconnect, and keeps the last summary", () => {
    const { connection, sockets, latest } = setup();

    connection.watchTaskGraph();
    watching(latest());
    connection.watchTaskGraph();

    expect(
      latest()
        .commands()
        .filter((command) => command.type === "watch_task_graph"),
    ).toEqual([{ type: "watch_task_graph", id: expect.any(String) }]);
    expect(connection.getState().taskGraph).toBeNull();

    latest().say(summary);

    expect(connection.getState().taskGraph?.agents).toMatchObject([
      { id: "agent-1", status: "working" },
    ]);

    latest().drop();
    expect(connection.getState().taskGraph?.agents).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    sockets[1]!.say({ type: "hello", root: 1 });

    expect(
      sockets[1]!.commands().filter((command) => command.type === "watch_task_graph"),
    ).toHaveLength(1);
  });
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

  it("is watched once asked, and again after a reconnect, and keeps the last message", () => {
    const { connection, sockets, latest } = setup();

    connection.watchUsage();
    watching(latest());
    connection.watchUsage();

    expect(
      latest()
        .commands()
        .filter((command) => command.type === "watch_usage"),
    ).toEqual([{ type: "watch_usage", id: expect.any(String) }]);
    expect(connection.getState().usage).toBeNull();

    latest().say(usage);
    expect(connection.getState().usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 5,
      totalTokens: 125,
      cost: 0.5,
      limit: 2,
    });

    latest().say({ ...usage, cost: 0.75 });
    expect(connection.getState().usage?.cost).toBe(0.75);

    latest().drop();
    expect(connection.getState().usage?.cost).toBe(0.75);
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    sockets[1]!.say({ type: "hello", root: 1 });

    expect(sockets[1]!.commands().filter((command) => command.type === "watch_usage")).toHaveLength(
      1,
    );
  });
});

describe("Todo Lists on a Session connection", () => {
  const tasks = (...titles: string[]) =>
    titles.map((title, index) => ({ id: index + 1, title, status: "pending" }));

  it("keeps the root's list as the Session sends it, each list replacing the last", () => {
    const { connection, latest } = setup();

    expect(connection.getState().todos).toEqual([]);

    watching(latest());
    latest().say({ type: "todos", conversationId: 1, tasks: tasks("Write it") });
    expect(connection.getState().todos).toEqual(tasks("Write it"));

    latest().say({
      type: "todos",
      conversationId: 1,
      tasks: [{ id: 1, title: "Write it", description: "Soon", status: "completed" }],
    });
    expect(connection.getState().todos).toEqual([
      { id: 1, title: "Write it", description: "Soon", status: "completed" },
    ]);
  });

  it("keeps the last list while reconnecting, until the new socket sends one", () => {
    const { connection, sockets, latest } = setup();

    watching(latest());
    latest().say({ type: "todos", conversationId: 1, tasks: tasks("Write it") });
    latest().drop();
    expect(connection.getState().todos).toEqual(tasks("Write it"));

    vi.advanceTimersByTime(1_000);
    watching(sockets[1]!);
    sockets[1]!.say({ type: "todos", conversationId: 1, tasks: [] });

    expect(connection.getState().todos).toEqual([]);
  });

  it("keeps a subagent thread's list on the thread, apart from the root's", () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.watchThread(2);
    watchingThread(latest(), 2);
    latest().say({ type: "todos", conversationId: 2, tasks: tasks("Child task") });
    latest().say({ type: "todos", conversationId: 1, tasks: tasks("Root task") });

    expect(connection.getState().threads["2"]?.todos).toEqual(tasks("Child task"));
    expect(connection.getState().todos).toEqual(tasks("Root task"));
  });
});

describe("the catalog and Slash commands", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const CATALOG = {
    commands: [{ name: "export", description: "Export", argument: "none" }],
    templates: [{ name: "review", description: "Review", argumentHint: "<ref>" }],
    skills: [{ name: "deploy", description: "Deploy" }],
  };

  it("asks for a conversation's catalog and resolves with the answer", async () => {
    const { connection, latest } = setup();

    watching(latest());
    connection.watchThread(2);
    watchingThread(latest(), 2);

    const root = connection.catalog();
    const child = connection.catalog(2);

    const [rootAsk, childAsk] = latest()
      .commands()
      .filter((command) => command.type === "catalog");

    expect(rootAsk).toEqual({ type: "catalog", id: rootAsk?.id });
    expect(childAsk).toMatchObject({ type: "catalog", conversationId: 2 });

    latest().say({ type: "result", id: rootAsk?.id, result: CATALOG });
    latest().say({ type: "result", id: childAsk?.id, result: { ...CATALOG, skills: [] } });

    await expect(root).resolves.toEqual(CATALOG);
    await expect(child).resolves.toEqual({ ...CATALOG, skills: [] });
  });

  it("runs a command and resolves with what it did, or rejects with why it could not", async () => {
    const { connection, latest } = setup();

    watching(latest());

    const done = connection.command("compact", "the API");
    const refused = connection.command("todo", "");

    const [first, second] = latest()
      .commands()
      .filter((command) => command.type === "command");

    expect(first).toEqual({ type: "command", id: first?.id, name: "compact", args: "the API" });

    latest().say({ type: "result", id: first?.id, result: { notice: "Compacting the context." } });
    latest().say({ type: "error", id: second?.id, message: "/todo takes clear." });

    await expect(done).resolves.toEqual({ notice: "Compacting the context." });
    await expect(refused).rejects.toThrow("/todo takes clear.");
    // A command's failure is the composer's to show, not the Session's.
    expect(connection.getState().failure).toBeNull();
  });

  it("rejects a request made while disconnected, and one the socket's close leaves unanswered", async () => {
    const { connection, latest } = setup();

    await expect(connection.command("export", "")).rejects.toThrow(/not connected/);

    watching(latest());

    const waiting = connection.catalog();
    const running = connection.command("todo", "clear");

    latest().drop();

    await expect(waiting).rejects.toThrow("The connection was lost; try again once it is back.");
    // A command may have reached the Session before the socket went.
    await expect(running).rejects.toThrow(/the command may have run/);
  });
});
