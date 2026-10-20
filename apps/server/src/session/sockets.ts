// The Session socket (`docs/spec.md` → Client and protocol, ADR-0009): clients' hibernatable WebSockets to the Session
// DO, carrying `@cloudpid/protocol`'s Session messages. As in the socket glue of Cloudflare's `agents` pi example,
// watches live in memory and each socket's attachment names the conversations it watches, so an instance woken from
// hibernation restarts them, each with a fresh snapshot, on sockets that never closed.
import {
  ClientMessageJson,
  ConversationId,
  HEARTBEAT,
  type ClientMessage,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { SessionError, SessionHost } from "./host.ts";

/**
 * The parts of a Durable Object's `ctx` the sockets use. Narrow on purpose, as `SessionStorage` is, so the module and
 * global declarations of the state both fit it.
 */
export type SocketState = {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
};

/** What a socket keeps across hibernation: the conversations it watches. */
const Attachment = Schema.Struct({ watches: Schema.Array(ConversationId) });

type Attachment = typeof Attachment.Type;

const encodeMessage = Schema.encodeEffect(ServerMessageJson);

const decodeMessage = Schema.decodeUnknownEffect(ClientMessageJson);

const decodeAttachment = Schema.decodeUnknownOption(Attachment);

export type SessionSocketsService = {
  /** Accept a new client and greet it: the result is the client's end, to answer the upgrade with. */
  readonly connect: Effect.Effect<WebSocket, SessionError>;
  /** Handle a message a client sent on `socket`. */
  readonly receive: (socket: WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>;
  /** `socket` closed or failed: stop its watches. */
  readonly drop: (socket: WebSocket) => Effect.Effect<void>;
};

/** The Session DO's client sockets. */
export class SessionSockets extends Context.Service<SessionSockets, SessionSocketsService>()(
  "@cloudpid/server/session/sockets/SessionSockets",
) {}

/** Send `message` on `socket`, unless it has closed. */
const send = (socket: WebSocket, message: ServerMessage): Effect.Effect<void> =>
  encodeMessage(message).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => socket.send(text),
        // The socket closed; its close event drops it.
        catch: () => undefined,
      }),
    ),
    Effect.ignore,
  );

const readAttachment = (socket: WebSocket): Attachment =>
  Option.getOrElse(decodeAttachment(socket.deserializeAttachment()), () => ({ watches: [] }));

/** Record that `socket` watches `conversationId`, or no longer does. */
const setWatched = (socket: WebSocket, conversationId: ConversationId, watched: boolean) =>
  Effect.sync(() => {
    const { watches } = readAttachment(socket);
    const others = Arr.filter(watches, (id) => id !== conversationId);

    socket.serializeAttachment({
      watches: watched ? Arr.append(others, conversationId) : others,
    } satisfies Attachment);
  });

/**
 * The Session's sockets over the object's `state`. Building it restarts the watches of sockets that outlived the last
 * instance, so build it once, from the object's constructor, before any socket event is handled.
 */
export const sessionSocketsLayer = (
  state: SocketState,
): Layer.Layer<SessionSockets, never, SessionHost> =>
  Layer.effect(
    SessionSockets,
    Effect.gen(function* () {
      const host = yield* SessionHost;
      const scope = yield* Effect.scope;
      /** Each open socket's running watches, by conversation. */
      const watching = new Map<WebSocket, FiberMap.FiberMap<ConversationId>>();

      // Answered by the runtime, so a client's heartbeat never wakes a hibernated object.
      state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(HEARTBEAT.request, HEARTBEAT.response),
      );

      const watchesOf = (socket: WebSocket) =>
        Effect.suspend(() => {
          const existing = watching.get(socket);

          if (existing !== undefined) return Effect.succeed(existing);

          return FiberMap.make<ConversationId>().pipe(
            Effect.tap((fibers) => Effect.sync(() => watching.set(socket, fibers))),
            Scope.provide(scope),
          );
        });

      /**
       * Stream `conversationId`'s events to `socket`, replacing a watch it already has, and resolve once its snapshot
       * is sent, or once a newer watch or the socket's close replaces it. A watch that ends after its snapshot is
       * dropped, and the client told.
       */
      const watch = (socket: WebSocket, conversationId: ConversationId) =>
        Effect.gen(function* () {
          const fibers = yield* watchesOf(socket);
          const started = yield* Deferred.make<void, SessionError>();

          yield* host.events(conversationId).pipe(
            Stream.runForEach((events) =>
              send(socket, { type: "events", conversationId, events }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
              ),
            ),
            Effect.catch((error) =>
              Deferred.fail(started, error).pipe(
                Effect.flatMap((first) =>
                  first
                    ? Effect.void
                    : setWatched(socket, conversationId, false).pipe(
                        Effect.andThen(send(socket, { type: "error", message: error.message })),
                      ),
                ),
              ),
            ),
            Effect.onInterrupt(() => Deferred.succeed(started, undefined)),
            FiberMap.run(fibers, conversationId),
          );

          yield* Deferred.await(started);
        });

      const unwatch = (socket: WebSocket, conversationId: ConversationId) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          return fibers === undefined ? Effect.void : FiberMap.remove(fibers, conversationId);
        });

      const command = (socket: WebSocket, message: ClientMessage) => {
        switch (message.type) {
          case "submit": {
            const { type: _type, id: _id, input, ...options } = message;

            return host
              .submit({ input, ...options })
              .pipe(Effect.map((submissionId) => ({ submissionId })));
          }

          case "abort":
            return host.abort.pipe(Effect.as(null));
          case "watch":
            return watch(socket, message.conversationId).pipe(
              Effect.andThen(setWatched(socket, message.conversationId, true)),
              Effect.as(null),
            );
          case "unwatch":
            return unwatch(socket, message.conversationId).pipe(
              Effect.andThen(setWatched(socket, message.conversationId, false)),
              Effect.as(null),
            );
        }
      };

      const receive = (socket: WebSocket, data: string | ArrayBuffer) =>
        Effect.gen(function* () {
          const text = Predicate.isString(data) ? data : new TextDecoder().decode(data);
          const decoded = yield* Effect.option(decodeMessage(text));

          if (Option.isNone(decoded)) {
            return yield* send(socket, { type: "error", message: "Unreadable message" });
          }

          const message = decoded.value;
          const exit = yield* Effect.exit(command(socket, message));

          if (Exit.isSuccess(exit)) {
            if (message.id !== undefined) {
              yield* send(socket, { type: "result", id: message.id, result: exit.value });
            }

            return;
          }

          const error = Exit.findErrorOption(exit);

          const failure: Extract<ServerMessage, { type: "error" }> = {
            type: "error",
            message: Option.isSome(error) ? error.value.message : "Internal error",
          };

          yield* Effect.logWarning(`Session command ${message.type} failed`, exit.cause);
          yield* send(socket, message.id === undefined ? failure : { ...failure, id: message.id });
        });

      const drop = (socket: WebSocket) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          watching.delete(socket);

          return fibers === undefined ? Effect.void : FiberMap.clear(fibers);
        });

      const connect = Effect.gen(function* () {
        const root = yield* host.root;
        const { 0: client, 1: server } = new WebSocketPair();

        state.acceptWebSocket(server);
        server.serializeAttachment({ watches: [] } satisfies Attachment);
        yield* send(server, { type: "hello", root });

        return client;
      });

      // Sockets that outlived the last instance keep their watches, each from a fresh snapshot.
      for (const socket of state.getWebSockets()) {
        for (const conversationId of readAttachment(socket).watches) {
          yield* watch(socket, conversationId).pipe(
            // A watch that cannot restart is dropped, so the next instance does not retry it.
            Effect.catch((error) =>
              setWatched(socket, conversationId, false).pipe(
                Effect.andThen(send(socket, { type: "error", message: error.message })),
              ),
            ),
          );
        }
      }

      return { connect, receive, drop } satisfies SessionSocketsService;
    }),
  );
