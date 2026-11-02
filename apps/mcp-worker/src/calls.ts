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
import { connect, type ListKind, type McpConnection } from "@cloudpid/mcp";
import {
  Cut,
  type McpCallContext,
  type McpEngineCompleted,
  McpEngineDiscoverResult,
  type McpEngineDiscovered,
  type McpEngineFailed,
  type McpEngineHooks,
  McpEnginePrior,
  type McpEnginePriorEncoded,
  McpEngineRequest,
  type McpEngineRequestEncoded,
  McpEngineRequestResult,
  type McpEngineState,
  McpEngineTarget,
  type McpEngineTargetEncoded,
  type McpError,
  type McpErrorWire,
  McpToolDefinition,
  type McpStructuredOutput,
  type McpToolProblem,
  ServerError,
  Unsupported,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { Mutable } from "effect/Types";
import { type CallContext, type CallEnvironment, withCall } from "./call-context.ts";
import { type Answer, malformed, scrubError, toEngineValue } from "./results.ts";
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
}

/** Fails as a cut once the caller aborts the call or dies, whichever comes first (#409 answer 2). */
const abortedBy = (hooks: McpEngineHooks, mayHaveRun: boolean) =>
  Effect.tryPromise(() => hooks.untilAborted()).pipe(
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
  ) => Effect.Effect<A, McpError, R | Scope.Scope>,
) {
  // A row this engine cannot read is absent: it probes or initializes again.
  const rows = yield* Schema.decodeEffect(McpEnginePrior)(input.prior).pipe(
    Effect.orElseSucceed(() => ({})),
  );

  return yield* withCall(rows, input.hooks, input.env, (call) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.gen(function* () {
        const server = yield* Schema.decodeEffect(McpEngineTarget)(input.target).pipe(
          Effect.mapError(() =>
            Unsupported.make({ message: "This engine cannot reach that kind of server" }),
          ),
        );

        const connection = yield* connect(server, call.deps);

        return yield* work(connection, call);
      }).pipe(
        Effect.scoped,
        Effect.raceFirst(abortedBy(input.hooks, input.mayHaveRun)),
        Effect.result,
      );

      if (Result.isSuccess(outcome)) {
        return { outcome, state: call.state() };
      }

      // A stream made before the call failed is never returned, so its lease goes back now.
      call.lease.release();

      return {
        outcome: Result.fail(yield* scrubError(outcome.failure, call.tokens)),
        state: call.state(),
      };
    }),
  );
});

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

/** Discovers the server: its era, what it is, every page of its tools and prompts, and its tools' schema problems. */
export const discover = Effect.fn("mcp.engine.discover")(function* (
  target: McpEngineTargetEncoded,
  prior: McpEnginePriorEncoded,
  hooks: McpEngineHooks,
  env: CallEnvironment,
) {
  const validators = yield* Validators;

  const { outcome, state } = yield* runCall(
    { target, prior, hooks, env, mayHaveRun: false },
    (connection) =>
      Effect.gen(function* () {
        const tools = yield* connection.list("tools", HOST_WORK);
        const prompts = yield* connection.list("prompts", HOST_WORK);
        const definitions = yield* definitionsOf(tools.value);
        const problems = yield* validators.compileAll(definitions);

        const promptValues = yield* decodePrompts(prompts.value).pipe(
          Effect.mapError(() => malformed("a prompt")),
        );

        const about = yield* decodeAbout({
          serverInfo: connection.serverInfo,
          capabilities: connection.capabilities,
        }).pipe(Effect.mapError(() => malformed("its description")));

        const discovered: Mutable<Omit<McpEngineDiscovered, "state">> = {
          kind: "discovered",
          era: connection.era,
          protocolVersion: connection.protocolVersion,
          ...about,
          tools: definitions,
          prompts: promptValues,
          problems,
          fetchedAt: tools.fetchedAt,
        };

        if (connection.instructions !== undefined) {
          discovered.instructions = connection.instructions;
        }

        if (tools.ttlMs !== undefined) {
          discovered.ttlMs = tools.ttlMs;
        }

        return discovered;
      }),
  );

  return yield* encodeResult(
    McpEngineDiscoverResult,
    Result.isSuccess(outcome) ? { ...outcome.success, state } : failed(outcome.failure, state),
  );
});

const isServerError = Schema.is(ServerError);

/** The server rejected the call's `Mcp-Param` headers: its tool's definition has changed (D14). */
const headerMismatch = (error: McpError) => isServerError(error) && error.code === -32020;

const toolNamed = (tools: ReadonlyArray<McpToolDefinition>, name: string) =>
  Arr.findFirst(tools, (tool) => tool.name === name);

type ToolCall = McpEngineRequest & { readonly op: "tools/call" };

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
  const tools = yield* definitionsOf(listed.value);

  const refreshed = Option.some<Refreshed>({
    tools,
    problems: yield* validators.compileAll(tools),
  });

  const fresh = toolNamed(tools, req.tool.name);

  if (Option.isNone(fresh)) {
    return { sent: first, tool: req.tool, refreshed };
  }

  return { sent: yield* send(fresh.value), tool: fresh.value, refreshed };
});

type Completed = Omit<McpEngineCompleted, "state">;

/** A request's result before its rows are added. */
type RequestOutcome = Completed | Omit<McpEngineFailed, "state">;

/** Runs a `tools/call`, checking its `structuredContent`. */
const runToolCall = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: ToolCall,
  env: CallEnvironment,
  validators: ValidatorsApi,
) {
  const { sent, tool, refreshed } = yield* callWithRefresh(connection, req, validators);
  const extras = Option.getOrElse(refreshed, () => ({}));

  if (Result.isFailure(sent)) {
    return {
      kind: "failed",
      error: yield* scrubError(sent.failure, call.tokens),
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

/** Walks a list to its end; a `tools/list` also brings its tools' schema problems. */
const runList = Effect.fnUntraced(function* (
  connection: McpConnection,
  call: CallContext,
  req: Exclude<McpEngineRequest, ToolCall>,
  env: CallEnvironment,
  validators: ValidatorsApi,
) {
  const { value, kind: _kind, ...meta } = yield* connection.list(LIST_KINDS[req.op], req.ctx);

  const problems =
    req.op === "tools/list"
      ? Option.some(yield* validators.compileAll(yield* definitionsOf(value)))
      : Option.none<ReadonlyArray<McpToolProblem>>();

  const completed: Mutable<Completed> = {
    kind: "complete",
    ...meta,
    result: yield* toEngineValue(value, call, env),
  };

  Option.map(problems, (listed) => {
    completed.problems = listed;
  });

  return completed;
});

/** Runs one request: a `tools/call`, or a list walked to its end. An `op` this engine does not know is `Unsupported`. */
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

  const { outcome, state } = yield* runCall(
    { target, prior, hooks, env, mayHaveRun: req.op === "tools/call" },
    (connection, context): Effect.Effect<RequestOutcome, McpError, Scope.Scope> =>
      req.op === "tools/call"
        ? runToolCall(connection, context, req, env, validators)
        : runList(connection, context, req, env, validators),
  );

  const result = Result.isSuccess(outcome) ? outcome.success : failed(outcome.failure, state);

  return yield* encodeResult(McpEngineRequestResult, { ...result, state });
});
