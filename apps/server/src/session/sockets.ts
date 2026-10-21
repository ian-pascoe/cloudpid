// The Session socket (`docs/spec.md` → Client and protocol, ADR-0009): clients' hibernatable WebSockets to the Session
// DO, carrying `@cloudpid/protocol`'s Session messages. As in the socket glue of Cloudflare's `agents` pi example,
// watches live in memory and each socket's attachment names the conversations it watches, so an instance woken from
// hibernation restarts them, each with a fresh snapshot, on sockets that never closed.
import {
  ConversationId,
  decodeClientMessage,
  HEARTBEAT,
  type ClientMessage,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import { parseModelId } from "@cloudpid/config";
import {
  SECRET_LIFETIME_MS,
  type SecretAsk,
  Secrets,
  type SecretsError,
} from "@cloudpid/extensions/secrets";
import { type BrowserHandoffRequest, BrowserHandoffs } from "@cloudpid/extensions/browser";
import type { AgentChange } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
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

type ErrorMessage = Extract<ServerMessage, { type: "error" }>;

/** What a socket keeps across hibernation: the conversations it watches, and whether it watches the task graph. */
const Attachment = Schema.Struct({
  watches: Schema.Array(ConversationId),
  taskGraph: Schema.optionalKey(Schema.Boolean),
});

type Attachment = typeof Attachment.Type;

const encodeMessage = Schema.encodeEffect(ServerMessageJson);

/** The `id` of a message that is not a valid command, so its error can answer it. */
const decodeCommandId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);

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
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain helper, not an Effect operator.
export const send = (socket: WebSocket, message: ServerMessage): Effect.Effect<void> =>
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

/** The `secret_requests` message for `asks`. */
export const secretRequests = (asks: ReadonlyArray<SecretAsk>): ServerMessage => ({
  type: "secret_requests",
  lifetimeMinutes: SECRET_LIFETIME_MS / 60_000,
  requests: Arr.map(asks, (ask) => ({
    ...ask,
    // SAFETY: an ask's conversation is the asking call's, a pi-durable conversation ID.
    conversationId: ask.conversationId as ConversationId,
  })),
});

/** The `browser_handoff_requests` message for `requests`: the Live View links go to the owner's clients, and nowhere else. */
export const browserHandoffRequests = (
  requests: ReadonlyArray<BrowserHandoffRequest>,
): ServerMessage => ({
  type: "browser_handoff_requests",
  requests: Arr.map(requests, (request) => ({
    ...request,
    // SAFETY: a handoff's conversation is the asking call's, a pi-durable conversation ID.
    conversationId: request.conversationId as ConversationId,
  })),
});

/** The agent change a `configure` asks for: a field it leaves out is left out, as is. */
const agentChange = (message: Extract<ClientMessage, { type: "configure" }>): AgentChange => {
  const change: Types.Mutable<AgentChange> = {};

  if (message.model !== undefined) {
    change.model = message.model === null ? null : parseModelId(message.model);
  }

  if (message.thinkingLevel !== undefined) change.thinkingLevel = message.thinkingLevel;

  return change;
};

const readAttachment = (socket: WebSocket): Attachment =>
  Option.getOrElse(decodeAttachment(socket.deserializeAttachment()), () => ({ watches: [] }));

/** Record that `socket` watches `conversationId`, or no longer does. */
const setWatched = (socket: WebSocket, conversationId: ConversationId, watched: boolean) =>
  Effect.sync(() => {
    const attachment = readAttachment(socket);
    const others = Arr.filter(attachment.watches, (id) => id !== conversationId);

    socket.serializeAttachment({
      ...attachment,
      watches: watched ? Arr.append(others, conversationId) : others,
    } satisfies Attachment);
  });

/** Record that `socket` watches the task graph, or no longer does. */
const setGraphWatched = (socket: WebSocket, watched: boolean) =>
  Effect.sync(() => {
    socket.serializeAttachment({
      ...readAttachment(socket),
      taskGraph: watched,
    } satisfies Attachment);
  });

/** The key of a socket's task graph watch among its watches. */
const TASK_GRAPH = "task_graph";

type WatchKey = ConversationId | typeof TASK_GRAPH;

/**
 * The Session's sockets over the object's `state`. Building it restarts the watches of sockets that outlived the last
 * instance, so build it once, from the object's constructor, before any socket event is handled.
 */
export const sessionSocketsLayer = (
  state: SocketState,
): Layer.Layer<SessionSockets, never, SessionHost | Secrets | BrowserHandoffs> =>
  Layer.effect(
    SessionSockets,
    Effect.gen(function* () {
      const host = yield* SessionHost;
      const secrets = yield* Secrets;
      const handoffs = yield* BrowserHandoffs;
      const scope = yield* Effect.scope;
      /** Each open socket's running watches, by conversation. */
      const watching = new Map<WebSocket, FiberMap.FiberMap<WatchKey>>();

      // Answered by the runtime, so a client's heartbeat never wakes a hibernated object.
      state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(HEARTBEAT.request, HEARTBEAT.response),
      );

      const watchesOf = (socket: WebSocket) =>
        Effect.suspend(() => {
          const existing = watching.get(socket);

          if (existing !== undefined) return Effect.succeed(existing);

          return FiberMap.make<WatchKey>().pipe(
            Effect.tap((fibers) => Effect.sync(() => watching.set(socket, fibers))),
            Scope.provide(scope),
          );
        });

      /**
       * Stream `conversationId`'s events to `socket`, replacing a watch it already has, and resolve once its snapshot
       * is sent, or once a newer watch or the socket's close replaces it. The socket's attachment records the watch
       * before it starts, and a watch that fails drops it, so the attachment never names a watch no fiber runs. One
       * that fails after its snapshot tells the client, by `conversationId`.
       */
      const watch = (socket: WebSocket, conversationId: ConversationId) =>
        Effect.gen(function* () {
          const fibers = yield* watchesOf(socket);
          const started = yield* Deferred.make<void, SessionError>();

          yield* setWatched(socket, conversationId, true);
          yield* host.events(conversationId).pipe(
            Stream.runForEach((events) =>
              send(socket, { type: "events", conversationId, events }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
              ),
            ),
            Effect.catch((error) =>
              setWatched(socket, conversationId, false).pipe(
                Effect.andThen(Deferred.fail(started, error)),
                Effect.flatMap((first) =>
                  first
                    ? Effect.void
                    : send(socket, { type: "error", conversationId, message: error.message }),
                ),
              ),
            ),
            Effect.onInterrupt(() => Deferred.succeed(started, undefined)),
            FiberMap.run(fibers, conversationId),
          );

          yield* Deferred.await(started);
        });

      /**
       * Stream the task graph's summaries to `socket`, replacing a watch it already has. The first summary follows
       * shortly; a watch that fails is dropped and the client told.
       */
      const watchGraph = (socket: WebSocket) =>
        Effect.gen(function* () {
          const fibers = yield* watchesOf(socket);

          yield* setGraphWatched(socket, true);
          yield* host.taskGraph.pipe(
            Stream.runForEach((summary) => send(socket, { type: "task_graph", ...summary })),
            Effect.catch((error) =>
              setGraphWatched(socket, false).pipe(
                Effect.andThen(
                  send(socket, {
                    type: "error",
                    message: `Task graph watch ended: ${error.message}`,
                  }),
                ),
              ),
            ),
            FiberMap.run(fibers, TASK_GRAPH),
          );
        });

      const unwatchGraph = (socket: WebSocket) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          return (fibers === undefined ? Effect.void : FiberMap.remove(fibers, TASK_GRAPH)).pipe(
            Effect.andThen(setGraphWatched(socket, false)),
          );
        });

      const unwatch = (socket: WebSocket, conversationId: ConversationId) =>
        Effect.suspend(() => {
          const fibers = watching.get(socket);

          return fibers === undefined ? Effect.void : FiberMap.remove(fibers, conversationId);
        });

      const command = (
        socket: WebSocket,
        message: ClientMessage,
      ): Effect.Effect<{ readonly submissionId: number } | null, SessionError | SecretsError> => {
        switch (message.type) {
          case "submit": {
            const { type: _type, id: _id, ...prompt } = message;

            return host.submit(prompt).pipe(Effect.map((submissionId) => ({ submissionId })));
          }

          case "abort": {
            const { type: _type, id: _id, ...options } = message;

            return host.abort(options).pipe(Effect.as(null));
          }

          case "configure":
            return host
              .configure(agentChange(message))
              .pipe(Effect.andThen(announcePicks), Effect.as(null));
          case "watch":
            return watch(socket, message.conversationId).pipe(Effect.as(null));
          case "unwatch":
            return unwatch(socket, message.conversationId).pipe(
              Effect.andThen(setWatched(socket, message.conversationId, false)),
              Effect.as(null),
            );
          case "watch_task_graph":
            return watchGraph(socket).pipe(Effect.as(null));
          case "unwatch_task_graph":
            return unwatchGraph(socket).pipe(Effect.as(null));
          case "secret_answer":
            return secrets.answer(message.request, message.values).pipe(Effect.as(null));
        }
      };

      const receive = (socket: WebSocket, data: string | ArrayBuffer) =>
        Effect.gen(function* () {
          const text = Predicate.isString(data) ? data : new TextDecoder().decode(data);
          const decoded = yield* Effect.result(decodeClientMessage(text));

          if (Result.isFailure(decoded)) {
            const unreadable: ErrorMessage = {
              type: "error",
              message: `Unreadable message: ${decoded.failure.message}`,
            };

            const id = decodeCommandId(text);

            return yield* send(
              socket,
              Option.isSome(id) ? { ...unreadable, id: id.value.id } : unreadable,
            );
          }

          const message = decoded.success;
          const exit = yield* Effect.exit(command(socket, message));

          if (Exit.isSuccess(exit)) {
            if (message.id !== undefined) {
              yield* send(socket, { type: "result", id: message.id, result: exit.value });
            }

            return;
          }

          const error = Exit.findErrorOption(exit);

          const failure: ErrorMessage = {
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

      /** Tell `socket`, or every connected client, which of the model and thinking level the Session picked. */
      const announcePicks = host.picks.pipe(
        Effect.flatMap((picks) =>
          Effect.forEach(state.getWebSockets(), (socket) =>
            send(socket, { type: "picked", ...picks }),
          ),
        ),
        Effect.asVoid,
      );

      const connect = Effect.gen(function* () {
        // The default in force, so the client's first view shows what the next request runs on.
        yield* host.sync.pipe(
          Effect.catch((error) => Effect.logWarning("Syncing the agent on connect failed", error)),
        );

        const root = yield* host.root;
        const { 0: client, 1: server } = new WebSocketPair();

        state.acceptWebSocket(server);
        server.serializeAttachment({ watches: [] } satisfies Attachment);
        yield* send(server, { type: "hello", root });
        yield* host.picks.pipe(
          Effect.flatMap((picks) => send(server, { type: "picked", ...picks })),
        );

        // Requests for Secrets outlive the sockets that saw them: a client that reconnects is shown them again.
        const asks = yield* secrets.pending;

        if (asks.length > 0) yield* send(server, secretRequests(asks));

        // So are Browser Handoffs, which wait for the owner for up to 30 minutes.
        const pending = yield* handoffs.pending;

        if (pending.length > 0) yield* send(server, browserHandoffRequests(pending));

        return client;
      });

      // Sockets that outlived the last instance keep their watches, each from a fresh snapshot.
      for (const socket of state.getWebSockets()) {
        if (readAttachment(socket).taskGraph === true) yield* watchGraph(socket);

        for (const conversationId of readAttachment(socket).watches) {
          yield* watch(socket, conversationId).pipe(
            // The watch dropped itself, so the next instance does not retry it.
            Effect.catch((error) =>
              send(socket, { type: "error", conversationId, message: error.message }),
            ),
          );
        }
      }

      return { connect, receive, drop } satisfies SessionSocketsService;
    }),
  );
