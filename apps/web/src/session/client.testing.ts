// A WebSocket a test drives by hand, given to the client through `Socket.WebSocketConstructor`.

// @effect-diagnostics preferEffectArray:off preferSchemaOverJson:off -- an in-memory fake of the browser's WebSocket over native arrays, reading what the client sent as plain JSON.

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

  /** The commands sent so far, without heartbeats. */
  commands(): Array<{ readonly [key: string]: Value }> {
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
