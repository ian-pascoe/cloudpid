/**
 * A request's value as the engine returns it (`docs/architecture/mcp-connections.md` → The engine, Large results;
 * #382 D9.2): serialized once, with every access token the call sent replaced by `[REDACTED]`
 * (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object), then inline up to 1 MiB, else as a native byte
 * stream produced on pull, which RPC neither clones nor counts and the host returns unread (#409 answer 3). A failed
 * call's error is scrubbed of the same tokens.
 */
// @effect-diagnostics globalJsonInEffect:off -- a server's answer, already decoded by the SDK, serialized to bytes once.
// @effect-diagnostics globalTimers:off -- a stream's expiry timer, in the invocation that made it.
// @effect-diagnostics missingPipeableSignature:off -- `byteStream` is a plain function over bytes, not a combinator.
import type { ListItems, ListKind, McpConnection } from "@cloudpid/mcp";
import { McpErrorWire, type McpEngineValue, ProtocolViolation } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { STREAM_HOLD_MS } from "./budget.ts";
import type { CallContext, CallEnvironment } from "./call-context.ts";
import { scrubValues } from "./scrub.ts";
import { MiB } from "./units.ts";

/** A value serialized to more than this goes back as a byte stream (D9.2). */
export const INLINE_LIMIT = MiB;

/** The size of the pieces a large value's stream yields. */
const STREAM_CHUNK = 64 * 1024;

/** What a request completes with: a `tools/call` result, a `resources/read`, `prompts/get` or `completion/complete` result, or a list's items. */
export type Answer =
  | Extract<
      Effect.Success<ReturnType<McpConnection["callTool"]>>,
      { readonly kind: "complete" }
    >["value"]
  | Extract<
      Effect.Success<ReturnType<McpConnection["readResource"]>>,
      { readonly kind: "complete" }
    >["value"]
  | Effect.Success<ReturnType<McpConnection["getPrompt"]>>["value"]
  | Effect.Success<ReturnType<McpConnection["complete"]>>["value"]
  | ReadonlyArray<ListItems[ListKind]>
  | { readonly [key: string]: ReadonlyArray<ListItems[ListKind]> | string };

/** A server's answer the engine cannot read: the server is not speaking MCP. */
export const malformed = (what: string) =>
  ProtocolViolation.make({ message: `Not an MCP server: ${what} is malformed` });

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

/** The JSON text of `value`, with every token in `tokens` replaced in its string values (never its keys or numbers). */
const scrubbedJson = (value: Answer, tokens: ReadonlySet<string>) =>
  Effect.try({
    try: () => JSON.stringify(scrubValues(value, tokens)),
    catch: () => malformed("its answer"),
  });

const encodeError = Schema.encodeEffect(McpErrorWire);

const decodeError = Schema.decodeEffect(McpErrorWire);

/**
 * `error` with every token in `tokens` replaced in its string values, since a server's error message may echo what it was
 * sent; its code and shape stay. One that does not come back whole reads as a server not speaking MCP, never as the
 * original.
 */
export const scrubError = Effect.fnUntraced(function* (
  error: McpErrorWire,
  tokens: ReadonlySet<string>,
) {
  if (tokens.size === 0) {
    return error;
  }

  return yield* encodeError(error).pipe(
    Effect.flatMap((wire) => decodeError(scrubValues(wire, tokens))),
    Effect.orElseSucceed((): McpErrorWire => malformed("its error")),
  );
});

/** What a value's stream tells its call. */
export interface StreamHooks {
  /** At each pull: the stream is being read. */
  readonly pulled: () => void;
  /** Once, when the stream is read, cancelled, or expired. */
  readonly done: () => void;
}

/**
 * `bytes` as a stream that yields one piece at each pull. Left unpulled for `holdMs`, it errors and lets its bytes
 * go; its timer runs in the invocation that made it, which the call holds until `done`.
 */
export const byteStream = (input: Uint8Array, holdMs: number, hooks: StreamHooks) => {
  let bytes: Uint8Array | undefined = input;
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    clearTimeout(timer);

    if (bytes !== undefined) {
      bytes = undefined;
      hooks.done();
    }
  };

  const renew = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (bytes !== undefined) {
        controller.error(new Error("The result was not read in time"));
        finish();
      }
    }, holdMs);
  };

  return new ReadableStream<Uint8Array>({
    start: renew,
    pull: (controller) => {
      if (bytes === undefined || offset >= bytes.byteLength) {
        controller.close();
        finish();

        return;
      }

      hooks.pulled();
      renew(controller);
      controller.enqueue(bytes.slice(offset, offset + STREAM_CHUNK));
      offset += STREAM_CHUNK;
    },
    cancel: finish,
  });
};

/**
 * `value` as the call returns it. A stream takes the call's lease, and holds its invocation, until it is read,
 * cancelled, or left unread for `STREAM_HOLD_MS` (`budget.ts`); an inline value leaves the lease to the call.
 */
export const toEngineValue = Effect.fn("mcp.engine.value")(function* (
  value: Answer,
  call: CallContext,
  env: CallEnvironment,
) {
  const json = yield* scrubbedJson(value, call.tokens);
  const bytes = new TextEncoder().encode(json);

  if (bytes.byteLength <= INLINE_LIMIT) {
    const inline = yield* decodeJson(json).pipe(Effect.mapError(() => malformed("its answer")));

    return { kind: "inline", value: inline } satisfies McpEngineValue;
  }

  const read = Promise.withResolvers<void>();

  env.hold(read.promise);
  call.handOff();
  call.lease.expireIn(STREAM_HOLD_MS);

  return {
    kind: "stream",
    body: byteStream(bytes, STREAM_HOLD_MS, {
      // Each pull renews the lease's expiry, so only a stream left unread loses it.
      pulled: () => call.lease.expireIn(STREAM_HOLD_MS),
      done: () => {
        call.lease.release();
        read.resolve();
      },
    }),
    bytes: bytes.byteLength,
  } satisfies McpEngineValue;
});
