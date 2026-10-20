// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// Reading a response: the status as a short cause, and the body within a byte limit. Ported from pi-web-tools'
// `src/web-response.ts` (see ../../NOTICE.md), as Effects, and without Node's `http.STATUS_CODES`.
import * as Effect from "effect/Effect";
import { WebToolError } from "./errors.ts";

const STATUS_PHRASES: ReadonlyMap<number, string> = new Map([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [402, "Payment Required"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [406, "Not Acceptable"],
  [408, "Request Timeout"],
  [409, "Conflict"],
  [410, "Gone"],
  [415, "Unsupported Media Type"],
  [418, "I'm a Teapot"],
  [429, "Too Many Requests"],
  [451, "Unavailable For Legal Reasons"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
]);

/** The cause of a response that is not a success: its status and the standard phrase, never server-supplied text. */
export const statusCause = (status: number): string => {
  const phrase = STATUS_PHRASES.get(status);

  return phrase === undefined ? `HTTP ${status}` : `HTTP ${status} ${phrase}`;
};

const formatByteLimit = (bytes: number): string =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes}-byte`;

const tooLarge = (maximumBytes: number): WebToolError =>
  WebToolError.make({
    message: `response body exceeds the ${formatByteLimit(maximumBytes)} limit`,
  });

/** Drop a response's body without reading it. */
export const discardBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore);

/** What a bounded read found. */
type Read = { readonly bytes: Uint8Array } | { readonly tooLarge: true };

/**
 * Read a response's body incrementally, never holding more than `maximumBytes`: a larger declared or streamed body
 * fails and the rest is cancelled. Interrupting the Effect cancels the read.
 */
export const readBoundedBody = (
  response: Response,
  maximumBytes: number,
): Effect.Effect<Uint8Array, WebToolError> =>
  Effect.tryPromise({
    // @effect-diagnostics-next-line asyncFunction:off
    try: async (signal): Promise<Read> => {
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);

      if (Number.isSafeInteger(declared) && declared > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);

        return { tooLarge: true };
      }

      if (response.body === null) return { bytes: new Uint8Array() };

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const abort = (): void => void reader.cancel().catch(() => undefined);

      signal.addEventListener("abort", abort, { once: true });

      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- chunks arrive in order
          const chunk = await reader.read();

          if (chunk.done) break;

          if (total + chunk.value.byteLength > maximumBytes) {
            await reader.cancel().catch(() => undefined);

            return { tooLarge: true };
          }

          chunks.push(chunk.value);
          total += chunk.value.byteLength;
        }
      } finally {
        signal.removeEventListener("abort", abort);
        reader.releaseLock();
      }

      const bytes = new Uint8Array(total);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return { bytes };
    },
    catch: () => WebToolError.make({ message: "network error while reading the response body" }),
  }).pipe(
    Effect.flatMap((read) =>
      "bytes" in read ? Effect.succeed(read.bytes) : Effect.fail(tooLarge(maximumBytes)),
    ),
  );
