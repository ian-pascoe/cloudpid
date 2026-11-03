/**
 * A request's value as the engine returns it (`docs/architecture/mcp-connections.md` → The engine, Large results;
 * #382 D9.2): serialized once, with every access token the call sent replaced by `[REDACTED]`
 * (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object), then inline up to 1 MiB, else as a native byte
 * stream produced on pull, which RPC neither clones nor counts and the host returns unread (#409 answer 3). A failed
 * call's error is scrubbed of the same tokens.
 */
// @effect-diagnostics preferSchemaOverJson:off -- a server's answer, already decoded by the SDK, serialized to bytes once.
// @effect-diagnostics globalTimers:off -- a stream's expiry timer, in the invocation that made it.
// @effect-diagnostics missingPipeableSignature:off -- `byteStream` is a plain function over bytes, not a combinator.
import type { ListItems, ListKind, McpConnection } from "@cloudpid/mcp";
import { McpErrorWire, type McpEngineValue, ProtocolViolation } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import { STREAM_HOLD_MS } from "./budget.ts";
import type { CallContext, CallEnvironment } from "./call-context.ts";
import { MiB } from "./units.ts";

/** A value serialized to more than this goes back as a byte stream (D9.2). */
export const INLINE_LIMIT = MiB;

/** The size of the pieces a large value's stream yields. */
const STREAM_CHUNK = 64 * 1024;

const REDACTED = "[REDACTED]";

/** What a request completes with: a `tools/call` result, or a list's items. */
export type Answer =
  | Effect.Success<ReturnType<McpConnection["callTool"]>>["value"]
  | ReadonlyArray<ListItems[ListKind]>;

/** A server's answer the engine cannot read: the server is not speaking MCP. */
export const malformed = (what: string) =>
  ProtocolViolation.make({ message: `Not an MCP server: ${what} is malformed` });

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

/** `forms` replaced in `text`, longest first, so a form that contains another (an old token and its refresh) leaves no remainder. */
const replaceForms = (text: string, forms: ReadonlyArray<string>) => {
  let scrubbed = text;

  for (const form of Arr.sort(
    Arr.filter(forms, (each) => each.length > 0),
    Order.mapInput(Order.Number, (form: string) => -form.length),
  )) {
    scrubbed = scrubbed.replaceAll(form, REDACTED);
  }

  return scrubbed;
};

/** `token` as it appears inside a JSON string: a `"` or a `\` escaped. */
const escapedForm = (token: string) => JSON.stringify(token).slice(1, -1);

/**
 * `text`, the text of a JSON value, with every token in `tokens` replaced as it appears inside a JSON string. Not the
 * raw form, which could match the JSON's own structure.
 */
export const scrubText = (text: string, tokens: ReadonlySet<string>) =>
  replaceForms(text, Arr.map([...tokens], escapedForm));

/**
 * `text`, a string that stands alone (a log's data), with every token in `tokens` replaced in both forms: as it is, and
 * as it would be inside a JSON string, since a server may echo either (a value with a `"` or a `\` differs in the two).
 */
export const scrubRaw = (text: string, tokens: ReadonlySet<string>) =>
  replaceForms(
    text,
    Arr.flatMap([...tokens], (token) => [token, escapedForm(token)]),
  );

/**
 * `encoded`, a value as it crosses RPC, with every token in `tokens` replaced in the text of all of it: through its
 * JSON text and back, which fails for what does not read back.
 */
export const scrubEncoded = <I>(
  schema: Schema.Codec<I, I>,
  encoded: I,
  tokens: ReadonlySet<string>,
) => {
  const json = Schema.fromJsonString(schema);

  return Schema.encodeEffect(json)(encoded).pipe(
    Effect.map((text) => scrubText(text, tokens)),
    Effect.flatMap(Schema.decodeEffect(json)),
  );
};

/** The JSON text of `value`, with every token in `tokens` replaced. */
const scrubbedJson = (value: Answer, tokens: ReadonlySet<string>) =>
  Effect.try({
    try: () => scrubText(JSON.stringify(value), tokens),
    catch: () => malformed("its answer"),
  });

const ErrorJson = Schema.fromJsonString(McpErrorWire);

/**
 * `error` with every token in `tokens` replaced in its fields, since a server's error message may echo what it was
 * sent. One that does not come back whole reads as a server not speaking MCP, never as the original.
 */
export const scrubError = Effect.fnUntraced(function* (
  error: McpErrorWire,
  tokens: ReadonlySet<string>,
) {
  if (tokens.size === 0) {
    return error;
  }

  return yield* Schema.encodeEffect(ErrorJson)(error).pipe(
    Effect.flatMap((json) => Schema.decodeEffect(ErrorJson)(scrubText(json, tokens))),
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
