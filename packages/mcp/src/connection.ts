/**
 * `connect(target, deps) → McpConnection`: one connection to one MCP server, in either Protocol era, over the SDK
 * client (`docs/architecture/mcp.md` → Protocol eras, Packages and objects (the core's seam); The MCP core #394
 * D1–D7, D23).
 *
 * Everything outside the core is injected: `fetch`, `auth`, the era and Legacy session stores, `capabilities(ctx)`,
 * `extensions` and `clientInfo`; the clock is Effect's. The connection opens from the stored rows when it can (a
 * Modern server with no round trip, a Legacy session with no `initialize`), probes the era otherwise, and keeps the
 * rows current: an unknown row format reads as absent, a Legacy row is probed again once 24 h old, a Modern
 * server's 400, 404 or 405 drops the era and sends the request again once, and a Legacy session's 404 initializes
 * again and sends it again once.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type CallToolRequestOptions,
  type CallToolRequestParams,
  type CallToolResult,
  Client,
  type ConnectOptions,
  type ClientCapabilities,
  isCallToolResult,
  type DiscoverResult,
  extractWWWAuthenticateParams,
  type FetchLike,
  type Implementation,
  type JSONObject,
  type JsonSchemaValidator,
  LOG_LEVEL_META_KEY,
  type LoggingLevel,
  PROTOCOL_VERSION_META_KEY,
  type PriorDiscovery,
  type Prompt,
  type ProtocolEra,
  type Resource,
  type ResourceTemplateType,
  type RequestOptions,
  type Result,
  type ServerCapabilities,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  type Tool,
} from "@modelcontextprotocol/client";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { Mutable } from "effect/Types";
import { authChallenge, classify, type Failure, signInRequired } from "./failures.ts";
import { declaredCapabilities, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.ts";
import { MCP_LOG_LEVEL } from "./log.ts";
import { type TapObserver, tapFetch, Verdicts } from "./tap.ts";
import {
  openTaskWire,
  type TaskParams,
  type TaskRequestOptions,
  type TaskWire,
} from "./task-wire.ts";
import { xMcpHeaders } from "./tool-headers.ts";
import {
  Cut,
  type EraRow,
  EraRowV1,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LIST_WALK_TIMEOUT_MS,
  MCP_TASKS_EXTENSION,
  type McpCallContext,
  type McpAuthChallenge,
  type McpError,
  type McpProgress,
  type McpRoot,
  McpTaskCreated,
  type McpTaskInputResponses,
  McpTaskSnapshot,
  ProtocolViolation,
  type SessionRow,
  SessionRowV1,
  SignInRequired,
  StepUpRequired,
  TimedOut,
  Unreachable,
  Unsupported,
} from "./types.ts";

/** The server to connect to: an HTTP server, or a stdio server through the Container bridge, by URL. */
export interface McpTarget {
  readonly url: string;
  /** The server's configured name, which the one failure that names it says (a `-32021` for an MCP task). */
  readonly name?: string;
  /** The entry's headers, `${NAME}` values resolved. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The entry's `timeout` for a `tools/call` (default 60 s). */
  readonly timeoutMs?: number;
  /**
   * How long a probe or an `initialize` may take (default `MCP_CONNECT_TIMEOUT_MS`, 15 s). Through the Container bridge
   * it is 60 s, since the first request may start the Container and spawn the server
   * (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions, Timeouts).
   */
  readonly connectTimeoutMs?: number;
}

/** Where one `prior` row (era or Legacy session) is kept. A row may be of any format, so it is read as JSON. */
export interface RowStore {
  readonly get: Effect.Effect<Schema.Json | undefined>;
  readonly set: (row: Schema.Json) => Effect.Effect<void>;
  readonly drop: Effect.Effect<void>;
}

/** Everything outside the core, injected and never created (The MCP core #394 D7). */
export interface McpDeps {
  /** Guarded and queued, or the Container port. */
  readonly fetch: FetchLike;
  /** An access token for the server, asked again with `stale` after the server refused one; none for no OAuth. */
  readonly auth?: (stale: boolean) => Effect.Effect<string | undefined>;
  readonly eras: RowStore;
  readonly sessions: RowStore;
  /** What the client declares: connection-wide without `ctx` (Legacy), per request with it (Modern). */
  readonly capabilities: (ctx?: McpCallContext) => ClientCapabilities;
  /** Extensions the connection declares besides MCP Apps, such as OAuth Client Credentials. */
  readonly extensions?: Readonly<Record<string, JSONObject>>;
  /** `{ name: "cloudpid", version: <deploy> }`. */
  readonly clientInfo: Implementation;
  /**
   * Hears each `notifications/message` the server sends. With it, the core asks a server that declares `logging` for
   * `warning` and above, in both eras (Legacy: `logging/setLevel` after an `initialize` that opens a session the host
   * keeps, since a server that keeps none forgets the level at once; Modern: `_meta` `logLevel` on every request);
   * without it, it asks for none.
   */
  readonly onLog?: (log: McpLog) => void;
  /**
   * A `tools/call`'s progress. With it, a call asks the server for progress (a `progressToken`), and each notice also
   * resets the call's timeout; without it, the server is asked for none.
   */
  readonly onProgress?: (progress: McpProgress) => void;
  /**
   * The Roots the client offers (`docs/architecture/mcp-in-a-session.md` → Roots), given only on a bridge connection. With
   * it the client declares `roots` and answers `roots/list` from it, on the call's stream in a Legacy exchange and in the
   * `input_required` round it arrives in on Modern; without it a server is declared no `roots`, so a remote server is
   * never asked for any.
   */
  readonly roots?: ReadonlyArray<McpRoot>;
}

/** A `notifications/message` as the server sent it: the level, the logger's name and the data, any JSON. */
export interface McpLog {
  readonly level: string;
  readonly logger?: string | undefined;
  readonly data: unknown;
}

/**
 * What a connection did on the wire, for the engine's span: counts and one status, never a URL, header or value
 * (`docs/architecture/mcp-connections.md` → Telemetry).
 */
export interface McpConnectionStats {
  /** HTTP responses received, retries included. */
  readonly responses: number;
  /** The last HTTP status received. */
  readonly lastStatus: number | undefined;
  /** Requests sent again after a 408, 429 or 5xx. */
  readonly retries: number;
  /** Modern requests the server refused as of another era. */
  readonly eraDrops: number;
  /** Times the connection initialized or probed again. */
  readonly reinitializes: number;
}

/** What `list` lists, and the items of each. */
export interface ListItems {
  readonly tools: Tool;
  readonly prompts: Prompt;
  readonly resources: Resource;
  readonly "resources/templates": ResourceTemplateType;
}

export type ListKind = keyof ListItems;

/** A request that completed. Later slices add `input_required`. */
export interface Complete<A> {
  readonly kind: "complete";
  readonly value: A;
  /** False when the result came from answered questions, so no cache may keep it. */
  readonly cacheable: boolean;
  /** The server's cache hints, for the host's caches; the core serves nothing from a cache (D13). */
  readonly ttlMs?: number;
  readonly cacheScope?: "public" | "private";
  readonly fetchedAt: number;
}

/**
 * A `tools/call` the server answered with an MCP task (`resultType: "task"`). Only a call with `ctx.allowTask`, made to a
 * Modern server that advertises the tasks extension, is ever offered one; every other call gets the server's result as
 * a synchronous call does, or fails.
 */
export interface TaskStarted {
  readonly kind: "task";
  readonly task: McpTaskCreated;
  readonly fetchedAt: number;
}

/** A request's result: it completed, or (for a task-capable `tools/call` only) it started an MCP task. */
export type Outcome<A> = Complete<A> | TaskStarted;

/** A `tasks/get` answer: where the task stands and, once it has `completed`, the result of the call that started it. */
export interface TaskState {
  readonly task: McpTaskSnapshot;
  /** The `CallToolResult` of a `completed` task. */
  readonly result?: CallToolResult;
  readonly fetchedAt: number;
}

/**
 * The tasks of a Modern server, on the core's own task wire (`task-wire.ts`). A connection to a Legacy server fails each
 * as `Unsupported`: a Legacy server has no MCP tasks.
 */
export interface McpTasks {
  readonly get: (taskId: string, ctx: McpCallContext) => Effect.Effect<TaskState, McpError>;
  /** Answers the questions the task waits on, by key. */
  readonly update: (
    taskId: string,
    inputResponses: McpTaskInputResponses,
    ctx: McpCallContext,
  ) => Effect.Effect<void, McpError>;
  readonly cancel: (taskId: string, ctx: McpCallContext) => Effect.Effect<void, McpError>;
}

/**
 * A `tools/call`: the tool's definition, from the host's catalog (D13, D14), and the arguments. The call goes by the
 * definition's name, and its `inputSchema` gives the `Mcp-Param` headers.
 */
export interface CallToolParams {
  readonly tool: Tool;
  readonly arguments?: Readonly<Record<string, Schema.Json>>;
}

/** One connection to one MCP server (The MCP core #394 D7). */
export interface McpConnection {
  readonly era: ProtocolEra;
  readonly protocolVersion: string;
  readonly serverInfo: Implementation | undefined;
  readonly capabilities: ServerCapabilities;
  readonly instructions: string | undefined;
  /** What the connection did on the wire so far. */
  readonly stats: () => McpConnectionStats;
  /** Every page of `kind`. */
  readonly list: <K extends ListKind>(
    kind: K,
    ctx: McpCallContext,
  ) => Effect.Effect<Complete<ReadonlyArray<ListItems[K]>>, McpError>;
  /**
   * Calls a tool. With `ctx.allowTask`, on a Modern server that advertises the tasks extension, the call is sent on the
   * task wire with the extension declared, and the server may answer with a task; otherwise the extension is never
   * declared and the answer is always the tool's result.
   */
  readonly callTool: (
    params: CallToolParams,
    ctx: McpCallContext,
  ) => Effect.Effect<Outcome<CallToolResult>, McpError>;
  readonly task: McpTasks;
}

const CONNECT_TIMEOUT_MS = MCP_CONNECT_TIMEOUT_MS;

const PAGE_TIMEOUT_MS = 30_000;

const WALK_TIMEOUT = Duration.millis(MCP_LIST_WALK_TIMEOUT_MS);

const CALL_TIMEOUT_MS = 60_000;

/** A `tasks/*` request may take 30 s (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions). */
const TASK_TIMEOUT_MS = 30_000;

/** How long a close waits for the notifications in flight. */
const NOTIFY_GRACE = Duration.seconds(2);

/** A Legacy era row older than this is probed again at the next `initialize` (D3). */
const LEGACY_ERA_TTL_MS = 24 * 60 * 60 * 1000;

/** `discover_json` is kept up to 64 KiB (D3). */
const MAX_DISCOVER_BYTES = 64 * 1024;

/** A list request's params: a cursor, and the client's declaration on Modern. */
interface PageParams {
  cursor?: string;
  _meta?: RequestMeta;
}

/** A Modern request's `_meta`: the client's declaration, and the log level asked for where the server logs. */
type RequestMeta = {
  [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilities;
  [LOG_LEVEL_META_KEY]?: LoggingLevel;
};

/** One page of a list: its items, the next cursor, and the result for its cache hints. */
interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | undefined;
  readonly result: Result;
}

type PageOf<K extends ListKind> = (
  client: Client,
  params: PageParams,
  options: RequestOptions,
) => Promise<Page<ListItems[K]>>;

/** How `list` asks for each kind: the server capability it needs, and one page through `client.request`. */
type Lists = {
  readonly [K in ListKind]: {
    readonly capability: keyof ServerCapabilities;
    readonly page: PageOf<K>;
  };
};

/** Each list's method and the server capability it needs; `client.request`, so the core walks the cursors (D7). */
const LISTS = {
  tools: {
    capability: "tools",
    page: (client, params, options) =>
      client
        .request({ method: "tools/list", params: { ...params } }, options)
        .then((result) => ({ items: result.tools, nextCursor: result.nextCursor, result })),
  },
  prompts: {
    capability: "prompts",
    page: (client, params, options) =>
      client
        .request({ method: "prompts/list", params: { ...params } }, options)
        .then((result) => ({ items: result.prompts, nextCursor: result.nextCursor, result })),
  },
  resources: {
    capability: "resources",
    page: (client, params, options) =>
      client
        .request({ method: "resources/list", params: { ...params } }, options)
        .then((result) => ({ items: result.resources, nextCursor: result.nextCursor, result })),
  },
  "resources/templates": {
    capability: "resources",
    page: (client, params, options) =>
      client
        .request({ method: "resources/templates/list", params: { ...params } }, options)
        .then((result) => ({
          items: result.resourceTemplates,
          nextCursor: result.nextCursor,
          result,
        })),
  },
} satisfies Lists;

/** `LISTS` by kind, typed for that kind. */
const listOf = <K extends ListKind>(kind: K): Lists[K] => (LISTS satisfies Lists)[kind];

/** A list result's cache hints (SEP-2549), from its first page. */
const CacheHints = Schema.Struct({
  ttlMs: Schema.optionalKey(Schema.Finite),
  cacheScope: Schema.optionalKey(Schema.Literals(["public", "private"])),
});

type CacheHints = typeof CacheHints.Type;

const decodeCacheHints = Schema.decodeUnknownOption(CacheHints);

const decodeEraRow = Schema.decodeUnknownOption(EraRowV1);

const decodeTaskCreated = Schema.decodeUnknownOption(McpTaskCreated);

const decodeTaskSnapshot = Schema.decodeUnknownOption(McpTaskSnapshot);

/** What a `tasks/get` answers beside the task's own fields: its `resultType`, and a completed task's result. */
const TaskGetAnswer = Schema.Struct({
  resultType: Schema.Literal("complete"),
  result: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const decodeTaskGetAnswer = Schema.decodeUnknownOption(TaskGetAnswer);

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const decodeSessionRow = Schema.decodeUnknownOption(SessionRowV1);

const toJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

/**
 * The SDK validates nothing: the engine validates `structuredContent` against what it compiled (D17). `callTool`
 * also withholds `outputSchema`, which is what stops the SDK refusing a result without `structuredContent`; this
 * keeps the SDK from building a validator of its own (Ajv on Node, `@cfworker` on workerd) or running one on any
 * other path.
 */
const noValidation = {
  getValidator:
    <T>(): JsonSchemaValidator<T> =>
    (input) => ({
      valid: true,
      // SAFETY: no validation is the point; the engine checks `structuredContent` itself (D17).
      data: input as T,
      errorMessage: undefined,
    }),
};

/** A live SDK client and what the core knows of the server through it. */
interface Live {
  readonly client: Client;
  readonly era: ProtocolEra;
  readonly protocolVersion: string;
  readonly serverInfo: Implementation | undefined;
  readonly capabilities: ServerCapabilities;
  readonly instructions: string | undefined;
  readonly sessionId: string | undefined;
}

/** How a connection opens: from the rows, or fresh. */
type Plan =
  | { readonly kind: "modern"; readonly row: Extract<EraRow, { era: "modern" }> }
  | { readonly kind: "session"; readonly row: SessionRow }
  | { readonly kind: "legacy" }
  | { readonly kind: "probe" };

/** Connects to `target`; the connection closes with the scope. */
export const connect = Effect.fn("mcp.connect")(function* (target: McpTarget, deps: McpDeps) {
  const context = yield* Effect.context<never>();
  const connectMs = target.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const verdicts = new Verdicts();
  let challenge: McpAuthChallenge | undefined;

  /**
   * `deps.fetch`, remembering the `WWW-Authenticate` challenge of the last 401, for the failure the SDK throws after
   * it.
   */
  const watched: FetchLike = (input, init) =>
    deps.fetch(input, init).then((response) => {
      challenge =
        response.status === 401 ? authChallenge(extractWWWAuthenticateParams(response)) : undefined;

      return response;
    });

  const auth = authState(deps, context, () => challenge);

  const counts = { responses: 0, retries: 0, eraDrops: 0, reinitializes: 0 };
  let lastStatus: number | undefined;

  const observer: TapObserver = {
    response: (status) => {
      counts.responses += 1;
      lastStatus = status;
    },
    retried: () => {
      counts.retries += 1;
    },
  };

  const fetch = tapFetch(
    watched,
    {
      now: () => Effect.runSyncWith(context)(Clock.currentTimeMillis),
      sleep: (ms) => Effect.sleep(Duration.millis(ms)).pipe(Effect.runPromiseWith(context)),
    },
    verdicts,
    observer,
  );

  const failure = (cause: unknown, mayHaveRun = false, tasksDeclared = false) =>
    classify(cause, {
      mayHaveRun,
      tokenSent: auth.tokenSent(),
      challenge,
      verdicts,
      serverName: target.name,
      tasksDeclared,
    });

  /** Notifications still being sent, which a close would abort: a Legacy `notifications/cancelled` above all. */
  const notifying = new Set<Promise<void>>();

  const transportFor = (session?: SessionRow) => {
    const requestInit: RequestInit = { headers: { ...target.headers } };

    const options: StreamableHTTPClientTransportOptions = {
      fetch,
      requestInit,
      onInsufficientScope: "throw",
      // No resumption yet, Legacy included: a request stream that ends without its answer is a cut (D15; #542).
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    };

    if (tokenBearing(target, deps)) {
      // A token is never sent on to where a redirect points (The MCP core #394, smaller decisions).
      requestInit.redirect = "manual";
    }

    if (deps.auth !== undefined) {
      options.authProvider = auth.provider;
    }

    if (session !== undefined) {
      options.sessionId = session.sessionId;
      options.protocolVersion = session.protocolVersion;
    }

    const transport = new StreamableHTTPClientTransport(new URL(target.url), options);
    const send = transport.send.bind(transport);

    transport.send = (message, sendOptions) => {
      const sent = send(message, sendOptions);

      if ("method" in message && !("id" in message)) {
        const settled = sent.then(
          () => undefined,
          () => undefined,
        );

        notifying.add(settled);
        void settled.then(() => notifying.delete(settled));
      }

      return sent;
    };

    return transport;
  };

  const newClient = () => {
    const client = new Client(deps.clientInfo, {
      capabilities: declaredCapabilities(deps.capabilities, deps.extensions, deps.roots),
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      versionNegotiation: { mode: "auto", probe: { timeoutMs: connectMs, maxRetries: 0 } },
      enforceStrictCapabilities: false,
      jsonSchemaValidator: noValidation,
      // Only Roots are answered, from the handler below; the other questions come with their slices.
      inputRequired: { autoFulfill: deps.roots !== undefined },
    });

    const { onLog, roots } = deps;

    if (roots !== undefined) {
      client.setRequestHandler("roots/list", () => ({
        roots: Arr.map(roots, (root) => ({ ...root })),
      }));
    }

    if (onLog !== undefined) {
      client.setNotificationHandler("notifications/message", ({ params }) => {
        onLog({ level: params.level, logger: params.logger, data: params.data });
      });
    }

    return client;
  };

  /** Whether the server is asked for logs: `onLog` hears them, and the server declares `logging`. */
  const wantsLogs = (capabilities: ServerCapabilities) =>
    deps.onLog !== undefined && capabilities.logging !== undefined;

  /**
   * Closes `client` once the notifications in flight are sent (at most 2 s), so an aborted Legacy request's
   * `notifications/cancelled` reaches the server before the close aborts the transport's fetches (D15).
   */
  const closeClient = (client: Client) =>
    Effect.suspend(() =>
      notifying.size === 0
        ? Effect.void
        : Effect.promise(() => Promise.all(notifying)).pipe(
            Effect.timeoutOrElse({ duration: NOTIFY_GRACE, orElse: () => Effect.void }),
          ),
    ).pipe(Effect.andThen(Effect.tryPromise(() => client.close())), Effect.ignore);

  /** Runs one connect attempt of `plan`, closing the client if it fails. */
  const attempt = (plan: Plan) =>
    Effect.gen(function* () {
      const client = newClient();
      const transport = transportFor(plan.kind === "session" ? plan.row : undefined);
      const prior = priorOf(plan);

      yield* Effect.tryPromise({
        try: (signal) => {
          const options: ConnectOptions = { timeout: connectMs, signal };

          if (prior !== undefined) {
            options.prior = prior;
          }

          return client.connect(transport, options);
        },
        catch: (cause) => failure(cause),
      }).pipe(Effect.tapError(() => closeClient(client)));

      return { client, transport };
    });

  /** Opens a live client by `plan`, then records the era and session rows it learned. */
  const open = (plan: Plan): Effect.Effect<Live, Failure> =>
    Effect.gen(function* () {
      const { client, transport } = yield* attempt(plan);
      const now = yield* Clock.currentTimeMillis;
      const era = client.getProtocolEra() ?? "legacy";

      const protocolVersion =
        client.getNegotiatedProtocolVersion() ??
        (plan.kind === "session" ? plan.row.protocolVersion : "");

      if (plan.kind === "session") {
        return {
          client,
          era: "legacy",
          protocolVersion: plan.row.protocolVersion,
          // SAFETY: the row holds what `getServerVersion()` returned at `initialize`.
          serverInfo: plan.row.serverInfo as Implementation,
          // SAFETY: the row holds what `getServerCapabilities()` returned at `initialize`.
          capabilities: plan.row.capabilities as ServerCapabilities,
          instructions: plan.row.instructions,
          sessionId: plan.row.sessionId,
        } satisfies Live;
      }

      if (era === "modern") {
        const discover = client.getDiscoverResult();

        yield* plan.kind === "modern" || discover === undefined
          ? Effect.void
          : keepModernEra(deps.eras, protocolVersion, discover, now);
      } else {
        yield* plan.kind === "legacy"
          ? Effect.void
          : deps.eras.set({ v: 1, era: "legacy", version: protocolVersion, probedAt: now });
        yield* transport.sessionId === undefined
          ? deps.sessions.drop
          : deps.sessions.set(sessionRowOf(client, transport.sessionId, protocolVersion, now));

        // The level belongs to the session the server just opened, so only an `initialize` sets it, and only one whose
        // session is kept pays for it: a server with no session is initialized by every connection and forgets the level
        // at once, so asking is a round trip for nothing, in a discovery as in a call. A server that refuses the level is
        // still a server: its logs just come at its own level.
        if (transport.sessionId !== undefined && wantsLogs(client.getServerCapabilities() ?? {})) {
          yield* Effect.tryPromise(() =>
            client.setLoggingLevel(MCP_LOG_LEVEL, { timeout: connectMs }),
          ).pipe(Effect.ignore);
        }
      }

      return {
        client,
        era,
        protocolVersion,
        serverInfo: client.getServerVersion(),
        capabilities: client.getServerCapabilities() ?? {},
        instructions: client.getInstructions(),
        sessionId: transport.sessionId,
      } satisfies Live;
    });

  /** Opens from the stored rows, falling back to a probe when a row no longer holds. */
  const openFromRows = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const eraRow = Option.getOrUndefined(decodeEraRow(yield* deps.eras.get));
    const sessionRow = Option.getOrUndefined(decodeSessionRow(yield* deps.sessions.get));

    // A Modern row opens with no round trip, so it fails only when the SDK refuses the row: probe instead.
    if (eraRow?.era === "modern") {
      return yield* open({ kind: "modern", row: eraRow }).pipe(
        Effect.catch(() => Effect.andThen(deps.eras.drop, open({ kind: "probe" }))),
      );
    }

    if (sessionRow !== undefined) {
      return yield* open({ kind: "session", row: sessionRow });
    }

    if (eraRow?.era === "legacy" && now - eraRow.probedAt < LEGACY_ERA_TTL_MS) {
      // A failed Legacy `initialize` drops the row (D3); when the server answered, it may speak Modern now.
      return yield* open({ kind: "legacy" }).pipe(
        Effect.catchIf(eraInDoubt, () => Effect.andThen(deps.eras.drop, open({ kind: "probe" }))),
        Effect.tapError((failed) => (unreached(failed) ? deps.eras.drop : Effect.void)),
      );
    }

    return yield* open({ kind: "probe" });
  });

  let live = yield* openFromRows.pipe(Effect.mapError((failed) => failed.error));

  yield* Effect.addFinalizer(() => Effect.suspend(() => closeClient(live.client)));

  /** The task wire, opened at the first task request of a Modern connection and closed with the scope. */
  let wire: TaskWire | undefined;

  const taskWire = () => {
    wire ??= openTaskWire(transportFor());

    return wire;
  };

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() =>
      wire === undefined
        ? Effect.void
        : Effect.ignore(
            Effect.tryPromise({ try: () => wire?.close() ?? Promise.resolve(), catch: String }),
          ),
    ),
  );

  /** Swaps the live client for one `reopen` opens. */
  const replace = (reopen: Effect.Effect<Live, Failure>) =>
    Effect.gen(function* () {
      counts.reinitializes += 1;
      yield* closeClient(live.client);
      live = yield* reopen;
    });

  /**
   * Runs `send` on the live client. When the server refused it before it ran, recovers and sends it once more: a
   * Modern server's era drop (400 with no Modern error, 404, 405, `-32022`) probes again; a Legacy session's
   * 404 initializes again.
   */
  const request = <A>(
    send: (client: Client, signal: AbortSignal) => Promise<A>,
    mayHaveRun: boolean,
    tasksDeclared = false,
  ): Effect.Effect<A, McpError> => {
    const once = Effect.suspend(() => {
      const client = live.client;

      return Effect.tryPromise({
        try: (signal) => send(client, signal),
        catch: (cause) => failure(cause, mayHaveRun, tasksDeclared),
      });
    });

    /** What brings the request back after `failed`, when the server refused it before it ran or it only reads. */
    const recovery = (failed: Failure) => {
      if (eraDropped(live, failed)) {
        counts.eraDrops += 1;

        return Option.some(Effect.andThen(deps.eras.drop, replace(open({ kind: "probe" }))));
      }

      if (sessionLost(live, failed)) {
        return Option.some(Effect.andThen(deps.sessions.drop, replace(open({ kind: "legacy" }))));
      }

      // A read is sent once more after a cut; a `tools/call` never is, in either era (D15).
      return !mayHaveRun && isCut(failed.error) ? Option.some(Effect.void) : Option.none();
    };

    return once.pipe(
      Effect.catch((failed) =>
        Option.match(recovery(failed), {
          onNone: () => Effect.fail(failed),
          onSome: (recover) => Effect.andThen(recover, once),
        }),
      ),
      Effect.mapError((failed) => failed.error),
    );
  };

  /** The client's declaration for `ctx`, sent in a Modern request's `_meta` (D7, D23); none on Legacy. */
  const metaFor = (ctx: McpCallContext): RequestMeta | undefined => {
    if (live.era !== "modern") return undefined;

    const meta: RequestMeta = {
      [CLIENT_CAPABILITIES_META_KEY]: declaredCapabilities(
        deps.capabilities,
        deps.extensions,
        deps.roots,
        ctx,
      ),
    };

    if (wantsLogs(live.capabilities)) meta[LOG_LEVEL_META_KEY] = MCP_LOG_LEVEL;

    return meta;
  };

  const list = <K extends ListKind>(kind: K, ctx: McpCallContext) =>
    Effect.gen(function* () {
      const { capability, page: listPage } = listOf(kind);
      const fetchedAt = yield* Clock.currentTimeMillis;

      if (live.capabilities[capability] === undefined) {
        return { kind: "complete", value: [], cacheable: true, fetchedAt } satisfies Complete<
          ReadonlyArray<ListItems[K]>
        >;
      }

      const all: Array<ListItems[K]> = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let hints: CacheHints | undefined;

      do {
        const params: PageParams = {};
        const meta = metaFor(ctx);

        if (cursor !== undefined) {
          params.cursor = cursor;
        }

        if (meta !== undefined) {
          params._meta = meta;
        }

        const page = yield* request(
          (client, signal) => listPage(client, params, { signal, timeout: PAGE_TIMEOUT_MS }),
          false,
        );

        hints ??= Option.getOrUndefined(decodeCacheHints(page.result));
        all.push(...page.items);
        cursor = page.nextCursor;

        if (cursor !== undefined && seen.has(cursor)) {
          return yield* ProtocolViolation.make({
            message: `The server's ${kind} pages never end: cursor ${cursor} came back`,
          });
        }

        if (cursor !== undefined) {
          seen.add(cursor);
        }
      } while (cursor !== undefined);

      return {
        kind: "complete",
        value: all,
        cacheable: true,
        fetchedAt,
        ...hints,
      } satisfies Complete<ReadonlyArray<ListItems[K]>>;
    }).pipe(
      Effect.timeoutOrElse({
        duration: WALK_TIMEOUT,
        orElse: () => Effect.fail(TimedOut.make({ message: `Listing ${kind} took over 120 s` })),
      }),
    );

  /** Whether `ctx` may be offered an MCP task: it asked, the server is Modern and it advertises the extension. */
  const offersTask = (ctx: McpCallContext) =>
    ctx.allowTask === true &&
    live.era === "modern" &&
    live.capabilities.extensions?.[MCP_TASKS_EXTENSION] !== undefined;

  const callTool = (
    params: CallToolParams,
    ctx: McpCallContext,
  ): Effect.Effect<Outcome<CallToolResult>, McpError> =>
    offersTask(ctx) ? callToolOnTaskWire(params, ctx) : callToolOnClient(params, ctx);

  const callToolOnClient = (params: CallToolParams, ctx: McpCallContext) =>
    Effect.gen(function* () {
      const call: CallToolRequestParams = {
        name: params.tool.name,
        arguments: { ...params.arguments },
      };

      const meta = metaFor(ctx);

      if (meta !== undefined) {
        call._meta = meta;
      }

      const value = yield* request((client, signal) => {
        const options: CallToolRequestOptions = {
          signal,
          timeout: target.timeoutMs ?? CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          // Without `outputSchema`, so the SDK checks no `structuredContent`: the engine does (D17). With the
          // definition given, the SDK rethrows a `-32020` header mismatch rather than refreshing `tools/list`: the
          // refresh and one retry (D14) belong to the catalog's owner, the engine, so it surfaces as `ServerError`.
          toolDefinition: Struct.omit(params.tool, ["outputSchema"]),
        };

        if (deps.onProgress !== undefined) options.onprogress = progressOf(deps.onProgress);

        return client.callTool(call, options);
      }, true);

      const fetchedAt = yield* Clock.currentTimeMillis;

      return {
        kind: "complete",
        value,
        cacheable: true,
        fetchedAt,
      } satisfies Complete<CallToolResult>;
    });

  /**
   * A Modern request's params framed as the SDK frames one, with the tasks extension declared in the client's
   * capabilities (the task wire's transport derives its headers from this envelope).
   */
  const framed = (params: TaskParams, ctx: McpCallContext, progressToken?: number): TaskParams => {
    const capabilities = declaredCapabilities(deps.capabilities, deps.extensions, deps.roots, ctx);

    const meta: NonNullable<TaskParams["_meta"]> = {
      [PROTOCOL_VERSION_META_KEY]: live.protocolVersion,
      [CLIENT_INFO_META_KEY]: deps.clientInfo,
      [CLIENT_CAPABILITIES_META_KEY]: {
        ...capabilities,
        extensions: { ...capabilities.extensions, [MCP_TASKS_EXTENSION]: {} },
      },
    };

    if (wantsLogs(live.capabilities)) meta[LOG_LEVEL_META_KEY] = MCP_LOG_LEVEL;

    if (progressToken !== undefined) meta.progressToken = progressToken;

    return { ...params, _meta: meta };
  };

  let progressTokens = 0;

  /** Sends `method` on the task wire; `read` turns the server's result into the answer or the failure. */
  const taskRequest = <A>(
    method: string,
    params: TaskParams,
    ctx: McpCallContext,
    options: {
      readonly timeoutMs: number;
      readonly mayHaveRun: boolean;
      readonly headers?: Readonly<Record<string, string>>;
      readonly onProgress?: (progress: McpProgress) => void;
    },
    read: (result: Result) => Effect.Effect<A, McpError>,
  ): Effect.Effect<A, McpError> => {
    if (live.era !== "modern") {
      return Effect.fail(
        Unsupported.make({
          message: "The server speaks the Legacy protocol, which has no MCP tasks",
        }),
      );
    }

    return request(
      (_client, signal) => {
        const { onProgress } = options;
        const token = onProgress === undefined ? undefined : (progressTokens += 1);
        const sending: Mutable<TaskRequestOptions> = { timeoutMs: options.timeoutMs, signal };

        if (options.headers !== undefined) sending.headers = options.headers;

        if (token !== undefined && onProgress !== undefined) {
          sending.progress = { token, notify: onProgress };
        }

        return taskWire().call(method, framed(params, ctx, token), sending);
      },
      options.mayHaveRun,
      true,
    ).pipe(Effect.flatMap(read));
  };

  const notMcp = (what: string) =>
    ProtocolViolation.make({ message: `Not an MCP server: ${what}` });

  /** A `tools/call` on the task wire: the server's result, or the task it started. */
  const callToolOnTaskWire = (params: CallToolParams, ctx: McpCallContext) => {
    const args = { ...params.arguments };

    const options: Mutable<Parameters<typeof taskRequest>[3]> = {
      timeoutMs: target.timeoutMs ?? CALL_TIMEOUT_MS,
      mayHaveRun: true,
      headers: xMcpHeaders(
        Option.getOrElse(decodeJson(params.tool.inputSchema), () => ({})),
        args,
      ),
    };

    if (deps.onProgress !== undefined) options.onProgress = deps.onProgress;

    return taskRequest(
      "tools/call",
      { name: params.tool.name, arguments: args },
      ctx,
      options,
      (answer): Effect.Effect<Outcome<CallToolResult>, McpError> =>
        Effect.gen(function* () {
          const fetchedAt = yield* Clock.currentTimeMillis;
          const { resultType, ...rest } = answer;

          if (resultType === "task") {
            const started = decodeTaskCreated(rest);

            return Option.isNone(started)
              ? yield* notMcp("the task it started is malformed")
              : ({ kind: "task", task: started.value, fetchedAt } satisfies TaskStarted);
          }

          if (resultType === "input_required") {
            return yield* Unsupported.make({
              message:
                "The server asked a question, which cloudpid cannot answer in an MCP task call yet",
            });
          }

          if (resultType !== "complete" || !isCallToolResult(rest)) {
            return yield* notMcp("the answer to tools/call is neither a result nor a task");
          }

          return {
            kind: "complete",
            value: rest,
            cacheable: false,
            fetchedAt,
          } satisfies Complete<CallToolResult>;
        }),
    );
  };

  const taskGet = (taskId: string, ctx: McpCallContext) =>
    taskRequest(
      "tasks/get",
      { taskId },
      ctx,
      { timeoutMs: TASK_TIMEOUT_MS, mayHaveRun: false },
      (answer): Effect.Effect<TaskState, McpError> =>
        Effect.gen(function* () {
          const fetchedAt = yield* Clock.currentTimeMillis;
          const snapshot = decodeTaskSnapshot(answer);
          const ended = decodeTaskGetAnswer(answer);

          if (Option.isNone(snapshot) || Option.isNone(ended)) {
            return yield* notMcp("the answer to tasks/get is not a task");
          }

          if (snapshot.value.status !== "completed") return { task: snapshot.value, fetchedAt };

          // A completed task's result is the `CallToolResult` the call would have returned.
          const value = Record.remove(ended.value.result ?? {}, "resultType");

          return isCallToolResult(value)
            ? { task: snapshot.value, result: value, fetchedAt }
            : yield* notMcp("the result of a completed task is not a tool result");
        }),
    );

  /** `tasks/update` and `tasks/cancel` answer an empty result; sent once, since the caller knows what a resend means. */
  const taskCommand = (
    method: "tasks/update" | "tasks/cancel",
    params: TaskParams,
    ctx: McpCallContext,
  ) =>
    taskRequest(
      method,
      params,
      ctx,
      { timeoutMs: TASK_TIMEOUT_MS, mayHaveRun: true },
      () => Effect.void,
    );

  const task: McpTasks = {
    get: taskGet,
    update: (taskId, inputResponses, ctx) =>
      taskCommand("tasks/update", { taskId, inputResponses }, ctx),
    cancel: (taskId, ctx) => taskCommand("tasks/cancel", { taskId }, ctx),
  };

  const connection: McpConnection = {
    get era() {
      return live.era;
    },
    get protocolVersion() {
      return live.protocolVersion;
    },
    get serverInfo() {
      return live.serverInfo;
    },
    get capabilities() {
      return live.capabilities;
    },
    get instructions() {
      return live.instructions;
    },
    stats: () => ({ ...counts, lastStatus }),
    list,
    callTool,
    task,
  };

  return connection;
});

/** The SDK's progress callback over `onProgress`: the notice's fields the core passes on, and nothing more. */
const progressOf =
  (onProgress: (progress: McpProgress) => void) =>
  ({
    progress,
    total,
    message,
  }: {
    progress: number;
    total?: number | undefined;
    message?: string | undefined;
  }) => {
    const notice: Mutable<McpProgress> = { progress };

    if (total !== undefined) notice.total = total;

    if (message !== undefined) notice.message = message;

    onProgress(notice);
  };

/** Whether a token is in play, so redirects are never followed (The MCP core #394, smaller decisions). */
const tokenBearing = (target: McpTarget, deps: McpDeps) =>
  deps.auth !== undefined ||
  Arr.some(Record.keys(target.headers ?? {}), (name) => name.toLowerCase() === "authorization");

/** The `prior` the SDK connects from for `plan`. */
const priorOf = (plan: Plan): PriorDiscovery | undefined => {
  switch (plan.kind) {
    case "modern":
      // SAFETY: the row holds what `getDiscoverResult()` returned; the SDK validates a prior before using it.
      return { kind: "modern", discover: plan.row.discover as DiscoverResult };
    case "session":
    case "legacy":
      return { kind: "legacy" };
    case "probe":
      return undefined;
  }
};

const isCut = Schema.is(Cut);

const isUnreachable = Schema.is(Unreachable);

const isTimedOut = Schema.is(TimedOut);

const isSignInRequired = Schema.is(SignInRequired);

const isStepUpRequired = Schema.is(StepUpRequired);

/** The server could not be reached, or did not answer in time: nothing about its era. */
const unreached = (failed: Failure) => isUnreachable(failed.error) || isTimedOut(failed.error);

/** A failed Legacy `initialize` that says something about the era: not an auth wall, and the server answered. */
const eraInDoubt = (failed: Failure) =>
  !unreached(failed) && !isSignInRequired(failed.error) && !isStepUpRequired(failed.error);

/** A Modern server refused a request before it ran: its era no longer holds (D3). */
const eraDropped = (live: Live, failed: Failure) =>
  live.era === "modern" &&
  (failed.status === 400 ||
    failed.status === 404 ||
    failed.status === 405 ||
    failed.code === -32022);

/** A Legacy server no longer knows the session (D5, D15). */
const sessionLost = (live: Live, failed: Failure) =>
  live.era === "legacy" && live.sessionId !== undefined && failed.status === 404;

/** `value`, an SDK result, as the JSON object it was decoded from. */
const jsonObjectOf = (value: DiscoverResult | Implementation | ServerCapabilities | undefined) =>
  Option.getOrElse(toJsonObject(JSON.stringify(value ?? {})), () => ({}));

/** Keeps a Modern server's era row, unless its `server/discover` result is over 64 KiB (D3). */
const keepModernEra = (eras: RowStore, version: string, discover: DiscoverResult, now: number) => {
  const json = jsonObjectOf(discover);

  return new TextEncoder().encode(JSON.stringify(json)).byteLength > MAX_DISCOVER_BYTES
    ? eras.drop
    : eras.set({ v: 1, era: "modern", version, discover: json, probedAt: now });
};

const sessionRowOf = (
  client: Client,
  sessionId: string,
  protocolVersion: string,
  now: number,
): SessionRow => {
  const instructions = client.getInstructions();

  const row: SessionRow = {
    v: 1,
    sessionId,
    protocolVersion,
    serverInfo: jsonObjectOf(client.getServerVersion()),
    capabilities: jsonObjectOf(client.getServerCapabilities()),
    initializedAt: now,
  };

  return instructions === undefined ? row : { ...row, instructions };
};

/**
 * The SDK's `AuthProvider` over `deps.auth` (installed only when there is one), remembering whether the last request
 * carried a token.
 */
const authState = (
  deps: McpDeps,
  context: Context.Context<never>,
  challenge: () => McpAuthChallenge | undefined,
) => {
  let stale = false;
  let sent: string | undefined;

  return {
    tokenSent: () => sent !== undefined,
    provider: {
      token: () =>
        Effect.suspend(
          () => deps.auth?.(stale) ?? Effect.succeedNone.pipe(Effect.map(Option.getOrUndefined)),
        ).pipe(
          Effect.map((token) => {
            sent = token;
            stale = false;

            return token;
          }),
          Effect.runPromiseWith(context),
        ),
      onUnauthorized: () => {
        if (sent === undefined) {
          // No token was sent, so asking again changes nothing: the server wants a sign-in (#390).
          return Promise.reject(
            signInRequired("The server requires signing in", false, challenge()),
          );
        }

        stale = true;

        return Promise.resolve();
      },
    },
  };
};
