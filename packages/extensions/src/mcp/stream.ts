// A `tools/call` result over 1 MiB, as the Session reads it (`docs/architecture/mcp.md` → RPC edges, Large results;
// `docs/architecture/mcp-connections.md` → The engine): the engine's byte stream of the result's JSON, which the host
// returned unread. The Session reads it here, one result over `DECODE_SLOT_OVER` at a time per isolate, since a large
// result is read, decoded and parsed in memory: a few of them at once would not fit the object's 128 MB.
// @effect-diagnostics asyncFunction:off newPromise:off missingPipeableSignature:off -- a stream is read with Promises.
import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";

const MiB = 1024 * 1024;

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

/** The slot's queue: each holder waits for the one before it. */
let queue: Promise<void> = Promise.resolve();

/** Runs `work` when every holder before it is done. */
const alone = async <A>(work: () => Promise<A>): Promise<A> => {
  const before = queue;
  const gate = Promise.withResolvers<void>();

  queue = gate.promise;

  await before;

  try {
    return await work();
  } finally {
    gate.resolve();
  }
};

/** The text of `body`, read to its end: `undefined` past `MAX_STREAMED_BYTES` or when it breaks, with why. */
const textOf = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<{ readonly text: string } | { readonly kind: "too_large" | "lost" | "aborted" }> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: Array<string> = [];
  const stop = () => void reader.cancel().catch(() => undefined);
  const stopped = () => signal?.aborted === true;
  let total = 0;

  // Stopped while it waited for the slot.
  if (stopped()) {
    stop();

    return { kind: "aborted" };
  }

  signal?.addEventListener("abort", stop, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

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
    signal?.removeEventListener("abort", stop);
  }

  // A cancel ends the read as a normal end, with what came before it.
  return stopped() ? { kind: "aborted" } : { text: Arr.join(parts, "") };
};

/**
 * The JSON value `body` carries (`bytes` long, as the engine says): read and parsed under the isolate's decode slot
 * when it is over `DECODE_SLOT_OVER`. Stop (`signal`) cancels the stream, which lets the engine's bytes go.
 */
export const readStreamed = (
  body: ReadableStream<Uint8Array>,
  bytes: number,
  signal: AbortSignal | undefined,
): Promise<Streamed> => {
  const read = async (): Promise<Streamed> => {
    const got = await textOf(body, signal);

    if ("kind" in got) return got;

    try {
      // SAFETY: the engine serialized a `tools/call` result's JSON; anything else is caught as unreadable.
      return { kind: "value", value: JSON.parse(got.text) as Schema.Json };
    } catch {
      return { kind: "unreadable" };
    }
  };

  return bytes > DECODE_SLOT_OVER ? alone(read) : read();
};
