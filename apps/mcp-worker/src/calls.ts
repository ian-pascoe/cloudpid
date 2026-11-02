/**
 * What `McpEngine`'s methods do, over `@cloudpid/mcp` (`docs/architecture/mcp-connections.md` → The engine; #382 D1,
 * D9, D13.2). Each call connects from the host's `prior` rows and its hooks, does its work, and returns its result
 * with the rows it changed, encoded for RPC; it keeps nothing once it ends.
 *
 * - **Aborts:** the call races `untilAborted()`, which resolves when the caller aborts and rejects when it dies; either
 *   way the work is interrupted, which aborts the server request (a Legacy server gets `notifications/cancelled`), and
 *   the call fails as a cut.
 * - **Bytes:** the call's `fetch` is metered against a lease on the isolate's byte budget, given back when the call
 *   ends, or for a large result once its stream is read (`budget.ts`, `results.ts`).
 * - **`structuredContent`** is checked against the tool's `outputSchema` (The MCP core #394 D17, refined by D9.3).
 * - **`-32020`:** a `tools/call` whose headers the server rejects lists the server's tools again and is sent once more
 *   with the fresh definition, which goes back to the host for its catalog (The MCP core #394 D14). The server refused
 *   the first before running it, so the call runs at most once.
 */
import { connect, type ListKind, type McpConnection } from "@cloudpid/mcp";
import {
  Cut,
  type McpCallContext,
  McpEngineDiscoverResult,
  type McpEngineDiscovered,
  type McpEngineHooks,
  type McpEngineMethods,
  McpEnginePrior,
  McpEngineRequest,
  McpEngineRequestResult,
  type McpEngineState,
  McpEngineTarget,
  type McpError,
  McpToolDefinition,
  ProtocolViolation,
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
import { type Answer, valueOf } from "./results.ts";
import { type CallEnvironment, type CallSession, openSession } from "./session.ts";
import { Validators } from "./validators.ts";

type EngineArguments<K extends keyof McpEngineMethods> = Parameters<McpEngineMethods[K]>;

/** Discovery is the host's own work (The MCP core #394 D7). */
const HOST: McpCallContext = { origin: "host" };

/** Each list `request` walks, by the core's kind. */
const LIST_KINDS = {
  "tools/list": "tools",
  "prompts/list": "prompts",
  "resources/list": "resources",
  "resources/templates/list": "resources/templates",
} as const satisfies Record<string, ListKind>;

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

const notJson = (what: string) =>
  ProtocolViolation.make({ message: `Not an MCP server: ${what} is malformed` });

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
  decodeTools(tools).pipe(Effect.mapError(() => notJson("a tool definition")));

/**
 * Runs `work` over a new connection to `target`, racing the caller's abort. The outcome, and the session whose rows,
 * lease and tokens the caller settles.
 */
const runCall = Effect.fnUntraced(function* <A, R>(
  target: EngineArguments<"request">[0],
  prior: EngineArguments<"request">[1],
  hooks: McpEngineHooks,
  env: CallEnvironment,
  mayHaveRun: boolean,
  work: (
    connection: McpConnection,
    session: CallSession,
  ) => Effect.Effect<A, McpError, R | Scope.Scope>,
) {
  // A row this engine cannot read is absent: it probes or initializes again.
  const rows = yield* Schema.decodeEffect(McpEnginePrior)(prior).pipe(
    Effect.orElseSucceed(() => ({})),
  );

  const session = yield* openSession(rows, hooks, env);

  const outcome = yield* Effect.gen(function* () {
    const server = yield* Schema.decodeEffect(McpEngineTarget)(target).pipe(
      Effect.mapError(() =>
        Unsupported.make({ message: "This engine cannot reach that kind of server" }),
      ),
    );

    const connection = yield* connect(server, session.deps);

    return yield* work(connection, session);
  }).pipe(Effect.scoped, Effect.raceFirst(abortedBy(hooks, mayHaveRun)), Effect.result);

  return { outcome, session };
});

const failed = (error: McpError, state: McpEngineState) =>
  ({ kind: "failed", error, state }) as const;

const encodeDiscover = (result: McpEngineDiscoverResult) =>
  Schema.encodeEffect(McpEngineDiscoverResult)(result).pipe(
    Effect.catch(() =>
      Schema.encodeEffect(McpEngineDiscoverResult)(failed(notJson("its answer"), result.state)),
    ),
    Effect.orDie,
  );

const encodeRequest = (result: McpEngineRequestResult) =>
  Schema.encodeEffect(McpEngineRequestResult)(result).pipe(
    Effect.catch(() =>
      Schema.encodeEffect(McpEngineRequestResult)(failed(notJson("its answer"), result.state)),
    ),
    Effect.orDie,
  );

/** Discovers the server: its era, what it is, every page of its tools and prompts, and its tools' schema problems. */
export const discover = Effect.fn("mcp.engine.discover")(function* (
  target: EngineArguments<"discover">[0],
  prior: EngineArguments<"discover">[1],
  hooks: McpEngineHooks,
  env: CallEnvironment,
) {
  const validators = yield* Validators;

  const { outcome, session } = yield* runCall(target, prior, hooks, env, false, (connection) =>
    Effect.gen(function* () {
      const tools = yield* connection.list("tools", HOST);
      const prompts = yield* connection.list("prompts", HOST);
      const definitions = yield* definitionsOf(tools.value);
      const problems = yield* validators.compileAll(definitions);

      const promptValues = yield* decodePrompts(prompts.value).pipe(
        Effect.mapError(() => notJson("a prompt")),
      );

      const about = yield* decodeAbout({
        serverInfo: connection.serverInfo,
        capabilities: connection.capabilities,
      }).pipe(Effect.mapError(() => notJson("its description")));

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

  session.lease.release();

  const state = session.state();

  return yield* encodeDiscover(
    Result.isSuccess(outcome) ? { ...outcome.success, state } : failed(outcome.failure, state),
  );
});

const isServerError = Schema.is(ServerError);

/** The server rejected the call's `Mcp-Param` headers: its tool's definition has changed (D14). */
const headerMismatch = (error: McpError) => isServerError(error) && error.code === -32020;

const toolNamed = (tools: ReadonlyArray<McpToolDefinition>, name: string) =>
  Arr.findFirst(tools, (tool) => tool.name === name);

/** Runs one request: a `tools/call`, or a list walked to its end. An `op` this engine does not know is `Unsupported`. */
export const request = Effect.fn("mcp.engine.request")(function* (
  target: EngineArguments<"request">[0],
  prior: EngineArguments<"request">[1],
  input: EngineArguments<"request">[2],
  hooks: McpEngineHooks,
  env: CallEnvironment,
) {
  const validators = yield* Validators;
  const decoded = yield* Schema.decodeEffect(McpEngineRequest)(input).pipe(Effect.option);

  if (Option.isNone(decoded)) {
    return yield* encodeRequest(
      failed(Unsupported.make({ message: "This engine does not run that request" }), {}),
    );
  }

  const req = decoded.value;

  const { outcome, session } = yield* runCall(
    target,
    prior,
    hooks,
    env,
    req.op === "tools/call",
    (connection, call) =>
      Effect.gen(function* () {
        if (req.op !== "tools/call") {
          const {
            value,
            kind: _kind,
            ...meta
          } = yield* connection.list(LIST_KINDS[req.op], req.ctx);

          return { ...meta, result: yield* valueOf(value, call, env) };
        }

        const callWith = (tool: McpToolDefinition) =>
          connection.callTool(
            // SAFETY: a definition the server listed, decoded as one; the SDK reads it as its `Tool`.
            {
              tool: tool as Parameters<McpConnection["callTool"]>[0]["tool"],
              arguments: req.arguments ?? {},
            },
            req.ctx,
          );

        let tool = req.tool;
        let listed = Option.none<ReadonlyArray<McpToolDefinition>>();

        const sent = yield* callWith(tool).pipe(
          Effect.catchIf(headerMismatch, (mismatch) =>
            Effect.gen(function* () {
              const tools = yield* connection.list("tools", HOST);
              const definitions = yield* definitionsOf(tools.value);
              const fresh = toolNamed(definitions, req.tool.name);

              if (Option.isNone(fresh)) {
                return yield* mismatch;
              }

              tool = fresh.value;
              listed = Option.some(definitions);

              return yield* callWith(tool);
            }),
          ),
        );

        const { value, kind: _kind, ...meta } = sent;

        const completed: Mutable<Omit<McpEngineRequestResult & { kind: "complete" }, "state">> = {
          kind: "complete",
          ...meta,
          result: yield* valueOf(value, call, env),
        };

        if (tool.outputSchema !== undefined && value.isError !== true) {
          completed.structuredOutput = yield* validators.check(
            tool.outputSchema,
            value.structuredContent,
          );
        }

        Option.map(listed, (tools) => {
          completed.tools = tools;
        });

        return completed;
      }),
  );

  const state = session.state();

  if (Result.isFailure(outcome)) {
    session.lease.release();

    return yield* encodeRequest(failed(outcome.failure, state));
  }

  const completed = outcome.success;

  // A stream gives the lease back once it is read; an inline value has been made.
  if (completed.result.kind === "inline") {
    session.lease.release();
  }

  return yield* encodeRequest({ kind: "complete", ...completed, state });
});
