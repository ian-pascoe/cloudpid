// A `tools/call` result over 1 MiB, as the Session reads it (`docs/architecture/mcp.md` → RPC edges, Large results;
// `docs/architecture/mcp-connections.md` → The engine): the engine's byte stream of the result's JSON, which the host
// returned unread. The Session reads it here, one result over `DECODE_SLOT_OVER` at a time per isolate, since a large
// result is read, decoded and parsed in memory: a few of them at once would not fit the object's 128 MB. The slot is held
// until the caller has cut the result to what the model or a script gets (`readStreamed`'s `use`), not only while it is
// read, and a read that stalls ends at its idle deadline, a wait for the slot at Stop.
// @effect-diagnostics asyncFunction:off newPromise:off missingPipeableSignature:off globalTimers:off -- a stream is read with Promises.
import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";
import { MiB } from "./ended.ts";

/** A result of more bytes than this takes the isolate's one decode slot (`mcp-connections.md` → The engine). */
export const DECODE_SLOT_OVER = 4 * MiB;

/**
 * The most bytes read of a stream: twice the 16 MiB the engine's byte limit allows, since the engine serializes the
 * result again, and escapes can make that longer than what the server sent.
 */
export const MAX_STREAMED_BYTES = 32 * MiB;

/** What reading a result's stream came to. */
export type Streamed =
  | { readonly kind: "value"; readonly value: Schema.Json }
  | { readonly kind: "too_large" }
  /** The stream broke, or was never read in time: the engine or the RPC was lost. */
  | { readonly kind: "lost" }
  /** What was read is not JSON. */
  | { readonly kind: "unreadable" }
  | { readonly kind: "aborted" };

/** The slot's queue: each holder waits for the one before it, and a waiter that gives up leaves the line in order. */
let queue: Promise<void> = Promise.resolve();

/**
 * Runs `work` when every holder before it is done, or answers `undefined` as soon as `signal` aborts while it waits:
 * Stop does not wait for the holder. A waiter that gave up still stands between the one before it and the one after, so
 * the one after waits for the same holder.
 */
const alone = async <A>(
  work: () => Promise<A>,
  signal: AbortSignal | undefined,
): Promise<A | undefined> => {
  const before = queue;
  const mine = Promise.withResolvers<void>();

  queue = before.then(() => mine.promise);

  try {
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal?.aborted === true) return resolve("aborted");

      signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });

    if ((await Promise.race([before.then(() => "turn" as const), aborted])) === "aborted") {
      return undefined;
    }

    return await work();
  } finally {
    mine.resolve();
  }
};

/** What reads a stream's chunks: how long it waits for the next one, and whom it answers to. */
export type StreamLimits = {
  /** Stop. */
  readonly signal?: AbortSignal | undefined;
  /** The longest the stream may be quiet before it is given up on as lost, in ms. */
  readonly idleMs: number;
};

/** The text of `body`, read to its end, or why it was not. */
const textOf = async (
  body: ReadableStream<Uint8Array>,
  limits: StreamLimits,
): Promise<{ readonly text: string } | Exclude<Streamed, { readonly kind: "value" }>> => {
  const { signal } = limits;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: Array<string> = [];
  const stop = () => void reader.cancel().catch(() => undefined);
  const stopped = () => signal?.aborted === true;
  let total = 0;
  let stalled = false;

  // The deadline between chunks: a stream that goes quiet is cancelled, which ends its read.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => clearTimeout(timer);

  const arm = () => {
    clear();
    timer = setTimeout(() => {
      stalled = true;
      stop();
    }, limits.idleMs);
  };

  arm();

  // Stopped while it waited for the slot.
  if (stopped()) {
    clear();
    stop();

    return { kind: "aborted" };
  }

  signal?.addEventListener("abort", stop, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      arm();
      total += value.byteLength;

      if (total > MAX_STREAMED_BYTES) {
        await reader.cancel().catch(() => undefined);

        return { kind: "too_large" };
      }

      parts.push(decoder.decode(value, { stream: true }));
    }

    parts.push(decoder.decode());
  } catch {
    return { kind: stopped() ? "aborted" : "lost" };
  } finally {
    clear();
    signal?.removeEventListener("abort", stop);
  }

  // A cancel ends the read as a normal end, with what came before it.
  if (stopped()) return { kind: "aborted" };

  return stalled ? { kind: "lost" } : { text: Arr.join(parts, "") };
};

/**
 * What `use` makes of the JSON value `body` carries (`bytes` long, as the engine says), or of why there is none. A result
 * over `DECODE_SLOT_OVER` is read, parsed and used under the isolate's decode slot: `use` runs inside it, so the slot is
 * not given up before the result is cut to what its caller keeps, and its text and value are then free to go. Stop
 * (`limits.signal`) cancels the stream, which lets the engine's bytes go, and ends a wait for the slot at once.
 */
export const readStreamed = <A>(
  body: ReadableStream<Uint8Array>,
  bytes: number,
  limits: StreamLimits,
  use: (streamed: Streamed) => Promise<A>,
): Promise<A> => {
  // The text is read and parsed in a function of its own, so only the value, not the text it came from, is held while
  // `use` runs.
  const parsed = async (): Promise<Streamed> => {
    const got = await textOf(body, limits);

    if ("kind" in got) return got;

    try {
      // SAFETY: the engine serialized a `tools/call` result's JSON; anything else is caught as unreadable.
      return { kind: "value", value: JSON.parse(got.text) as Schema.Json };
    } catch {
      return { kind: "unreadable" };
    }
  };

  const read = async (): Promise<A> => use(await parsed());

  if (bytes <= DECODE_SLOT_OVER) return read();

  return alone(read, limits.signal).then((done) => {
    if (done !== undefined) return done;

    // Stopped while it waited for the slot: the stream is let go unread.
    void body.cancel().catch(() => undefined);

    return use({ kind: "aborted" });
  });
};
