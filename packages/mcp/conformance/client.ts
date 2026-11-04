#!/usr/bin/env node
/**
 * The scenario client the official conformance suite drives (`docs/architecture/mcp.md` → Testing and tracing →
 * Conformance): a small Node program over the core's seam, `connect`, `list` and `callTool`, with a plain `fetch` and
 * in-memory stores injected, as the engine injects its own.
 *
 * The runner appends the mock server's URL and sets `MCP_CONFORMANCE_SCENARIO`, and `MCP_CONFORMANCE_CONTEXT` for
 * scenarios that carry more (the tool calls to make). The core finds the era itself, so the mode (the spec version)
 * only picks which scenarios the runner starts; the client never reads `MCP_CONFORMANCE_PROTOCOL_VERSION`. A scenario
 * the core cannot drive yet exits 1, so it is a failure that `baseline.json` records and not a skip, and it passes
 * the day the core can drive it.
 *
 * Run by `run.ts` (`bun run --cwd packages/mcp conformance <mode>`).
 */
// @effect-diagnostics preferEffectArray:off processEnv:off missedPipeableOpportunity:off -- a scenario script over a few tools, driven by the runner's environment.
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  connect,
  type ListItems,
  type McpConnection,
  type McpDeps,
  type RowStore,
} from "../src/index.ts";
import { type McpCallContext, type McpError, xMcpHeaderProblems } from "../src/types.ts";

/** What every call here is made for: the owner's host, which has no conversation. */
const HOST_CALL: McpCallContext = { origin: "host" };

/** A call that answers a Modern server's form at once (`onInput` accepts every one): the core's own rounds drive it. */
const ANSWERING_CALL: McpCallContext = { origin: "host", answers: { elicitation: true } };

/** What stops a scenario short: one the core cannot drive yet, or one the server did not set up as expected. */
class ScenarioError extends Schema.TaggedError<ScenarioError, { readonly brand: unique symbol }>()(
  "ScenarioError",
  { message: Schema.String },
) {}

/** One scenario over a live connection, with the `MCP_CONFORMANCE_CONTEXT` the runner handed it. */
type Scenario = (
  connection: McpConnection,
  context: string | undefined,
) => Effect.Effect<void, ScenarioError | McpError>;

/** A row store over one in-memory cell: the connection lives for one process. */
const memoryStore = (): RowStore => {
  let row: Schema.Json | undefined;

  return {
    get: Effect.sync(() => row),
    set: (next) =>
      Effect.sync(() => {
        row = next;
      }),
    drop: Effect.sync(() => {
      row = undefined;
    }),
  };
};

const deps = (): McpDeps => ({
  fetch: globalThis.fetch,
  eras: memoryStore(),
  sessions: memoryStore(),
  // What the SDK's own `request-metadata` client declares, so the per-request envelope carries a declaration.
  capabilities: () => ({ roots: { listChanged: true }, sampling: {}, elicitation: {} }),
  clientInfo: { name: "test-client", version: "1.0.0" },
  // A form is confirmed: the MRTR scenario asks for `{ confirmed }` and checks only how the rounds are sent.
  onInput: () =>
    Effect.succeed({
      kind: "answered",
      result: { action: "accept", content: { confirmed: true } },
    }),
});

/** The tool calls a scenario hands the client in `MCP_CONFORMANCE_CONTEXT`. */
const ToolCalls = Schema.fromJsonString(
  Schema.Struct({
    toolCalls: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          arguments: Schema.Record(Schema.String, Schema.Json),
        }),
      ),
    ),
  }),
);

const decodeToolCalls = Schema.decodeUnknownOption(ToolCalls);

const toolCallsOf = (context: string | undefined) =>
  Option.fromUndefinedOr(context).pipe(
    Option.flatMap(decodeToolCalls),
    Option.flatMap((decoded) => Option.fromUndefinedOr(decoded.toolCalls)),
    Option.getOrElse(() => []),
  );

/**
 * The server's tools, less those whose `x-mcp-header` declarations break SEP-2243's rules, which a Modern client
 * leaves out, as `McpHost`'s discovery does (`xMcpHeaderProblems`). A Legacy server's tools are kept as listed.
 */
const listTools = (connection: McpConnection) =>
  connection.list("tools", HOST_CALL).pipe(
    Effect.map((outcome): ReadonlyArray<ListItems["tools"]> =>
      connection.era === "modern"
        ? outcome.value.filter(
            // SAFETY: a listed tool's `inputSchema` is a JSON object.
            (tool) => xMcpHeaderProblems(tool.inputSchema as Schema.Json).length === 0,
          )
        : outcome.value,
    ),
  );

/** The tool `name` of `tools`, or the scenario's failure that the server does not list it. */
const toolNamed = (tools: ReadonlyArray<ListItems["tools"]>, name: string) => {
  const tool = tools.find((t) => t.name === name);

  return tool === undefined
    ? Effect.fail(ScenarioError.make({ message: `The server does not list ${name}.` }))
    : Effect.succeed(tool);
};

/** Connect and list tools: what the SDK's own client does for these. */
const listOnly: Scenario = (connection) => Effect.asVoid(listTools(connection));

const connectOnly: Scenario = () => Effect.void;

const SCENARIOS = new Map<string, Scenario>([
  ["initialize", listOnly],
  ["request-metadata", connectOnly],
  ["json-schema-ref-no-deref", listOnly],

  [
    "tools_call",
    (connection) =>
      Effect.gen(function* () {
        const tools = yield* listTools(connection);
        const tool = yield* toolNamed(tools, "add_numbers");

        yield* connection.callTool({ tool, arguments: { a: 5, b: 3 } }, HOST_CALL);
      }),
  ],

  // The mock lists tools, resources and prompts and checks each request's `Mcp-Method` and `Mcp-Name`; the core reads
  // no resource and gets no prompt yet, so only the listings and the call of its tool are driven.
  [
    "http-standard-headers",
    (connection) =>
      Effect.gen(function* () {
        const tools = yield* listTools(connection);
        const tool = yield* toolNamed(tools, "test_headers");

        yield* connection.callTool({ tool, arguments: {} }, HOST_CALL);

        yield* connection.list("resources", HOST_CALL);
        yield* connection.list("prompts", HOST_CALL);
      }),
  ],

  [
    "http-custom-headers",
    (connection, context) =>
      Effect.gen(function* () {
        const tools = yield* listTools(connection);

        const calls = toolCallsOf(context);

        for (const call of calls) {
          const tool = yield* toolNamed(tools, call.name);

          yield* connection.callTool({ tool, arguments: call.arguments }, HOST_CALL);
        }
      }),
  ],

  // The mock lists one valid tool among invalid ones, which `listTools` leaves out (`xMcpHeaderProblems`); call what is
  // left.
  [
    "http-invalid-tool-headers",
    (connection) =>
      Effect.gen(function* () {
        const tools = yield* listTools(connection);

        for (const tool of tools) {
          yield* connection
            .callTool({ tool, arguments: { region: "us-west1" } }, HOST_CALL)
            .pipe(Effect.ignore);
        }
      }),
  ],

  // Passes the focal tool's `inputSchema` back, as listed, for the referee to compare with its fixture.
  [
    "json-schema-2020-12-preservation",
    (connection) =>
      Effect.gen(function* () {
        const tools = yield* listTools(connection);
        const focal = yield* toolNamed(tools, "json_schema_2020_12_tool");
        const echo = yield* toolNamed(tools, "json_schema_echo");

        // SAFETY: a JSON Schema is JSON.
        const schema = focal.inputSchema as Schema.Json;

        yield* connection.callTool({ tool: echo, arguments: { schema } }, HOST_CALL);
      }),
  ],

  // SEP-2322's rounds: the core answers each `input_required` itself and sends the call again, with the server's
  // `requestState` as it came (none when it sent none), on a new id; another tool's call carries none of it.
  [
    "sep-2322-client-request-state",
    (connection) =>
      Effect.gen(function* () {
        const tools = yield* listTools(connection);

        for (const name of ["test_mrtr_echo_state", "test_mrtr_unrelated", "test_mrtr_no_state"]) {
          const tool = yield* toolNamed(tools, name);

          yield* connection.callTool({ tool, arguments: {} }, ANSWERING_CALL);
        }

        // A result with no `resultType` is never answered as a round; the SDK refuses it from a server of this
        // revision, which the scenario does not check.
        const plain = yield* toolNamed(tools, "test_mrtr_no_result_type");

        yield* connection
          .callTool({ tool: plain, arguments: {} }, ANSWERING_CALL)
          .pipe(Effect.ignore);
      }),
  ],

  // The scenario's server ends the call's stream after a priming event and answers the `GET` that resumes it, after
  // the `retry` it sent and with the `Last-Event-ID` it gave (#394 D15; #542).
  [
    "sse-retry",
    (connection) =>
      Effect.gen(function* () {
        const tools = yield* listTools(connection);
        const tool = yield* toolNamed(tools, "test_reconnection");

        yield* connection.callTool({ tool, arguments: {} }, HOST_CALL);
      }),
  ],
]);

/** What the runner hands the client: the mock server's URL, and the scenario with its context. */
const runnerHandOff = {
  url: process.argv[2],
  scenario: process.env.MCP_CONFORMANCE_SCENARIO,
  context: process.env.MCP_CONFORMANCE_CONTEXT,
};

const main = Effect.gen(function* () {
  const { url, scenario: name, context } = runnerHandOff;

  if (url === undefined || name === undefined) {
    return yield* ScenarioError.make({
      message: "Usage: MCP_CONFORMANCE_SCENARIO=<scenario> client.ts <server-url>",
    });
  }

  const scenario = SCENARIOS.get(name);

  if (scenario === undefined) {
    return yield* ScenarioError.make({
      message: `The core cannot drive the scenario ${name} yet.`,
    });
  }

  const connection = yield* connect({ url }, deps());

  yield* scenario(connection, context);
});

const failed = (cause: Cause.Cause<ScenarioError | McpError>) =>
  Console.error(Cause.pretty(cause)).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

await main.pipe(Effect.scoped, Effect.catchCause(failed), Effect.runPromise);
