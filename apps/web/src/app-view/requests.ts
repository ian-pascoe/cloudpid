// docs/architecture/mcp-apps.md → An App View's calls. What a View asks of its own server: `tools/call` and `resources/read`,
// served by handing the request to the Session (`mcp_app_request`), which holds every check (page visible, limits, the call's
// own server, the tool's visibility, sign-in) and answers with the server's result or an error the View is answered with as
// JSON-RPC's. Nothing is checked here that the Session does not check again: this only decodes the View's params, names the
// request, ends it when the View's frame goes, and reports what the card shows (the sign-in it needs, the audit entry). The
// View's log lines (`notifications/message`) are cut and handed to the Session for telemetry.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- a handler is given a View's own `params`, which are decoded here against `Schema.Json` before they go anywhere, and answers the server's result as it is */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- plain functions over the bridge's promises: a handler answers a promise.
import {
  MAX_MCP_APP_AUDIT,
  MAX_MCP_APP_LOG_CHARS,
  MAX_MCP_APP_REQUEST_KEY,
  MCP_APP_INTERNAL_ERROR,
  MCP_APP_INVALID_PARAMS,
  type McpAppAuditEntry,
  type McpAppRequestAnswer,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { SessionClient } from "../session/client.ts";
import { RpcError, type RequestHandler } from "./bridge.ts";

/** What serving a View's requests needs of the Session's client. */
export type AppRequestClient = Pick<SessionClient, "appRequest" | "appLog">;

/** The methods a View may ask its server, which the bridge serves. */
export const VIEW_REQUEST_METHODS = ["tools/call", "resources/read"] as const;

/** The methods a View that may only read is served. */
export const READ_ONLY_METHODS = ["resources/read"] as const;

/** What the card is told as requests come to an end. */
export interface ViewRequestReports {
  /** A request failed because the server needs a sign-in (`stepUp`: the one it has is not enough). */
  readonly onSignIn: (need: { readonly server: string; readonly stepUp: boolean }) => void;
  /** The entry the Session kept of a request, for the card's details. */
  readonly onAudit: (entry: McpAppAuditEntry) => void;
}

/** The audit log the details show: the entries the record kept, then those since, the last `MAX_MCP_APP_AUDIT` of them (the Session's own bound). */
export const auditLog = (
  kept: ReadonlyArray<McpAppAuditEntry>,
  added: ReadonlyArray<McpAppAuditEntry>,
): ReadonlyArray<McpAppAuditEntry> => Arr.takeRight([...kept, ...added], MAX_MCP_APP_AUDIT);

const decodeParams = Schema.decodeUnknownOption(
  Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Json)),
);

// Every request of every View in this page has its own name: two frames of one call (the one tearing down and its
// replacement) must not share one, for the Session ends a request by the call and its name.
let requests = 0;

const nextRequestId = (): string => {
  requests += 1;

  return `r${requests}`;
};

/** The View's `params` for the Session: absent, or an object of JSON; anything else is the View's mistake. */
const paramsOf = (params: unknown): Record<string, Schema.Json> | undefined => {
  const decoded = Arr.isArray(params) ? Option.none() : decodeParams(params);

  if (Option.isNone(decoded))
    throw new RpcError(MCP_APP_INVALID_PARAMS, "params must be an object");

  return decoded.value;
};

const answerOf = (answer: McpAppRequestAnswer, reports: ViewRequestReports): unknown => {
  if ("audit" in answer && answer.audit !== undefined) reports.onAudit(answer.audit);

  if (answer.status === "result" && "result" in answer) return answer.result;

  if (answer.status === "error" && "code" in answer && "message" in answer) {
    if (answer.reason === "sign_in" && answer.server !== undefined) {
      reports.onSignIn({ server: answer.server, stepUp: answer.stepUp === true });
    }

    throw new RpcError(answer.code, answer.message);
  }

  throw new RpcError(MCP_APP_INTERNAL_ERROR, "The host could not answer");
};

/**
 * The bridge's handlers of one View's requests, for call `callId`. A request is one `mcp_app_request`; the View giving up
 * (the frame going, so the bridge's signal aborting) interrupts it, which cancels it at the Session. A request the
 * connection ends (the socket dropped) is answered as lost.
 */
export const viewRequestHandlers = (
  client: AppRequestClient,
  callId: string,
  reports: ViewRequestReports,
  options: { readonly readOnly?: boolean } = {},
): Readonly<Record<string, RequestHandler>> => {
  const serve =
    (method: string): RequestHandler =>
    async (params, { signal }) => {
      const asked = paramsOf(params);

      const answer = await Effect.runPromise(
        client.appRequest(callId, nextRequestId(), method, asked),
        { signal },
      ).catch((error: unknown) => {
        if (error instanceof RpcError) throw error;

        // The socket is down (or dropped with the request in flight), or the frame is going: the View hears if it is there.
        throw new RpcError(
          MCP_APP_INTERNAL_ERROR,
          "Connection lost: the host could not reach the Session",
        );
      });

      return answerOf(answer, reports);
    };

  // A View that may only read is served `resources/read`; `tools/call` is no handler, which the bridge answers as not found.
  const methods = options.readOnly === true ? READ_ONLY_METHODS : VIEW_REQUEST_METHODS;

  return Record.fromEntries(Arr.map(methods, (method) => [method, serve(method)]));
};

const LogLine = Schema.Struct({
  level: Schema.String,
  logger: Schema.optionalKey(Schema.String),
  data: Schema.Json,
});

const decodeLogLine = Schema.decodeUnknownOption(LogLine);

const isText = Schema.is(Schema.String);

const jsonText = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * What the bridge hands a View's `notifications/message` to: the line, as a log level, a logger and text cut to
 * `MAX_MCP_APP_LOG_CHARS`, sent to the Session for telemetry. A message that is not a log line (no level, data that is
 * not JSON) is dropped. The Session redacts and limits it; it is never shown to the owner or the model.
 */
export const viewLogSink =
  (client: AppRequestClient, callId: string) =>
  (params: unknown): void => {
    const line = decodeLogLine(params);

    if (Option.isNone(line)) return;

    const { level, logger, data } = line.value;
    const text = isText(data) ? Option.some(data) : jsonText(data);

    if (Option.isNone(text)) return;

    // Cut to what the Session's message takes, or it would answer the whole line unreadable.
    client.appLog(
      callId,
      level.slice(0, MAX_MCP_APP_REQUEST_KEY),
      logger?.slice(0, MAX_MCP_APP_REQUEST_KEY),
      text.value.slice(0, MAX_MCP_APP_LOG_CHARS),
    );
  };
