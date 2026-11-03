// docs/architecture/mcp-endpoint.md → The `api` target, Access and identity, Limits and errors: what the main Worker
// builds per `/mcp` request and passes to `McpServer`, over the Registry and the Sessions it already has. It owns
// authorization (the guard has run), validation, the Registry and Session calls, cursors and rendering; `McpServer` owns
// the SDK, the schemas and the text. The caller's identity is closed over it and is never an argument. Failures travel
// as values (`ApiResult`); nothing streams. The four read operations are here; an operation `describe()` does not list
// answers `unsupported`, which is also how `McpServer` knows to leave its tool out.
// @effect-diagnostics globalDate:off preferEffectArray:off missingPipeableSignature:off -- epoch times said as ISO text; short native lists.
import { isModelId, SUPPORTED_MODELS, ThinkingLevel, THINKING_LEVELS } from "@cloudpid/config";
import {
  type ApiDescription,
  type ApiResult,
  apiFailure,
  apiOk,
  branchProblem,
  type ConfigureRequest,
  DEFAULT_ENVIRONMENT,
  type EnvironmentRecord,
  type EnvironmentsResult,
  MAX_MCP_INPUT_BYTES,
  MAX_MCP_RUNNING,
  MCP_API_LIMITS,
  type MarkedOrigin,
  type McpWhenBusy,
  SESSION_ID,
  type McpAuth,
  type McpSessionOrigin,
  type McpSessionSummary,
  ownBranchProblem,
  type SessionDetail,
  type SessionRecord,
  SessionTitle,
  type SessionsQuery,
  type SessionStatusReport,
  type SessionVia,
  type StartRequest,
  type StartResult,
  type StopRequest,
  type StopResult,
  type SubmitRequest,
  type SubmitResult,
  type TranscriptPage,
  type TranscriptRequest,
  type Via,
  whenBusyOf,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { Caller } from "../access.ts";
import type { SessionsResult } from "../registry/session-page.ts";
import type { SessionRefusal } from "../registry/store.ts";

/** The operations this version of `Server` has: `McpServer` serves a tool only when its operation is listed. */
export const MCP_API_OPERATIONS_SERVED = [
  "environments",
  "sessions",
  "session",
  "transcript",
  "start",
  "send",
  "stop",
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
  /** The Session object's `status()`. */
  readonly status: (id: string) => Effect.Effect<ApiResult<SessionStatusReport>>;
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
  }) => Effect.Effect<SessionRecord | SessionRefusal>;
  /** The Session object's `configure()`. */
  readonly configure: (id: string, request: ConfigureRequest) => Effect.Effect<ApiResult<null>>;
  /** The Session object's `submit()`. */
  readonly submit: (id: string, request: SubmitRequest) => Effect.Effect<ApiResult<SubmitResult>>;
  /** The Session object's `stop()`. */
  readonly stop: (id: string, request: StopRequest) => Effect.Effect<ApiResult<StopResult>>;
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
  readonly send: (request: {
    readonly session_id: string;
    readonly text: string;
    readonly when_busy?: McpWhenBusy;
    readonly request_id?: string;
    readonly via: Via;
  }) => Effect.Effect<ApiResult<SubmitResult>>;
  readonly stop: (request: {
    readonly session_id: string;
    readonly subagents?: boolean;
    readonly via: Via;
  }) => Effect.Effect<ApiResult<StopResult>>;
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
    status: record.status,
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

/** The Environments' names by id. */
const namesOf = (environments: ReadonlyArray<EnvironmentRecord>) =>
  new Map(Arr.map(environments, (environment) => [environment.id, environment.name] as const));

/** Why a start was refused, as the endpoint says it. */
const refusedStart = (
  refusal: SessionRefusal,
  environment: string,
  branch: string | undefined,
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
      return apiFailure(
        "too_many_running",
        `${String(refusal.limit)} Sessions started over MCP are running: wait for one to finish (session_wait) or stop one (session_stop), then start again.`,
        { retryable: true, details: { limit: refusal.limit } },
      );
    case "no-workspace":
      return apiFailure("unavailable", "The Workspace is gone: try again.");
  }
};

/** The service's operations over `backend` for one request. */
export const mcpApiService = (backend: McpBackend, context: McpApiContext): McpApiService => {
  const identity = identityOf(context.caller);

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
            waiting: Arr.map(report.value.waiting, (request) => ({
              ...request,
              url: request.url.startsWith("/") ? `${context.origin}${request.url}` : request.url,
            })),
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

          if ("refused" in created) return refusedStart(created, resolved.value, request.branch);

          const id = created.id;

          // A repeated `request_id` finds the same Session, and the same first message below (the Session knows the id).
          if (model !== undefined || thinking !== undefined) {
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

          const sent = yield* backend.submit(id, first);

          if (!sent.ok) return sent;

          const environment = Arr.findFirst(
            environments,
            ({ id: known }) => known === created.environment,
          );

          // A Session that cannot say its status yet is running the message just sent.
          const status = yield* backend.status(id).pipe(Effect.catchCause(() => Effect.void));

          return apiOk<StartResult>({
            session_id: id,
            title: created.title,
            url: `${context.origin}/sessions/${id}`,
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

    limited: context.withinRate(identity.rateKey).pipe(
      // A limiter that cannot answer counts as within the rate: the endpoint fails open, the owner's own calls first.
      Effect.catchCause(() => Effect.succeed(true)),
      Effect.map((within) => (within ? undefined : { retryAfterS: MCP_CALLS_PERIOD_S })),
    ),

    auth: identity.auth,
  };
};
