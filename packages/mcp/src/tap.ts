/**
 * The core's `fetch` tap: what the core does at the `fetch` seam, around the injected `fetch`, before the SDK sees a
 * response (`docs/architecture/mcp.md` → Protocol eras; `docs/architecture/mcp-connections.md` → Failures and cuts,
 * Requests and Legacy sessions; The MCP core #394 D2, D15, D16).
 *
 * - **Retries:** a 408 or 429 on the `server/discover` probe is retried once after `Retry-After` (at most 10 s, else
 *   1 s), then reads as unavailable, never as Legacy; read-only requests retry once on a 408, 429 or 5xx.
 * - **Redirects:** a redirect to another origin fails the request, with no further request.
 * - **Byte limits:** counted over the raw body or the whole SSE stream; a `Content-Length` over the limit is refused
 *   before reading.
 * - **Cuts:** an SSE stream that ends without its answer fails its request at once, since the SDK neither reconnects
 *   nor fails it (it drops `onRequestStreamEnd` for requests).
 * - **Not MCP:** a 2xx answer to a request that is neither JSON-RPC JSON nor an SSE stream.
 *
 * A verdict on a request reaches the SDK as a JSON-RPC error answering it, carrying a token the core maps back to the
 * `McpError` (`Verdicts`), so the request fails at once whatever the SDK does with a broken stream. On the probe, which
 * reads any JSON-RPC error as Legacy, the verdict is thrown from `fetch` instead.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off missingPipeableSignature:off preferEffectArray:off
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Cut,
  type McpError,
  ProtocolViolation,
  ServerError,
  TooLarge,
  Unreachable,
} from "./types.ts";

const MiB = 1024 * 1024;

/** Requests answered with up to 16 MiB; everything else gets 1 MiB (D16). */
const LARGE_ANSWERS = new Set([
  "tools/call",
  "tasks/get",
  "resources/read",
  "prompts/get",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

/** Requests that change nothing, retried once on a 408, 429 or 5xx (D15). */
const READ_ONLY = new Set([
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/get",
  "tasks/get",
]);

const PROBE = "server/discover";

const MAX_RETRY_AFTER_MS = 10_000;

const DEFAULT_RETRY_AFTER_MS = 1000;

/** The JSON-RPC error data key that carries a verdict's token. */
export const VERDICT_KEY = "cloudpid/verdict";

/** The limit on the answer to `method` (D16). */
export const answerLimit = (method: string) => (LARGE_ANSWERS.has(method) ? 16 * MiB : MiB);

/** The tap's verdicts on requests, by token, until the core reads them back from the SDK's error. */
export class Verdicts {
  private readonly pending = new Map<number, McpError>();

  private next = 0;

  /** Keeps `error` and returns its token. */
  issue(error: McpError) {
    this.next += 1;
    this.pending.set(this.next, error);

    return this.next;
  }

  /** The verdict `token` names, once. */
  take(token: number) {
    const error = this.pending.get(token);

    this.pending.delete(token);

    return error;
  }
}

/** What the tap needs besides the injected `fetch`: the clock (Effect's, through the connection's context). */
export interface TapClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const OutgoingRequest = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
    method: Schema.optionalKey(Schema.String),
  }),
);

const decodeOutgoing = Schema.decodeUnknownOption(OutgoingRequest);

/** A JSON-RPC request the SDK is sending: one with an id and a method. */
interface Outgoing {
  readonly id: string | number;
  readonly method: string;
}

const outgoing = (init: RequestInit | undefined): Outgoing | undefined =>
  Option.match(decodeOutgoing(init?.body), {
    onNone: () => undefined,
    onSome: ({ id, method }) =>
      id === undefined || method === undefined ? undefined : { id, method },
  });

const JsonRpcAnswer = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Null])),
});

const decodeJsonRpcBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([JsonRpcAnswer, Schema.NonEmptyArray(JsonRpcAnswer)])),
);

/** A message on a stream: an answer to the request has its id and no method (a server's own request has one). */
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Null])),
      method: Schema.optionalKey(Schema.String),
    }),
  ),
);

const mediaType = (response: Response) =>
  response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

/** `Retry-After` as a delay: seconds or an HTTP date, at most 10 s; 1 s when absent or unreadable. */
const retryAfter = (response: Response, now: number) => {
  const header = response.headers.get("retry-after");

  if (header === null) {
    return DEFAULT_RETRY_AFTER_MS;
  }

  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;

  return Number.isFinite(delay)
    ? Math.min(Math.max(delay, 0), MAX_RETRY_AFTER_MS)
    : DEFAULT_RETRY_AFTER_MS;
};

const shouldRetry = (request: Outgoing | undefined, status: number) => {
  if (request === undefined) {
    return false;
  }

  if (request.method === PROBE) {
    return status === 408 || status === 429;
  }

  return READ_ONLY.has(request.method) && (status === 408 || status === 429 || status >= 500);
};

const redirectedAway = (request: string | URL, response: Response) => {
  const location = response.headers.get("location");

  if (response.status < 300 || response.status > 399 || location === null) {
    return undefined;
  }

  const from = new URL(request);
  const to = new URL(location, from);

  return to.origin === from.origin ? undefined : to.origin;
};

const cut = (request: Outgoing, message: string) =>
  request.method === "tools/call"
    ? Cut.make({ message: `${message}; it may or may not have run`, mayHaveRun: true })
    : Cut.make({ message, mayHaveRun: false });

/** An SSE `message` event answering `request` with a JSON-RPC error that carries the verdict's token. */
const verdictEvent = (request: Outgoing, error: McpError, verdicts: Verdicts) =>
  `\n\nevent: message\ndata: ${JSON.stringify(verdictMessage(request, error, verdicts))}\n\n`;

const verdictMessage = (request: Outgoing, error: McpError, verdicts: Verdicts) => ({
  jsonrpc: "2.0",
  id: request.id,
  error: { code: -32603, message: error.message, data: { [VERDICT_KEY]: verdicts.issue(error) } },
});

const encoder = new TextEncoder();

/**
 * `body` as it arrives, counted against `limit`, watched for the answer to `request`: when the stream ends or breaks
 * without it, or runs over the limit, the stream ends with the verdict instead.
 */
const watchStream = (
  body: ReadableStream<Uint8Array>,
  request: Outgoing,
  limit: number,
  verdicts: Verdicts,
) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = "";
  let answered = false;

  const scan = (text: string) => {
    const events = (pending + text).split(/\r?\n\r?\n/);

    pending = events.pop() ?? "";

    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      Option.map(decodeAnswer(data), (message) => {
        if (message.id === request.id && message.method === undefined) {
          answered = true;
        }
      });
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // The probe reads any JSON-RPC error as Legacy, so it gets no verdict: a stream that ends without its answer
      // runs to the probe's timeout (D2), and one over the limit breaks.
      const end = (error: McpError) => {
        if (request.method !== PROBE) {
          controller.enqueue(encoder.encode(verdictEvent(request, error, verdicts)));
        }

        controller.close();
      };

      let chunk: ReadableStreamReadResult<Uint8Array>;

      try {
        chunk = await reader.read();
      } catch {
        return answered
          ? controller.close()
          : end(cut(request, "The stream broke before its answer arrived"));
      }

      if (chunk.done) {
        return answered
          ? controller.close()
          : end(cut(request, "The stream ended before its answer arrived"));
      }

      bytes += chunk.value.byteLength;

      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);

        return request.method === PROBE ? controller.error(tooLarge(limit)) : end(tooLarge(limit));
      }

      scan(decoder.decode(chunk.value, { stream: true }));
      controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
};

const tooLarge = (limit: number) =>
  TooLarge.make({ message: `The answer is over ${limit / MiB} MiB and was dropped`, limit });

/** The whole of `body`, or `undefined` once it runs over `limit`. */
const readUpTo = async (body: ReadableStream<Uint8Array>, limit: number) => {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let bytes = 0;

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    bytes += chunk.value.byteLength;

    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);

      return undefined;
    }

    chunks.push(chunk.value);
  }

  const whole = new Uint8Array(bytes);
  let offset = 0;

  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return whole;
};

/** The tap over `fetch` for one connection. */
export const tapFetch = (fetch: FetchLike, clock: TapClock, verdicts: Verdicts): FetchLike => {
  /** Fails `request` with `error`: thrown on the probe, answered as a JSON-RPC error otherwise. */
  const fail = (request: Outgoing, error: McpError, response: Response) => {
    if (request.method === PROBE) {
      throw error;
    }

    const headers = new Headers();
    const session = response.headers.get("mcp-session-id");

    if (session !== null) {
      headers.set("mcp-session-id", session);
    }

    return Response.json(verdictMessage(request, error, verdicts), { headers });
  };

  const send = async (
    input: string | URL,
    init: RequestInit | undefined,
    request: Outgoing | undefined,
  ) => {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (init?.signal?.aborted === true || request === undefined) {
        throw error;
      }

      throw request.method === "tools/call"
        ? cut(request, "The connection failed")
        : Unreachable.make({ message: `The server could not be reached: ${String(error)}` });
    }
  };

  return async (input, init) => {
    const request = outgoing(init);
    let response = await send(input, init, request);

    if (shouldRetry(request, response.status)) {
      await response.body?.cancel().catch(() => undefined);
      await clock.sleep(retryAfter(response, clock.now()));
      response = await send(input, init, request);

      if (request?.method === PROBE && (response.status === 408 || response.status === 429)) {
        await response.body?.cancel().catch(() => undefined);

        throw Unreachable.make({
          message: `The server answered HTTP ${response.status} twice; try again later`,
          status: response.status,
        });
      }
    }

    const away = redirectedAway(input, response);

    if (away !== undefined) {
      await response.body?.cancel().catch(() => undefined);

      throw ServerError.make({
        message: `The server redirects to ${away}, another origin; not followed`,
        status: response.status,
      });
    }

    if (
      request === undefined ||
      !response.ok ||
      response.status === 202 ||
      response.body === null
    ) {
      return response;
    }

    const limit = answerLimit(request.method);
    const length = Number(response.headers.get("content-length") ?? "0");

    if (length > limit) {
      await response.body.cancel().catch(() => undefined);

      return fail(request, tooLarge(limit), response);
    }

    switch (mediaType(response)) {
      case "text/event-stream":
        return new Response(watchStream(response.body, request, limit, verdicts), response);
      case "application/json": {
        let body: Uint8Array | undefined;

        try {
          body = await readUpTo(response.body, limit);
        } catch {
          return fail(request, cut(request, "The answer broke off"), response);
        }

        if (body === undefined) {
          return fail(request, tooLarge(limit), response);
        }

        if (Option.isNone(decodeJsonRpcBody(new TextDecoder().decode(body)))) {
          return fail(
            request,
            ProtocolViolation.make({ message: "Not an MCP server: its answer is not JSON-RPC" }),
            response,
          );
        }

        return new Response(body, response);
      }

      default:
        await response.body.cancel().catch(() => undefined);

        return fail(
          request,
          ProtocolViolation.make({
            message: `Not an MCP server: it answered with ${response.headers.get("content-type") ?? "no content type"}`,
          }),
          response,
        );
    }
  };
};
