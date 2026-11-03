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
  type CallToolRequestOptions,
  type CallToolRequestParams,
  type CallToolResult,
  Client,
  type ConnectOptions,
  type ClientCapabilities,
  type DiscoverResult,
  type FetchLike,
  type Implementation,
  type JSONObject,
  type JsonSchemaValidator,
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
import { classify, type Failure } from "./failures.ts";
import { declaredCapabilities, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.ts";
import { tapFetch, Verdicts } from "./tap.ts";
import {
  Cut,
  type EraRow,
  EraRowV1,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LIST_WALK_TIMEOUT_MS,
  type McpCallContext,
  type McpError,
  ProtocolViolation,
  type SessionRow,
  SessionRowV1,
  SignInRequired,
  StepUpRequired,
  TimedOut,
  Unreachable,
} from "./types.ts";

/** The server to connect to: an HTTP server, or a stdio server through the Container bridge, by URL. */
export interface McpTarget {
  readonly url: string;
  /** The entry's headers, `${NAME}` values resolved. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The entry's `timeout` for a `tools/call` (default 60 s). */
  readonly timeoutMs?: number;
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
}

/** What `list` lists, and the items of each. */
export interface ListItems {
  readonly tools: Tool;
  readonly prompts: Prompt;
  readonly resources: Resource;
  readonly "resources/templates": ResourceTemplateType;
}

export type ListKind = keyof ListItems;

/** A request's result. Later slices add `input_required` and `task`. */
export interface Outcome<A> {
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
  /** Every page of `kind`. */
  readonly list: <K extends ListKind>(
    kind: K,
    ctx: McpCallContext,
  ) => Effect.Effect<Outcome<ReadonlyArray<ListItems[K]>>, McpError>;
  readonly callTool: (
    params: CallToolParams,
    ctx: McpCallContext,
  ) => Effect.Effect<Outcome<CallToolResult>, McpError>;
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

/** A list request's params: a cursor, and the client's declaration on Modern. */
interface PageParams {
  cursor?: string;
  _meta?: { readonly [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilities };
}

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
  const verdicts = new Verdicts();
  const auth = authState(deps, context);

  const fetch = tapFetch(
    deps.fetch,
    {
      now: () => Effect.runSyncWith(context)(Clock.currentTimeMillis),
      sleep: (ms) => Effect.sleep(Duration.millis(ms)).pipe(Effect.runPromiseWith(context)),
    },
    verdicts,
  );

  const failure = (cause: unknown, mayHaveRun = false) =>
    classify(cause, { mayHaveRun, tokenSent: auth.tokenSent(), verdicts });

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

  const newClient = () =>
    new Client(deps.clientInfo, {
      capabilities: declaredCapabilities(deps.capabilities, deps.extensions),
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      versionNegotiation: { mode: "auto", probe: { timeoutMs: CONNECT_TIMEOUT_MS, maxRetries: 0 } },
      enforceStrictCapabilities: false,
      jsonSchemaValidator: noValidation,
      inputRequired: { autoFulfill: false },
    });

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
          const options: ConnectOptions = { timeout: CONNECT_TIMEOUT_MS, signal };

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

  /** Swaps the live client for one `reopen` opens. */
  const replace = (reopen: Effect.Effect<Live, Failure>) =>
    Effect.gen(function* () {
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
  ): Effect.Effect<A, McpError> => {
    const once = Effect.suspend(() => {
      const client = live.client;

      return Effect.tryPromise({
        try: (signal) => send(client, signal),
        catch: (cause) => failure(cause, mayHaveRun),
      });
    });

    /** What brings the request back after `failed`, when the server refused it before it ran or it only reads. */
    const recovery = (failed: Failure) => {
      if (eraDropped(live, failed)) {
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
  const metaFor = (ctx: McpCallContext) =>
    live.era === "modern"
      ? {
          [CLIENT_CAPABILITIES_META_KEY]: declaredCapabilities(
            deps.capabilities,
            deps.extensions,
            ctx,
          ),
        }
      : undefined;

  const list = <K extends ListKind>(kind: K, ctx: McpCallContext) =>
    Effect.gen(function* () {
      const { capability, page: listPage } = listOf(kind);
      const fetchedAt = yield* Clock.currentTimeMillis;

      if (live.capabilities[capability] === undefined) {
        return { kind: "complete", value: [], cacheable: true, fetchedAt } satisfies Outcome<
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
      } satisfies Outcome<ReadonlyArray<ListItems[K]>>;
    }).pipe(
      Effect.timeoutOrElse({
        duration: WALK_TIMEOUT,
        orElse: () => Effect.fail(TimedOut.make({ message: `Listing ${kind} took over 120 s` })),
      }),
    );

  const callTool = (params: CallToolParams, ctx: McpCallContext) =>
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

        return client.callTool(call, options);
      }, true);

      const fetchedAt = yield* Clock.currentTimeMillis;

      return {
        kind: "complete",
        value,
        cacheable: true,
        fetchedAt,
      } satisfies Outcome<CallToolResult>;
    });

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
    list,
    callTool,
  };

  return connection;
});

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
const authState = (deps: McpDeps, context: Context.Context<never>) => {
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
            SignInRequired.make({ message: "The server requires signing in", rejected: false }),
          );
        }

        stale = true;

        return Promise.resolve();
      },
    },
  };
};
