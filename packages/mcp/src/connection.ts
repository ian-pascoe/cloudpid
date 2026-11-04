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
  type CompleteRequest,
  type CompleteResult,
  Client,
  type ConnectOptions,
  type CreateMessageRequestParams,
  type CreateMessageResultWithTools,
  type ElicitRequestParams,
  type ClientCapabilities,
  isCallToolResult,
  type DiscoverResult,
  extractWWWAuthenticateParams,
  type FetchLike,
  type GetPromptResult,
  type Implementation,
  type JSONObject,
  type JsonSchemaValidator,
  LOG_LEVEL_META_KEY,
  type LoggingLevel,
  PROTOCOL_VERSION_META_KEY,
  type PriorDiscovery,
  type Prompt,
  ProtocolError,
  ProtocolErrorCode,
  type ProtocolEra,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplateType,
  type RequestOptions,
  type Result,
  SdkError,
  SdkErrorCode,
  type ServerCapabilities,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  type Tool,
} from "@modelcontextprotocol/client";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { Mutable } from "effect/Types";
import { authChallenge, classify, type Failure, signInRequired } from "./failures.ts";
import { type PausableDeadline, pausableDeadline } from "./deadline.ts";
import { isJsonObject, JsonObject } from "./json.ts";
import { declaredCapabilities, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.ts";
import { contentsSha256 } from "./read-hash.ts";
import { MCP_LOG_LEVEL } from "./log.ts";
import { APP_READ_HEADER, CALL_HEADER, type TapObserver, tapFetch, Ties, Verdicts } from "./tap.ts";
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
  MCP_ELICITATION_WAIT_MS,
  MCP_INPUT_ROUNDS,
  MCP_INTERNAL_ERROR,
  MCP_LISTEN_ACK_MS,
  MCP_RESUME_STATE_EXPIRED,
  MCP_RESUME_STATE_MAX_BYTES,
  MCP_COMPLETION_TIMEOUT_MS,
  MCP_LIST_WALK_TIMEOUT_MS,
  MCP_SAMPLING_REFUSED,
  MCP_SAMPLING_WAIT_MS,
  MCP_TASK_TIMEOUT_MS,
  MCP_TASKS_EXTENSION,
  type McpCallContext,
  type McpAuthChallenge,
  type McpCompletionArgument,
  type McpCompletionContext,
  type McpCompletionRef,
  type McpError,
  type McpInputAnswer,
  type McpInputRequest,
  type McpListenEvent,
  type McpListenFilter,
  type McpProgress,
  type McpRoot,
  McpTaskCreated,
  type McpTaskInputResponses,
  McpTaskSnapshot,
  MCP_URL_REQUIRED_CODE,
  ProtocolViolation,
  ResendStateV1,
  ResumeStateV1,
  ServerError,
  type SessionRow,
  SessionRowV1,
  SignInRequired,
  StepUpRequired,
  TimedOut,
  TooLarge,
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
  /**
   * A Legacy server's question during a call whose `ctx.answers` offers its kind (`docs/architecture/
   * mcp-server-requests.md` → Questions): answered with what the server gets, the call's timeout paused while it pends
   * and its wait bounded by `ctx.answers.inputWaitMs` (10 minutes for an elicitation, 12 for a Sampling request). When
   * the wait runs out an elicitation reads as `cancel` and a Sampling request as a refusal.
   *
   * A question that no call can take is not asked: one on another stream, with no `onInput`, or of a kind the call did
   * not offer is cancelled (an elicitation) or refused (a Sampling request). A Legacy connection declares `elicitation`
   * and `sampling` as `capabilities` says, and answers what the server asks the same way.
   */
  readonly onInput?: (request: McpInputRequest) => Effect.Effect<McpInputAnswer>;
  /** The server stopped waiting for question `key` (its own `notifications/cancelled`): the card is withdrawn. */
  readonly onInputEnded?: (key: string) => void;
  /** The server sent a request that uses a feature the spec deprecated (`"sampling"`), however it ends. Fails nothing. */
  readonly onDeprecated?: (feature: string) => void;
  /**
   * The owner finished at the page that URL question `key` asked them to open: the server said so on the call's own
   * stream (`notifications/elicitation/complete`), and the question is closed. Never for a completion on another stream.
   */
  readonly onInputComplete?: (key: string) => void;
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

/** One page of a list, as `listPage` returns it: its items and where the next page is, if there is one. */
export interface ListedPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor?: string;
}

/** A `resources/read` that completed, with the SHA-256 of what it answered (`./read-hash.ts`). */
export interface ReadComplete extends Complete<ReadResourceResult> {
  readonly sha256: string;
}

/** A request that completed. */
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

/**
 * A Modern `tools/call` whose server asked questions the caller deferred (`input_required`; ADR-0037): only a call
 * whose `ctx.answers.defer` is set is ever answered so. `requests` are the deferred questions, as `onInput` was handed
 * them; `resume` is the `ResumeState` that `resume` sends the call again from, with their answers. The core keeps
 * nothing.
 */
export interface InputRequired {
  readonly kind: "input_required";
  readonly requests: ReadonlyArray<McpInputRequest>;
  readonly resume: ResumeStateV1;
  readonly fetchedAt: number;
}

/**
 * A Legacy `tools/call` whose server answered `-32042` (URL elicitation required; `docs/architecture/
 * mcp-server-requests.md` → Elicitation requests): only a call whose `ctx.answers.pages` is set is ever answered so.
 * `requests` are the pages, as `onInput` was handed them; `resend` is the `ResendState` that `resend` sends the call
 * again from, with their answers. The core keeps nothing.
 */
export interface PagesRequired {
  readonly kind: "pages_required";
  readonly requests: ReadonlyArray<McpInputRequest>;
  /** The server's own error. */
  readonly message: string;
  /** What `resend` sends the call again from; absent for a `resources/read`, which the caller sends again as it was. */
  readonly resend?: ResendStateV1;
  readonly fetchedAt: number;
}

/**
 * A request's result: it completed, (for a task-capable `tools/call` only) it started an MCP task, (for a Modern
 * `tools/call` whose caller defers questions) it waits for answers, or (for a Legacy one whose caller keeps pages) it
 * waits for the owner at a page.
 */
export type Outcome<A> = Complete<A> | TaskStarted | InputRequired | PagesRequired;

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

/** The JSON-RPC code of a Legacy server's "URL elicitation required" error. */
const URL_REQUIRED_CODE = MCP_URL_REQUIRED_CODE;

/** The most the SDK's own timer may be given: the core's deadline is the one that ends a call. */
const SDK_TIMER_MAX_MS = 2_147_483_647;

/** The clock of a call that can be asked questions, and the token that ties its questions to it. */
interface Own {
  readonly deadline: PausableDeadline;
  readonly token: string;
}

/** What a Legacy question is answered with, in the core: the result the server gets, or a refusal that is its error. */
type QuestionAnswer = Exclude<McpInputAnswer, { readonly kind: "defer" }>;

/** The call a question may be tied to: what it offered, how long its questions may wait, and its clock to pause meanwhile. */
interface Asking {
  /** The kinds the call offered to answer (`ctx.answers`); a question of another kind is not asked. */
  readonly offers: ReadonlySet<McpInputRequest["kind"]>;
  readonly waitMs: number;
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  /** The call's token, which a page's completion notice is told under. */
  readonly token: string;
  /** Succeeds when the call is over: a page the owner opened is no longer waited for. */
  readonly over: Deferred.Deferred<void>;
}

/** How a listen ended: the caller closed it (`local`), the server ended it deliberately (`graceful`), or it was cut (`remote`). */
export type ListenEnd = "local" | "graceful" | "remote";

/**
 * An open listen (`McpConnection.listen`): what the server honors, how it ends, and a way to end it. The core never opens
 * it again: every end the caller did not ask for is a gap that the caller checks (ADR-0032).
 */
export interface Listening {
  /** The part of the filter the server agreed to: for a Legacy server, the URIs it accepted a subscription for. */
  readonly honored: McpListenFilter;
  /** Pending until the listen ends; never fails. */
  readonly closed: Effect.Effect<ListenEnd>;
  /** Ends the listen, and for a Legacy server unsubscribes (best effort). Idempotent. */
  readonly close: Effect.Effect<void>;
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
  /**
   * Sends a Modern `tools/call` that answered `input_required` again from its `ResumeState`, with the answers to the
   * questions it deferred, by key (every one, or nothing is sent), on a new id: the result, another round of
   * questions, or a task. `tool` is the tool's definition, for the call's headers. A state this build cannot read (a
   * format `v` past its 30 days) fails `Unsupported`, as does a server that no longer speaks Modern.
   */
  readonly resume: (
    state: Schema.Json,
    answers: McpTaskInputResponses,
    tool: Tool,
    ctx: McpCallContext,
  ) => Effect.Effect<Outcome<CallToolResult>, McpError>;
  /**
   * Sends a Legacy `tools/call` that answered `pages_required` again from its `ResendState`, as it was, once every page
   * is answered `accept` (an answer for each, or nothing is sent): the result, or another `-32042`. Any other answer
   * fails with the server's own error. `tool` is the tool's definition. A state this build cannot read fails `Unsupported`.
   */
  readonly resend: (
    state: Schema.Json,
    answers: McpTaskInputResponses,
    tool: Tool,
    ctx: McpCallContext,
  ) => Effect.Effect<Outcome<CallToolResult>, McpError>;
  /**
   * One page of `kind` from `cursor` (the first page without one), for a caller that shows pages and walks them itself.
   * A read, so it is sent once more after a cut; with the cache hints of the page's result. A server without the
   * kind's capability answers an empty page without a request.
   */
  readonly listPage: <K extends ListKind>(
    kind: K,
    cursor: string | undefined,
    ctx: McpCallContext,
  ) => Effect.Effect<Complete<ListedPage<ListItems[K]>>, McpError>;
  /**
   * One `resources/read` of `uri`: a read, so it is sent once more after a cut, and the SHA-256 of its contents. A
   * Legacy server's question during it is the caller's (`ctx.answers`, `deps.onInput`), as a `tools/call`'s is.
   */
  readonly readResource: (
    uri: string,
    ctx: McpCallContext,
    options?: ReadOptions,
  ) => Effect.Effect<ReadComplete | PagesRequired, McpError>;
  /**
   * One `prompts/get` of prompt `name` with `args`: a read of a server's own template, so it is sent once more after a
   * cut. The owner's request, never the agent's (`docs/architecture/mcp-in-a-session.md` → Getting a prompt at send).
   */
  readonly getPrompt: (
    name: string,
    args: Readonly<Record<string, string>>,
    ctx: McpCallContext,
  ) => Effect.Effect<Complete<GetPromptResult>, McpError>;
  /**
   * One `completion/complete`: suggestions for `argument` of the prompt or resource template `ref` names, given the other
   * arguments in `context` (`docs/architecture/mcp-in-a-session.md` → Arguments and completions). A server that does not
   * declare `completions` is not asked: it fails `Unsupported`. Never sent again after a cut ("Completions are never
   * retried"), and bounded at `MCP_COMPLETION_TIMEOUT_MS` or the entry's lower `timeout`; a caller that interrupts it has
   * the SDK send `notifications/cancelled`. It declares nothing the server could ask a question with.
   */
  readonly complete: (
    ref: McpCompletionRef,
    argument: McpCompletionArgument,
    context: McpCompletionContext | undefined,
    ctx: McpCallContext,
  ) => Effect.Effect<Complete<CompleteResult>, McpError>;
  /**
   * Opens a listen for `filter`, telling `onEvent` of each resource update and list change, until `closed`
   * (`docs/architecture/mcp-in-a-session.md` → Resource watches). A Modern server is sent `subscriptions/listen`, and
   * acknowledges within 10 s or the listen fails `TimedOut`. A Legacy server is sent `resources/subscribe` for each URI
   * (one it refuses is left out of `honored`) with its GET stream open, which carries the list changes; a Legacy server
   * with no session, or that answers the GET stream 405, cannot send updates and fails `Unsupported`. A listen holds
   * no request slot of its own beyond its opening: it lives until it is closed or the connection's scope ends.
   */
  readonly listen: (
    filter: McpListenFilter,
    onEvent: (event: McpListenEvent) => void,
  ) => Effect.Effect<Listening, McpError>;
}

/**
 * What a read depends on besides its URI: `app` says it is an App's read of its HTML, which `MCP_APP_READ_BYTES` bounds;
 * any other read, a `ui://` one the agent makes included, has the 16 MiB every read has.
 */
export interface ReadOptions {
  readonly app?: boolean;
}

const CONNECT_TIMEOUT_MS = MCP_CONNECT_TIMEOUT_MS;

const PAGE_TIMEOUT_MS = 30_000;

const WALK_TIMEOUT = Duration.millis(MCP_LIST_WALK_TIMEOUT_MS);

const CALL_TIMEOUT_MS = 60_000;

/** How long a close waits for the notifications in flight. */
const NOTIFY_GRACE = Duration.seconds(2);

/** A Legacy era row older than this is probed again at the next `initialize` (D3). */
const LEGACY_ERA_TTL_MS = 24 * 60 * 60 * 1000;

/** `discover_json` is kept up to 64 KiB (D3). */
const MAX_DISCOVER_BYTES = 64 * 1024;

/** What a request's recovery needs to know beyond whether it may have run. */
interface RequestPolicy {
  /** Whether the attempt declares the tasks extension, asked at the failure: a `-32021` for it means another thing then. */
  readonly declared?: () => boolean;
  /** Sent once more after a cut though it may have run: a request whose repeat the caller knows is safe. */
  readonly resend?: boolean;
}

/** What a `tools/call` attempt got: the task wire's answer, or the client's result (on Modern, maybe `input_required`). */
type CallSent =
  | { readonly kind: "wire"; readonly answer: Result }
  | { readonly kind: "client"; readonly value: CallToolResult | Result }
  | { readonly kind: "url"; readonly answer: UrlRequired };

/** A `tools/call` sent again with the answers to a round of questions (Modern; ADR-0037). */
interface Retry {
  readonly inputResponses: McpTaskInputResponses;
  readonly requestState?: string;
}

/** One question of a Modern round: answered at once, or deferred by the caller. */
type RoundAnswer =
  | { readonly key: string; readonly answer: JsonObject }
  | { readonly key: string; readonly defer: McpInputRequest };

/** A round of questions a Modern server answered a `tools/call` with: its requests by key, and its state. */
interface Asked {
  readonly kind: "asked";
  readonly inputRequests: Readonly<Record<string, JsonObject>>;
  readonly requestState?: string;
}

/** A `resources/read`'s params: the URI, and the request's `_meta`. */
type ReadParams = { readonly uri: string; readonly _meta?: RequestMeta };

/** A `prompts/get`'s params: the prompt, its arguments, and the request's `_meta`. */
type PromptParams = {
  readonly name: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly _meta?: RequestMeta;
};

/** `ctx` with no deferral: a request with no resume (a read) answers what it would defer with `cancel`. */
const noDeferral = (ctx: McpCallContext): McpCallContext =>
  ctx.answers?.defer === undefined ? ctx : { ...ctx, answers: Struct.omit(ctx.answers, ["defer"]) };

/**
 * A Legacy server's `-32042` (URL elicitation required): it refused the call before running it, until the owner has
 * opened the pages it lists. `elicitations` are those pages as the server sent them (`mode: "url"`, `elicitationId`,
 * `url`, `message`), and `message` is the server's own error.
 */
interface UrlRequired {
  readonly kind: "url_required";
  readonly message: string;
  readonly elicitations: ReadonlyArray<{
    readonly elicitationId: string;
    readonly page: JsonObject;
  }>;
}

/** What a `tools/call` attempt came to: an outcome, a round of questions to answer, or a Legacy server's `-32042`. */
type CallAnswer = Outcome<CallToolResult> | Asked | UrlRequired;

/** What a request on the task wire is given beside its method and params. */
interface WireOptions {
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly onProgress?: (progress: McpProgress) => void;
}

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

/** A Modern `input_required` answer: its questions by key (absent for a round that only carries state), and its state. */
const AskedAnswer = Schema.Struct({
  inputRequests: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
  requestState: Schema.optionalKey(Schema.String),
});

const decodeAsked = Schema.decodeUnknownOption(AskedAnswer);

const decodeResumeState = Schema.decodeUnknownOption(ResumeStateV1);

const decodeResendState = Schema.decodeUnknownOption(ResendStateV1);

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
  /** A Legacy `initialize` just made the session, so the SDK opens its GET stream by itself. */
  readonly autoGet: boolean;
}

/** What a connection knows of its Legacy session's GET stream. */
interface GetStream {
  /** What the server answered it. */
  status: number | undefined;
  open: boolean;
  /** Done once it was answered. */
  readonly settled: Deferred.Deferred<void>;
  /** Told when it ends. */
  readonly ends: Set<() => void>;
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
  const ties = new Ties();
  /** The calls that may be asked questions, by the token their request carries. */
  const asking = new Map<string, Asking>();
  let callCount = 0;
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

  /** The Legacy session's GET stream: what the server answered it, whether it is open, and who wants to know it ended. */
  const getStream: GetStream = {
    status: undefined,
    open: false,
    settled: Deferred.makeUnsafe<void>(),
    ends: new Set(),
  };

  const observer: TapObserver = {
    response: (status) => {
      counts.responses += 1;
      lastStatus = status;
    },
    retried: () => {
      counts.retries += 1;
    },
    get: (event) => {
      if ("status" in event) {
        getStream.status = event.status;
        getStream.open = event.status >= 200 && event.status < 300;
        Deferred.doneUnsafe(getStream.settled, Effect.void);

        return;
      }

      getStream.open = false;

      for (const ended of getStream.ends) ended();
    },
  };

  /** Who is told of a resource update or a list change: the open listens. */
  const sinks = new Set<(event: McpListenEvent) => void>();

  const emit = (event: McpListenEvent) => {
    for (const sink of sinks) sink(event);
  };

  const fetch = tapFetch(
    watched,
    {
      now: () => Effect.runSyncWith(context)(Clock.currentTimeMillis),
      sleep: (ms) => Effect.sleep(Duration.millis(ms)).pipe(Effect.runPromiseWith(context)),
    },
    verdicts,
    observer,
    ties,
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
      // The SDK never resumes a request stream, Legacy included: the tap does, for a Legacy one that carried an event id
      // (D15; `tap.ts`), and every other stream that ends without its answer is a cut.
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

    // What a listen is told: on a Modern connection the notifications of its `subscriptions/listen` stream, on a Legacy
    // one those of the session's GET stream. Nothing hears them while no listen is open.
    client.setNotificationHandler("notifications/resources/updated", ({ params }) => {
      emit({ kind: "resource_updated", uri: params.uri });
    });
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      emit({ kind: "list_changed", list: "tools" });
    });
    client.setNotificationHandler("notifications/prompts/list_changed", () => {
      emit({ kind: "list_changed", list: "prompts" });
    });
    client.setNotificationHandler("notifications/resources/list_changed", () => {
      emit({ kind: "list_changed", list: "resources" });
    });

    const declared = declaredCapabilities(deps.capabilities, deps.extensions, deps.roots);

    // A connection that declares `elicitation` is asked (Legacy: connection-wide, at `initialize`), so it answers: a
    // question that belongs to no call that can take it is cancelled, never left unanswered or refused as unknown.
    if (declared.elicitation !== undefined) {
      client.setRequestHandler("elicitation/create", (request, ctx) =>
        Effect.runPromiseWith(context)(
          askQuestion("elicitation", request.params, ctx.mcpReq.id, ctx.mcpReq.signal),
        ).then((answer) => {
          if (answer.kind === "refused") {
            throw new ProtocolError(answer.code ?? ProtocolErrorCode.InvalidParams, answer.message);
          }

          // SAFETY: `askQuestion` answers an elicitation with an `ElicitResult` or a refusal, which was thrown above.
          return (answer as Extract<QuestionAnswer, { kind: "answered" }>).result;
        }),
      );
    }

    // Sampling is declared only by a Legacy connection that was told to (the definition's key); like a form, a request
    // that belongs to no call that can take it is refused, and the server is told why.
    if (declared.sampling !== undefined) {
      client.setRequestHandler("sampling/createMessage", (request, ctx) => {
        // Noted whatever becomes of the request: on a call's stream or the standalone one, answered or refused.
        deps.onDeprecated?.("sampling");

        return Effect.runPromiseWith(context)(
          askQuestion("sampling", request.params, ctx.mcpReq.id, ctx.mcpReq.signal),
        ).then((answer) => {
          if (answer.kind !== "sampled") {
            const refused = noSampling(answer);

            throw new ProtocolError(refused.code, refused.message);
          }

          // SAFETY: the Session's `CreateMessageResult`, which the SDK checks against the spec before the server gets it.
          return answer.result as CreateMessageResultWithTools;
        });
      });
    }

    return client;
  };

  /** The call's clock goes on, and a page's completion is no longer listened for. */
  const release = (call: Asking, page: PageListening | undefined) =>
    Effect.andThen(call.resume, page?.forget ?? Effect.void);

  /** What an elicitation gets when it is not answered: the server may ask again. */
  const cancelled: QuestionAnswer = { kind: "answered", result: { action: "cancel" } };

  /** What a Sampling request gets when it is not answered: the server's error (`-1` is a refusal, the spec's own). */
  const unsampled = (message: string, code = MCP_SAMPLING_REFUSED): QuestionAnswer => ({
    kind: "refused",
    message,
    code,
  });

  /** The error a Sampling request that was not given a reply ends with. */
  const noSampling = (answer: QuestionAnswer) =>
    answer.kind === "refused"
      ? { code: answer.code ?? MCP_SAMPLING_REFUSED, message: answer.message }
      : { code: MCP_INTERNAL_ERROR, message: "cloudpid could not answer the sampling request" };

  /**
   * A Legacy server's question, an elicitation form or a Sampling request: tied by the tap to the call whose POST stream
   * carried it, passed to the call's `onInput` while the call's clock stops, and bound by the call's `inputWaitMs`. One
   * with no such call, or no `onInput`, is cancelled (an elicitation) or refused "no conversation to sample in" (a
   * request to sample); one the Session cannot take (`refused`) is the server's error, `-32602` for a form unless the
   * Session says another.
   */
  const askQuestion = (
    kind: McpInputRequest["kind"],
    params: ElicitRequestParams | CreateMessageRequestParams,
    id: string | number,
    ended: AbortSignal,
  ) =>
    Effect.gen(function* () {
      const sampling = kind === "sampling";
      const none = sampling ? unsampled("no conversation to sample in") : cancelled;
      const token = ties.take(id);
      const call = token === undefined ? undefined : asking.get(token);
      const { onInput } = deps;

      if (call === undefined || onInput === undefined) return none;

      // A call that offered only the other kind never takes this one: refused as an unoffered kind, never handed to a hook
      // that reads only its own.
      if (!call.offers.has(kind)) {
        return sampling
          ? unsampled("the call did not offer to answer a sampling request")
          : cancelled;
      }

      const key = String(id);

      const input: McpInputRequest = {
        key,
        kind,
        params: jsonObjectOf(params),
        mode: "live",
        era: "legacy",
      };

      const answered = onInput(input).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(call.waitMs),
          orElse: () =>
            Effect.succeed(sampling ? unsampled("the owner did not answer in time") : cancelled),
        }),
        Effect.catchCause(() =>
          Effect.succeed(
            sampling
              ? unsampled("cloudpid could not answer the sampling request", MCP_INTERNAL_ERROR)
              : cancelled,
          ),
        ),
      );

      const answerOf = (given: Effect.Success<typeof answered>): QuestionAnswer => {
        if (given.kind === "defer") return none;

        if (sampling) {
          return given.kind === "answered"
            ? unsampled("cloudpid could not answer the sampling request", MCP_INTERNAL_ERROR)
            : given;
        }

        return given.kind === "sampled" ? cancelled : given;
      };

      // The server stopped waiting (its own `notifications/cancelled`): the question is withdrawn.
      const stopped = Effect.callback<"ended">((resume) => {
        if (ended.aborted) return resume(Effect.succeed("ended"));

        const onEnd = () => resume(Effect.succeed("ended"));

        ended.addEventListener("abort", onEnd, { once: true });

        return Effect.sync(() => ended.removeEventListener("abort", onEnd));
      });

      // A page's completion is heard from the ask on: the owner may finish there before they have answered.
      const page =
        "mode" in params && params.mode === "url"
          ? yield* listenForPage(call, params.elicitationId)
          : undefined;

      const finished = page === undefined ? stopped : Effect.raceFirst(stopped, page.completed);

      yield* call.pause;

      const askedAt = yield* Clock.currentTimeMillis;

      const outcome = yield* Effect.raceFirst(answered, finished).pipe(
        Effect.onInterrupt(() => release(call, page)),
      );

      if (outcome === "complete") {
        yield* release(call, page);
        deps.onInputComplete?.(key);

        return cancelled;
      }

      if (outcome === "ended") {
        yield* release(call, page);
        deps.onInputEnded?.(key);

        return none;
      }

      // A Legacy question lives only as long as its call: one kept for later is cancelled, or refused (ADR-0037); an
      // answer of the other kind is one the Session should never give: a form is cancelled, a sample refused.
      const answer = answerOf(outcome);

      // A page the owner opened: the server goes on at once, and the call's clock stays stopped until the owner has
      // finished there (the server says so on this call's stream), the call ends, or the bound passes.
      if (page !== undefined && answer.kind === "answered" && answer.result.action === "accept") {
        yield* Effect.forkDetach(awaitPage(call, page, key, askedAt));
      } else {
        yield* release(call, page);
      }

      return answer;
    });

  /** A page question's completion, heard from the ask on: when it comes, and how to stop listening. */
  type PageListening = Effect.Success<ReturnType<typeof listenForPage>>;

  /** Hears the completion of the URL question `elicitationId` on `call`'s stream, from now until `forget`. */
  const listenForPage = (call: Asking, elicitationId: string) =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<"complete">();

      const forget = ties.onComplete(call.token, elicitationId, () =>
        Effect.runForkWith(context)(Deferred.succeed(completed, "complete" as const)),
      );

      return { completed: Deferred.await(completed), forget: Effect.sync(forget) };
    });

  /**
   * Holds the clock of `call`, stopped for the page that question `key` asked the owner to open, until the server says the
   * owner finished there (`onInputComplete`), the call ends, or the call's bound from the ask passes (`onInputEnded`:
   * the card is withdrawn).
   */
  const awaitPage = (call: Asking, page: PageListening, key: string, askedAt: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const remaining = Math.max(0, call.waitMs - (now - askedAt));

      const ended = yield* Effect.raceFirst(
        page.completed,
        Effect.raceFirst(
          Effect.as(Deferred.await(call.over), "over" as const),
          Effect.as(Effect.sleep(Duration.millis(remaining)), "bound" as const),
        ),
      ).pipe(Effect.ensuring(release(call, page)));

      if (ended === "complete") deps.onInputComplete?.(key);
      else if (ended === "bound") deps.onInputEnded?.(key);
    });

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
          autoGet: false,
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
          : deps.sessions.set(
              sessionRowOf(
                client,
                transport.sessionId,
                protocolVersion,
                now,
                declaredCapabilities(deps.capabilities, deps.extensions, deps.roots),
              ),
            );

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
        autoGet: era === "legacy" && transport.sessionId !== undefined,
      } satisfies Live;
    });

  /** Whether the Legacy session `row` was initialized with what the client declares today. */
  const declaredToday = (row: SessionRow) =>
    row.declared !== undefined &&
    JSON.stringify(row.declared) ===
      JSON.stringify(
        jsonObjectOf(declaredCapabilities(deps.capabilities, deps.extensions, deps.roots)),
      );

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

    // A server keeps what it was told at `initialize` for the life of the session: one initialized with other
    // capabilities than today's (questions added, a sampling key changed, or a row from before they were recorded) is
    // initialized again, with nothing else about the connection changed.
    if (sessionRow !== undefined && declaredToday(sessionRow)) {
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
   * 404 initializes again. `send` looks at `live` each time it runs, so an attempt after a recovery sees the era and
   * capabilities the server has now.
   */
  const request = <A>(
    send: (client: Client, signal: AbortSignal) => Promise<A>,
    mayHaveRun: boolean,
    policy: RequestPolicy = {},
  ): Effect.Effect<A, McpError> => {
    const once = Effect.suspend(() => {
      const client = live.client;

      return Effect.tryPromise({
        try: (signal) => send(client, signal),
        catch: (cause) => failure(cause, mayHaveRun, policy.declared?.() ?? false),
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

      // A read is sent once more after a cut, and so is a request whose resend is safe (`tasks/update`, `tasks/cancel`);
      // a `tools/call` never is, in either era (D15).
      return (policy.resend === true || !mayHaveRun) && isCut(failed.error)
        ? Option.some(Effect.void)
        : Option.none();
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
    ctx.allowTask === true && live.era === "modern" && advertisesTasks();

  const advertisesTasks = () => live.capabilities.extensions?.[MCP_TASKS_EXTENSION] !== undefined;

  /**
   * `run` with the clock and the questions of a call, when the call can have them: a Legacy request whose caller can
   * answer elicitations is tied to its questions by a header the tap strips, and has a clock of its own that a
   * question's wait can stop (`own`). Every other request keeps the SDK's timeout, as before. What was set up is let go
   * of however `run` ends.
   */
  const withAsking = <A, E>(
    ctx: McpCallContext,
    timeoutMs: number,
    run: (own: Own | undefined) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const token = `c${(callCount += 1)}`;
      const { answers } = ctx;

      const askable =
        live.era === "legacy" &&
        deps.onInput !== undefined &&
        (answers?.elicitation === true || answers?.sampling === true);

      const deadline = askable
        ? yield* pausableDeadline(
            timeoutMs,
            () =>
              new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", {
                timeout: timeoutMs,
              }),
          )
        : undefined;

      const over = yield* Deferred.make<void>();

      if (askable && deadline !== undefined) {
        asking.set(token, {
          offers: new Set<McpInputRequest["kind"]>([
            ...(answers.elicitation === true ? (["elicitation"] as const) : []),
            ...(answers.sampling === true ? (["sampling"] as const) : []),
          ]),
          waitMs:
            answers.inputWaitMs ??
            (answers.sampling === true ? MCP_SAMPLING_WAIT_MS : MCP_ELICITATION_WAIT_MS),
          pause: deadline.pause,
          resume: deadline.resume,
          token,
          over,
        });
      }

      return yield* run(deadline === undefined ? undefined : { deadline, token }).pipe(
        Effect.ensuring(
          Effect.andThen(
            deadline === undefined ? Effect.void : deadline.clear,
            Effect.andThen(
              Effect.sync(() => {
                asking.delete(token);
                ties.release(token);
              }),
              Deferred.succeed(over, undefined),
            ),
          ),
        ),
      );
    });

  /**
   * Whether a Legacy server's `-32042` may be kept for the owner: the call can answer an elicitation, keeps its questions
   * for later (`ctx.answers.defer`), keeps pages (`ctx.answers.pages`) and has an `onInput` to ask. For any other call it
   * is the server's error.
   */
  const mayKeepPages = (ctx: McpCallContext) =>
    live.era === "legacy" &&
    deps.onInput !== undefined &&
    ctx.answers?.elicitation === true &&
    ctx.answers.defer === true &&
    ctx.answers.pages === true;

  /**
   * Sends a tool's call once, or with `retry` the answers to a round of questions. Whether the call is offered a task
   * is decided at each attempt, on the era and capabilities the server has then: a call sent again after an era drop to
   * a server that is Legacy now declares nothing, and a retry to one is refused before it is sent.
   */
  const sendCall = (
    params: CallToolParams,
    ctx: McpCallContext,
    retry?: Retry,
  ): Effect.Effect<CallAnswer, McpError> =>
    Effect.gen(function* () {
      const timeoutMs = target.timeoutMs ?? CALL_TIMEOUT_MS;

      const sent = yield* withAsking(ctx, timeoutMs, (own) =>
        request<CallSent>(
          (client, signal) => {
            // Answers go only to the Modern server that asked: one that dropped its era since has no round to answer.
            if (retry !== undefined && live.era !== "modern") {
              return Promise.reject(
                Unsupported.make({
                  message:
                    "The server no longer speaks the Modern protocol, so its question can't be answered; call the tool again",
                }),
              );
            }

            return offersTask(ctx)
              ? callOnTaskWire(params, ctx, signal, retry).then(
                  (answer) => ({ kind: "wire", answer }) as const,
                )
              : callOnClient(client, params, ctx, signal, own, retry).then(
                  (value) => ({ kind: "client", value }) as const,
                  (error: Error) => {
                    // A `-32042` is a question for a call that keeps them; to any other it is the server's error.
                    const url = mayKeepPages(ctx) ? urlRequiredOf(error) : undefined;

                    return url === undefined
                      ? Promise.reject(error)
                      : ({ kind: "url", answer: url } as const);
                  },
                );
          },
          true,
          { declared: () => offersTask(ctx) },
        ),
      );

      if (sent.kind === "url") return sent.answer;

      return yield* sent.kind === "wire"
        ? readCallAnswer(sent.answer)
        : readClientAnswer(sent.value);
    });

  /**
   * A Modern round's Sampling request, by `key` (`docs/architecture/mcp-server-requests.md` → Sampling requests): the
   * call's `onInput` runs it (`sampled`) or keeps it for later (`defer`, only for a call that keeps questions). Anything
   * else ends the call locally, since an `InputResponse` has no error form and a Sampling request has no `cancel`: a
   * refusal, a request the call never offered to answer, and a deferral it cannot keep. The server is told nothing.
   */
  const answerSample = (
    key: string,
    params: JsonObject,
    ctx: McpCallContext,
  ): Effect.Effect<RoundAnswer, McpError> =>
    Effect.gen(function* () {
      const { onInput } = deps;

      if (onInput === undefined || ctx.answers?.sampling !== true) {
        return yield* ProtocolViolation.make({
          message:
            "The server asked for sampling/createMessage, which cloudpid did not offer on this call",
        });
      }

      const input: McpInputRequest = {
        key,
        kind: "sampling",
        params,
        mode: "deferrable",
        era: "modern",
      };

      const answer = yield* onInput(input);

      if (answer.kind === "sampled") return { key, answer: { ...answer.result } };

      if (answer.kind === "defer" && ctx.answers.defer === true) return { key, defer: input };

      return yield* Unsupported.make({
        message:
          answer.kind === "refused"
            ? answer.message
            : "cloudpid could not answer the sampling request",
      });
    });

  /**
   * Answers one question of a Modern round, by `key`: Roots from the connection's own, an elicitation through the
   * call's `onInput` when the call offers it (else `cancel`, as for a question with nowhere to go), a Sampling request
   * through it too (`answerSample`). Anything else was never offered, and fails the call locally: the server is told
   * nothing (`InputResponse` has no error form).
   */
  const answerOne = (
    key: string,
    entry: JsonObject,
    ctx: McpCallContext,
  ): Effect.Effect<RoundAnswer, McpError> =>
    Effect.gen(function* () {
      const method = entry["method"];
      const params = isJsonObject(entry["params"]) ? entry["params"] : {};

      if (method === "roots/list" && deps.roots !== undefined) {
        return {
          key,
          answer: { roots: Arr.map(deps.roots, (root) => ({ ...root })) },
        } satisfies RoundAnswer;
      }

      if (method === "sampling/createMessage") return yield* answerSample(key, params, ctx);

      if (method !== "elicitation/create") {
        return yield* ProtocolViolation.make({
          message: `The server asked for ${Predicate.isString(method) ? method : "something"}, which cloudpid did not offer on this call`,
        });
      }

      const { onInput } = deps;

      if (onInput === undefined || ctx.answers?.elicitation !== true) {
        return { key, answer: { action: "cancel" } };
      }

      const input: McpInputRequest = {
        key,
        kind: "elicitation",
        params,
        mode: "deferrable",
        era: "modern",
      };

      const answer = yield* onInput(input);

      if (answer.kind === "defer") {
        // Only a caller that keeps questions defers one; to any other a deferral is a `cancel`.
        return ctx.answers.defer === true
          ? { key, defer: input }
          : { key, answer: { action: "cancel" } };
      }

      if (answer.kind === "refused") {
        return yield* Unsupported.make({ message: answer.message });
      }

      return { key, answer: { ...answer.result } } satisfies RoundAnswer;
    });

  /** Answers every question of a Modern round (`answerOne`): those answered at once, and those the caller deferred. */
  const answerRound = (asked: Asked, ctx: McpCallContext) =>
    Effect.gen(function* () {
      const answered: Record<string, JsonObject> = {};
      const deferred: Array<McpInputRequest> = [];

      for (const [key, entry] of Record.toEntries(asked.inputRequests)) {
        const one = yield* answerOne(key, entry, ctx);

        if ("defer" in one) deferred.push(one.defer);
        else answered[key] = one.answer;
      }

      return { answered, deferred };
    });

  /**
   * A Legacy server's `-32042`, round `round` of its request: it ran nothing, so it waits for the owner and is sent
   * again. Each page it lists goes to `onInput` as a question to keep (`defer`). A page the caller does not keep (it
   * declined it unseen), and the eleventh `-32042`, end the request with the server's own error: the latter says the
   * server kept asking, and the request is never sent again.
   */
  const deferPages = (
    answer: UrlRequired,
    round: number,
  ): Effect.Effect<ReadonlyArray<McpInputRequest>, McpError> =>
    Effect.gen(function* () {
      const { onInput } = deps;
      const error = ServerError.make({ message: answer.message, code: URL_REQUIRED_CODE });

      if (round > MCP_INPUT_ROUNDS) {
        return yield* ServerError.make({
          message: `${answer.message}. ${target.name ?? "The server"} kept asking for the same page; stopped after ${MCP_INPUT_ROUNDS} tries`,
          code: URL_REQUIRED_CODE,
        });
      }

      const deferred: Array<McpInputRequest> = [];

      for (const { elicitationId, page } of answer.elicitations) {
        const input: McpInputRequest = {
          key: elicitationId,
          kind: "elicitation",
          params: page,
          mode: "deferrable",
          era: "legacy",
        };

        const kept = onInput === undefined ? undefined : yield* onInput(input);

        if (kept?.kind !== "defer") return yield* error;

        deferred.push(input);
      }

      return deferred;
    });

  /**
   * A Legacy `tools/call`'s `-32042` (round `round`): each page it lists is kept, and the call ends as `pages_required`
   * with the `ResendState` that `resend` sends the original request again from, on a new id, once every page is
   * answered `accept`.
   */
  const keepPages = (
    params: CallToolParams,
    answer: UrlRequired,
    round: number,
  ): Effect.Effect<Outcome<CallToolResult>, McpError> =>
    Effect.gen(function* () {
      const deferred = yield* deferPages(answer, round);

      const state: ResendStateV1 = {
        v: 1,
        method: "tools/call",
        name: params.tool.name,
        arguments: { ...params.arguments },
        deferred: Arr.map(deferred, (each) => each.key),
        round,
        message: answer.message,
      };

      if (jsonBytes(state) > MCP_RESUME_STATE_MAX_BYTES) {
        return yield* TooLarge.make({
          message: "The server's questions are too large to keep for later",
          limit: MCP_RESUME_STATE_MAX_BYTES,
        });
      }

      return {
        kind: "pages_required",
        requests: deferred,
        message: answer.message,
        resend: state,
        fetchedAt: yield* Clock.currentTimeMillis,
      } satisfies PagesRequired;
    });

  /**
   * Runs a call's rounds from `answer`. A Modern round of questions: each is answered (Roots by the core, the rest
   * through `onInput`), then the call is sent again with every answer and the server's `requestState`, on a new id, at
   * most `MCP_INPUT_ROUNDS` rounds; a round with a question the caller deferred ends here, as `input_required` with the
   * `ResumeState` `resume` goes on from, and a partial round is never sent. A Legacy `-32042` ends here too, as
   * `pages_required` with the `ResendState` `resend` goes on from, or as the server's error (`keepPages`). A result after
   * questions is never cacheable.
   */
  const drive = (
    params: CallToolParams,
    ctx: McpCallContext,
    first: CallAnswer,
    firstRound: number,
  ): Effect.Effect<Outcome<CallToolResult>, McpError> =>
    Effect.gen(function* () {
      let answer = first;
      let round = firstRound;

      while (answer.kind === "asked" || answer.kind === "url_required") {
        if (answer.kind === "url_required") return yield* keepPages(params, answer, round);

        if (round > MCP_INPUT_ROUNDS) {
          return yield* ProtocolViolation.make({
            message: `The server asked questions for more than ${MCP_INPUT_ROUNDS} rounds`,
          });
        }

        const { requestState } = answer;
        const { answered, deferred } = yield* answerRound(answer, ctx);

        if (deferred.length > 0) {
          const state: Mutable<ResumeStateV1> = {
            v: 1,
            method: "tools/call",
            name: params.tool.name,
            arguments: { ...params.arguments },
            answered,
            deferred: Arr.map(deferred, (each) => each.key),
            round,
          };

          if (requestState !== undefined) state.requestState = requestState;

          if (jsonBytes(state) > MCP_RESUME_STATE_MAX_BYTES) {
            return yield* TooLarge.make({
              message: "The server's questions are too large to keep for later",
              limit: MCP_RESUME_STATE_MAX_BYTES,
            });
          }

          return {
            kind: "input_required",
            requests: deferred,
            resume: state,
            fetchedAt: yield* Clock.currentTimeMillis,
          } satisfies InputRequired;
        }

        const retry: Mutable<Retry> = { inputResponses: answered };

        if (requestState !== undefined) retry.requestState = requestState;

        answer = yield* sendCall(params, ctx, retry);
        round += 1;
      }

      return answer.kind === "complete" && round > 1 ? { ...answer, cacheable: false } : answer;
    });

  /** Calls a tool, answering a Modern server's rounds of questions as the call's `ctx` and `onInput` allow. */
  const callTool = (
    params: CallToolParams,
    ctx: McpCallContext,
  ): Effect.Effect<Outcome<CallToolResult>, McpError> =>
    Effect.flatMap(sendCall(params, ctx), (answer) => drive(params, ctx, answer, 1));

  const resume = (
    given: Schema.Json,
    answers: McpTaskInputResponses,
    tool: Tool,
    ctx: McpCallContext,
  ): Effect.Effect<Outcome<CallToolResult>, McpError> =>
    Effect.gen(function* () {
      const decoded = decodeResumeState(given);

      if (Option.isNone(decoded)) {
        return yield* Unsupported.make({ message: MCP_RESUME_STATE_EXPIRED });
      }

      const state = decoded.value;
      const missing = Arr.filter(state.deferred, (key) => answers[key] === undefined);

      // A partial round is never sent (`docs/architecture/mcp-server-requests.md` → Several at once on Modern). The
      // caller's fault, not the server's: nothing was sent, so nothing ran.
      if (missing.length > 0) {
        return yield* Unsupported.make({
          message: `The resume answers too few questions: ${Arr.join(missing, ", ")} unanswered`,
        });
      }

      const inputResponses: Record<string, JsonObject> = { ...state.answered };

      for (const key of state.deferred) {
        const answer = answers[key];

        if (answer !== undefined) inputResponses[key] = answer;
      }

      const retry: Mutable<Retry> = { inputResponses };

      if (state.requestState !== undefined) retry.requestState = state.requestState;

      const params: CallToolParams = {
        tool: { ...tool, name: state.name },
        arguments: state.arguments,
      };

      return yield* Effect.flatMap(sendCall(params, ctx, retry), (answer) =>
        drive(params, ctx, answer, state.round + 1),
      );
    });

  const resend = (
    given: Schema.Json,
    answers: McpTaskInputResponses,
    tool: Tool,
    ctx: McpCallContext,
  ): Effect.Effect<Outcome<CallToolResult>, McpError> =>
    Effect.gen(function* () {
      const decoded = decodeResendState(given);

      if (Option.isNone(decoded)) {
        return yield* Unsupported.make({ message: MCP_RESUME_STATE_EXPIRED });
      }

      const state = decoded.value;
      const missing = Arr.filter(state.deferred, (key) => answers[key] === undefined);

      if (missing.length > 0) {
        return yield* Unsupported.make({
          message: `The resend answers too few pages: ${Arr.join(missing, ", ")} unanswered`,
        });
      }

      // The original request goes again, as it was, once the owner has opened every page. Any other answer ends the call
      // with the server's own error, which nothing sent again can change.
      if (Arr.some(state.deferred, (key) => answers[key]?.["action"] !== "accept")) {
        return yield* ServerError.make({ message: state.message, code: URL_REQUIRED_CODE });
      }

      const again: CallToolParams = {
        tool: { ...tool, name: state.name },
        arguments: state.arguments,
      };

      return yield* Effect.flatMap(sendCall(again, ctx), (answer) =>
        drive(again, ctx, answer, state.round + 1),
      );
    });

  const completeCall = (value: CallToolResult) =>
    Effect.map(
      Clock.currentTimeMillis,
      (fetchedAt) =>
        ({
          kind: "complete",
          value,
          cacheable: true,
          fetchedAt,
        }) satisfies Complete<CallToolResult>,
    );

  /** The client's answer to a `tools/call`: its result, or (Modern) a round of questions. */
  const readClientAnswer = (value: CallToolResult | Result): Effect.Effect<CallAnswer, McpError> =>
    value["resultType"] === "input_required"
      ? askedOf(value)
      : // SAFETY: anything but `input_required` is the result the SDK validated as a `CallToolResult`.
        completeCall(value as CallToolResult);

  /** The abort signal and timeout of a request: the SDK's own, or, with a clock of its own (`own`), the deadline's. */
  const timingOf = (own: Own | undefined, signal: AbortSignal, timeoutMs: number) => ({
    signal: own === undefined ? signal : AbortSignal.any([signal, own.deadline.signal]),
    // The deadline's is the one that ends a request with a clock of its own: the SDK's own timer is given the most it takes.
    timeout: own === undefined ? timeoutMs : SDK_TIMER_MAX_MS,
  });

  /**
   * Sends with the headers a request has: the call header when it has a clock of its own (each attempt, a request sent
   * again after the server dropped its session or the era, then has the whole timeout), and `more`. `send` gets none
   * when there are none.
   */
  const sendWith = <A>(
    own: Own | undefined,
    more: Readonly<Record<string, string>> | undefined,
    send: (headers: Record<string, string> | undefined) => Promise<A>,
  ): Promise<A> => {
    if (own === undefined) return send(more === undefined ? undefined : { ...more });

    return Effect.runPromiseWith(context)(own.deadline.reset).then(() =>
      send({ ...more, [CALL_HEADER]: own.token }),
    );
  };

  const callOnClient = (
    client: Client,
    params: CallToolParams,
    ctx: McpCallContext,
    signal: AbortSignal,
    own: Own | undefined,
    retry: Retry | undefined,
  ): Promise<CallToolResult | Result> => {
    const call: CallToolRequestParams = {
      name: params.tool.name,
      arguments: { ...params.arguments },
      // A round's answers and the server's state go back as top-level params (Modern only; ADR-0037).
      ...retry,
    };

    const meta = metaFor(ctx);

    if (meta !== undefined) {
      call._meta = meta;
    }

    const timeoutMs = target.timeoutMs ?? CALL_TIMEOUT_MS;

    const options: CallToolRequestOptions = {
      ...timingOf(own, signal, timeoutMs),
      // Without `outputSchema`, so the SDK checks no `structuredContent`: the engine does (D17). With the
      // definition given, the SDK rethrows a `-32020` header mismatch rather than refreshing `tools/list`: the
      // refresh and one retry (D14) belong to the catalog's owner, the engine, so it surfaces as `ServerError`.
      toolDefinition: Struct.omit(params.tool, ["outputSchema"]),
    };

    if (own === undefined) options.resetTimeoutOnProgress = true;

    // A Modern server's questions come back to the core, which answers them itself (`drive`): never the SDK's own loop.
    if (live.era === "modern") options.allowInputRequired = true;

    if (deps.onProgress !== undefined) {
      const progress = progressOf(deps.onProgress);

      // With a deadline of its own, each notice starts the call's timeout again from the whole.
      options.onprogress =
        own === undefined
          ? progress
          : (notice) => {
              Effect.runForkWith(context)(own.deadline.reset);
              progress(notice);
            };
    }

    return sendWith(own, undefined, (headers) =>
      client.callTool(call, headers === undefined ? options : { ...options, headers }),
    );
  };

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

  /** Sends `method` on the task wire, with the Modern envelope. */
  const sendOnTaskWire = (
    method: string,
    params: TaskParams,
    ctx: McpCallContext,
    options: WireOptions,
    signal: AbortSignal,
  ) => {
    const { onProgress } = options;
    const token = onProgress === undefined ? undefined : (progressTokens += 1);
    const sending: Mutable<TaskRequestOptions> = { timeoutMs: options.timeoutMs, signal };

    if (options.headers !== undefined) sending.headers = options.headers;

    if (token !== undefined && onProgress !== undefined) {
      sending.progress = { token, notify: onProgress };
    }

    return taskWire().call(method, framed(params, ctx, token), sending);
  };

  /**
   * Why a `tasks/*` request cannot be sent to the server as it is now, checked at every attempt, after a recovery's
   * reconnect included: it is Legacy, or no longer advertises the tasks extension. Both fail `Unsupported`, which on a
   * `tasks/*` request tells the follower the task is `unknown` (as does `-32021`, a `ServerError`).
   */
  const tasksUnavailable = () => {
    if (live.era !== "modern") {
      return Unsupported.make({
        message: "The server speaks the Legacy protocol, which has no MCP tasks",
      });
    }

    return advertisesTasks()
      ? undefined
      : Unsupported.make({ message: "The server no longer advertises MCP tasks" });
  };

  /** Sends a `tasks/*` request: refused, before anything is sent, by a server that no longer qualifies. */
  const taskRequest = <A>(
    method: "tasks/get" | "tasks/update" | "tasks/cancel",
    params: TaskParams,
    ctx: McpCallContext,
    policy: { readonly mayHaveRun: boolean; readonly resend: boolean },
    read: (result: Result) => Effect.Effect<A, McpError>,
  ): Effect.Effect<A, McpError> =>
    request(
      (_client, signal) => {
        const refused = tasksUnavailable();

        return refused === undefined
          ? sendOnTaskWire(method, params, ctx, { timeoutMs: MCP_TASK_TIMEOUT_MS }, signal)
          : Promise.reject(refused);
      },
      policy.mayHaveRun,
      { declared: () => true, resend: policy.resend },
    ).pipe(Effect.flatMap(read));

  const notMcp = (what: string) =>
    ProtocolViolation.make({ message: `Not an MCP server: ${what}` });

  /** A `tools/call` on the task wire: the server's result, or the task it started. */
  const callOnTaskWire = (
    params: CallToolParams,
    ctx: McpCallContext,
    signal: AbortSignal,
    retry?: Retry,
  ) => {
    const args = { ...params.arguments };

    const options: Mutable<WireOptions> = {
      timeoutMs: target.timeoutMs ?? CALL_TIMEOUT_MS,
      headers: xMcpHeaders(
        Option.getOrElse(decodeJson(params.tool.inputSchema), () => ({})),
        args,
      ),
    };

    if (deps.onProgress !== undefined) options.onProgress = deps.onProgress;

    return sendOnTaskWire(
      "tools/call",
      { name: params.tool.name, arguments: args, ...retry },
      ctx,
      options,
      signal,
    );
  };

  /** A Modern server's round of questions, as it answered a `tools/call`. */
  const askedOf = (answer: Result): Effect.Effect<CallAnswer, McpError> =>
    Option.match(decodeAsked(answer), {
      onNone: () => Effect.fail(notMcp("its questions are malformed")),
      onSome: ({ inputRequests, requestState }) => {
        const asked: Mutable<Asked> = { kind: "asked", inputRequests: inputRequests ?? {} };

        if (requestState !== undefined) asked.requestState = requestState;

        return Effect.succeed(asked);
      },
    });

  /** What the task wire's answer to a `tools/call` made with the extension declared says. */
  const readCallAnswer = (answer: Result): Effect.Effect<CallAnswer, McpError> =>
    Effect.gen(function* () {
      const fetchedAt = yield* Clock.currentTimeMillis;
      const { resultType, ...rest } = answer;

      if (resultType === "task") {
        const started = decodeTaskCreated(rest);

        return Option.isNone(started)
          ? yield* notMcp("the task it started is malformed")
          : ({ kind: "task", task: started.value, fetchedAt } satisfies TaskStarted);
      }

      if (resultType === "input_required") return yield* askedOf(answer);

      if (resultType !== "complete" || !isCallToolResult(rest)) {
        return yield* notMcp("the answer to tools/call is neither a result nor a task");
      }

      return {
        kind: "complete",
        value: rest,
        cacheable: false,
        fetchedAt,
      } satisfies Complete<CallToolResult>;
    });

  const taskGet = (taskId: string, ctx: McpCallContext) =>
    taskRequest(
      "tasks/get",
      { taskId },
      ctx,
      { mayHaveRun: false, resend: false },
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

  /**
   * `tasks/update` and `tasks/cancel` answer an empty result. They may have run when cut, and are sent once more anyway:
   * a repeated answer to a question, or a repeated cancel, changes nothing the task did not already.
   */
  const taskCommand = (
    method: "tasks/update" | "tasks/cancel",
    params: TaskParams,
    ctx: McpCallContext,
  ) => taskRequest(method, params, ctx, { mayHaveRun: true, resend: true }, () => Effect.void);

  const task: McpTasks = {
    get: taskGet,
    update: (taskId, inputResponses, ctx) =>
      taskCommand("tasks/update", { taskId, inputResponses }, ctx),
    cancel: (taskId, ctx) => taskCommand("tasks/cancel", { taskId }, ctx),
  };

  /** A read's own bound: the page timeout, or the entry's `timeout` when that is lower (#394 D15). */
  const readTimeoutMs = () => Math.min(target.timeoutMs ?? PAGE_TIMEOUT_MS, PAGE_TIMEOUT_MS);

  /**
   * Reads `uri` once, or with `options.retry` the answers to a round of questions: its result, or (Modern) a round of
   * questions, which the read's own rounds answer (`readResource`). `options.recover` reads a failure as a value
   * instead: a read that keeps pages recovers a Legacy `-32042` as a `UrlRequired`.
   */
  const readOnce = <Recovered = never>(
    params: ReadParams,
    ctx: McpCallContext,
    more: Readonly<Record<string, string>> | undefined,
    options: {
      readonly retry?: Retry | undefined;
      readonly recover?: ((error: Error) => Recovered | undefined) | undefined;
    } = {},
  ) => {
    const { retry, recover } = options;

    const timeoutMs = readTimeoutMs();

    return withAsking(ctx, timeoutMs, (own) =>
      request((client, signal) => {
        const timing: Mutable<RequestOptions> = timingOf(own, signal, timeoutMs);

        // A Modern server's questions come back to the core, which answers them itself: never the SDK's own loop.
        if (live.era === "modern") timing.allowInputRequired = true;

        return sendWith(own, more, (headers) =>
          client.request(
            { method: "resources/read", params: { ...params, ...retry } },
            headers === undefined ? timing : { ...timing, headers },
          ),
        ).then(
          (value) => value,
          (error: Error) => {
            const recovered = recover?.(error);

            return recovered === undefined ? Promise.reject(error) : recovered;
          },
        );
      }, false),
    );
  };

  /**
   * Reads a resource. A Modern server may answer with a round of questions (`input_required`), which the read answers
   * at once, as a call's rounds are answered (Roots by the core, an elicitation through `onInput`), and sends again
   * with every answer and the server's `requestState`, at most `MCP_INPUT_ROUNDS` rounds. A read is never kept for
   * later: a question the caller would defer is a `cancel`. A read after questions is not cacheable.
   */
  const readResource = (uri: string, ctx: McpCallContext, options: ReadOptions = {}) =>
    Effect.gen(function* () {
      // A read has no resume: its caller's deferrals are cancels, so it declares no page either (a Modern server's page
      // waits for a resume).
      const asking = noDeferral(ctx);
      const meta = metaFor(asking);
      const params: ReadParams = meta === undefined ? { uri } : { uri, _meta: meta };
      const more = options.app === true ? { [APP_READ_HEADER]: "1" } : undefined;

      const first = yield* readOnce(params, asking, more, {
        // A `-32042` is a question for a read that keeps pages; to any other it is the server's error.
        recover: mayKeepPages(ctx) ? urlRequiredOf : undefined,
      });

      // A Legacy server's `-32042` on a read: its pages are kept for the owner, and the caller sends the read again as it
      // was once they are done (a read has no state; the caller counts the rounds and ends the eleventh).
      if (isUrlRequired(first)) {
        return {
          kind: "pages_required",
          requests: yield* deferPages(first, 1),
          message: first.message,
          fetchedAt: yield* Clock.currentTimeMillis,
        } satisfies PagesRequired;
      }

      let value: ReadResourceResult | Result = first;
      let round = 1;

      while (value["resultType"] === "input_required") {
        if (round > MCP_INPUT_ROUNDS) {
          return yield* ProtocolViolation.make({
            message: `The server asked questions for more than ${MCP_INPUT_ROUNDS} rounds`,
          });
        }

        const asked = yield* askedOf(value);

        if (asked.kind !== "asked") return yield* notMcp("its questions are malformed");

        const { answered } = yield* answerRound(asked, asking);
        const retry: Mutable<Retry> = { inputResponses: answered };

        if (asked.requestState !== undefined) retry.requestState = asked.requestState;

        // A round's retry is sent without `keepsPages`, so it is never answered as a `-32042`.
        value = yield* readOnce(params, asking, more, { retry });
        round += 1;
      }

      // SAFETY: anything but `input_required` is the result the SDK validated as a `ReadResourceResult`.
      const read = value as ReadResourceResult;
      const fetchedAt = yield* Clock.currentTimeMillis;
      const sha256 = yield* Effect.promise(() => contentsSha256(read.contents));

      return {
        kind: "complete",
        value: read,
        cacheable: round === 1,
        fetchedAt,
        sha256,
        ...Option.getOrUndefined(decodeCacheHints(read)),
      } satisfies ReadComplete;
    });

  const listPage = <K extends ListKind>(kind: K, cursor: string | undefined, ctx: McpCallContext) =>
    Effect.gen(function* () {
      const { capability, page: listOnePage } = listOf(kind);
      const fetchedAt = yield* Clock.currentTimeMillis;

      if (live.capabilities[capability] === undefined) {
        return {
          kind: "complete",
          value: { items: [] },
          cacheable: true,
          fetchedAt,
        } satisfies Complete<ListedPage<ListItems[K]>>;
      }

      const params: PageParams = {};
      const meta = metaFor(ctx);

      if (cursor !== undefined) params.cursor = cursor;

      if (meta !== undefined) params._meta = meta;

      const timeoutMs = readTimeoutMs();

      const page = yield* request(
        (client, signal) => listOnePage(client, params, { signal, timeout: timeoutMs }),
        false,
      );

      return {
        kind: "complete",
        value:
          page.nextCursor === undefined
            ? { items: page.items }
            : { items: page.items, nextCursor: page.nextCursor },
        cacheable: true,
        fetchedAt,
        ...Option.getOrUndefined(decodeCacheHints(page.result)),
      } satisfies Complete<ListedPage<ListItems[K]>>;
    });

  /**
   * Gets the prompt once, or with `retry` the answers to a round of questions: its result, or (Modern) a round of
   * questions, which the get's own rounds answer (`getPrompt`). A Legacy server's question during it is tied to the
   * call by the header (`withAsking`), and the get's clock stands still while it waits. `atPages` (`urlRequiredOf`, for a
   * get that waits at pages) turns a Legacy server's `-32042` into the pages to wait at, which the failure the request
   * ends with no longer lists; it is generic so that only the call that passes it gets them in its type.
   */
  const promptOnce = <Recovered = never>(
    params: PromptParams,
    ctx: McpCallContext,
    retry?: Retry,
    atPages?: (error: Error) => Recovered | undefined,
  ) => {
    const timeoutMs = readTimeoutMs();

    return withAsking(ctx, timeoutMs, (own) =>
      request((client, signal) => {
        const timing: Mutable<RequestOptions> = timingOf(own, signal, timeoutMs);

        // A Modern server's questions come back to the core, which answers them itself: never the SDK's own loop.
        if (live.era === "modern") timing.allowInputRequired = true;

        return sendWith(own, undefined, (headers) =>
          client.request(
            { method: "prompts/get", params: { ...params, ...retry } },
            headers === undefined ? timing : { ...timing, headers },
          ),
        ).then(
          (value) => value,
          (error: Error) => {
            const pages = atPages?.(error);

            return pages === undefined ? Promise.reject(error) : pages;
          },
        );
      }, false),
    );
  };

  /**
   * Whether a Legacy server's `-32042` is waited at: the get can answer an elicitation, waits at pages live
   * (`ctx.answers.livePages`) and has an `onInput` to ask. For any other get it is the server's error.
   */
  const mayWaitAtPages = (ctx: McpCallContext) =>
    live.era === "legacy" &&
    deps.onInput !== undefined &&
    ctx.answers?.elicitation === true &&
    ctx.answers.livePages === true;

  /**
   * A Legacy server's `-32042`, number `resends` of a get: it ran nothing, so the get waits for the owner at each page it
   * lists (shown together, each answered by its own `onInput`) and is sent again once every one is `accept`, which says the
   * owner is done there. A page that is declined, cancelled or refused, and the eleventh `-32042`, end the get with the
   * server's own error, the latter saying the server kept asking (`deferPages`' words); the first answer of the other kind
   * settles the round at once, and the cards of the pages still waiting are withdrawn (`onInputEnded`).
   */
  const waitAtPages = (answer: UrlRequired, resends: number): Effect.Effect<void, McpError> =>
    Effect.gen(function* () {
      const { onInput } = deps;

      if (resends > MCP_INPUT_ROUNDS) {
        return yield* ServerError.make({
          message: `${answer.message}. ${target.name ?? "The server"} kept asking for the same page; stopped after ${MCP_INPUT_ROUNDS} tries`,
          code: URL_REQUIRED_CODE,
        });
      }

      const error = ServerError.make({ message: answer.message, code: URL_REQUIRED_CODE });

      // Each page waits for its owner; one that is not `accept` fails the round, which interrupts the others.
      yield* Effect.forEach(
        answer.elicitations,
        ({ elicitationId, page }) =>
          (onInput === undefined
            ? Effect.succeed<McpInputAnswer>({
                kind: "refused",
                message: "The get cannot ask the owner",
              })
            : onInput({
                key: elicitationId,
                kind: "elicitation",
                params: page,
                mode: "deferrable",
                era: "legacy",
              })
          ).pipe(
            Effect.flatMap((each) =>
              each.kind === "answered" && each.result.action === "accept"
                ? Effect.void
                : Effect.fail(error),
            ),
            Effect.onInterrupt(() => Effect.sync(() => deps.onInputEnded?.(elicitationId))),
          ),
        { concurrency: "unbounded", discard: true },
      );
    });

  /**
   * Gets a prompt. A Modern server may answer with a round of questions (`input_required`), which the get answers at once,
   * as a read's rounds are answered (`readResource`): Roots by the core, an elicitation or a Sampling request through
   * `onInput`, then the get is sent again with every answer and the server's `requestState`, at most `MCP_INPUT_ROUNDS`
   * rounds. A get is never kept for later: a question the caller would defer is a `cancel`. A get after questions is not
   * cacheable.
   */
  const getPrompt = (name: string, args: Readonly<Record<string, string>>, ctx: McpCallContext) =>
    Effect.gen(function* () {
      // A get has no resume: its caller's deferrals are cancels, so it declares no page either.
      const asking = noDeferral(ctx);
      const meta = metaFor(asking);
      const sent = { name, arguments: { ...args } };
      const params: PromptParams = meta === undefined ? sent : { ...sent, _meta: meta };

      // A Legacy server's `-32042` is a page to wait at for a get that waits at pages live; to any other it is the server's
      // error. The get is sent again once the owner is done, as the server asked.
      const atPages = mayWaitAtPages(asking) ? urlRequiredOf : undefined;

      let first = yield* promptOnce(params, asking, undefined, atPages);
      let resends = 1;

      while (isUrlRequired(first)) {
        yield* waitAtPages(first, resends);
        first = yield* promptOnce(params, asking, undefined, atPages);
        resends += 1;
      }

      let value: GetPromptResult | Result = first;
      let round = 1;

      while (value["resultType"] === "input_required") {
        if (round > MCP_INPUT_ROUNDS) {
          return yield* ProtocolViolation.make({
            message: `The server asked questions for more than ${MCP_INPUT_ROUNDS} rounds`,
          });
        }

        const asked = yield* askedOf(value);

        if (asked.kind !== "asked") return yield* notMcp("its questions are malformed");

        const { answered } = yield* answerRound(asked, asking);
        const retry: Mutable<Retry> = { inputResponses: answered };

        if (asked.requestState !== undefined) retry.requestState = asked.requestState;

        value = yield* promptOnce(params, asking, retry);
        round += 1;
      }

      // SAFETY: anything but `input_required` is the result the SDK validated as a `GetPromptResult`.
      const got = value as GetPromptResult;
      const fetchedAt = yield* Clock.currentTimeMillis;

      return {
        kind: "complete",
        value: got,
        cacheable: round === 1,
        fetchedAt,
        ...Option.getOrUndefined(decodeCacheHints(got)),
      } satisfies Complete<GetPromptResult>;
    });

  /** A completion, once: a read the server may answer from its own list, which must never be sent again after a cut. */
  const complete = (
    ref: McpCompletionRef,
    argument: McpCompletionArgument,
    context: McpCompletionContext | undefined,
    ctx: McpCallContext,
  ) =>
    Effect.gen(function* () {
      if (live.capabilities.completions === undefined) {
        return yield* Unsupported.make({ message: "The server does not offer completions" });
      }

      const meta = metaFor(noDeferral(ctx));
      const sent: Mutable<CompleteRequest["params"]> = { ref, argument };

      if (context?.arguments !== undefined) sent.context = { arguments: { ...context.arguments } };

      if (meta !== undefined) sent._meta = meta;

      const timeoutMs = Math.min(
        target.timeoutMs ?? MCP_COMPLETION_TIMEOUT_MS,
        MCP_COMPLETION_TIMEOUT_MS,
      );

      // `mayHaveRun: true` is not a claim about the server: it is what stops the request being sent once more after a cut.
      const result = yield* request(
        (client, signal) => client.complete(sent, { signal, timeout: timeoutMs }),
        true,
      );

      const fetchedAt = yield* Clock.currentTimeMillis;

      return {
        kind: "complete",
        value: result,
        cacheable: false,
        fetchedAt,
      } satisfies Complete<CompleteResult>;
    });

  /**
   * The Modern listen: `subscriptions/listen`, acknowledged within `MCP_LISTEN_ACK_MS`. An era drop or a lost session
   * recovers as any request's does.
   */
  const listenModern = (filter: McpListenFilter, onEvent: (event: McpListenEvent) => void) =>
    Effect.gen(function* () {
      sinks.add(onEvent);

      const subscription = yield* request(
        (client) => client.listen(filterOf(filter), { timeout: MCP_LISTEN_ACK_MS }),
        false,
      ).pipe(Effect.tapError(() => Effect.sync(() => sinks.delete(onEvent))));

      const closed = Effect.promise(() => subscription.closed).pipe(
        Effect.tap(() => Effect.sync(() => sinks.delete(onEvent))),
      );

      return {
        honored: filterOf(subscription.honoredFilter),
        closed,
        close: Effect.promise(() => subscription.close()).pipe(
          Effect.ignore,
          Effect.tap(() => Effect.sync(() => sinks.delete(onEvent))),
        ),
      } satisfies Listening;
    });

  /**
   * The Legacy listen: the session's GET stream, which carries the list changes and the updates, and a
   * `resources/subscribe` for each URI. A server with no session, or whose GET stream is answered 405, cannot send
   * updates. The GET stream a fresh `initialize` opens is the listen's; a connection made from a session row opens it.
   */
  const listenLegacy = (filter: McpListenFilter, onEvent: (event: McpListenEvent) => void) =>
    Effect.gen(function* () {
      const cannot = Unsupported.make({ message: "The server cannot send updates" });

      if (live.sessionId === undefined) return yield* cannot;

      if (live.autoGet) {
        yield* Deferred.await(getStream.settled).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(MCP_LISTEN_ACK_MS),
            orElse: () =>
              Effect.fail(TimedOut.make({ message: "The GET stream did not open in 10 s" })),
          }),
        );
      } else if (!getStream.open) {
        const { transport } = live.client;

        if (!(transport instanceof StreamableHTTPClientTransport)) return yield* cannot;

        yield* Effect.tryPromise({
          try: () => transport.resumeStream(""),
          catch: (cause) => failure(cause).error,
        });
      }

      if (!getStream.open) return yield* cannot;

      const wanted = filter.resourceSubscriptions ?? [];
      const canSubscribe = live.capabilities.resources?.subscribe === true;
      const subscribed: Array<string> = [];

      if (canSubscribe) {
        yield* Effect.forEach(
          wanted,
          (uri) =>
            Effect.tryPromise(() =>
              live.client.subscribeResource({ uri }, { timeout: MCP_LISTEN_ACK_MS }),
            ).pipe(
              Effect.tap(() => Effect.sync(() => subscribed.push(uri))),
              Effect.ignore,
            ),
          { concurrency: 4, discard: true },
        );
      }

      const ended = Deferred.makeUnsafe<ListenEnd>();

      const finish = (end: ListenEnd) => {
        sinks.delete(onEvent);
        getStream.ends.delete(remoteEnd);
        Deferred.doneUnsafe(ended, Effect.succeed(end));
      };

      const remoteEnd = () => finish("remote");

      sinks.add(onEvent);
      getStream.ends.add(remoteEnd);

      // The stream ended while the URIs were being subscribed.
      if (!getStream.open) finish("remote");

      return {
        honored: filterOf({ ...filter, resourceSubscriptions: subscribed }),
        closed: Deferred.await(ended),
        close: Effect.gen(function* () {
          if (Deferred.isDoneUnsafe(ended)) return;

          finish("local");

          yield* Effect.forEach(
            subscribed,
            (uri) =>
              Effect.tryPromise(() =>
                live.client.unsubscribeResource(
                  { uri },
                  { timeout: NOTIFY_GRACE.pipe(Duration.toMillis) },
                ),
              ).pipe(Effect.ignore),
            { concurrency: 4, discard: true },
          ).pipe(Effect.timeoutOrElse({ duration: NOTIFY_GRACE, orElse: () => Effect.void }));
        }),
      } satisfies Listening;
    });

  const listen = (filter: McpListenFilter, onEvent: (event: McpListenEvent) => void) =>
    live.era === "modern" ? listenModern(filter, onEvent) : listenLegacy(filter, onEvent);

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
    resume,
    resend,
    listPage,
    readResource,
    getPrompt,
    complete,
    listen,
  };

  return connection;
});

/** `McpListenFilter` with a mutable list, which the SDK takes. */
interface WireFilter {
  resourceSubscriptions?: Array<string>;
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
}

/** A listen's filter as the core holds it: only the parts that are set, and the lists of the flags that are `true`. */
const filterOf = (given: {
  readonly resourceSubscriptions?: ReadonlyArray<string> | undefined;
  readonly toolsListChanged?: boolean | undefined;
  readonly promptsListChanged?: boolean | undefined;
  readonly resourcesListChanged?: boolean | undefined;
}) => {
  const filter: WireFilter = {};

  if (given.resourceSubscriptions !== undefined) {
    filter.resourceSubscriptions = [...given.resourceSubscriptions];
  }

  if (given.toolsListChanged === true) filter.toolsListChanged = true;

  if (given.promptsListChanged === true) filter.promptsListChanged = true;

  if (given.resourcesListChanged === true) filter.resourcesListChanged = true;

  return filter;
};

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
const jsonObjectOf = (
  value:
    | DiscoverResult
    | Implementation
    | ServerCapabilities
    | ClientCapabilities
    | ElicitRequestParams
    | CreateMessageRequestParams
    | undefined,
) => Option.getOrElse(toJsonObject(JSON.stringify(value ?? {})), () => ({}));

/** The pages a `-32042` lists (`ElicitRequestURLParams`): each is a question of URL mode. */
const decodeUrlElicitations = Schema.decodeUnknownOption(
  Schema.Struct({
    elicitations: Schema.NonEmptyArray(
      Schema.Struct({
        mode: Schema.Literal("url"),
        elicitationId: Schema.String,
        url: Schema.String,
        message: Schema.String,
      }),
    ),
  }),
);

/** Whether a read's answer is a Legacy server's `-32042` rather than a result. */
const isUrlRequired = (answer: ReadResourceResult | Result | UrlRequired): answer is UrlRequired =>
  answer["kind"] === "url_required";

/** A Legacy server's `-32042` and the pages it lists, when `error` is one that lists any. */
const urlRequiredOf = (error: Error): UrlRequired | undefined => {
  if (
    !(error instanceof ProtocolError) ||
    error.code !== ProtocolErrorCode.UrlElicitationRequired
  ) {
    return undefined;
  }

  return Option.match(decodeUrlElicitations(error.data), {
    onNone: () => undefined,
    onSome: ({ elicitations }) => ({
      kind: "url_required",
      message: error.message,
      elicitations: Arr.map(elicitations, (page) => ({
        elicitationId: page.elicitationId,
        page: { ...page },
      })),
    }),
  });
};

/** How many bytes `value` weighs as JSON. */
const jsonBytes = (value: Schema.Json) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

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
  declared: ClientCapabilities,
): SessionRow => {
  const instructions = client.getInstructions();

  const row: SessionRow = {
    v: 1,
    sessionId,
    protocolVersion,
    serverInfo: jsonObjectOf(client.getServerVersion()),
    capabilities: jsonObjectOf(client.getServerCapabilities()),
    initializedAt: now,
    declared: jsonObjectOf(declared),
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
