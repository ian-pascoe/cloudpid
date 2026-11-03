// docs/architecture/mcp-endpoint.md → The `api` target, Access and identity, Limits and errors: what the main Worker
// builds per `/mcp` request and passes to `McpServer`, over the Registry and the Sessions it already has. It owns
// authorization (the guard has run), validation, the Registry and Session calls, cursors and rendering; `McpServer` owns
// the SDK, the schemas and the text. The caller's identity is closed over it and is never an argument. Failures travel
// as values (`ApiResult`); nothing streams. The read operations, `start`, `send`, `stop` and `wait` are here; an operation
// `describe()` does not list answers `unsupported`, which is also how `McpServer` knows to leave its tool out.
// @effect-diagnostics globalDate:off preferEffectArray:off missingPipeableSignature:off -- epoch times said as ISO text; short native lists.
import { isModelId, SUPPORTED_MODELS, ThinkingLevel, THINKING_LEVELS } from "@cloudpid/config";
import {
  type ApiDescription,
  type ApiError,
  type ApiResult,
  apiFailure,
  apiOk,
  branchProblem,
  type ConfigureRequest,
  decodeCursor,
  DEFAULT_ENVIRONMENT,
  DEFAULT_MCP_WAIT_MS,
  encodeCursor,
  type EnvironmentRecord,
  type EnvironmentsResult,
  type ImportAppendRequest,
  type ImportAppendResult,
  type ImportBeginRequest,
  type ImportBeginResult,
  type ImportCancelRequest,
  type ImportCancelResult,
  type ImportFinishRequest,
  type ImportFinishResult,
  MAX_MCP_IMPORT_BYTES,
  MAX_MCP_INPUT_BYTES,
  MAX_MCP_OPEN_IMPORTS,
  MAX_MCP_SLICE_BYTES,
  MAX_MCP_RUNNING,
  MAX_MCP_WAIT_MS,
  MCP_API_LIMITS,
  type MarkedOrigin,
  SESSION_ID,
  type McpAuth,
  type McpSessionOrigin,
  type McpSessionSummary,
  ownBranchProblem,
  PI_SESSION_FORMAT,
  type SendRequest,
  type SessionDetail,
  type SessionRecord,
  SessionTitle,
  type SessionsQuery,
  type SessionStatusReport,
  type SessionVia,
  type StageImportAppend,
  type StageImportBegin,
  type StageImportFinish,
  type StagedCancel,
  type StagedFinish,
  type StagedImport,
  type StartRequest,
  type StartResult,
  type StopRequest,
  type StopSessionRequest,
  type StopResult,
  type SubmitRequest,
  type SubmitResult,
  type TranscriptPage,
  type TranscriptRequest,
  type Via,
  type WaitingRequest,
  type WaitOutcome,
  type WaitRequest,
  type WaitResult,
  type WaitSessionRequest,
  whenBusyOf,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import { WORKSPACE_ROOT } from "@cloudpid/protocol/repo";
import { importCarryRef } from "@cloudpid/sandbox-image/workspaces";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { Caller } from "../access.ts";
import type { SessionsResult } from "../registry/session-page.ts";
import type { CreatedSession, SessionRefusal } from "../registry/store.ts";

/** The operations this version of `Server` has: `McpServer` serves a tool only when its operation is listed. */
export const MCP_API_OPERATIONS_SERVED = [
  "environments",
  "sessions",
  "session",
  "transcript",
  "start",
  "send",
  "stop",
  "wait",
  "importBegin",
  "importAppend",
  "importFinish",
  "importCancel",
] as const;

/** The period of `MCP_CALLS`, in seconds: what a caller over the rate is told to wait at most. */
export const MCP_CALLS_PERIOD_S = 60;

/** The calls per period of `MCP_CALLS`, per identity. */
export const MCP_CALLS_LIMIT = 120;

/** What the endpoint reads of the Registry and the Sessions. Each is one RPC; a failure of any is `unavailable`. */
export interface McpBackend {
  readonly environments: Effect.Effect<ReadonlyArray<EnvironmentRecord>>;
  /** Every Session, newest first: for each Environment's running count. */
  readonly allSessions: Effect.Effect<ReadonlyArray<SessionRecord>>;
  readonly sessions: (query: SessionsQuery) => Effect.Effect<SessionsResult>;
  readonly session: (id: string) => Effect.Effect<SessionRecord | null>;
  readonly workspace: (id: string) => Effect.Effect<WorkspaceRecord | null>;
  /** The Global Settings' default model. */
  readonly defaultModel: Effect.Effect<string>;
  /** The Session object's `status()`; `after` is the cursor the caller holds, which `branch_changed` is told against. */
  readonly status: (id: string, after?: string) => Effect.Effect<ApiResult<SessionStatusReport>>;
  /**
   * The Session object's `waitForChange()`: the RPC stays open until the wait ends, at `request.deadline` at the latest. An
   * RPC that is cut (a deploy, an eviction) is a defect, which `wait` reads as an interrupted wait.
   */
  readonly wait: (id: string, request: WaitRequest) => Effect.Effect<ApiResult<WaitOutcome>>;
  /** The Session object's `transcriptPage()`. */
  readonly transcript: (
    id: string,
    request: TranscriptRequest,
  ) => Effect.Effect<ApiResult<TranscriptPage>>;
  /**
   * The Registry's `createSession` in a new Workspace of `environment`, as the endpoint starts one: marked, deduped by
   * `requestId` for 24 h, and refused past `maxRunning`. The spare and Build upkeep run after it, as for the owner's.
   */
  readonly createSession: (input: {
    readonly environment: string;
    readonly title?: string | undefined;
    readonly branch?: string | undefined;
    readonly base?: string | undefined;
    readonly marks: MarkedOrigin;
    readonly requestId?: string | undefined;
    readonly maxRunning: number;
    /** For an import: how many the caller may have open, by how it got in (`auth`). */
    readonly maxOpenImports?: { readonly limit: number; readonly auth: McpAuth } | undefined;
  }) => Effect.Effect<CreatedSession | SessionRefusal>;
  /** The Session object's `configure()`. */
  readonly configure: (id: string, request: ConfigureRequest) => Effect.Effect<ApiResult<null>>;
  /** The Session object's `submit()`. */
  readonly submit: (id: string, request: SubmitRequest) => Effect.Effect<ApiResult<SubmitResult>>;
  /** The Session object's `stop()`. */
  readonly stop: (id: string, request: StopRequest) => Effect.Effect<ApiResult<StopResult>>;
  /** The Session object's `stageImportBegin()`: the Session starts importing. */
  readonly stageImportBegin: (
    id: string,
    request: StageImportBegin,
  ) => Effect.Effect<ApiResult<StagedImport>>;
  /** The Session object's `stageImportAppend()`. */
  readonly stageImportAppend: (
    id: string,
    request: StageImportAppend,
  ) => Effect.Effect<ApiResult<StagedImport>>;
  /** The Session object's `stageImportFinish()`: translates, and waits for it up to 30 s. */
  readonly stageImportFinish: (
    id: string,
    request: StageImportFinish,
  ) => Effect.Effect<ApiResult<StagedFinish>>;
  /** The Session object's `stageImportCancel()`. */
  readonly stageImportCancel: (id: string) => Effect.Effect<ApiResult<StagedCancel>>;
  /**
   * Delete a Session as the owner's delete does (`registry/removal.ts`): its object, its record, and its Workspace when no
   * other Session is in it. A failure is a defect, which the operation reads as `unavailable`.
   */
  readonly deleteSession: (id: string) => Effect.Effect<void>;
}

/** What one request adds: where the owner's pages are, who is calling, and the rate limit. */
export interface McpApiContext {
  /** `https://<host>`, from the request's own URL: the base of every `url` the Local agent is given. */
  readonly origin: string;
  readonly caller: Caller;
  /** `Server`'s deploy id, which `describe()` reports for `McpServer`'s `serverInfo.version`; none where the runtime has no version metadata. */
  readonly version?: string | undefined;
  /** Counts one call against the caller's rate: whether it is within it. */
  readonly withinRate: (key: string) => Effect.Effect<boolean>;
}

/** The `api` target's operations as Effects: the RPC target over them is `rpcTarget`. */
export interface McpApiService {
  readonly describe: () => ApiDescription;
  readonly environments: Effect.Effect<ApiResult<EnvironmentsResult>>;
  readonly sessions: (query: SessionsQuery) => Effect.Effect<
    ApiResult<{
      readonly sessions: ReadonlyArray<McpSessionSummary>;
      readonly next_cursor?: string;
    }>
  >;
  readonly session: (id: string) => Effect.Effect<ApiResult<SessionDetail>>;
  readonly transcript: (
    request: TranscriptRequest & { readonly session_id: string },
  ) => Effect.Effect<ApiResult<TranscriptPage & { readonly session_id: string }>>;
  readonly start: (request: StartRequest) => Effect.Effect<ApiResult<StartResult>>;
  readonly send: (request: SendRequest) => Effect.Effect<ApiResult<SubmitResult>>;
  readonly stop: (request: StopSessionRequest) => Effect.Effect<ApiResult<StopResult>>;
  readonly wait: (request: WaitSessionRequest) => Effect.Effect<ApiResult<WaitResult>>;
  readonly importBegin: (
    request: ImportBeginRequest,
  ) => Effect.Effect<ApiResult<ImportBeginResult>>;
  readonly importAppend: (
    request: ImportAppendRequest,
  ) => Effect.Effect<ApiResult<ImportAppendResult>>;
  readonly importFinish: (
    request: ImportFinishRequest,
  ) => Effect.Effect<ApiResult<ImportFinishResult>>;
  readonly importCancel: (
    request: ImportCancelRequest,
  ) => Effect.Effect<ApiResult<ImportCancelResult>>;
  /** Counts a call; present when the caller is over its rate. */
  readonly limited: Effect.Effect<{ readonly retryAfterS: number } | undefined>;
  readonly auth: McpAuth;
}

/** Who is calling, as the span and the rate limit read it. */
export interface Identity {
  readonly auth: McpAuth;
  readonly rateKey: string;
}

/**
 * How the caller got in, as the audit mark says it (the owner comes through managed OAuth), and the key its calls are
 * counted under: `owner`, `token:<client id>` or `local`, never the email.
 */
export const identityOf = (caller: Caller): Identity => {
  switch (caller.kind) {
    case "owner":
      return { auth: "oauth", rateKey: "owner" };
    case "service_token":
      return { auth: "service_token", rateKey: `token:${caller.clientId}` };
    case "local":
      return { auth: "local", rateKey: "local" };
  }
};

const unavailable = apiFailure(
  "unavailable",
  "cloudpid could not read that just now: try again shortly.",
);

/** Every failure or defect of an RPC is `unavailable`, which may heal; the operation's own failures are values. */
const guarded = <A>(effect: Effect.Effect<ApiResult<A>>): Effect.Effect<ApiResult<A>> =>
  effect.pipe(Effect.catchCause(() => Effect.succeed(unavailable)));

const invalidId = apiFailure(
  "invalid_argument",
  "session_id must be a Session's full id (a UUID), as sessions_list gives it.",
);

const notFound = (id: string) =>
  apiFailure("not_found", `No Session ${id}: list Sessions to find its id.`);

const originOf = (record: SessionRecord): McpSessionOrigin | undefined => {
  if (record.marks !== undefined) return record.marks;

  return record.origin === undefined
    ? undefined
    : { kind: record.origin.kind, session: record.origin.session };
};

const summaryOf = (
  record: SessionRecord,
  environments: ReadonlyMap<string, string>,
  origin: string,
): McpSessionSummary => {
  const sessionOrigin = originOf(record);

  const summary: McpSessionSummary = {
    session_id: record.id,
    title: record.title,
    environment: {
      id: record.environment,
      name: environments.get(record.environment) ?? record.environment,
    },
    // An import still filling the Session is what it is doing, whatever its last Run reported.
    status: record.importing === true ? "importing" : record.status,
    updated_at: new Date(record.updatedAt).toISOString(),
    archived: record.archivedAt !== null,
    url: `${origin}/sessions/${record.id}`,
  };

  return sessionOrigin === undefined ? summary : { ...summary, origin: sessionOrigin };
};

/** `request`'s Environment as an id: an exact id, else an exact name in any case. */
const resolveEnvironment = (
  reference: string,
  environments: ReadonlyArray<EnvironmentRecord>,
): ApiResult<string> => {
  const byId = Arr.findFirst(environments, (environment) => environment.id === reference);

  if (Option.isSome(byId)) return apiOk(byId.value.id);

  const wanted = reference.trim().toLowerCase();

  const named = Arr.filter(
    environments,
    (environment) => environment.name.toLowerCase() === wanted,
  );

  if (named.length === 1 && named[0] !== undefined) return apiOk(named[0].id);

  return named.length === 0
    ? apiFailure(
        "not_found",
        `No Environment "${reference}": call environments_list for the ids and names.`,
      )
    : apiFailure(
        "ambiguous_environment",
        `Several Environments are named "${reference}": use the id environments_list gives.`,
        { details: { ids: Arr.map(named, (environment) => environment.id) } },
      );
};

const decodeTitle = Schema.decodeUnknownOption(SessionTitle);

const isThinkingLevel = Schema.is(ThinkingLevel);

const tooLarge = apiFailure(
  "input_too_large",
  `Input is over ${String(MAX_MCP_INPUT_BYTES)} bytes: send less text, or put it in a file in the Workspace.`,
);

/** Whether `text` is within the most input a message may carry over the endpoint. */
const withinInput = (text: string): boolean =>
  new TextEncoder().encode(text).length <= MAX_MCP_INPUT_BYTES;

/**
 * What the Session keeps of who sent an input: the client's name and the era from `McpServer`, and from the verified caller,
 * never from an argument, how it got in (`auth`) and, for the owner, which of their Access grants it came through
 * (`clientId`, the assertion's `oauth.client_id`). The email is never here.
 */
const sessionViaOf = (via: Via, caller: Caller, auth: McpAuth): SessionVia => {
  const marked: Types.Mutable<SessionVia> = { auth, era: via.era };

  if (via.client !== undefined) marked.client = via.client;

  if (caller.kind === "owner" && caller.clientId !== undefined) marked.clientId = caller.clientId;

  return marked;
};

/** The waiting requests with their `url` (the Session's own, `/sessions/<id>?request=<id>`) made absolute at `origin`. */
const absoluteUrls = (
  waiting: ReadonlyArray<WaitingRequest>,
  origin: string,
): ReadonlyArray<WaitingRequest> =>
  Arr.map(waiting, (request) => ({
    ...request,
    url: request.url.startsWith("/") ? `${origin}${request.url}` : request.url,
  }));

/**
 * `cursor` with what it says its caller has seen cleared (the newest waiting request, the newest settled input, the
 * entries): the same conversation, nothing seen. A wait from it ends with whatever the Session already holds.
 */
const unseen = (cursor: string): string => {
  const state = Option.getOrUndefined(decodeCursor(cursor));

  return state === undefined ? cursor : encodeCursor({ ...state, e: 0, w: 0, s: 0 });
};

/** The Environments' names by id. */
const namesOf = (environments: ReadonlyArray<EnvironmentRecord>) =>
  new Map(Arr.map(environments, (environment) => [environment.id, environment.name] as const));

const unreachable = apiFailure(
  "unavailable",
  "The Session service could not be reached: try again shortly.",
);

/**
 * A failure after the Registry made the Session names it (`details.session_id` and `url`), so the caller can use it, or
 * repeat the start under the same `request_id`, rather than make a second one.
 */
const madeButNotStarted = (
  error: ApiError,
  session: { readonly id: string; readonly url: string },
  hasRequestId: boolean,
): ApiResult<never> => {
  const hint = !error.retryable
    ? ""
    : hasRequestId
      ? " Repeat session_start with the same request_id to send it."
      : " Send it with session_send to that session_id.";

  return apiFailure(error.code, `${error.message} The Session was made (${session.url}).${hint}`, {
    retryable: error.retryable,
    details: { session_id: session.id, url: session.url },
  });
};

/**
 * The running cap's refusal. It names a tool only where `served` (the operations `describe()` lists) has its operation,
 * as the tools' own descriptions are worded over the served tools: `session_wait` waits for one to end, `session_get`
 * checks them.
 */
export const tooManyRunning = (limit: number, served: ReadonlyArray<string>): string => {
  const check = Arr.join(
    [
      ...(served.includes("wait") ? ["wait for one with session_wait"] : []),
      ...(served.includes("session") ? ["check them with session_get"] : []),
    ],
    " or ",
  );

  return `${String(limit)} Sessions started over MCP are running: ${check === "" ? "" : `${check}, or `}stop one with session_stop, then start again.`;
};

/** Why a start was refused, as the endpoint says it. */
const refusedStart = (
  refusal: SessionRefusal,
  environment: string,
  branch: string | undefined,
  served: ReadonlyArray<string>,
): ApiResult<never> => {
  switch (refusal.refused) {
    case "no-environment":
      return apiFailure(
        "not_found",
        `No Environment "${environment}": call environments_list for the ids and names.`,
      );
    case "branch-taken":
      return apiFailure(
        "branch_taken",
        `Another Workspace is already on branch ${branch ?? ""}: choose another branch, or leave branch out.`,
        { details: { workspace: refusal.workspace } },
      );
    case "too-many-running":
      return apiFailure("too_many_running", tooManyRunning(refusal.limit, served), {
        retryable: true,
        details: { limit: refusal.limit },
      });
    case "too-many-imports":
      return apiFailure(
        "too_many_running",
        `${String(refusal.limit)} session imports are open: finish or cancel one (session_import_cancel), or wait for one to expire, then begin again.`,
        { retryable: true, details: { limit: refusal.limit } },
      );
    case "no-workspace":
      return apiFailure("unavailable", "The Workspace is gone: try again.");
  }
};

/** An epoch time as ISO 8601 text. */
const isoOf = (epochMs: number): string => new Date(epochMs).toISOString();

/** What the Session is told of an import it begins: the size, who sent it, the Workspace's branch and Repos, and what was asked. */
const importOf = (
  request: ImportBeginRequest,
  workspace: WorkspaceRecord,
  caller: Caller,
  auth: McpAuth,
): StageImportBegin => {
  const begin: Types.Mutable<StageImportBegin> = {
    size_bytes: request.size_bytes,
    via: sessionViaOf(request.via, caller, auth),
    workspace: {
      branch: workspace.branch,
      repos: Arr.map(workspace.repos, (name) => ({
        name,
        directory: `${WORKSPACE_ROOT}/${name}`,
      })),
    },
  };

  if (request.model !== undefined) begin.model = request.model;

  if (request.thinking !== undefined) begin.thinking = request.thinking;

  if (request.text !== undefined) begin.text = request.text;

  return begin;
};

/** The failure for an import tool called with an id that is no import of the Registry's: made up, deleted, or another Session. */
const notAnImport = (id: string) =>
  apiFailure(
    "not_found",
    `No Session import ${id}: it was cancelled or expired and is deleted, or the id is not one session_import_begin gave.`,
  );

/** The service's operations over `backend` for one request. */
export const mcpApiService = (backend: McpBackend, context: McpApiContext): McpApiService => {
  const identity = identityOf(context.caller);

  /** Whether `id` is a Session the Registry lists as an import: the import tools never reach another Session's object. */
  const isImport = (id: string) =>
    Effect.map(backend.session(id), (record) => record?.marks?.kind === "import");

  /**
   * What a wait whose RPC was cut answers (`docs/architecture/mcp-endpoint.md` → Following a Run): `timeout`, `interrupted`,
   * the Session's status read once, and **the cursor that was passed in**, so the caller waits again from where it was
   * and a Run that ended, or a request that appeared, while the RPC was cut is still reported by that wait. With none
   * passed, the status's cursor with its marks cleared (`unseen`): it follows the same conversation but has seen
   * nothing, so the re-wait may end at once with what is already there (the last Run, the requests waiting) and never
   * misses what changed during the cut. Only a status that cannot be read either is `unavailable`.
   */
  const interruptedOutcome = (id: string, after: string | undefined) =>
    backend.status(id, after).pipe(
      Effect.catchCause(() => Effect.succeed(unreachable)),
      Effect.map((report): ApiResult<WaitOutcome> => {
        if (!report.ok) return report;

        const { status, waiting, cursor, branch_changed, text_withheld } = report.value;

        const outcome: Types.Mutable<WaitOutcome> = {
          status,
          ended_by: "timeout",
          interrupted: true,
          waiting,
          activity: { entries: 0, tool_calls: 0, latest: [] },
          cursor: after ?? unseen(cursor),
        };

        if (branch_changed === true) outcome.branch_changed = true;

        if (text_withheld !== undefined) outcome.text_withheld = text_withheld;

        return apiOk(outcome);
      }),
    );

  return {
    describe: () => {
      const description = { operations: [...MCP_API_OPERATIONS_SERVED], limits: MCP_API_LIMITS };

      return context.version === undefined
        ? description
        : { ...description, version: context.version };
    },

    environments: guarded(
      Effect.gen(function* () {
        const [environments, sessions, model] = yield* Effect.all([
          backend.environments,
          backend.allSessions,
          // A Registry that cannot say the default model still lists the Environments.
          backend.defaultModel.pipe(
            Effect.asSome,
            Effect.catchCause(() => Effect.succeed(Option.none<string>())),
          ),
        ]);

        const running = new Map<string, number>();

        for (const session of sessions) {
          if (session.status === "running") {
            running.set(session.environment, (running.get(session.environment) ?? 0) + 1);
          }
        }

        // The default Environment first, as the web lists them; the rest as the Registry does (newest first).
        const ordered = Arr.sort(
          environments,
          Order.mapInput(Order.Number, (environment: EnvironmentRecord) =>
            environment.id === DEFAULT_ENVIRONMENT ? 0 : 1,
          ),
        );

        return apiOk({
          environments: Arr.map(ordered, (environment) => ({
            id: environment.id,
            name: environment.name,
            default: environment.id === DEFAULT_ENVIRONMENT,
            repos: Arr.map(environment.repos, ({ name, url }) => ({ name, url })),
            running_sessions: running.get(environment.id) ?? 0,
          })),
          models: Option.isSome(model)
            ? { available: [...SUPPORTED_MODELS], default: model.value }
            : { available: [...SUPPORTED_MODELS] },
        } satisfies EnvironmentsResult);
      }),
    ),

    sessions: (query) =>
      guarded(
        Effect.gen(function* () {
          const environments = yield* backend.environments;
          let environment: string | undefined;

          if (query.environment !== undefined) {
            const resolved = resolveEnvironment(query.environment, environments);

            if (!resolved.ok) return resolved;

            environment = resolved.value;
          }

          const { environment: _asked, ...rest } = query;

          const page = yield* backend.sessions(
            environment === undefined ? rest : { ...rest, environment },
          );

          if ("refused" in page) {
            return apiFailure(
              "invalid_cursor",
              "That cursor is not one sessions_list gave: list again without it.",
            );
          }

          const names = namesOf(environments);

          const sessions = Arr.map(page.sessions, (record) =>
            summaryOf(record, names, context.origin),
          );

          return apiOk(
            page.nextCursor === undefined
              ? { sessions }
              : { sessions, next_cursor: page.nextCursor },
          );
        }),
      ),

    session: (id) =>
      guarded(
        Effect.gen(function* () {
          if (!SESSION_ID.test(id)) return invalidId;

          const record = yield* backend.session(id);

          if (record === null) return notFound(id);

          const [environments, workspace, report] = yield* Effect.all([
            backend.environments,
            backend.workspace(record.workspace),
            backend.status(id),
          ]);

          if (!report.ok) return report;

          const summary = summaryOf(record, namesOf(environments), context.origin);

          return apiOk({
            ...summary,
            ...report.value,
            // The Session's own account of what each waits for, as a page the owner can open.
            waiting: absoluteUrls(report.value.waiting, context.origin),
            agents: Arr.map(record.agents ?? [], (agent) => ({
              agent_id: agent.id,
              parent: agent.parent,
              role: agent.role,
              status: agent.status,
            })),
            workspace: {
              branch: workspace?.branch ?? null,
              base: workspace?.base ?? null,
              repos: workspace?.repos ?? [],
            },
          } satisfies SessionDetail);
        }),
      ),

    transcript: ({ session_id: id, ...request }) =>
      guarded(
        Effect.gen(function* () {
          if (!SESSION_ID.test(id)) return invalidId;

          // The Registry first: a made-up id never reaches a Session object (and so never makes one).
          const record = yield* backend.session(id);

          if (record === null) return notFound(id);

          const page = yield* backend.transcript(id, request);

          return page.ok ? apiOk({ ...page.value, session_id: id }) : page;
        }),
      ),

    start: (request) =>
      guarded(
        Effect.gen(function* () {
          const { via, text } = request;

          if (!withinInput(text)) return tooLarge;

          if (request.branch !== undefined) {
            const problem = ownBranchProblem(request.branch);

            if (problem !== undefined) return apiFailure("invalid_argument", `branch: ${problem}.`);
          }

          if (request.base !== undefined) {
            const problem = branchProblem(request.base);

            if (problem !== undefined) return apiFailure("invalid_argument", `base: ${problem}.`);
          }

          const model = request.model;

          if (model !== undefined && !isModelId(model)) {
            return apiFailure(
              "invalid_argument",
              `model must be one of environments_list's models.available: ${Arr.join(SUPPORTED_MODELS, ", ")}.`,
            );
          }

          const thinking = request.thinking;

          if (thinking !== undefined && !isThinkingLevel(thinking)) {
            return apiFailure(
              "invalid_argument",
              `thinking must be one of ${Arr.join(THINKING_LEVELS, ", ")}.`,
            );
          }

          const title =
            request.title === undefined
              ? undefined
              : Option.getOrUndefined(decodeTitle(request.title));

          if (request.title !== undefined && title === undefined) {
            return apiFailure("invalid_argument", "title must not be empty.");
          }

          const environments = yield* backend.environments;

          const resolved =
            request.environment === undefined
              ? apiOk(DEFAULT_ENVIRONMENT)
              : resolveEnvironment(request.environment, environments);

          if (!resolved.ok) return resolved;

          const marks: Types.Mutable<MarkedOrigin> = { kind: "mcp", auth: identity.auth };

          if (via.client !== undefined) marks.client = via.client;

          const created = yield* backend.createSession({
            environment: resolved.value,
            title,
            branch: request.branch,
            base: request.base,
            marks,
            requestId: request.request_id,
            maxRunning: MAX_MCP_RUNNING,
          });

          if ("refused" in created)
            return refusedStart(created, resolved.value, request.branch, MCP_API_OPERATIONS_SERVED);

          const id = created.id;
          const url = `${context.origin}/sessions/${id}`;

          // The Registry made the Session, so every failure from here names it: the caller can use it, or repeat the start.
          const sendFirst = Effect.gen(function* () {
            // Only the first start of a `request_id` picks the model: a repeat finds the Session as it was left, and
            // heals at most the first message (the Session's own dedupe of the same id).
            if (created.repeated !== true && (model !== undefined || thinking !== undefined)) {
              const pick: Types.Mutable<ConfigureRequest> = {};

              if (model !== undefined) pick.model = model;

              if (thinking !== undefined) pick.thinkingLevel = thinking;

              const configured = yield* backend.configure(id, pick);

              if (!configured.ok) return configured;
            }

            const first: Types.Mutable<SubmitRequest> = {
              input: text,
              via: sessionViaOf(via, context.caller, identity.auth),
            };

            if (request.request_id !== undefined) first.requestId = request.request_id;

            return yield* backend.submit(id, first);
          }).pipe(Effect.catchCause(() => Effect.succeed(unreachable)));

          const sent = yield* sendFirst;

          if (!sent.ok) {
            return madeButNotStarted(sent.error, { id, url }, request.request_id !== undefined);
          }

          const environment = Arr.findFirst(
            environments,
            ({ id: known }) => known === created.environment,
          );

          // A Session that cannot say its status yet is running the message just sent.
          const status = yield* backend.status(id).pipe(Effect.catchCause(() => Effect.void));

          return apiOk<StartResult>({
            session_id: id,
            title: created.title,
            url,
            status: status?.ok === true ? status.value.status : "running",
            cursor: sent.value.cursor,
            environment: {
              id: created.environment,
              name: Option.isSome(environment) ? environment.value.name : created.environment,
              repos: Option.isSome(environment)
                ? Arr.map(environment.value.repos, (repo) => repo.name)
                : [],
            },
          });
        }),
      ),

    send: (request) =>
      guarded(
        Effect.gen(function* () {
          if (!SESSION_ID.test(request.session_id)) return invalidId;

          if (!withinInput(request.text)) return tooLarge;

          // The Registry first: a made-up id never reaches a Session object (and so never makes one).
          if ((yield* backend.session(request.session_id)) === null) {
            return notFound(request.session_id);
          }

          const message: Types.Mutable<SubmitRequest> = {
            input: request.text,
            whenBusy: whenBusyOf(request.when_busy ?? "queue"),
            via: sessionViaOf(request.via, context.caller, identity.auth),
          };

          if (request.request_id !== undefined) message.requestId = request.request_id;

          return yield* backend.submit(request.session_id, message);
        }),
      ),

    stop: (request) =>
      guarded(
        Effect.gen(function* () {
          if (!SESSION_ID.test(request.session_id)) return invalidId;

          if ((yield* backend.session(request.session_id)) === null) {
            return notFound(request.session_id);
          }

          const stopping: Types.Mutable<StopRequest> = {
            via: sessionViaOf(request.via, context.caller, identity.auth),
          };

          if (request.subagents !== undefined) stopping.subagents = request.subagents;

          return yield* backend.stop(request.session_id, stopping);
        }),
      ),

    wait: (request) =>
      guarded(
        Effect.gen(function* () {
          const { session_id: id, after } = request;

          if (!SESSION_ID.test(id)) return invalidId;

          // The Registry first: a made-up id never reaches a Session object (and so never makes one).
          if ((yield* backend.session(id)) === null) return notFound(id);

          const waitMs = Math.min(
            MAX_MCP_WAIT_MS,
            Math.max(0, (request.timeout_s ?? DEFAULT_MCP_WAIT_MS / 1000) * 1000),
          );

          const deadline = (yield* Clock.currentTimeMillis) + waitMs;

          const waited = yield* backend
            .wait(id, after === undefined ? { deadline } : { after, deadline })
            // The RPC was cut on the Session's side (a deploy or an eviction cut it, or it could not be reached): the
            // Run goes on, so the wait says so and hands the caller's cursor back instead of failing.
            .pipe(Effect.catchCause(() => interruptedOutcome(id, after)));

          return waited.ok
            ? apiOk<WaitResult>({
                session_id: id,
                ...waited.value,
                waiting: absoluteUrls(waited.value.waiting, context.origin),
              })
            : waited;
        }),
      ),

    importBegin: (request) =>
      guarded(
        Effect.gen(function* () {
          if (request.format !== PI_SESSION_FORMAT) {
            return apiFailure(
              "unsupported_format",
              `format ${request.format} is not one this server reads: send ${PI_SESSION_FORMAT}, the pi session file as it is on disk.`,
            );
          }

          if (request.size_bytes < 0) {
            return apiFailure("invalid_argument", "size_bytes must be the file's size in bytes.");
          }

          if (request.size_bytes > MAX_MCP_IMPORT_BYTES) {
            return apiFailure(
              "import_too_large",
              `The file is over ${String(MAX_MCP_IMPORT_BYTES)} bytes: import_too_large.`,
            );
          }

          if (request.text !== undefined && !withinInput(request.text)) return tooLarge;

          if (request.branch !== undefined) {
            const problem = ownBranchProblem(request.branch);

            if (problem !== undefined) return apiFailure("invalid_argument", `branch: ${problem}.`);
          }

          if (request.base !== undefined) {
            const problem = branchProblem(request.base);

            if (problem !== undefined) return apiFailure("invalid_argument", `base: ${problem}.`);
          }

          const title =
            request.title === undefined
              ? undefined
              : Option.getOrUndefined(decodeTitle(request.title));

          if (request.title !== undefined && title === undefined) {
            return apiFailure("invalid_argument", "title must not be empty.");
          }

          const environments = yield* backend.environments;
          const resolved = resolveEnvironment(request.environment, environments);

          if (!resolved.ok) return resolved;

          const marks: Types.Mutable<MarkedOrigin> = { kind: "import", auth: identity.auth };

          if (request.via.client !== undefined) marks.client = request.via.client;

          const created = yield* backend.createSession({
            environment: resolved.value,
            title,
            branch: request.branch,
            base: request.base,
            marks,
            requestId: request.request_id,
            maxRunning: MAX_MCP_RUNNING,
            maxOpenImports: { limit: MAX_MCP_OPEN_IMPORTS, auth: identity.auth },
          });

          if ("refused" in created) {
            if (created.refused !== "branch-taken") {
              return refusedStart(
                created,
                resolved.value,
                request.branch,
                MCP_API_OPERATIONS_SERVED,
              );
            }

            const held = yield* backend.allSessions;

            return apiFailure(
              "branch_taken",
              `Another Workspace is already on branch ${request.branch ?? ""}: remove it in cloudpid, or import onto another branch.`,
              {
                details: {
                  workspace: created.workspace,
                  sessions: Arr.map(
                    Arr.filter(held, (record) => record.workspace === created.workspace),
                    (record) => ({
                      id: record.id,
                      url: `${context.origin}/sessions/${record.id}`,
                      title: record.title,
                      status: record.status,
                    }),
                  ),
                },
              },
            );
          }

          // A `request_id` finds the Session an earlier call made, whatever the call was: one that was no import is
          // none of this begin's to use, and is left as it is.
          if (created.marks?.kind !== "import") {
            return apiFailure(
              "invalid_argument",
              "request_id was used by another call that did not begin a session import: use a new request_id.",
            );
          }

          const id = created.id;
          const workspace = yield* backend.workspace(created.workspace);

          // The Registry made the Session: one that cannot be told it is an import is deleted again, so no importing
          // Session is left that nothing will finish (a repeat of a begin that did not get this far finds none).
          const begun =
            workspace === null
              ? unreachable
              : yield* backend
                  .stageImportBegin(id, importOf(request, workspace, context.caller, identity.auth))
                  .pipe(Effect.catchCause(() => Effect.succeed(unreachable)));

          if (workspace === null || !begun.ok) {
            if (created.repeated !== true) yield* Effect.ignoreCause(backend.deleteSession(id));

            return begun.ok ? unreachable : begun;
          }

          return apiOk<ImportBeginResult>({
            import_id: id,
            session_id: id,
            url: `${context.origin}/sessions/${id}`,
            received: begun.value.received,
            max_slice_bytes: MAX_MCP_SLICE_BYTES,
            expires_at: isoOf(begun.value.expires_at),
            carry_ref: importCarryRef(id),
          });
        }),
      ),

    importAppend: (request) =>
      guarded(
        Effect.gen(function* () {
          const id = request.import_id;

          if (!SESSION_ID.test(id)) return invalidId;

          if (!(yield* isImport(id))) return notAnImport(id);

          const staged = yield* backend.stageImportAppend(id, {
            offset: request.offset,
            data: request.data,
          });

          return staged.ok
            ? apiOk<ImportAppendResult>({ received: staged.value.received })
            : staged;
        }),
      ),

    importFinish: (request) =>
      guarded(
        Effect.gen(function* () {
          const id = request.import_id;

          if (!SESSION_ID.test(id)) return invalidId;

          if (!(yield* isImport(id))) return notAnImport(id);

          const finished = yield* backend.stageImportFinish(id, { sha256: request.sha256 });

          if (!finished.ok) return finished;

          const { status, cursor, summary, warnings } = finished.value;

          const result: Types.Mutable<ImportFinishResult> = {
            session_id: id,
            status,
            url: `${context.origin}/sessions/${id}`,
            cursor,
            warnings,
          };

          if (summary !== undefined) result.summary = summary;

          return apiOk(result);
        }),
      ),

    importCancel: (request) =>
      guarded(
        Effect.gen(function* () {
          const id = request.import_id;

          if (!SESSION_ID.test(id)) return invalidId;

          const known = yield* backend.session(id);

          // Cancelling is idempotent: a Session that is gone was cancelled, or expired, and deleted.
          if (known === null) return apiOk<ImportCancelResult>({ cancelled: true });

          // Never a Session that is not an import: this tool deletes what it is given.
          if (known.marks?.kind !== "import") return notAnImport(id);

          const staged = yield* backend.stageImportCancel(id);

          // A Session that already took the cancel (or expired) is still listed: its deletion goes on.
          if (!staged.ok && staged.error.code !== "not_found") return staged;

          yield* backend.deleteSession(id);

          return apiOk<ImportCancelResult>({ cancelled: true });
        }),
      ),

    limited: context.withinRate(identity.rateKey).pipe(
      // A limiter that cannot answer counts as within the rate: the endpoint fails open, the owner's own calls first.
      Effect.catchCause(() => Effect.succeed(true)),
      Effect.map((within) => (within ? undefined : { retryAfterS: MCP_CALLS_PERIOD_S })),
    ),

    auth: identity.auth,
  };
};
