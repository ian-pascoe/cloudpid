// @effect-diagnostics asyncFunction:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { EMPTY_VIEW } from "@cloudpid/protocol";
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

  /** The network drops the socket. */
  drop() {
    this.onclose?.(new CloseEvent("close"));
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
