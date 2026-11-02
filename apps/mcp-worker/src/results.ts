/**
 * A request's value as the engine returns it (`docs/architecture/mcp-connections.md` → The engine, Large results;
 * #382 D9.2): serialized once, with every access token the call sent replaced by `[REDACTED]`
 * (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object), then inline up to 1 MiB, else as a native byte
 * stream produced on pull, which RPC neither clones nor counts and the host returns unread (#409 answer 3).
 */
// @effect-diagnostics preferSchemaOverJson:off -- a server's answer, already decoded by the SDK, serialized to bytes once.
import type { ListItems, ListKind, McpConnection } from "@cloudpid/mcp";
import type { McpEngineValue } from "@cloudpid/mcp/types";
import { ProtocolViolation } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CallEnvironment, CallSession } from "./session.ts";

const MiB = 1024 * 1024;

/** A value serialized to more than this goes back as a byte stream (D9.2). */
export const INLINE_LIMIT = MiB;

/** The size of the pieces a large value's stream yields. */
const STREAM_CHUNK = 64 * 1024;

const REDACTED = "[REDACTED]";

/** What a request completes with: a `tools/call` result, or a list's items. */
export type Answer =
  | Effect.Success<ReturnType<McpConnection["callTool"]>>["value"]
  | ReadonlyArray<ListItems[ListKind]>;

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

/** The JSON text of `value`, with every token in `tokens` replaced. */
const scrubbedJson = (value: Answer, tokens: ReadonlySet<string>) =>
  Effect.try({
    try: () => {
      let text = JSON.stringify(value);

      for (const token of tokens) {
        // The token as it appears inside a JSON string.
        text = text.replaceAll(JSON.stringify(token).slice(1, -1), REDACTED);
      }

      return text;
    },
    catch: () => ProtocolViolation.make({ message: "Not an MCP server: its answer is not JSON" }),
  });

/** `bytes` as a stream that yields one piece at each pull, calling `done` once it is read or cancelled. */
const byteStream = (bytes: Uint8Array, done: () => void) => {
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (offset >= bytes.byteLength) {
        controller.close();
        done();

        return;
      }

      controller.enqueue(bytes.slice(offset, offset + STREAM_CHUNK));
      offset += STREAM_CHUNK;
    },
    cancel: () => done(),
  });
};

/**
 * `value` as the call returns it. A stream keeps the call's lease on the byte budget, and its invocation, until it is
 * read or cancelled; an inline value leaves the lease to the call.
 */
export const valueOf = Effect.fn("mcp.engine.value")(function* (
  value: Answer,
  session: CallSession,
  env: CallEnvironment,
) {
  const json = yield* scrubbedJson(value, session.tokens);
  const bytes = new TextEncoder().encode(json);

  if (bytes.byteLength <= INLINE_LIMIT) {
    const inline = yield* decodeJson(json).pipe(
      Effect.mapError(() =>
        ProtocolViolation.make({ message: "Not an MCP server: its answer is not JSON" }),
      ),
    );

    return { kind: "inline", value: inline } satisfies McpEngineValue;
  }

  const read = Promise.withResolvers<void>();

  env.hold(read.promise);

  return {
    kind: "stream",
    body: byteStream(bytes, () => {
      session.lease.release();
      read.resolve();
    }),
    bytes: bytes.byteLength,
  } satisfies McpEngineValue;
});
