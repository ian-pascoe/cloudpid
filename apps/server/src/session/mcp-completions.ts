// What a socket's completions have in common (`docs/architecture/mcp-in-a-session.md` → As built (#485): completion): the
// argument form's requests, which reach an MCP server, are counted for each socket over the last minute, kept in flight by
// their `requestId`, and a newer request for a form field ends the older one of the same field. Each answer is a
// `McpCompletion`, whatever happens: a request that is over a limit, a failure, and one ended all answer `failed` (nothing
// reads the answer of one that was ended).
// @effect-diagnostics missingPipeableSignature:off preferEffectRecord:off -- the fields of a socket's form are a small map.
import {
  MAX_MCP_COMPLETE_IN_FLIGHT,
  MAX_MCP_COMPLETE_PER_MINUTE,
  MCP_COMPLETION_STATUS,
  type McpCompletion,
  noCompletion,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { socketRequests } from "./socket-requests.ts";

/** What one request asks, as the socket got it, and the signal that ends it. */
export type CompletionRequest = {
  readonly requestId: string;
  readonly field: string;
};

/** The completions of every socket, over `run`, which completes one request and ends when `signal` aborts. */
export type SocketCompletions = {
  /** Complete `request` for `socket`: its answer however it ends, never a failure. */
  readonly complete: <E>(
    socket: WebSocket,
    request: CompletionRequest,
    run: (signal: AbortSignal) => Effect.Effect<McpCompletion, E>,
  ) => Effect.Effect<McpCompletion>;
  /** End the request `requestId` of `socket` if it is still running. */
  readonly cancel: (socket: WebSocket, requestId: string) => void;
  /** The socket went: everything it has in flight ends and what it counted is forgotten. */
  readonly end: (socket: WebSocket) => void;
};

/** The completions of every socket, counting the minute by `now`. */
export const socketCompletions = (now: () => number): SocketCompletions => {
  const requests = socketRequests(now);
  // The request each field of a socket's form is waiting on.
  const fieldsOf = new WeakMap<WebSocket, Map<string, string>>();

  return {
    complete: (socket, request, run) =>
      Effect.suspend(() => {
        const requester = requests.of(socket);
        const fields = fieldsOf.get(socket) ?? new Map<string, string>();
        const older = fields.get(request.field);

        fieldsOf.set(socket, fields);

        if (older !== undefined) requester.abort(older);

        // A request that is over a limit, or names one in flight already, is not sent: nothing reads its answer.
        if (
          !requester.admits("complete", MAX_MCP_COMPLETE_PER_MINUTE) ||
          requester.inFlight() >= MAX_MCP_COMPLETE_IN_FLIGHT ||
          requester.running(request.requestId)
        ) {
          return Effect.succeed(noCompletion(MCP_COMPLETION_STATUS.failed));
        }

        const stop = requester.start(request.requestId);

        fields.set(request.field, request.requestId);

        return run(stop.signal).pipe(
          Effect.catchCause(() => Effect.succeed(noCompletion(MCP_COMPLETION_STATUS.failed))),
          Effect.ensuring(
            Effect.sync(() => {
              requester.finish(request.requestId);

              if (fields.get(request.field) === request.requestId) fields.delete(request.field);
            }),
          ),
        );
      }),
    cancel: (socket, requestId) => {
      requests.find(socket)?.abort(requestId);
    },
    end: (socket) => {
      requests.end(socket);
      fieldsOf.delete(socket);
    },
  };
};
