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
 * - **Resumes:** a Legacy request stream that ends without its answer, having carried an event id, is resumed by the
 *   tap itself with `GET` and `Last-Event-ID`, after the server's `retry` (0.5–10 s); the SDK is handed one stream, and
 *   only the request's own events from the resumed one. Two resumes failing in a row is a cut (D15; #542).
 * - **Cuts:** an SSE stream that ends without its answer, and cannot be resumed, fails its request at once, since the
 *   SDK neither reconnects nor fails it (it drops `onRequestStreamEnd` for requests).
 * - **Not MCP:** a 2xx answer to a request that is neither JSON-RPC JSON nor an SSE stream.
 * - **The GET stream:** a Legacy session's GET stream ends at an event over 1 MiB (D16), which the core does not
 *   reopen; the span without it is a gap.
 *
 * A verdict on a request reaches the SDK as a JSON-RPC error answering it, carrying a token the core maps back to the
 * `McpError` (`Verdicts`), so the request fails at once whatever the SDK does with a broken stream. On the probe, which
 * reads any JSON-RPC error as Legacy, the verdict is thrown from `fetch` instead.
 */
// @effect-diagnostics asyncFunction:off -- the tap is a `fetch`, called by the SDK: Promises at its seam.
// @effect-diagnostics globalFetch:off -- it wraps the injected `fetch`, and builds the `Response`s the SDK reads.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// @effect-diagnostics preferEffectArray:off -- byte chunks and stream events, in place.
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MODERN_PROTOCOL_VERSION } from "./protocol.ts";
import {
  Cut,
  MCP_APP_READ_BYTES,
  MCP_LARGE_RESULT_BYTES,
  McpError,
  MiB,
  ProtocolViolation,
  ServerError,
  TooLarge,
  Unreachable,
} from "./types.ts";

const isMcpError = Schema.is(McpError);

/** What the tap does with a request, by its method. */
interface Policy {
  /** The most its answer may be, in bytes (D16). */
  readonly limit: number;
  /** It changes nothing, so it is retried once on a 408, 429 or 5xx (D15). */
  readonly readOnly: boolean;
  /** The era probe: retried once on a 408 or 429 only, and failed by a throw, never a JSON-RPC error (D2). */
  readonly probe: boolean;
  /** A cut leaves it maybe run (D15). */
  readonly mayHaveRun: boolean;
}

/** Any request not in `POLICIES`: 1 MiB, no retry. */
const OTHER: Policy = { limit: MiB, readOnly: false, probe: false, mayHaveRun: false };

/** A read with a large answer. */
const LARGE_READ: Policy = {
  limit: MCP_LARGE_RESULT_BYTES,
  readOnly: true,
  probe: false,
  mayHaveRun: false,
};

/** Each method's policy: the reads and `tools/call` get 16 MiB (D16). A `Map`, so no method finds a prototype key. */
const POLICIES = new Map<string, Policy>([
  ["server/discover", { ...OTHER, probe: true }],
  [
    "tools/call",
    { limit: MCP_LARGE_RESULT_BYTES, readOnly: false, probe: false, mayHaveRun: true },
  ],
  ["tools/list", LARGE_READ],
  ["prompts/list", LARGE_READ],
  ["resources/list", LARGE_READ],
  ["resources/templates/list", LARGE_READ],
  ["resources/read", LARGE_READ],
  ["prompts/get", LARGE_READ],
  ["tasks/get", LARGE_READ],
  // An update or a cancel changes the task, so it is neither retried here nor free of doubt when its stream is cut.
  ["tasks/update", { ...OTHER, mayHaveRun: true }],
  ["tasks/cancel", { ...OTHER, mayHaveRun: true }],
]);

/** An App's read of its `ui://` resource: its HTML, which `MCP_APP_READ_BYTES` bounds, and not a large read. */
const APP_READ: Policy = { ...LARGE_READ, limit: MCP_APP_READ_BYTES };

/**
 * `method`'s policy; `app` says the request is an App's read of its HTML (`APP_READ_HEADER`). Who reads decides, not the
 * URI: an agent's read of a `ui://` resource has the 16 MiB every read has.
 */
const policyOf = (method: string, app: boolean) =>
  method === "resources/read" && app ? APP_READ : (POLICIES.get(method) ?? OTHER);

const MAX_RETRY_AFTER_MS = 10_000;

const DEFAULT_RETRY_AFTER_MS = 1000;

/** The JSON-RPC error data key that carries a verdict's token. */
export const VERDICT_KEY = "cloudpid/verdict";

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

/**
 * The header the core puts on a `tools/call` that may be asked questions: a token naming the call. The tap removes it
 * before the request goes on, so no server sees it, and ties each server request on that call's response stream to the
 * token (`Ties`).
 */
export const CALL_HEADER = "x-cloudpid-call";

/**
 * The header the core puts on an App's read of its `ui://` resource (`readResource`'s `app`), which `MCP_APP_READ_BYTES`
 * bounds. Removed by the tap like `CALL_HEADER`.
 */
export const APP_READ_HEADER = "x-cloudpid-app-read";

/**
 * Which call each server request on a POST response stream belongs to (`mcp-server-requests.md` → Questions, Legacy:
 * "the core's `fetch` tap ties a question to the call whose POST stream carried it"). A question on any other stream,
 * the GET stream above all, has no tie, and nowhere to go.
 */
export class Ties {
  private readonly calls = new Map<string | number, string>();
  private readonly completions = new Map<string, () => void>();

  /** Server request `id` arrived on the stream of the call `token` names. */
  tie(id: string | number, token: string) {
    this.calls.set(id, token);
  }

  /** The token of the call that carried server request `id`, once. */
  take(id: string | number) {
    const token = this.calls.get(id);

    this.calls.delete(id);

    return token;
  }

  /**
   * `done` is called once, when the URL elicitation `elicitationId` is completed on the stream of the call `token`
   * names (`notifications/elicitation/complete`); the returned function takes it back. A completion on any other
   * stream, or for another call, reaches no one.
   */
  onComplete(token: string, elicitationId: string, done: () => void) {
    const key = completionKey(token, elicitationId);

    this.completions.set(key, done);

    return () => {
      if (this.completions.get(key) === done) this.completions.delete(key);
    };
  }

  /** The URL elicitation `elicitationId` was completed on the stream of the call `token` names. */
  complete(token: string, elicitationId: string) {
    const key = completionKey(token, elicitationId);
    const done = this.completions.get(key);

    this.completions.delete(key);
    done?.();
  }

  /** The call `token` names is over: its ties and completions no one took are let go. */
  release(token: string) {
    for (const [id, tied] of this.calls) {
      if (tied === token) this.calls.delete(id);
    }

    for (const key of this.completions.keys()) {
      if (key.startsWith(`${token}\u0000`)) this.completions.delete(key);
    }
  }
}

const completionKey = (token: string, elicitationId: string) => `${token}\u0000${elicitationId}`;

/** What the tap needs besides the injected `fetch`: the clock (Effect's, through the connection's context). */
export interface TapClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** A JSON-RPC id: a request's is a string or a number; an answer's may be null. */
const JsonRpcId = Schema.Union([Schema.String, Schema.Finite, Schema.Null]);

/** A JSON-RPC message's id and method: a request has both, an answer only the id, a notification only the method. */
const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(JsonRpcId),
      method: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** A message on a call's response stream: its id and method, and the `params` a completion notice carries. */
const StreamMessage = Schema.Struct({
  id: Schema.optionalKey(JsonRpcId),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
});

/** An event's data: one message, or a batch (the first Legacy revision's), tried as the batch first. */
const decodeStreamMessages = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Schema.Array(StreamMessage), StreamMessage])),
);

/** The `params` of a `notifications/elicitation/complete`: the page that was finished. */
const decodeCompletion = Schema.decodeUnknownOption(
  Schema.Struct({ elicitationId: Schema.String }),
);

/** What the tap does for the call whose POST stream it watches: tie a question to it, and hear a page's completion. */
interface CallStream {
  readonly tie: (id: string | number) => void;
  readonly complete: (elicitationId: string) => void;
}

/** A JSON-RPC request the SDK is sending: one with an id and a method, and what the tap does with it. */
interface Outgoing {
  readonly id: string | number;
  readonly method: string;
  readonly policy: Policy;
}

const outgoing = (init: RequestInit | undefined, app: boolean): Outgoing | undefined =>
  Option.match(decodeMessage(init?.body), {
    onNone: () => undefined,
    onSome: ({ id, method }) =>
      id === undefined || id === null || method === undefined
        ? undefined
        : { id, method, policy: policyOf(method, app) },
  });

const JsonRpcAnswer = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(JsonRpcId),
});

const decodeJsonRpcBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([JsonRpcAnswer, Schema.NonEmptyArray(JsonRpcAnswer)])),
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

/** A status that may pass if tried again. */
const transientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

const shouldRetry = (request: Outgoing | undefined, status: number) => {
  if (request === undefined) {
    return false;
  }

  if (request.policy.probe) {
    return status === 408 || status === 429;
  }

  return request.policy.readOnly && transientStatus(status);
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
  request.policy.mayHaveRun
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

/** Lets go of a body the tap will not pass on. */
const drain = (body: ReadableStream<Uint8Array> | null) => body?.cancel().catch(() => undefined);

/** The most one event on a GET stream, or on a resumed request stream, may be (D16). */
const EVENT_LIMIT = MiB;

/** How many resumes in a row may fail before the request is cut: the SDK's own `maxRetries` (D15). */
const MAX_RESUME_FAILURES = 2;

/** The server's `retry` is waited out within these bounds (D15); with none, the SDK's own first delay. */
const MIN_RESUME_MS = 500;
const MAX_RESUME_MS = 10_000;
const DEFAULT_RESUME_MS = 1000;

/**
 * Splits an SSE stream's text into its events as it arrives, doing work only for the new text (a stream may be fed in
 * tiny chunks). A blank line ends an event, whichever of CRLF, LF and CR ends its lines (WHATWG HTML, server-sent
 * events), so the events come back with LF only. A CR at the end of a chunk may be the start of a CRLF, so it is held
 * for the next chunk to settle, unless the stream ended (`final`). The bytes of the event being read, and of each one
 * that ends, are counted against `limit`.
 */
export class EventSplitter {
  /** Whether an event (the one being read, or one that ended) was over `limit` bytes. */
  over = false;

  private readonly limit: number;
  private parts: Array<string> = [];
  private bytes = 0;
  private lineEnd = false;
  private heldCr = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Whether what is held of the event being read ends in a line ending. */
  get endsInLineEnd() {
    return this.lineEnd;
  }

  /** The event being read, so far. */
  get unfinished() {
    return this.parts.join("");
  }

  /** The events `text` finishes. */
  push(text: string, final = false) {
    let input = this.heldCr ? `\r${text}` : text;

    this.heldCr = !final && input.endsWith("\r");

    if (this.heldCr) input = input.slice(0, -1);

    const lf = input.replace(/\r\n?/g, "\n");
    const events: Array<string> = [];
    let from = 0;

    // The event being read ends in a line ending and this text starts with one: that is its blank line.
    if (this.lineEnd && lf.startsWith("\n")) {
      events.push(this.finish().slice(0, -1));
      from = 1;
    }

    const segments = lf.slice(from).split("\n\n");

    for (const [index, segment] of segments.entries()) {
      this.parts.push(segment);
      this.bytes += encoder.encode(segment).byteLength;

      if (segment !== "") this.lineEnd = segment.endsWith("\n");

      // A line ending last in the event being read may be the first of its blank line, so it is not counted yet.
      const last = index === segments.length - 1;

      if (this.bytes - (last && this.lineEnd ? 1 : 0) > this.limit) this.over = true;

      if (index < segments.length - 1) events.push(this.finish());
    }

    return events;
  }

  private finish() {
    const event = this.parts.join("");

    this.parts = [];
    this.bytes = 0;
    this.lineEnd = false;

    return event;
  }
}

/**
 * Whether a CR follows the last LF of a stream, given whether one did before `text` arrived. The SDK's parser holds
 * back a CR that ends a chunk, and appends to it, unparsed, every later chunk with no CR or LF; so the stream's end
 * leaves it unfinished only if its last line ending is such a CR, which this over-reports.
 */
export const crFollowsLf = (before: boolean, text: string) => {
  const lf = text.lastIndexOf("\n");

  return (lf === -1 && before) || text.indexOf("\r", lf + 1) !== -1;
};

/** What opening a resumed stream came to: its body, or whether trying again could help. */
type Reopened = Data.TaggedEnum<{
  Stream: { readonly body: ReadableStream<Uint8Array> };
  Failed: { readonly transient: boolean };
}>;

const Reopened = Data.taggedEnum<Reopened>();

/** How the tap reopens a Legacy request's stream with `GET` and `Last-Event-ID` (D15). */
interface Resume {
  readonly open: (lastEventId: string) => Promise<Reopened>;
  readonly sleep: (ms: number) => Promise<void>;
  /** The request was aborted, so nothing more is wanted of it. */
  readonly aborted: () => boolean;
}

/** What a stream that ended without its answer comes to. */
type Resumption = Data.TaggedEnum<{
  Resumed: { readonly body: ReadableStream<Uint8Array> };
  Stopped: {};
  Cut: { readonly error: McpError };
}>;

const Resumption = Data.taggedEnum<Resumption>();

/**
 * An SSE event's `id`, `retry`, `event` type and `data` (with how many `data` lines it had: one is enough to be
 * dispatched); the last `id`, `retry` and `event` win. `event` has LF line ends only.
 */
export const eventFields = (event: string) => {
  let id: string | undefined;
  let retry: number | undefined;
  let type: string | undefined;
  const data: Array<string> = [];

  for (const line of event.split("\n")) {
    if (line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;

    if (name === "data") data.push(value);
    else if (name === "event") type = value === "" ? undefined : value;
    else if (name === "id" && !value.includes("\u0000")) id = value;
    else if (name === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }

  return { id, retry, type, dataLines: data.length, data: data.join("\n") };
};

/**
 * What is written to the SDK where a stream's unfinished last event is left behind to resume: an `event` type of its
 * own, which overrides the unfinished event's, so the SDK ignores that event instead of joining it to the first
 * resumed one. A line ending first, unless the unfinished event already ends in one: a blank line would make the SDK
 * dispatch it.
 */
const discardEvent = (endsInLineEnd: boolean) =>
  `${endsInLineEnd ? "" : "\n"}event: cloudpid-discard\n\n`;

const eventTooLarge = () =>
  TooLarge.make({
    message: `An event on the resumed stream is over ${EVENT_LIMIT / MiB} MiB; the answer was dropped`,
    limit: EVENT_LIMIT,
  });

/**
 * Where a Legacy request's stream stands, over the streams resumed so far: the last event id and `retry` the server
 * sent, and the resumes that failed in a row. A resume fails when it cannot be opened, or when the stream it opens ends
 * with no event id newer than the one it was asked from; so a server that polls is resumed for as long as it makes
 * progress.
 */
class Resumer {
  /** Whether the stream being read is a resumed one. */
  resumed = false;

  private readonly request: Outgoing;
  private readonly resume: Resume | undefined;
  private readonly stopped: () => boolean;
  private lastEventId: string | undefined;
  private retryMs: number | undefined;
  private resumedFrom: string | undefined;
  private failures = 0;

  /** `stopped` says the reader let go of the stream, so nothing more is wanted. */
  constructor(request: Outgoing, resume: Resume | undefined, stopped: () => boolean) {
    this.request = request;
    this.resume = resume;
    this.stopped = stopped;
  }

  /** An event of the stream carried these fields. */
  see(fields: { readonly id: string | undefined; readonly retry: number | undefined }) {
    if (fields.id !== undefined) this.lastEventId = fields.id === "" ? undefined : fields.id;

    if (fields.retry !== undefined) this.retryMs = fields.retry;
  }

  /** The stream ended (`broke` says it broke) without its answer: resume it, or give the cut. */
  async next(broke: boolean): Promise<Resumption> {
    if (this.resumed) {
      this.failures = this.lastEventId === this.resumedFrom ? this.failures + 1 : 0;
    }

    const { request, resume } = this;
    const lastEventId = this.lastEventId;

    if (resume === undefined || lastEventId === undefined) {
      return Resumption.Cut({
        error: cut(
          request,
          broke
            ? "The stream broke before its answer arrived"
            : "The stream ended before its answer arrived",
        ),
      });
    }

    const failed = () =>
      Resumption.Cut({
        error: cut(request, "The stream ended before its answer arrived, and resuming it failed"),
      });

    for (;;) {
      if (this.failures >= MAX_RESUME_FAILURES) return failed();

      await resume.sleep(
        Math.min(Math.max(this.retryMs ?? DEFAULT_RESUME_MS, MIN_RESUME_MS), MAX_RESUME_MS),
      );

      if (this.stopped() || resume.aborted()) return Resumption.Stopped();

      const opened = await resume.open(lastEventId);

      if (this.stopped() || resume.aborted()) {
        if (Reopened.$is("Stream")(opened)) await drain(opened.body);

        return Resumption.Stopped();
      }

      if (Reopened.$is("Stream")(opened)) {
        this.resumed = true;
        this.resumedFrom = lastEventId;

        return Resumption.Resumed({ body: opened.body });
      }

      if (!opened.transient) return failed();

      this.failures += 1;
    }
  }
}

/**
 * `body` as it arrives, counted against the request's limit, watched for the answer to `request`. A stream that ends
 * or breaks without it is resumed when `resume` is given and the stream carried an event id (D15): the SDK is handed
 * one stream, the first's events and then the resumed ones, and of those only the request's own (an answer to another
 * request never reaches it). The resumed bytes count toward the same limit, and an event over 1 MiB on a resumed
 * stream fails the request. With no way to resume, or once resuming fails, the stream ends with the verdict instead,
 * as it does over the limit.
 */
const watchStream = (
  body: ReadableStream<Uint8Array>,
  request: Outgoing,
  verdicts: Verdicts,
  call?: CallStream,
  resume?: Resume,
) => {
  const limit = request.policy.limit;
  let reader = body.getReader();
  let decoder = new TextDecoder();
  let bytes = 0;
  // A resumed stream's events are held to 1 MiB; the first's are not.
  let splitter = new EventSplitter(Number.POSITIVE_INFINITY);
  let answered = false;
  let cancelled = false;
  /** Whether a CR follows the last LF of the first stream so far (`crFollowsLf`). */
  let crAfterLf = false;
  const resumer = new Resumer(request, resume, () => cancelled);

  /** The whole events of `text` the SDK may be given, or `undefined` when one is over the per-event cap. */
  const scan = (text: string, final = false) => {
    const events = splitter.push(text, final);

    if (splitter.over) return undefined;

    const kept: Array<string> = [];

    for (const event of events) {
      const fields = eventFields(event);

      resumer.see(fields);

      const messages = Option.match(decodeStreamMessages(fields.data), {
        onNone: () => [],
        onSome: (decoded) => (Array.isArray(decoded) ? decoded : [decoded]),
      });

      // The SDK reads an event with no type or the type `message`, and no other.
      const read = fields.type === undefined || fields.type === "message";

      for (const message of messages) {
        // An answer to the request has its id and no method (a server's own request has one).
        if (read && message.id === request.id && message.method === undefined) {
          answered = true;
        }

        // A question on this call's stream is tied to the call, before the SDK is given the event that carries it.
        if (
          call !== undefined &&
          (message.method === "elicitation/create" ||
            message.method === "sampling/createMessage") &&
          message.id !== undefined &&
          message.id !== null
        ) {
          call.tie(message.id);
        }

        // A page the owner finished, told on the call's own stream (`notifications/elicitation/complete`): only here.
        if (call !== undefined && message.method === "notifications/elicitation/complete") {
          Option.map(decodeCompletion(message.params), ({ elicitationId }) => {
            call.complete(elicitationId);
          });
        }
      }

      // The SDK matches an answer to its request by id, so an answer to another request must never reach it.
      const foreign = messages.some(
        (message) =>
          message.method === undefined && message.id !== undefined && message.id !== request.id,
      );

      if (!foreign) kept.push(event);
    }

    return kept;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // The probe reads any JSON-RPC error as Legacy, so it gets no verdict: a stream that ends without its answer
      // runs to the probe's timeout (D2), and one over the limit breaks.
      const end = (error: McpError) => {
        if (!request.policy.probe) {
          controller.enqueue(encoder.encode(verdictEvent(request, error, verdicts)));
        }

        controller.close();
      };

      // Until something is handed to the SDK: a resumed stream may give nothing of what it reads (another request's
      // events), and a pull that enqueues nothing is not called again.
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        let broke = false;

        try {
          chunk = await reader.read();
        } catch {
          chunk = { done: true, value: undefined };
          broke = true;
        }

        if (cancelled) return;

        if (chunk.done) {
          // The first stream is handed over as it came, and the SDK's parser holds a CR that ends a chunk for a LF
          // that never comes, and with it the rest of the stream, dispatching nothing more. The SDK is given the LF,
          // and the tap counts it too, so the answer it finds is one the SDK dispatches.
          if (crAfterLf && !resumer.resumed) {
            crAfterLf = false;
            scan("\n");
            controller.enqueue(encoder.encode("\n"));

            return;
          }

          // A CR at the end of a resumed stream is a line end: the events it finishes are still owed to the SDK.
          const last = scan("", true);

          if (last === undefined) return end(eventTooLarge());

          if (resumer.resumed && last.length > 0) {
            controller.enqueue(encoder.encode(last.map((event) => `${event}\n\n`).join("")));

            return;
          }

          if (answered) return controller.close();

          // The first stream is handed over as it came, so an event it left unfinished is cut off for the SDK.
          const unfinished =
            resumer.resumed || /^\n*$/.test(splitter.unfinished)
              ? undefined
              : discardEvent(splitter.endsInLineEnd);

          const next = await resumer.next(broke);

          if (cancelled) return;

          if (Resumption.$is("Stopped")(next)) return controller.close();

          if (Resumption.$is("Cut")(next)) return end(next.error);

          reader = next.body.getReader();
          decoder = new TextDecoder();
          splitter = new EventSplitter(EVENT_LIMIT);

          if (unfinished !== undefined) {
            controller.enqueue(encoder.encode(unfinished));

            return;
          }

          continue;
        }

        bytes += chunk.value.byteLength;

        if (bytes > limit) {
          await reader.cancel().catch(() => undefined);

          return request.policy.probe ? controller.error(tooLarge(limit)) : end(tooLarge(limit));
        }

        const text = decoder.decode(chunk.value, { stream: true });

        crAfterLf = crFollowsLf(crAfterLf, text);

        const kept = scan(text);

        if (kept === undefined) {
          await reader.cancel().catch(() => undefined);

          return end(eventTooLarge());
        }

        if (!resumer.resumed) {
          controller.enqueue(chunk.value);

          return;
        }

        if (kept.length > 0) {
          controller.enqueue(encoder.encode(kept.map((event) => `${event}\n\n`).join("")));

          return;
        }
      }
    },
    cancel: (reason) => {
      cancelled = true;

      return reader.cancel(reason);
    },
  });
};

/**
 * A GET stream's `body`, ended (and let go of) at an event over 1 MiB, so no event the client must hold whole outgrows
 * the limit.
 */
const capEvents = (body: ReadableStream<Uint8Array>, ended?: () => void) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const splitter = new EventSplitter(EVENT_LIMIT);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));

      if (chunk.done) {
        controller.close();
        ended?.();

        return;
      }

      splitter.push(decoder.decode(chunk.value, { stream: true }));

      if (splitter.over) {
        await reader.cancel().catch(() => undefined);
        controller.close();
        ended?.();

        return;
      }

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

/** What the tap tells a connection about its wire, for the connection's counts: statuses only, never what was sent. */
export interface TapObserver {
  /** A response arrived, with its HTTP status. */
  readonly response: (status: number) => void;
  /** A request is sent again after a 408, 429 or 5xx. */
  readonly retried: () => void;
  /**
   * A GET stream (a Legacy session's): the status the server answered with, and later `ended` when its body ended or was
   * cut at an event over 1 MiB (never when the reader cancelled it).
   */
  readonly get?: (event: { readonly status: number } | { readonly ended: true }) => void;
}

/** `init` without the core's own headers, the token the call header carried, and whether the request is an App's read. */
const withoutCoreHeaders = (init: RequestInit | undefined) => {
  if (init?.headers === undefined) return { init, token: undefined, app: false };

  const headers = new Headers(init.headers);
  const token = headers.get(CALL_HEADER) ?? undefined;
  const app = headers.has(APP_READ_HEADER);

  if (token === undefined && !app) return { init, token, app };

  headers.delete(CALL_HEADER);
  headers.delete(APP_READ_HEADER);

  return { init: { ...init, headers }, token, app };
};

/** The tap over `fetch` for one connection. */
export const tapFetch = (
  fetch: FetchLike,
  clock: TapClock,
  verdicts: Verdicts,
  observer?: TapObserver,
  ties?: Ties,
): FetchLike => {
  /** Fails `request` with `error`: thrown on the probe, answered as a JSON-RPC error otherwise. */
  const fail = (request: Outgoing, error: McpError, response: Response) => {
    if (request.policy.probe) {
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
      // An injected `fetch` that already names the failure (the Container bridge's refusals) is believed, not reworded.
      if (init?.signal?.aborted === true || request === undefined || isMcpError(error)) {
        throw error;
      }

      throw request.policy.mayHaveRun
        ? cut(request, "The connection failed")
        : Unreachable.make({ message: `The server could not be reached: ${String(error)}` });
    }
  };

  /**
   * How `request`'s stream is resumed (D15): a Legacy request only, never the probe or a Modern request (its headers
   * say which). The `GET` takes the POST's headers (session, version, authorization, the entry's own), without the
   * body's, and asks for a stream after the last event id; its failures are the caller's to count, never thrown.
   */
  const resumeOf = (
    input: string | URL,
    init: RequestInit | undefined,
    request: Outgoing,
  ): Resume | undefined => {
    if (init === undefined || request.policy.probe) return undefined;

    const post = new Headers(init.headers);

    if (post.has("mcp-method") || post.get("mcp-protocol-version") === MODERN_PROTOCOL_VERSION) {
      return undefined;
    }

    return {
      sleep: clock.sleep,
      aborted: () => init.signal?.aborted === true,
      open: async (lastEventId) => {
        const headers = new Headers(post);

        headers.delete("content-type");
        headers.delete("content-length");
        headers.set("accept", "text/event-stream");
        headers.set("last-event-id", lastEventId);

        let response: Response;

        try {
          response = await fetch(input, { ...init, method: "GET", headers, body: null });
        } catch {
          return Reopened.Failed({ transient: true });
        }

        if (
          !response.ok ||
          response.body === null ||
          mediaType(response) !== "text/event-stream" ||
          redirectedAway(input, response) !== undefined
        ) {
          await drain(response.body);

          return Reopened.Failed({ transient: transientStatus(response.status) });
        }

        return Reopened.Stream({ body: response.body });
      },
    };
  };

  return async (input, given) => {
    const { init, token, app } = withoutCoreHeaders(given);
    const request = outgoing(init, app);
    let response = await send(input, init, request);

    observer?.response(response.status);

    if (shouldRetry(request, response.status)) {
      observer?.retried();
      await drain(response.body);
      await clock.sleep(retryAfter(response, clock.now()));
      response = await send(input, init, request);
      observer?.response(response.status);

      if (request?.policy.probe === true && (response.status === 408 || response.status === 429)) {
        await drain(response.body);

        throw Unreachable.make({
          message: `The server answered HTTP ${response.status} twice; try again later`,
          status: response.status,
        });
      }
    }

    const away = redirectedAway(input, response);

    if (away !== undefined) {
      await drain(response.body);

      throw ServerError.make({
        message: `The server redirects to ${away}, another origin; not followed`,
        status: response.status,
      });
    }

    if (init?.method === "GET") observer?.get?.({ status: response.status });

    if (
      init?.method === "GET" &&
      response.ok &&
      response.body !== null &&
      mediaType(response) === "text/event-stream"
    ) {
      return new Response(
        capEvents(response.body, () => observer?.get?.({ ended: true })),
        response,
      );
    }

    if (
      request === undefined ||
      !response.ok ||
      response.status === 202 ||
      response.body === null
    ) {
      return response;
    }

    const limit = request.policy.limit;
    const length = Number(response.headers.get("content-length") ?? "0");

    if (length > limit) {
      await drain(response.body);

      return fail(request, tooLarge(limit), response);
    }

    switch (mediaType(response)) {
      case "text/event-stream":
        return new Response(
          watchStream(
            response.body,
            request,
            verdicts,
            token === undefined || ties === undefined
              ? undefined
              : {
                  tie: (id) => ties.tie(id, token),
                  complete: (elicitationId) => ties.complete(token, elicitationId),
                },
            resumeOf(input, init, request),
          ),
          response,
        );
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
        await drain(response.body);

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
