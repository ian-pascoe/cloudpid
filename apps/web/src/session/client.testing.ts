// A WebSocket a test drives by hand, given to the client through `Socket.WebSocketConstructor`.

// @effect-diagnostics preferEffectArray:off globalJsonInEffect:off missingPipeableSignature:off -- an in-memory fake of the browser's WebSocket over native arrays, reading what the client sent as plain JSON; frame builders are plain functions.

import { diffRevisions } from "@earendil-works/chord/delta";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Socket from "effect/socket/Socket";

export type Value =
  | undefined
  | string
  | number
  | boolean
  | null
  | readonly Value[]
  | { readonly [key: string]: Value };

/** What the Session says: a message, or the heartbeat's text. */
type Said = string | { readonly [key: string]: Value };

type Listener = (event: Socket.WebSocketEvent) => void;

type EventType = "open" | "message" | "error" | "close";

/** Let every fiber the last step woke run until it waits again. */
export const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 40; turn += 1) yield* Effect.yieldNow;
});

/**
 * A WebSocket the test drives by hand, as the client gets it from `Socket.WebSocketConstructor`: what the client
 * sent, and what the Session says.
 */
export class FakeSocket implements Socket.WebSocketLike {
  readonly sent: string[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<EventType, Map<Listener, boolean>>();

  constructor(readonly url: string) {}

  addEventListener(type: EventType, listener: Listener, options?: { readonly once?: boolean }) {
    const listeners = this.listeners.get(type) ?? new Map<Listener, boolean>();

    listeners.set(listener, options?.once === true);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: EventType, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    this.sent.push(Predicate.isString(data) ? data : new TextDecoder().decode(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  private dispatch(type: EventType, event: Socket.WebSocketEvent) {
    const listeners = this.listeners.get(type);

    if (listeners === undefined) return;

    // A Map visits what is added while it is iterated, so the listeners are taken as they were.
    for (const [listener, once] of Array.from(listeners)) {
      if (once) listeners.delete(listener);

      listener(event);
    }
  }

  open() {
    return Effect.sync(() => {
      this.readyState = 1;
      this.dispatch("open", { type: "open" });
    }).pipe(Effect.andThen(settle));
  }

  say(message: Said) {
    return Effect.sync(() => {
      this.dispatch("message", {
        type: "message",
        data: Predicate.isString(message) ? message : JSON.stringify(message),
      });
    }).pipe(Effect.andThen(settle));
  }

  /** The commands sent so far, without heartbeats and the page's visibility (`visibility`, which every open socket sends). */
  commands(): Array<{ readonly [key: string]: Value }> {
    return this.everything().filter((command) => command["type"] !== "page_visible");
  }

  /** The `visible` of each `page_visible` sent so far. */
  visibility(): Value[] {
    return this.everything()
      .filter((command) => command["type"] === "page_visible")
      .map((command) => command["visible"]);
  }

  private everything(): Array<{ readonly [key: string]: Value }> {
    return this.sent.filter((text) => text !== "ping").map((text) => JSON.parse(text));
  }

  /** The network drops the socket, or the Session closes it with `code`. */
  drop(code?: number) {
    return Effect.sync(() => {
      this.readyState = 3;
      this.dispatch("close", code === undefined ? { type: "close" } : { type: "close", code });
    }).pipe(Effect.andThen(settle));
  }
}

/** What a test puts in pi's conversation view: its window of `entries`, and its documents' state. */
export type Pi = {
  readonly entries?: readonly Value[];
  /** ID of the entry before the window, when the window does not start the transcript. */
  readonly before?: number;
  /** The inbox's items (`pi.inbox`). */
  readonly inbox?: readonly Value[];
  /** The run, the generation and the tools (`pi.live`). */
  readonly live?: { readonly [key: string]: Value };
};

/** A run, as `pi.live.run` holds it. */
export const RUN = { taskId: 1, inputs: [1], turns: 0 };

/** pi's conversation view, as the Session sends it, built a field at a time. */
type PiView = {
  conversation: { readonly id: number };
  entries: readonly Value[];
  before?: number;
  docs: {
    "pi.live"?: { readonly [key: string]: Value };
    "pi.inbox"?: { readonly items: readonly Value[] };
  };
};

/** pi's conversation view of `conversationId`, as the Session sends it. */
const piView = (conversationId: number, pi: Pi): Value => {
  const docs: PiView["docs"] = {};

  if (pi.live !== undefined) docs["pi.live"] = pi.live;

  if (pi.inbox !== undefined) docs["pi.inbox"] = { items: pi.inbox };

  const view: PiView = {
    conversation: { id: conversationId },
    entries: pi.entries ?? [],
    docs,
  };

  if (pi.before !== undefined) view.before = pi.before;

  return view;
};

/** The `view` frame of conversation `conversationId`: its whole view. */
export const viewFrame = (pi: Pi = {}, conversationId = 1) => ({
  type: "view",
  conversationId,
  view: piView(conversationId, pi),
});

/** The `ops` frame that changes conversation `conversationId`'s view from `from` to `to`. */
export const opsFrame = (from: Pi, to: Pi, conversationId = 1) => ({
  type: "ops",
  conversationId,
  // SAFETY: the views and their operations are JSON.
  ops: diffRevisions(
    piView(conversationId, from) as never,
    piView(conversationId, to) as never,
  ) as Value,
});
