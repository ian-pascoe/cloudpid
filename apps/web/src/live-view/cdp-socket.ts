// @effect-diagnostics preferSchemaOverJson:off newSchemaClass:off missingPipeableSignature:off -- CDP's own wire format, written as plain JSON; the Live View's error class; and a plain constructor of a page's connection.

// One page's CDP connection (#154): a WebSocket to a Live View link (Browser Run's `webSocketDebuggerUrl`, opened as it
// is), its commands and their answers, and its events. Calls time out; a call out when the socket closes fails.

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";
import type { CdpCommand } from "./cdp.ts";

/** Why the Live View could not do something: a socket that would not open or closed, a call refused or unanswered. */
export class LiveViewError extends Schema.TaggedError<
  LiveViewError,
  { readonly brand: unique symbol }
>()("LiveViewError", { message: Schema.String }) {}

/** A JSON value, as CDP's parameters are. */
export type CdpJson =
  | string
  | number
  | boolean
  | null
  | readonly CdpJson[]
  | { readonly [key: string]: CdpJson | undefined };

/** A command's parameters. */
export type CdpParams = { readonly [key: string]: CdpJson | undefined };

/** A message from the page: an answer (with `id`) or an event (with `method`). */
const CdpMessage = Schema.Struct({
  id: Schema.optional(Schema.Finite),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});

type CdpMessage = typeof CdpMessage.Type;

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(CdpMessage));

/** How long a socket may take to open, and a call to be answered, by default. */
export const OPEN_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 10_000;

/** A page's open CDP connection. */
export interface CdpPage {
  readonly targetId: string;
  /** Whether the socket is open. A socket iOS killed in the background can still say it is: ping it. */
  readonly isOpen: () => boolean;
  /** Send a command without waiting for its answer (input, frame acks, cleanup on the way out). */
  readonly send: (method: string, params?: CdpParams) => void;
  /** Send input commands, in order. */
  readonly input: (commands: readonly CdpCommand[]) => void;
  /** Send a command and wait for its answer, read by `schema`. */
  readonly call: <A>(
    method: string,
    params: CdpParams,
    schema: Schema.Decoder<A>,
    timeoutMs?: number,
  ) => Effect.Effect<A, LiveViewError>;
  /** Hear event `method`, read by `schema` (an event it cannot read is dropped); returns how to stop. */
  readonly on: <A>(
    method: string,
    schema: Schema.Decoder<A>,
    listener: (params: A) => void,
  ) => () => void;
  /** Done once the socket has closed, whoever closed it. */
  readonly closed: Effect.Effect<void>;
  /** Close the socket. */
  readonly close: () => void;
}

interface Pending {
  readonly method: string;
  readonly answer: Deferred.Deferred<CdpMessage, LiveViewError>;
}

/** Open the page `targetId`'s CDP socket at `link`; fails when it closes before opening or takes too long. */
export const openPage = (
  makeWebSocket: (url: string) => Socket.WebSocketLike,
  link: string,
  targetId: string,
): Effect.Effect<CdpPage, LiveViewError> =>
  Effect.callback<CdpPage, LiveViewError>((resume) => {
    const ws = makeWebSocket(link);
    const pending = new Map<number, Pending>();
    const listeners = new Map<string, Set<(message: CdpMessage) => void>>();
    const closed = Deferred.makeUnsafe<void>();
    let opened = false;
    let nextId = 0;

    /** Send a command whose answer nobody waits for. */
    const write = (method: string, params: CdpParams | CdpCommand["params"]) => {
      if (!page.isOpen()) return;

      nextId += 1;
      ws.send(JSON.stringify({ id: nextId, method, params }));
    };

    const page: CdpPage = {
      targetId,
      isOpen: () => opened && ws.readyState === 1 && !Deferred.isDoneUnsafe(closed),
      send: (method, params = {}) => {
        write(method, params);
      },
      input: (commands) => {
        for (const command of commands) write(command.method, command.params);
      },
      call: (method, params, schema, timeoutMs = CALL_TIMEOUT_MS) =>
        Effect.suspend(() => {
          if (!page.isOpen()) {
            return Effect.fail(
              LiveViewError.make({ message: `${method}: the page is not connected` }),
            );
          }

          nextId += 1;

          const id = nextId;
          const answer = Deferred.makeUnsafe<CdpMessage, LiveViewError>();

          pending.set(id, { method, answer });
          ws.send(JSON.stringify({ id, method, params }));

          const read = Schema.decodeUnknownOption(schema);

          return Deferred.await(answer).pipe(
            Effect.flatMap((message) =>
              Effect.fromOption(read(message.result)).pipe(
                Effect.mapError(() =>
                  LiveViewError.make({ message: `${method}: the answer could not be read` }),
                ),
              ),
            ),
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () =>
                Effect.fail(
                  LiveViewError.make({ message: `${method}: no answer in ${timeoutMs} ms` }),
                ),
            }),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id);
              }),
            ),
          );
        }),
      on: (method, schema, listener) => {
        const read = Schema.decodeUnknownOption(schema);

        const heard = (message: CdpMessage) => {
          Option.map(read(message.params ?? {}), listener);
        };

        const set = listeners.get(method) ?? new Set();

        set.add(heard);
        listeners.set(method, set);

        return () => {
          set.delete(heard);
        };
      },
      closed: Deferred.await(closed),
      close: () => {
        ws.close(1000);
      },
    };

    ws.addEventListener("open", () => {
      opened = true;
      resume(Effect.succeed(page));
    });

    ws.addEventListener("message", (event) => {
      const message = decodeMessage(event.data);

      if (Option.isNone(message)) return;

      const { id, method, error } = message.value;

      if (id !== undefined) {
        const waiting = pending.get(id);

        if (waiting === undefined) return;

        pending.delete(id);
        Deferred.doneUnsafe(
          waiting.answer,
          error === undefined
            ? Effect.succeed(message.value)
            : Effect.fail(LiveViewError.make({ message: `${waiting.method}: ${error.message}` })),
        );

        return;
      }

      if (method === undefined) return;

      for (const listener of Array.from(listeners.get(method) ?? [])) listener(message.value);
    });

    ws.addEventListener("close", (event) => {
      const why = `the page's connection closed${event.code === undefined ? "" : ` (${event.code})`}`;

      for (const waiting of pending.values()) {
        Deferred.doneUnsafe(
          waiting.answer,
          Effect.fail(LiveViewError.make({ message: `${waiting.method}: ${why}` })),
        );
      }

      pending.clear();
      Deferred.doneUnsafe(closed, Effect.void);

      if (!opened) resume(Effect.fail(LiveViewError.make({ message: why })));
    });

    // Given up on before it opened (a timeout, or the Live View closed): it is not wanted any more.
    return Effect.sync(() => {
      if (!opened) ws.close();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(OPEN_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(LiveViewError.make({ message: "The Live View did not connect in time." })),
    }),
  );
