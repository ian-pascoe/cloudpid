/**
 * What `McpEngine`'s methods do, over `@cloudpid/mcp` (`docs/architecture/mcp-connections.md` → The engine; #382 D1,
 * D9, D13.2). Each call connects from the host's `prior` rows and its hooks, does its work, and returns its result
 * with the rows it changed, encoded for RPC; it keeps nothing once it ends.
 *
 * - **Aborts:** the call races `untilAborted()`, which resolves when the caller aborts and rejects when it dies; either
 *   way the work is interrupted, which aborts the server request (a Legacy server gets `notifications/cancelled`), and
 *   the call fails as a cut, one that may have run for a `tools/call` only.
 * - **Bytes:** the call's `fetch` is metered against a lease on the isolate's byte budget, given back when the call
 *   ends however it ends, or for a large result once its stream is read (`budget.ts`, `results.ts`).
 * - **Tokens:** every token the host's `auth` hook gave the call is scrubbed from its result and from its error.
 * - **`structuredContent`** is checked against the tool's `outputSchema` (The MCP core #394 D17, refined by D9.3).
 * - **`-32020`:** a `tools/call` whose headers the server rejects lists the server's tools again and is sent once more
 *   with the fresh definition (The MCP core #394 D14). The server refused the first before running it, so the call
 *   runs at most once. The fresh tools and their schema problems, compiled as discovery compiles them, go back to the
 *   host for its catalog, whether the second send completed or failed; so do a `tools/list` request's problems.
 */
import {
  connect,
  type ListItems,
  type McpDeps,
  type ListKind,
  type McpConnection,
  type McpConnectionStats,
  type McpTarget,
} from "@cloudpid/mcp";
import {
  Cut,
  MCP_CLIENT_CREDENTIALS_CAPABILITY,
  MCP_CLIENT_CREDENTIALS_EXTENSION,
  type McpCallContext,
  type McpEngineCompleted,
  McpEngineDiscoverResult,
  McpEngineListenResult,
  McpListenFilter,
  type McpListenEvent,
  type McpEngineDiscovered,
  type McpEngineFailed,
  type McpEngineHooks,
  McpEnginePrior,
  type McpEnginePriorEncoded,
  McpEngineRequest,
  type McpEngineRequestEncoded,
  McpEngineRequestResult,
  type McpEngineInputRequired,
  type McpEnginePagesRequired,
  type McpEngineTaskAck,
  type McpEngineTaskStarted,
  type McpEngineTaskState,
  type McpEngineState,
  type McpEngineHttpTarget,
  McpEngineTarget,
  type McpEngineTargetEncoded,
  EraRowV1,
  type McpError,
  type McpErrorWire,
  type McpLogEntry,
  McpToolDefinition,
  type McpStructuredOutput,
  type McpToolProblem,
  ServerError,
  Unsupported,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { Mutable } from "effect/Types";
import { stdioBridge, type StdioBridge, STDIO_CONNECT_TIMEOUT_MS, STDIO_URL } from "./bridge.ts";
import { type ByteBudget } from "./budget.ts";
import { type CallContext, type CallEnvironment, withCall } from "./call-context.ts";
import { secretsOf } from "./logs.ts";
import { type Answer, malformed, scrubError, toEngineValue } from "./results.ts";
import { promptsLeftOut, scrubRaw, scrubValues, toolsLeftOut, vetListed } from "./scrub.ts";
import { Validators, type ValidatorsApi } from "./validators.ts";

/** Discovery, and the tools listed again after a `-32020`, are the host's own work (The MCP core #394 D7). */
const HOST_WORK: McpCallContext = { origin: "host" };

/** Each list `request` walks, by the core's kind. */
const LIST_KINDS = {
  "tools/list": "tools",
  "prompts/list": "prompts",
  "resources/list": "resources",
  "resources/templates/list": "resources/templates",
} as const satisfies Record<string, ListKind>;

/** One engine call: where it goes, the host's rows and hooks, the Worker around it, and whether it may run anything. */
interface CallInput {
  readonly target: McpEngineTargetEncoded;
  readonly prior: McpEnginePriorEncoded;
  readonly hooks: McpEngineHooks;
  readonly env: CallEnvironment;
  /** Whether the server may have run the request once it was sent: only a `tools/call`. */
  readonly mayHaveRun: boolean;
  /** A listen: through the bridge, no request is a use of the Container or starts it. */
  readonly quiet?: boolean;
}

/**
 * `deps` declaring the extensions the host named for the call's connection, the ones this engine knows (OAuth Client
 * Credentials, `docs/architecture/mcp.md` → Extensions) and no other: a third party's extension is never declared, and a
 * connection the host named none for declares none.
 */
const withExtensions = (deps: McpDeps, named: McpEngineHttpTarget["extensions"]): McpDeps => {
  const known = named?.[MCP_CLIENT_CREDENTIALS_EXTENSION];

  return known === undefined
    ? deps
    : {
        ...deps,
        extensions: { [MCP_CLIENT_CREDENTIALS_EXTENSION]: MCP_CLIENT_CREDENTIALS_CAPABILITY },
      };
};

/**
 * `deps` that also declare `sampling: { tools: {} }`, only when the host's target says the definition lets it, for an HTTP server or a stdio one
 * (`docs/architecture/mcp-server-requests.md` → Questions). A Legacy server is told once,
 * connection-wide, at `initialize`; a Legacy session that was initialized with another declaration is initialized again,
 * once. A Modern request declares it per request, in its `_meta`, only for a call whose caller offers to answer a Sampling
 * request (`ctx.answers.sampling`) and has an `onInput` to answer with; the round's request is answered by `onInput` (run,
 * or kept for later when the call also defers). The ctx-less declaration (a Modern `server/discover` probe) is Legacy's,
 * which a Modern server never acts on.
 */
const withSampling = (deps: McpDeps, server: McpEngineTarget): McpDeps => {
  if (server.sampling !== true) return deps;

  return {
    ...deps,
    capabilities: (ctx) => {
      const base = deps.capabilities(ctx);

      if (ctx === undefined) return { ...base, sampling: { tools: {} } };

      return ctx.answers?.sampling === true && deps.onInput !== undefined
        ? { ...base, sampling: { tools: {} } }
        : base;
    },
  };
};

const cutOnceAborted = (untilAborted: () => Promise<void>, mayHaveRun: boolean) =>
  Effect.tryPromise(() => untilAborted()).pipe(
    Effect.ignore,
    Effect.andThen(
      Cut.make({
        message: mayHaveRun
          ? "The caller cancelled the request; it may or may not have run"
          : "The caller cancelled the request",
        mayHaveRun,
      }),
    ),
  );

/**
 * Fails as a cut once the caller aborts the call or dies, whichever comes first (#409 answer 2). A call with no
 * `untilAborted` (the host's background discovery) is never cut by its caller: it runs to its own bounds.
 */
const abortedBy = (hooks: McpEngineHooks, mayHaveRun: boolean) => {
  const { untilAborted } = hooks;

  return untilAborted === undefined ? Effect.never : cutOnceAborted(untilAborted, mayHaveRun);
};

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpToolDefinition));

const decodePrompts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Record(Schema.String, Schema.Json)),
);

const decodeAbout = Schema.decodeUnknownEffect(
  Schema.Struct({
    serverInfo: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    capabilities: Schema.Record(Schema.String, Schema.Json),
  }),
);

/** Tools as the SDK listed them, as the definitions the host keeps. */
const definitionsOf = (tools: Answer) =>
  decodeTools(tools).pipe(Effect.mapError(() => malformed("a tool definition")));

const decodeEraRow = Schema.decodeUnknownOption(EraRowV1);

/**
 * Reaches a stdio target through the Workspaces Worker's bridge, offering the server the Roots the target carries (none
 * given, an empty list: a bridge connection always declares `roots`); an HTTP target is reached as it is, with none.
 */
const reachBridge = Effect.fnUntraced(function* (
  server: McpEngineTarget,
  era: Schema.Json | undefined,
  env: CallEnvironment,
  call: CallContext,
  quiet = false,
) {
  if (server.kind !== "stdio") return undefined;

  const { bridge } = env;

  if (bridge === undefined) {
    return yield* Unsupported.make({ message: "This engine has no way to reach a Container" });
  }

  const hint = Option.map(decodeEraRow(era), (row) => row.era);
  const scrub = (text: string) => scrubRaw(text, call.tokens);
  const through = stdioBridge(bridge, server, Option.getOrUndefined(hint), scrub, quiet);

  call.routeVia(through.fetch, server.roots ?? []);

  return through;
});

/** What the core connects to: an HTTP server's URL and headers, or the bridge's, whose connects may start a Container. */
const connectTarget = (server: McpEngineTarget): McpTarget => {
  const target: Mutable<McpTarget> =
    server.kind === "http"
      ? { url: server.url, name: server.name }
      : { url: STDIO_URL, name: server.name, connectTimeoutMs: STDIO_CONNECT_TIMEOUT_MS };

  if (server.kind === "http" && server.headers !== undefined) target.headers = server.headers;

  if (server.timeoutMs !== undefined) target.timeoutMs = server.timeoutMs;

  return target;
};

/**
 * `error`, named from the bridge's status if it is a cut of a stdio call (a `tools/call` hands its failure back as a
 * result, so it comes here too); as it was for an HTTP server.
 */
const named = (bridge: StdioBridge | undefined, error: McpError) =>
  bridge === undefined || !Predicate.isTagged(error, "Cut")
    ? Effect.succeed(error)
    : Effect.promise(() => bridge.explainCut(error));

/**
 * Runs `work` over a new connection to the call's target, racing the caller's abort: the outcome, its error scrubbed
 * of the call's tokens, and the rows the call changed. The call's lease goes back when it ends, however it ends,
 * unless it succeeded with a stream, which holds the lease until it is read (`call-context.ts`, `withCall`).
 */
const runCall = Effect.fnUntraced(function* <A, R>(
  input: CallInput,
  work: (
    connection: McpConnection,
    call: CallContext,
    bridge: StdioBridge | undefined,
  ) => Effect.Effect<A, McpError, R | Scope.Scope>,
) {
  // A row this engine cannot read is absent: it probes or initializes again.
  const rows: McpEnginePrior = yield* Schema.decodeEffect(McpEnginePrior)(input.prior).pipe(
    Effect.orElseSucceed((): McpEnginePrior => ({})),
  );

  return yield* withCall(
    rows,
    input.hooks,
    input.env,
    (call) =>
      Effect.gen(function* () {
        let wire: (() => McpConnectionStats) | undefined;
        let bridge: StdioBridge | undefined;

        const outcome = yield* Schema.decodeEffect(McpEngineTarget)(input.target).pipe(
          Effect.mapError(() =>
            Unsupported.make({ message: "This engine cannot reach that kind of server" }),
          ),
          Effect.flatMap((server) =>
            Effect.gen(function* () {
              bridge = yield* reachBridge(server, rows.era, input.env, call, input.quiet === true);

              const connection = yield* connect(
                connectTarget(server),
                withSampling(
                  withExtensions(call.deps, server.kind === "http" ? server.extensions : undefined),
                  server,
                ),
              );

              wire = connection.stats;

              return yield* work(connection, call, bridge);
            }).pipe(
              // A cut of a stdio call is named from the bridge's status, whichever step it came in.
              Effect.catchTag("Cut", (cut) => Effect.flatMap(named(bridge, cut), Effect.fail)),
            ),
          ),
          Effect.scoped,
          Effect.raceFirst(abortedBy(input.hooks, input.mayHaveRun)),
          Effect.result,
        );

        const logs = call.logs();

        yield* annotateWire(input.target, wire?.(), call.bytes(), logs.length);

        // The rows the host will keep hold what the server said of itself (`serverInfo`, `instructions`), which it may have
        // made of a header it was sent: they are scrubbed in their string values as the result is.
        const state = scrubValues(call.state(), call.tokens);

        const spawn = bridge?.spawn();

        if (Result.isSuccess(outcome)) {
          return { outcome, state, logs, spawn };
        }

        // A stream made before the call failed is never returned, so its lease goes back now.
        call.lease.release();

        return {
          outcome: Result.fail(yield* scrubError(outcome.failure, call.tokens)),
          state,
          logs,
          spawn,
        };
      }),
    // A server may echo a header it was sent (a Secret's value) into a log, an error or a result; all are scrubbed of them.
    secretsOf(input.target),
  );
});

/**
 * The call's span, with what the call did on the wire (`docs/architecture/mcp-connections.md` → Telemetry): counts and
 * one status, the server's name and its origin (scheme and host), never a path, header, argument, result or token.
 */
type WireAttributes = {
  "mcp.server": string;
  "mcp.bytes": number;
  "mcp.logs": number;
  "mcp.server.origin"?: string;
  "mcp.http.responses"?: number;
  "mcp.http.retries"?: number;
  "mcp.era_drops"?: number;
  "mcp.reinitializes"?: number;
  "mcp.http.status"?: number;
};

const annotateWire = (
  target: McpEngineTargetEncoded,
  wire: McpConnectionStats | undefined,
  bytes: number,
  logs: number,
) => {
  const attributes: WireAttributes = {
    "mcp.server": target.name,
    "mcp.bytes": bytes,
    "mcp.logs": logs,
  };

  // A stdio server has no origin: it runs in a Container, which a span never names.
  if (target.kind === "http") {
    Option.map(originOf(target.url), (origin) => {
      attributes["mcp.server.origin"] = origin;
    });
  }

  if (wire !== undefined) {
    attributes["mcp.http.responses"] = wire.responses;
    attributes["mcp.http.retries"] = wire.retries;
    attributes["mcp.era_drops"] = wire.eraDrops;
    attributes["mcp.reinitializes"] = wire.reinitializes;

    if (wire.lastStatus !== undefined) attributes["mcp.http.status"] = wire.lastStatus;
  }

  return Effect.annotateCurrentSpan(attributes);
};

/** The server's origin, scheme and host only: a URL's path and query may carry what a span must not. */
const originOf = (url: string) =>
  Option.map(
    Option.liftThrowable(() => new URL(url))(),
    ({ protocol, host }) => `${protocol}//${host}`,
  );

/** `logs` as the result's gain-only field: absent when the call heard none. */
const logsField = (logs: ReadonlyArray<McpLogEntry>) => (logs.length === 0 ? {} : { logs });

/** `spawn` as the result's gain-only field: absent for an HTTP server. */
const spawnField = (spawn: string | undefined) => (spawn === undefined ? {} : { spawn });

const failed = (error: McpErrorWire, state: McpEngineState): McpEngineFailed => ({
  kind: "failed",
  error,
  state,
});

/** `result` encoded for RPC; one that cannot be encoded (a server's odd value) fails as not MCP. */
const encodeResult = <A extends { readonly state: McpEngineState }, I>(
  schema: Schema.Codec<A | McpEngineFailed, I>,
  result: A | McpEngineFailed,
) =>
  Schema.encodeEffect(schema)(result).pipe(
    Effect.catch(() => Schema.encodeEffect(schema)(failed(malformed("its answer"), result.state))),
    Effect.orDie,
  );

/** The items of a list, as the SDK listed them. */
type Listed = ReadonlyArray<ListItems[ListKind]>;

/**
 * A tools list as the engine hands it back (`scrub.ts`): the items a call may keep, scrubbed in their string values, and
 * their definitions and schema problems; with the problem of each item left out for a secret in its name or a key.
 */
const vettedTools = Effect.fnUntraced(function* (
  listed: Listed,
  validators: ValidatorsApi,
  tokens: ReadonlySet<string>,
) {
  const vetted = vetListed("tool", listed, tokens);
  const tools = yield* definitionsOf(vetted.kept);

  return {
    kept: vetted.kept,
    tools,
    problems: scrubValues(
      [...toolsLeftOut(vetted.left), ...(yield* validators.compileAll(tools))],
      tokens,
    ),
  };
});

/** Discovers the server: its era, what it is, every page of its tools and prompts, and its tools' schema problems. */
export const discover = Effect.fn("mcp.engine.discover")(function* (
  target: McpEngineTargetEncoded,
  prior: McpEnginePriorEncoded,
  hooks: McpEngineHooks,
  env: CallEnvironment,
) {
  const validators = yield* Validators;

  const { outcome, state, logs, spawn } = yield* runCall(
    { target, prior, hooks, env, mayHaveRun: false },
    (connection, call) =>
      Effect.gen(function* () {
        const tools = yield* connection.list("tools", HOST_WORK);
        const prompts = yield* connection.list("prompts", HOST_WORK);

        const promptsListed = yield* decodePrompts(prompts.value).pipe(
          Effect.mapError(() => malformed("a prompt")),
        );

        // What a server tells of itself is scrubbed in its string values only; a tool or prompt that holds a secret in a name
        // or a key is left out, since neither is ever rewritten (`scrub.ts`).
        const listedTools = yield* vettedTools(tools.value, validators, call.tokens);
        const vettedPrompts = vetListed("prompt", promptsListed, call.tokens);

        const about = scrubValues(
          yield* decodeAbout({
            serverInfo: connection.serverInfo,
            capabilities: connection.capabilities,
          }).pipe(Effect.mapError(() => malformed("its description"))),
          call.tokens,
        );

        const discovered: Mutable<Omit<McpEngineDiscovered, "state">> = {
          kind: "discovered",
          era: connection.era,
          protocolVersion: connection.protocolVersion,
          ...about,
          tools: listedTools.tools,
          prompts: vettedPrompts.kept,
          problems: listedTools.problems,
          fetchedAt: tools.fetchedAt,
        };

        if (vettedPrompts.left.length > 0) {
          discovered.promptProblems = promptsLeftOut(vettedPrompts.left);
        }

        if (connection.instructions !== undefined) {
          discovered.instructions = scrubRaw(connection.instructions, call.tokens);
        }

        if (tools.ttlMs !== undefined) {
          discovered.ttlMs = tools.ttlMs;
        }

        return discovered;
      }),
  );

  return yield* encodeResult(McpEngineDiscoverResult, {
    ...(Result.isSuccess(outcome) ? outcome.success : failed(outcome.failure, state)),
    ...logsField(logs),
    ...spawnField(spawn),
    state,
  });
});

const isServerError = Schema.is(ServerError);

/** The server rejected the call's `Mcp-Param` headers: its tool's definition has changed (D14). */
const headerMismatch = (error: McpError) => isServerError(error) && error.code === -32020;

const toolNamed = (tools: ReadonlyArray<McpToolDefinition>, name: string) =>
  Arr.findFirst(tools, (tool) => tool.name === name);

type ToolCall = McpEngineRequest & { readonly op: "tools/call" };

type Resume = McpEngineRequest & { readonly op: "resume" };

type Resend = McpEngineRequest & { readonly op: "resend" };

type ResourceRead = McpEngineRequest & { readonly op: "resources/read" };

type ResourcePage = McpEngineRequest & {
  readonly op: "resources/list_page" | "resources/templates/list_page";
};

type PromptGet = McpEngineRequest & { readonly op: "prompts/get" };

type Completion = McpEngineRequest & { readonly op: "completion/complete" };

/** The server's tools, listed again after a `-32020`, and their schema problems. */
interface Refreshed {
  readonly tools: ReadonlyArray<McpToolDefinition>;
  readonly problems: ReadonlyArray<McpToolProblem>;
}

/**
 * Sends `req`; if the server rejects its headers (`-32020`), lists the server's tools again, compiles them as discovery
 * does, and sends it once more with the tool's fresh definition (D14). What the last send gave, the definition it
 * was sent with, and the fresh tools, if they were listed.
 */
const callWithRefresh = Effect.fnUntraced(function* (
  connection: McpConnection,
  req: ToolCall,
  validators: ValidatorsApi,
  tokens: ReadonlySet<string>,
) {
  const send = (tool: McpToolDefinition) =>
    connection
      .callTool(
        // SAFETY: a definition the server listed, decoded as one; the SDK reads it as its `Tool`.
        {
          tool: tool as Parameters<McpConnection["callTool"]>[0]["tool"],
          arguments: req.arguments ?? {},
        },
        req.ctx,
      )
      .pipe(Effect.result);

  const first = yield* send(req.tool);

  if (Result.isSuccess(first) || !headerMismatch(first.failure)) {
    return { sent: first, tool: req.tool, refreshed: Option.none<Refreshed>() };
  }

  const listed = yield* connection.list("tools", HOST_WORK);
  const { tools, problems } = yield* vettedTools(listed.value, validators, tokens);
  const refreshed = Option.some<Refreshed>({ tools, problems });

  const fresh = toolNamed(tools, req.tool.name);

  if (Option.isNone(fresh)) {
    return { sent: first, tool: req.tool, refreshed };
  }

  return { sent: yield* send(fresh.value), tool: fresh.value, refreshed };
});

type Completed = Omit<McpEngineCompleted, "state">;

/** A request's result before its rows are added. */
type RequestOutcome =
  | Completed
  | Omit<McpEngineFailed, "state">
  | Omit<McpEngineTaskStarted, "state">
  | Omit<McpEngineTaskState, "state">
  | Omit<McpEngineTaskAck, "state">
  | Omit<McpEngineInputRequired, "state">
  | Omit<McpEnginePagesRequired, "state">;

/** Runs a `tools/call`, checking its `structuredContent`. */
const runToolCall = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: ToolCall,
  env: CallEnvironment,
  validators: ValidatorsApi,
  bridge: StdioBridge | undefined,
) {
  const { sent, tool, refreshed } = yield* callWithRefresh(
    connection,
    req,
    validators,
    call.tokens,
  );

  return yield* callAnswer(
    sent,
    tool,
    Option.getOrElse(refreshed, () => ({})),
    {
      call,
      env,
      validators,
      bridge,
    },
  );
});

/**
 * Sends a `tools/call` that answered `input_required` again from its `ResumeState`, with the answers: answered as a
 * `tools/call` is (`docs/architecture/mcp-server-requests.md` → Questions).
 */
const runResume = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: Resume,
  env: CallEnvironment,
  validators: ValidatorsApi,
  bridge: StdioBridge | undefined,
) {
  const sent = yield* connection
    .resume(
      req.resume,
      req.answers,
      // SAFETY: a definition the server listed, decoded as one; the SDK reads it as its `Tool`.
      req.tool as Parameters<McpConnection["resume"]>[2],
      req.ctx,
    )
    .pipe(Effect.result);

  return yield* callAnswer(sent, req.tool, {}, { call, env, validators, bridge });
});

/**
 * Sends a `tools/call` that answered `pages_required` (a Legacy `-32042`) again from its `ResendState`, with an answer
 * for each page: answered as a `tools/call` is.
 */
const runResend = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: Resend,
  env: CallEnvironment,
  validators: ValidatorsApi,
  bridge: StdioBridge | undefined,
) {
  const sent = yield* connection
    .resend(
      req.resend,
      req.answers,
      // SAFETY: a definition the server listed, decoded as one; the SDK reads it as its `Tool`.
      req.tool as Parameters<McpConnection["resend"]>[2],
      req.ctx,
    )
    .pipe(Effect.result);

  return yield* callAnswer(sent, req.tool, {}, { call, env, validators, bridge });
});

/** What a call's answer is made with besides itself. */
interface Answering {
  readonly call: CallContext;
  readonly env: CallEnvironment;
  readonly validators: ValidatorsApi;
  readonly bridge: StdioBridge | undefined;
}

/**
 * What a `tools/call` (or its `resume`) answers: its failure, the task it started, the questions its caller deferred,
 * or its result with its `structuredContent` checked. What the server says of a task or a question is scrubbed as a
 * result is; the `ResumeState` goes back as the core made it, the server's `requestState` byte for byte.
 */
const callAnswer = Effect.fnUntraced(function* (
  sent: Result.Result<Effect.Success<ReturnType<McpConnection["callTool"]>>, McpError>,
  tool: McpToolDefinition,
  extras: Partial<Refreshed>,
  { call, env, validators, bridge }: Answering,
) {
  if (Result.isFailure(sent)) {
    return {
      kind: "failed",
      error: yield* scrubError(yield* named(bridge, sent.failure), call.tokens),
      ...extras,
    } satisfies RequestOutcome;
  }

  // A task is what a call with `ctx.allowTask` may be answered with, and only such a call is (the core declares the
  // extension for no other).
  if (sent.success.kind === "task") {
    return {
      kind: "task",
      task: scrubValues(sent.success.task, call.tokens),
      ...extras,
    } satisfies RequestOutcome;
  }

  // A `-32042` is what a call with `ctx.answers.pages` may be answered with, and only such a call is.
  if (sent.success.kind === "pages_required") {
    const pages: Mutable<Omit<McpEnginePagesRequired, "state">> = {
      kind: "pages_required",
      requests: scrubValues(sent.success.requests, call.tokens),
      message: sent.success.message,
      ...extras,
    };

    if (sent.success.resend !== undefined) pages.resend = sent.success.resend;

    return pages satisfies RequestOutcome;
  }

  // Questions are what a call with `ctx.answers.defer` may be answered with, and only such a call is.
  if (sent.success.kind === "input_required") {
    return {
      kind: "input_required",
      requests: scrubValues(sent.success.requests, call.tokens),
      resume: sent.success.resume,
      ...extras,
    } satisfies RequestOutcome;
  }

  const { value, kind: _kind, ...meta } = sent.success;

  // Checked before the value is serialized, so the stream a large one becomes, which takes the call's lease, is made
  // last and never left behind by an abort during the check.
  const structuredOutput =
    tool.outputSchema !== undefined && value.isError !== true
      ? Option.some(yield* validators.check(tool.outputSchema, value.structuredContent))
      : Option.none<McpStructuredOutput>();

  const completed: Mutable<Completed> = {
    kind: "complete",
    ...meta,
    ...extras,
    result: yield* toEngineValue(value, call, env),
  };

  Option.map(structuredOutput, (checked) => {
    completed.structuredOutput = checked;
  });

  return completed;
});

type TaskOp = Extract<
  McpEngineRequest,
  { readonly op: "tasks/get" | "tasks/update" | "tasks/cancel" }
>;

/** Whether `req` is for an MCP task: its `op`s share the `tasks/` prefix. */
const isTaskRequest = (req: McpEngineRequest): req is TaskOp => req.op.startsWith("tasks/");

/**
 * Runs a `tasks/*` request on the connection's task wire. A completed task's result is checked against the tool's
 * `outputSchema` and serialized as any result is, so a large one is a stream; what the server says of the task (its
 * status message, its error, its questions) is scrubbed of the call's tokens.
 */
const runTaskOp = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: TaskOp,
  env: CallEnvironment,
  validators: ValidatorsApi,
) {
  if (req.op === "tasks/update") {
    yield* connection.task.update(req.taskId, req.inputResponses, req.ctx);

    return { kind: "task_ack" } satisfies RequestOutcome;
  }

  if (req.op === "tasks/cancel") {
    yield* connection.task.cancel(req.taskId, req.ctx);

    return { kind: "task_ack" } satisfies RequestOutcome;
  }

  const { task, result, fetchedAt } = yield* connection.task.get(req.taskId, req.ctx);

  const state: Mutable<Omit<McpEngineTaskState, "state">> = {
    kind: "task_state",
    task: scrubValues(task, call.tokens),
    fetchedAt,
  };

  if (result === undefined) return state satisfies RequestOutcome;

  const outputSchema = req.tool?.outputSchema;

  if (outputSchema !== undefined && result.isError !== true) {
    state.structuredOutput = yield* validators.check(outputSchema, result.structuredContent);
  }

  state.result = yield* toEngineValue(result, call, env);

  return state satisfies RequestOutcome;
});

/** Runs a `resources/read`: the server's result as it is, its strings scrubbed of the call's tokens on the way out. */
const runRead = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: ResourceRead,
  env: CallEnvironment,
) {
  const read = yield* connection.readResource(req.uri, req.ctx, { app: req.app === true });

  // A Legacy server's `-32042`: the pages, scrubbed of the call's tokens; the caller sends the read again.
  if (read.kind === "pages_required") {
    return {
      kind: "pages_required",
      requests: scrubValues(read.requests, call.tokens),
      message: read.message,
    } satisfies RequestOutcome;
  }

  const { value, kind: _kind, ...meta } = read;

  return {
    kind: "complete",
    ...meta,
    result: yield* toEngineValue(value, call, env),
  } satisfies Completed;
});

/**
 * Runs one page of `resources/list` or `resources/templates/list`: the server's own result shape, `{ resources |
 * resourceTemplates, nextCursor? }`, its strings scrubbed of the call's tokens on the way out.
 */
const runResourcePage = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: ResourcePage,
  env: CallEnvironment,
) {
  const templates = req.op === "resources/templates/list_page";

  const {
    value,
    kind: _kind,
    ...meta
  } = yield* connection.listPage(
    templates ? "resources/templates" : "resources",
    req.cursor,
    req.ctx,
  );

  const items = [...value.items];
  const listed = templates ? { resourceTemplates: items } : { resources: items };

  const page =
    value.nextCursor === undefined ? listed : { ...listed, nextCursor: value.nextCursor };

  return {
    kind: "complete",
    ...meta,
    result: yield* toEngineValue(page, call, env),
  } satisfies Completed;
});

/**
 * Runs a `prompts/get`: the server's result as it is, its strings scrubbed of the call's tokens on the way out. The
 * core answers the server's questions during it through `req.ctx` (#492), as a read's.
 */
const runPrompt = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: PromptGet,
  env: CallEnvironment,
) {
  const {
    value,
    kind: _kind,
    ...meta
  } = yield* connection.getPrompt(req.name, req.arguments, req.ctx);

  return {
    kind: "complete",
    ...meta,
    result: yield* toEngineValue(value, call, env),
  } satisfies Completed;
});

/**
 * Runs a `completion/complete`: the server's `CompleteResult` as it is, its strings scrubbed of the call's tokens on the way
 * out. The core asks no question of the owner during it, and never sends it again after a cut.
 */
const runCompletion = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: Completion,
  env: CallEnvironment,
) {
  const {
    value,
    kind: _kind,
    ...meta
  } = yield* connection.complete(req.ref, req.argument, req.context, req.ctx);

  return {
    kind: "complete",
    ...meta,
    result: yield* toEngineValue(value, call, env),
  } satisfies Completed;
});

/** Walks a list to its end; a `tools/list` also brings its tools' schema problems. */
const runList = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: Exclude<
    McpEngineRequest,
    ToolCall | TaskOp | ResourceRead | ResourcePage | PromptGet | Completion | Resume | Resend
  >,
  env: CallEnvironment,
  validators: ValidatorsApi,
) {
  const { value, kind: _kind, ...meta } = yield* connection.list(LIST_KINDS[req.op], req.ctx);

  // A tool or a prompt that holds a secret in a name or a key is left out of what goes back, as a discovery leaves it out.
  const tools =
    req.op === "tools/list"
      ? Option.some(yield* vettedTools(value, validators, call.tokens))
      : Option.none();

  const prompts =
    req.op === "prompts/list"
      ? Option.some(vetListed("prompt", value, call.tokens))
      : Option.none();

  const problems = Option.map(tools, (listed) => listed.problems);

  const completed: Mutable<Completed> = {
    kind: "complete",
    ...meta,
    result: yield* toEngineValue(
      Option.match(tools, {
        onNone: () =>
          Option.match(prompts, { onNone: () => value, onSome: (vetted) => vetted.kept }),
        onSome: (listed) => listed.kept,
      }),
      call,
      env,
    ),
  };

  Option.map(prompts, (vetted) => {
    if (vetted.left.length > 0) completed.promptProblems = promptsLeftOut(vetted.left);
  });

  Option.map(problems, (listed) => {
    completed.problems = listed;
  });

  return completed;
});

/**
 * Runs one request: a `tools/call`, a `tasks/*` request on the MCP task wire, a `resources/read`, one page of a resource
 * list, a `prompts/get`, a `completion/complete`, or a list walked to its end. An `op` this engine does not know is `Unsupported`.
 */
export const request = Effect.fn("mcp.engine.request")(function* (
  target: McpEngineTargetEncoded,
  prior: McpEnginePriorEncoded,
  input: McpEngineRequestEncoded,
  hooks: McpEngineHooks,
  env: CallEnvironment,
) {
  const validators = yield* Validators;
  const decoded = yield* Schema.decodeEffect(McpEngineRequest)(input).pipe(Effect.option);

  if (Option.isNone(decoded)) {
    return yield* encodeResult(
      McpEngineRequestResult,
      failed(Unsupported.make({ message: "This engine does not run that request" }), {}),
    );
  }

  const req = decoded.value;

  const { outcome, state, logs, spawn } = yield* runCall(
    // A call, an update and a cancel may have run when the caller aborts; a `tasks/get` and a list only read.
    {
      target,
      prior,
      hooks,
      env,
      mayHaveRun:
        req.op === "tools/call" ||
        req.op === "resume" ||
        req.op === "resend" ||
        (isTaskRequest(req) && req.op !== "tasks/get"),
    },
    (connection, context, bridge): Effect.Effect<RequestOutcome, McpError, Scope.Scope> => {
      if (req.op === "tools/call") {
        return runToolCall(connection, context, req, env, validators, bridge);
      }

      if (req.op === "resume") return runResume(connection, context, req, env, validators, bridge);

      if (req.op === "resend") return runResend(connection, context, req, env, validators, bridge);

      if (isTaskRequest(req)) return runTaskOp(connection, context, req, env, validators);

      if (req.op === "resources/read") return runRead(connection, context, req, env);

      if (req.op === "prompts/get") return runPrompt(connection, context, req, env);

      if (req.op === "completion/complete") return runCompletion(connection, context, req, env);

      return req.op === "resources/list_page" || req.op === "resources/templates/list_page"
        ? runResourcePage(connection, context, req, env)
        : runList(connection, context, req, env, validators);
    },
  );

  const result = Result.isSuccess(outcome) ? outcome.success : failed(outcome.failure, state);

  return yield* encodeResult(McpEngineRequestResult, {
    ...result,
    ...logsField(logs),
    ...spawnField(spawn),
    state,
  });
});

/** How often a listen writes a `ping` line: the RPC notices a host that cancelled the events, or died, at the next write. */
const LISTEN_PING_MS = 30_000;

/** What a listen's event stream may hold unread before the host is taken to have stopped reading: its listen ends. */
const LISTEN_BACKLOG = 1_000;

const encoder = new TextEncoder();

/**
 * Opens one listen (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions → Listens): connects, opens the
 * core's listen, and answers once the server acknowledged, with what it honors and the events as newline-delimited JSON on
 * a native stream. The connection is kept, under `ctx.waitUntil`, for as long as the stream lives: it ends when the host
 * cancels the stream (or its RPC dies), or when the server ends the listen, which is the stream's last line (`closed`).
 * A failure before the acknowledgement is the answer, as any call's; nothing is held then. A listen is quiet at the
 * bridge: no request of it is a use of the Container or starts it. It takes no part in the byte budget beyond the few
 * bytes of its acknowledgement, since a listen's events are small and capped by the core.
 */
export const listen = Effect.fn("mcp.engine.listen")(function* (
  target: McpEngineTargetEncoded,
  prior: McpEnginePriorEncoded,
  input: typeof McpListenFilter.Encoded,
  hooks: McpEngineHooks,
  env: CallEnvironment,
  stop?: ReadableStream<Uint8Array>,
) {
  const decoded = yield* Schema.decodeEffect(McpListenFilter)(input).pipe(Effect.option);

  if (Option.isNone(decoded)) {
    return yield* encodeResult(
      McpEngineListenResult,
      failed(Unsupported.make({ message: "This engine does not run that listen" }), {}),
    );
  }

  const filter = decoded.value;
  const context = yield* Effect.context<ByteBudget>();
  const answered = Deferred.makeUnsafe<typeof McpEngineListenResult.Encoded>();

  const lifetime = runCall(
    { target, prior, hooks, env, mayHaveRun: false, quiet: true },
    (connection, call, bridge): Effect.Effect<void, McpError, Scope.Scope> =>
      Effect.gen(function* () {
        const stopped = Deferred.makeUnsafe<"local">();
        let over = false;
        let sink: ReadableStreamDefaultController<Uint8Array> | undefined;

        const events = new ReadableStream<Uint8Array>({
          start: (controller) => {
            sink = controller;
          },
          cancel: () => {
            over = true;
            Deferred.doneUnsafe(stopped, Effect.succeed("local" as const));
          },
        });

        const send = (event: McpListenEvent) => {
          if (over) return;

          try {
            sink?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            over = true;

            return;
          }

          // A host that has stopped reading is taken to be gone.
          if ((sink?.desiredSize ?? 0) < -LISTEN_BACKLOG) {
            over = true;
            Deferred.doneUnsafe(stopped, Effect.succeed("local" as const));
          }
        };

        const listening = yield* connection.listen(filter, (event) => {
          send(scrubValues(event, call.tokens));
        });

        // The host ends the listen by closing `stop`, which reaches here at once; one that dies ends it too. (Cancelling
        // the events is seen only when a line is next written, so the engine writes a `ping` every `LISTEN_PING_MS`.)
        if (stop !== undefined) {
          const reader = stop.getReader();

          const ended = () => {
            Deferred.doneUnsafe(stopped, Effect.succeed("local" as const));
          };

          void reader.read().then(ended, ended);
        }

        const pinging = yield* Effect.sleep(Duration.millis(LISTEN_PING_MS)).pipe(
          Effect.andThen(Effect.sync(() => send({ kind: "ping" }))),
          Effect.forever,
          Effect.forkScoped,
        );

        const spawn = bridge?.spawn();

        const result = yield* encodeResult(McpEngineListenResult, {
          kind: "listening",
          honored: listening.honored,
          events,
          era: connection.era,
          ...spawnField(spawn),
          state: scrubValues(call.state(), call.tokens),
        });

        Deferred.doneUnsafe(answered, Effect.succeed(result));

        const end = yield* Effect.raceFirst(listening.closed, Deferred.await(stopped));

        if (end !== "local") send({ kind: "closed", cause: end });

        // The stream ends with the listen, whoever ended it.
        if (!over) {
          over = true;
          sink?.close();
        }

        yield* Fiber.interrupt(pinging);
        yield* listening.close;
      }),
  ).pipe(
    Effect.flatMap(({ outcome, state, logs, spawn }) =>
      Result.isSuccess(outcome) || Deferred.isDoneUnsafe(answered)
        ? Effect.void
        : encodeResult(McpEngineListenResult, {
            ...failed(outcome.failure, state),
            ...logsField(logs),
            ...spawnField(spawn),
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => Deferred.doneUnsafe(answered, Effect.succeed(result))),
            ),
            Effect.asVoid,
          ),
    ),
  );

  // The connection outlives this call: it is held for as long as its events are read.
  env.hold(
    Effect.runPromiseWith(context)(lifetime).then(
      () => undefined,
      () => undefined,
    ),
  );

  return yield* Deferred.await(answered);
});
