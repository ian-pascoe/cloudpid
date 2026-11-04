// An App View's calls, in the Session (`docs/architecture/mcp-apps.md` → An App View's calls): the checks that are the
// Session's, in order, before anything is sent to the host:
//
// 1. **A visible page.** A request from a socket that has not said its page is visible is refused (`hidden`), so no
//    background tab keeps a Container awake. The socket says it with `page_visible`; the Session never trusts a View for it,
//    since only cloudpid's own page speaks on the socket.
// 2. **The limits**, for each View (a socket's mount of one call): at most `MAX_MCP_APP_PER_MINUTE` requests a minute, counted
//    when they arrive, and `MAX_MCP_APP_IN_FLIGHT` at once. A View that is over a limit is refused (`limit`).
// 3. **A method it may make** (`tools/call`, `resources/read`; any other is `-32601`) with params of its shape (`-32602`).
// 4. **The call's record**, which names the server: never the message (a View cannot ask for another server). A call
//    that has no record kept (evicted, or never an App's) is refused. An archived Session forwards no `tools/call`, only reads.
// 5. **What the extension checks against the inventory** (`McpTools.appRequest`): a server that is not switched off or
//    `hidden`, a tool whose visibility includes `app`. The host checks the same again, and that the server is still the
//    one the record names.
//
// **Server requests from a View's `tools/call`** (`docs/architecture/mcp-apps.md` → Server requests from an App View's
// calls): the request carries what the extension needs to ask the owner for the View's server: whether its page is visible
// now (a hide withdraws a Sampling card, not an elicitation's), and the View's one elicitation slot. A request's own signal is
// its teardown: the View's cancel, and the socket going. What the questions came to goes to the audit log as notes.
//
// A View's log line (`log`) is not a request: it is limited the same way, redacted, cut, and a `warning` or above becomes a
// span event for telemetry; it reaches no model, transcript or audit log.
//
// The answer is redacted of the Secrets the Session holds, and a summary of it goes to the call's audit log. A request ends
// when the host answers, when its View cancels it (`cancel`), or when its socket goes (`endViews`); a cancel aborts the
// host's request. One span for each request, which names its server, method and outcome but never its arguments.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- the registry of what is in flight is plain mutable state, which the limits are counted in.
import type { McpAppRequestInput, McpAppView } from "@cloudpid/extensions/mcp";
import { isWarningOrAbove, MCP_LOG_LEVELS, type JsonObject } from "@cloudpid/mcp/types";
import {
  appAuditSummary,
  MAX_MCP_APP_IN_FLIGHT,
  MAX_MCP_APP_LOG_CHARS,
  MAX_MCP_APP_LOGS_PER_MINUTE,
  MAX_MCP_APP_PER_MINUTE,
  MCP_APP_INTERNAL_ERROR,
  MCP_APP_INVALID_PARAMS,
  MCP_APP_METHOD_NOT_FOUND,
  mcpAppError,
  type McpAppAuditEntry,
  type McpAppAuditSummary,
  type McpAppRequestAnswer,
  McpAppRequestError,
  McpAppRequestResult,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { socketRequests } from "./socket-requests.ts";

/** What the call's record says of it: its server, and what the call was made on. */
export type AppCallRecord = {
  readonly server: string;
  readonly conversation: string;
  /** What named the origin of the server's Views when the call ran. */
  readonly viewHash?: string | undefined;
};

/** An App View's request, as its socket sent it. */
export type AppViewRequest = {
  /** The socket, which identifies the View's page: limits count and requests end with it. */
  readonly view: WebSocket;
  /** Whether the socket has said its page is visible. */
  readonly visible: boolean;
  readonly callId: string;
  readonly requestId: string;
  readonly method: string;
  readonly params: Schema.Json | undefined;
  /** The Workspace (`ws:<id>`) the call's conversation works in, asked for only by a stdio server's request. */
  readonly workspaceOf: (conversation: string) => Effect.Effect<string | undefined>;
};

/** An App View's log line, as its socket sent it. */
export type AppViewLog = {
  readonly view: WebSocket;
  readonly callId: string;
  readonly level: string;
  readonly logger?: string | undefined;
  readonly message: string;
};

/** The name of the span event a View's `warning` or above becomes. */
export const APP_LOG_EVENT = "mcp.app_log";

export type AppCallsOptions = {
  /** The kept record of call `callId`; none for a call that has none (evicted, or not an App's). */
  readonly record: (callId: string) => Option.Option<AppCallRecord>;
  /** The request, once the Session's own checks pass: the MCP tools' `appRequest`. */
  readonly request: (input: McpAppRequestInput) => Effect.Effect<McpAppRequestAnswer>;
  /** Add `entry` to call `callId`'s audit log. Never fails. */
  readonly audit: (callId: string, entry: McpAppAuditEntry) => Effect.Effect<void>;
  /** The Secrets held, to redact what is returned and logged of them. */
  readonly secrets: Effect.Effect<{ readonly redact: <A>(value: A) => A }>;
  /** Whether the Session is archived: its Views may read, and call nothing. */
  readonly archived?: Effect.Effect<boolean> | undefined;
  readonly now: () => number;
};

export type AppCalls = {
  /** One App View request: its answer, however it ends. Never fails. */
  readonly request: (input: AppViewRequest) => Effect.Effect<McpAppRequestAnswer>;
  /** The View's request `requestId` of call `callId`, if it is still running: the host's request is aborted. */
  readonly cancel: (view: WebSocket, callId: string, requestId: string) => Effect.Effect<void>;
  /** A log line the View sent (`notifications/message`): dropped when it is not one of a call that has a record, is over the limit, or is below `warning`. */
  readonly log: (input: AppViewLog) => Effect.Effect<void>;
  /** The View's page went: everything it has in flight is aborted. */
  readonly endViews: (view: WebSocket) => Effect.Effect<void>;
  /**
   * The page of `view`'s socket says it is visible or hidden (`page_visible`). A hide withdraws the Sampling cards of its
   * Views' calls; their elicitations stay.
   */
  readonly visibility: (view: WebSocket, visible: boolean) => Effect.Effect<void>;
};

const ToolParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const ReadParams = Schema.Struct({ uri: Schema.String });

const decodeToolParams = Schema.decodeUnknownOption(ToolParams);

const decodeReadParams = Schema.decodeUnknownOption(ReadParams);

/** What an App View asked for, once its params are read. */
type Asked =
  | { readonly method: "tools/call"; readonly name: string; readonly arguments?: JsonObject }
  | { readonly method: "resources/read"; readonly uri: string };

const askedOf = (method: string, params: Schema.Json | undefined): Option.Option<Asked> => {
  if (method === "tools/call") {
    return Option.map(decodeToolParams(params), (each): Asked => {
      const asked: Mutable<Extract<Asked, { method: "tools/call" }>> = {
        method: "tools/call",
        name: each.name,
      };

      if (each.arguments !== undefined) asked.arguments = each.arguments;

      return asked;
    });
  }

  return Option.map(decodeReadParams(params), (each): Asked => ({
    method: "resources/read",
    uri: each.uri,
  }));
};

const isResult = Schema.is(McpAppRequestResult);

const isError = Schema.is(McpAppRequestError);

/** What an answer comes to, for the log. */
const outcomeOf = (answer: McpAppRequestAnswer): McpAppAuditSummary["outcome"] => {
  if (isResult(answer)) return { status: "result", result: answer.result };

  if (isError(answer)) return { status: "error", reason: answer.reason, message: answer.message };

  return { status: "error", reason: "failed", message: answer.message ?? "The request failed" };
};

/** `done` with what the request's questions came to noted in its audit line. */
const withNotes = (done: Run, notes: ReadonlyArray<string>): Run =>
  done.summary === undefined || notes.length === 0
    ? done
    : { ...done, summary: { ...done.summary, notes } };

/** What the Session made of a request: its answer, and what its audit log says, none for a request that was no call. */
type Run = {
  readonly answer: McpAppRequestAnswer;
  readonly summary: McpAppAuditSummary | undefined;
};

export const appCallsOver = (options: AppCallsOptions): AppCalls => {
  // A View is a socket's mount of one call: its counts and what it has in flight are the registry's, under the call's id.
  const views = socketRequests(options.now);

  /** What each socket's page says of its visibility, and the signal a hide aborts. */
  const pages = new WeakMap<WebSocket, { visible: boolean; hide: AbortController }>();

  const pageOf = (socket: WebSocket) => {
    let page = pages.get(socket);

    if (page === undefined) {
      page = { visible: false, hide: new AbortController() };
      pages.set(socket, page);
    }

    return page;
  };

  /** The elicitation each View has waiting: one at a time. */
  const slots = new WeakMap<WebSocket, Set<string>>();

  /** What the extension asks of the View of `socket`'s mount of call `callId`. */
  const viewOf = (socket: WebSocket, callId: string): McpAppView => ({
    hidden: () => {
      const page = pageOf(socket);

      return page.visible ? page.hide.signal : AbortSignal.abort();
    },
    takeSlot: () => {
      let taken = slots.get(socket);

      if (taken === undefined) {
        taken = new Set();
        slots.set(socket, taken);
      }

      if (taken.has(callId)) return undefined;

      taken.add(callId);

      return () => {
        taken.delete(callId);
      };
    },
  });

  /** A request's own checks and what it comes to, before it is answered, redacted and logged. */
  const run = (input: AppViewRequest, stop: AbortController): Effect.Effect<Run> =>
    Effect.gen(function* () {
      const { method } = input;

      if (method !== "tools/call" && method !== "resources/read") {
        return {
          answer: mcpAppError("refused", `Method not found: ${method}`, MCP_APP_METHOD_NOT_FOUND),
          summary: undefined,
        };
      }

      const asked = askedOf(method, input.params);

      if (Option.isNone(asked)) {
        return {
          answer: mcpAppError(
            "refused",
            method === "tools/call"
              ? "tools/call needs params with the tool's name"
              : "resources/read needs params with a uri",
            MCP_APP_INVALID_PARAMS,
          ),
          summary: undefined,
        };
      }

      const record = options.record(input.callId);

      if (Option.isNone(record)) {
        return {
          answer: mcpAppError("unavailable", "No App record of this Session keeps that call"),
          summary: undefined,
        };
      }

      const { server, conversation, viewHash } = record.value;
      const what = asked.value;

      yield* Effect.annotateCurrentSpan("mcp.server", server);

      const ended = (answer: McpAppRequestAnswer): Run => ({
        answer,
        summary: {
          method,
          target: what.method === "tools/call" ? what.name : what.uri,
          arguments: what.method === "tools/call" ? what.arguments : undefined,
          outcome: outcomeOf(answer),
        },
      });

      if (
        what.method === "tools/call" &&
        options.archived !== undefined &&
        (yield* options.archived)
      ) {
        return ended(
          mcpAppError(
            "refused",
            "This Session is archived: its App Views can read but not call tools",
          ),
        );
      }

      const notes: Array<string> = [];

      const answer = yield* options.request({
        ...what,
        server,
        callId: input.callId,
        conversation,
        viewHash,
        signal: stop.signal,
        view: viewOf(input.view, input.callId),
        notes,
        workspaceOf: Effect.suspend(() => input.workspaceOf(conversation)),
      });

      return withNotes(ended(answer), notes);
    });

  const request: AppCalls["request"] = (input) =>
    Effect.gen(function* () {
      if (!input.visible) {
        return mcpAppError(
          "hidden",
          "The page is hidden: its App Views make no requests until it is visible",
        );
      }

      // A page that says it is visible is, until it says otherwise: a Sampling card asked now is not withdrawn at once.
      pageOf(input.view).visible = true;

      const view = views.of(input.view, input.callId);

      if (!view.admits("request", MAX_MCP_APP_PER_MINUTE)) {
        return mcpAppError(
          "limit",
          `At most ${MAX_MCP_APP_PER_MINUTE} requests a minute for each App View`,
        );
      }

      if (view.running(input.requestId)) {
        return mcpAppError("limit", "That request id is already in flight");
      }

      if (view.inFlight() >= MAX_MCP_APP_IN_FLIGHT) {
        return mcpAppError(
          "limit",
          `At most ${MAX_MCP_APP_IN_FLIGHT} requests in flight for each App View`,
        );
      }

      const stop = view.start(input.requestId);

      const done = yield* run(input, stop).pipe(
        Effect.ensuring(Effect.sync(() => view.finish(input.requestId))),
      );

      const redactor = yield* options.secrets;

      // Redacted before it leaves: the answer, and the line of the log.
      const answer = redactor.redact(done.answer);

      const outcome = outcomeOf(answer);

      yield* Effect.annotateCurrentSpan(
        "mcp.app.outcome",
        outcome.status === "result" ? "result" : outcome.reason,
      );

      if (done.summary === undefined) return answer;

      const entry: McpAppAuditEntry = {
        at: options.now(),
        kind: input.method,
        summary: redactor.redact(appAuditSummary(done.summary)),
      };

      yield* options.audit(input.callId, entry);

      return isResult(answer) || isError(answer) ? { ...answer, audit: entry } : answer;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("An App View's request failed in the Session", cause).pipe(
          Effect.as<McpAppRequestAnswer>(
            mcpAppError(
              "failed",
              "The Session could not serve the request",
              MCP_APP_INTERNAL_ERROR,
            ),
          ),
        ),
      ),
      Effect.withSpan("mcp.app_request", {
        attributes: { "mcp.method": input.method, "mcp.app.call": input.callId },
      }),
    );

  const cancel: AppCalls["cancel"] = (view, callId, requestId) =>
    Effect.sync(() => {
      views.find(view, callId)?.abort(requestId);
    });

  const endViews: AppCalls["endViews"] = (view) =>
    Effect.sync(() => {
      views.end(view);
    });

  const log: AppCalls["log"] = (input) =>
    Effect.gen(function* () {
      const record = options.record(input.callId);

      if (Option.isNone(record)) return;

      if (!views.of(input.view, input.callId).admits("log", MAX_MCP_APP_LOGS_PER_MINUTE)) return;

      // A level this build does not know is kept as a warning (it may be one), but is named `unknown`, never the View's own text.
      const known = Arr.contains(MCP_LOG_LEVELS, input.level);

      if (known && !isWarningOrAbove(input.level)) return;

      const level = known ? input.level : "unknown";
      const redactor = yield* options.secrets;

      // Redacted after the client cut it to 2 KiB, so a Secret that straddled that cut arrives as a fragment, which no
      // longer matches it: this guards against an accident (a View that logs what it was given), not a hostile View.
      const message = redactor.redact(input.message).slice(0, MAX_MCP_APP_LOG_CHARS);
      const logger = redactor.redact(input.logger ?? "");

      yield* Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        const now = yield* Clock.currentTimeNanos;

        span.event(APP_LOG_EVENT, now, { level, logger, message });
      }).pipe(
        Effect.withSpan("mcp.app_log", {
          attributes: {
            "mcp.server": record.value.server,
            "mcp.app.call": input.callId,
            "mcp.app.level": level,
          },
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("An App View's log line failed in the Session", cause),
      ),
    );

  const visibility: AppCalls["visibility"] = (view, visible) =>
    Effect.sync(() => {
      const page = pageOf(view);

      page.visible = visible;

      // Aborted for the requests that asked of it, and made anew for the ones that come when it is shown again.
      if (!visible) {
        page.hide.abort();
        page.hide = new AbortController();
      }
    });

  return { request, cancel, log, endViews, visibility };
};
