// A `tools/call` result over 1 MiB, as the Session reads it (`docs/architecture/mcp.md` → RPC edges, Large results;
// `docs/architecture/mcp-connections.md` → The engine): the engine's byte stream of the result's JSON, which the host
// returned unread. The Session reads it here, one result over `DECODE_SLOT_OVER` at a time per isolate, since a large
// result is read, decoded and parsed in memory: a few of them at once would not fit the object's 128 MB. The slot is held
// until the caller has cut the result to what the model or a script gets (`readStreamed`'s `use`), not only while it is
// read, and a read that stalls ends at its idle deadline, and a wait for the slot at Stop or at its own, shorter than the engine's, deadline.
// @effect-diagnostics asyncFunction:off newPromise:off missingPipeableSignature:off globalTimers:off -- a stream is read with Promises.
import { MCP_STREAM_HOLD_MS, MiB } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";

/** A result of more bytes than this takes the isolate's one decode slot (`mcp-connections.md` → The engine). */
export const DECODE_SLOT_OVER = 4 * MiB;

/**
 * The most bytes read of a stream: twice the 16 MiB the engine's byte limit allows, since the engine serializes the
 * result again, and escapes can make that longer than what the server sent.
 */
export const MAX_STREAMED_BYTES = 32 * MiB;

/**
 * The longest a result's stream waits for the decode slot, in ms: 15 s under what the engine holds a stream unread
 * (`MCP_STREAM_HOLD_MS`, which it counts from the result's return), so a waiter gives up and says so before the engine
 * errors its stream and the wait would read as a break. The read that follows renews the engine's hold with each pull.
 */
export const MCP_STREAM_SLOT_WAIT_MS = MCP_STREAM_HOLD_MS - 15_000;

/** What reading a result's stream came to. */
export type Streamed =
  | { readonly kind: "value"; readonly value: Schema.Json }
  | { readonly kind: "too_large" }
  /** The stream broke, or was never read in time: the engine or the RPC was lost. */
  | { readonly kind: "lost" }
  /** The wait for the slot passed `MCP_STREAM_SLOT_WAIT_MS`, so the engine would have let the stream go. */
  | { readonly kind: "waited" }
  /** What was read is not JSON. */
  | { readonly kind: "unreadable" }
  | { readonly kind: "aborted" };

/** The slot's queue: each holder waits for the one before it, and a waiter that gives up leaves the line in order. */
let queue: Promise<void> = Promise.resolve();

/**
 * Runs `work` when every holder before it is done, or says why it did not: `signal` aborted (Stop does not wait for the
 * holder) or `waitMs` passed while it waited. A waiter that gave up still stands between the one before it and the one
 * after, so the one after waits for the same holder.
 */
const alone = async <A>(
  work: () => Promise<A>,
  signal: AbortSignal | undefined,
  waitMs: number,
): Promise<{ readonly kind: "ran"; readonly ran: A } | { readonly kind: "aborted" | "waited" }> => {
  const before = queue;
  const mine = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  queue = before.then(() => mine.promise);

  try {
    const given = new Promise<"aborted" | "waited">((resolve) => {
      if (signal?.aborted === true) return resolve("aborted");

      signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
      timer = setTimeout(() => resolve("waited"), waitMs);
    });

    const turn = await Promise.race([before.then(() => "turn" as const), given]);

    if (turn !== "turn") return { kind: turn };

    clearTimeout(timer);

    return { kind: "ran", ran: await work() };
  } finally {
    clearTimeout(timer);
    mine.resolve();
  }
};

/** What reads a stream's chunks: how long it waits for the next one, and whom it answers to. */
export type StreamLimits = {
  /** Stop. */
  readonly signal?: AbortSignal | undefined;
  /** The longest the stream may be quiet before it is given up on as lost, in ms. */
  readonly idleMs: number;
  /** The longest it waits for the decode slot, `MCP_STREAM_SLOT_WAIT_MS` unless a test shortens it. */
  readonly waitMs?: number;
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

  return alone(read, limits.signal, limits.waitMs ?? MCP_STREAM_SLOT_WAIT_MS).then((done) => {
    if (done.kind === "ran") return done.ran;

    // Stopped, or too long in line: the stream is let go unread.
    void body.cancel().catch(() => undefined);

    return use({ kind: done.kind });
  });
};
