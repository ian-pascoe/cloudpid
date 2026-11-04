// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off -- builders over
// plain values, and pi-durable's Promise-based tool seam.
// The `mcp` extension's tools (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Exposure, Calls and
// results; ADR-0030), built purely from the host's inventory and the offered tools, so a build over unchanged tools gives
// byte-identical declarations, which keeps the provider's prompt cache (AGENTS.md → Prompt cache).
//
// A call sends `McpHost.request({ op: "tools/call" })` with its `untilAborted` and `onProgress` hooks and awaits it for
// its whole length, so the stubs outlive it. Stop aborts the call's context, which resolves `untilAborted`, and the host
// cancels. The Session waits at most the server's `timeout` and `MCP_CALL_SLACK_MS` from the call's start or its last
// progress notice (progress resets the engine's timeout too); past that, or when the RPC breaks, the call reads as
// `host_lost`, which may have run (`docs/architecture/mcp.md` → Deploys). The host answers within the timeout, a wait
// for a free slot counted in, plus the connects the call makes, which the slack covers.
//
// Every tool is `replay: "safe"` with the `mcp.sent` memo, written before the request leaves (`docs/architecture/
// mcp-server-requests.md` → The waiting-question record): a rerun after a restart that finds it settles the call as
// interrupted and never sends it again, unless a Modern server's round of questions waits (`mcp.wait.<r>`), which the
// rerun waits for again. The request and the wait are `./exchange.ts`'s, which the resource tools
// (`./resources.ts`) share.
import {
  type McpExposure,
  mcpServerNamespace,
  mcpToolNames,
  normalizeMcpName,
  resolveExposure,
} from "@cloudpid/config";
import {
  appUriOfMeta,
  isJsonObject,
  type JsonObject,
  type McpHostRequest,
  type McpHostRequestContext,
} from "@cloudpid/mcp/types";
import type { TSchema } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type Extension,
  GenerationTask,
  hook,
  type ToolExecutionResult,
  type ToolHookCall,
  ToolTask,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import { draftOf, type McpAppCall, MCP_APP_FEATURE } from "./apps.ts";
import { baseDetails } from "./details.ts";
import {
  contextOf,
  type Exchange,
  MCP_RESEND_FEATURE,
  type McpCallOrigin,
  type McpTasking,
  type McpToolOptions,
  parentCallOf,
  samplesOf,
  send,
} from "./exchange.ts";
import { withElicitation } from "./elicit.ts";
import { MCP_SCRIPT_TIMED_OUT_REASON } from "./question-records.ts";
import type { McpQuestionsService } from "./questions.ts";
import { withSampling } from "./sample.ts";
import { exposureKeys, flagsOf, isReachable, reachesModel } from "./exposure.ts";
import { taskFollower } from "./task-follow.ts";
import { resultPool } from "./task-results.ts";
import { taskTools } from "./task-tools.ts";
import { type McpResultContext, resultFor } from "./result.ts";
import { resourceTools } from "./resources.ts";
import { signInTool } from "./sign-in-tool.ts";
import { scriptSchemaOf } from "./schema.ts";
import { spillTo } from "./spill.ts";

export {
  MCP_CALL_SLACK_MS,
  MCP_RESEND_FEATURE,
  MCP_SAMPLING_FEATURE,
  MCP_STREAM_IDLE_MS,
} from "./exchange.ts";

export type { McpCallOrigin, McpToolOptions } from "./exchange.ts";

export const extensionName = "mcp";

/**
 * The host feature a call keeps its Modern server's questions for later with: a host that lists it answers a call that
 * defers `InputRequired`, and resumes it (`docs/architecture/mcp-server-requests.md` → Questions). Without it, a Modern
 * server's form is answered live.
 */
export const MCP_RESUME_FEATURE = "resume";

/** What the host can keep for later for a call: a Modern round of questions, and a Legacy `-32042`'s pages. */
type HostKeeps = { readonly defers: boolean; readonly pages: boolean };

/**
 * The host feature that says it knows the `tasks/*` ops (`MCP_HOST_FEATURES`): a call is offered an MCP task, and the
 * `mcp_tasks` tools are registered, only on a host that lists it.
 */
export const MCP_TASKS_FEATURE = "tasks";

/**
 * A server as the tools are built from it: its name, state, tools and `instructions`, and of its entry only what the
 * build reads (`timeout`, `description` and the Exposure keys), so what a Session keeps of a build never holds the
 * entry's URL, headers, `env` or OAuth, where a literal credential may be. Decoding an inventory's server drops the rest.
 * `resources` is whether the server offers resources, which the `mcp_servers` section marks (`./servers.ts`).
 */
export const McpBuildServer = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  discoveredAt: Schema.optionalKey(Schema.Finite),
  /** Where the server's definition is: a question's card says so. */
  source: Schema.optionalKey(
    Schema.Struct({ kind: Schema.String, slug: Schema.optionalKey(Schema.String) }),
  ),
  server: Schema.Struct({
    /** `stdio` for a server that runs in a Workspace's Container; its calls ready the caller's Workspace first. */
    type: Schema.optionalKey(Schema.Json),
    timeout: Schema.optionalKey(Schema.Json),
    description: Schema.optionalKey(Schema.Json),
    /** `ask`, `allow` or `off` (`ask` by default): `allow` and `ask` have its Sampling requests answered, on the Session's models, `ask` after the owner's yes (`samplingOf`). */
    sampling: Schema.optionalKey(Schema.Json),
    exposure: Schema.optionalKey(Schema.Json),
    toolExposure: Schema.optionalKey(Schema.Json),
  }),
  tools: Schema.Record(Schema.String, Schema.Json).pipe(Schema.Array, Schema.optionalKey),
  instructions: Schema.optionalKey(Schema.String),
  resources: Schema.optionalKey(Schema.Boolean),
  /** Whether the server declares `completions`: the composer's forms may ask it for suggestions. */
  completions: Schema.optionalKey(Schema.Boolean),
  /** Whether the entry can need an owner's sign-in (`signsIn`): `mcp_sign_in_ask` is registered when one can. */
  signIn: Schema.optionalKey(Schema.Boolean),
});

export type McpBuildServer = typeof McpBuildServer.Type;

/** A tool of the inventory, as far as the Session reads it; the rest of its definition stays the host's. */
const ToolDeclaration = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.optionalKey(Schema.Json),
  outputSchema: Schema.optionalKey(Schema.Json),
  annotations: Schema.optionalKey(Schema.Json),
  _meta: Schema.optionalKey(Schema.Json),
});

type ToolDeclaration = typeof ToolDeclaration.Type;

const decodeTool = Schema.decodeUnknownOption(ToolDeclaration);

/** The tools of `server`'s inventory that this build can read, in the server's order. */
export const listedTools = (
  server: Pick<McpBuildServer, "tools">,
): ReadonlyArray<ToolDeclaration> =>
  Arr.filterMap(server.tools ?? [], (tool) => Result.fromOption(decodeTool(tool), () => undefined));

/** A tool's `inputSchema` as its parameters: an object schema, or a loose object for anything else. */
const parametersOf = (tool: ToolDeclaration): TSchema => {
  const schema = tool.inputSchema;

  // SAFETY: an object JSON Schema, which pi-ai's `TSchema` describes; TypeBox's are JSON Schema too.
  return (
    isJsonObject(schema) && schema["type"] === "object" ? schema : { type: "object" }
  ) as TSchema;
};

/** The request a call of `tool` of `server` sends. */
const requestOf = (
  ctx: McpHostRequestContext,
  server: string,
  tool: string,
  args: JsonObject,
): McpHostRequest => ({ op: "tools/call", server, params: { name: tool, arguments: args }, ctx });

/** The tool that calls `tool` of `server` through `client`. */
const toolFor = (
  client: McpHostClientService,
  origin: McpCallOrigin,
  server: McpBuildServer,
  tool: ToolDeclaration,
  name: string,
  exposure: Exclude<McpExposure, "hidden">,
  options: McpToolOptions,
  readServer: string | undefined,
  appHtml: boolean,
  keeps: HostKeeps,
  samples: boolean,
  tasking: McpTasking | undefined,
): ToolRegistration => {
  const base = baseDetails(server.name, tool);
  const app = options.apps !== undefined && appUriOfMeta(tool._meta) !== undefined;

  const exchange: Exchange = {
    client,
    origin,
    server,
    options,
    tool: name,
    details: base,
    subject: "tool",
    defers: keeps.defers,
    pages: keeps.pages,
    samples,
    tasking,
    app: app ? { pinsView: appHtml } : undefined,
  };

  return {
    name,
    description: tool.description ?? "",
    parameters: parametersOf(tool),
    structuredOutputSchema: scriptSchemaOf(
      isJsonObject(tool.outputSchema) ? tool.outputSchema : undefined,
    ),
    replay: "safe",
    ...flagsOf(exposure),
    execute: async (args, api, context) => {
      const sent = await send(
        exchange,
        api,
        context,
        (workspace, answers, allowTask) =>
          requestOf(
            contextOf(
              { ...origin, workspace },
              { callId: api.callId, conversation: String(api.conversationId) },
              answers,
              allowTask,
            ),
            server.name,
            tool.name,
            // SAFETY: the arguments pi-durable validated against the tool's `inputSchema`, an object.
            args as JsonObject,
          ),
        async (value, completed, caller) => {
          // A script's call gets its value whole and no spill.
          const call: McpResultContext =
            caller === "script"
              ? { kind: "script", details: base, readServer }
              : { kind: "model", details: base, spill: spillTo(api.env, context), readServer };

          const result = await resultFor(value, completed.structuredOutput, call);

          // A completed call of an App tool, an `isError` result too, is recorded for the View's mounts: the whole result,
          // which the model's and the script's value drop part of. The page's hash is read only when the host lists it.
          if (app) {
            await recordApp(
              options.apps,
              {
                callId: api.callId,
                conversation: String(api.conversationId),
                parentCall: await parentCallOf(api, context),
                server: server.name,
                tool: tool.name,
                // SAFETY: the arguments pi-durable validated against the tool's `inputSchema`, an object.
                arguments: args as JsonObject,
                htmlHash: appHtml ? completed.app?.htmlHash : undefined,
                viewHash: appHtml ? completed.app?.viewHash : undefined,
              },
              value,
            );
          }

          return result;
        },
      );

      return sent.ok
        ? withSampling(withElicitation(sent.value, sent.asked), sent.sampled)
        : sent.result;
    },
  };
};

/** The record of `call`, kept by `apps`; a record that could not be kept never fails the call. */
const recordApp = async (
  apps: McpToolOptions["apps"],
  call: McpAppCall,
  value: Schema.Json,
): Promise<void> => {
  const draft = draftOf(call, value);

  if (apps === undefined || draft === undefined) return;

  await Effect.runPromise(apps.put(draft)).catch(() => undefined);
};

/** What the `mcp` extension is built from: the host's servers with their tools, and the tools the settings offer. */
export type McpBuild = {
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly offered: ReadonlyArray<string>;
  /** The host's features the build may use (`MCP_TOOL_FEATURES` and the optional ones it listed): none, when absent. */
  readonly features?: ReadonlyArray<string>;
};

/**
 * The hook that keeps a conversation's Resource watches held and tells it their news: before each model request of any
 * conversation (a subagent's included), `touch` is told which one, and the result is never used for the request.
 */
const watchHook = (touch: (conversation: string) => Promise<void>) =>
  hook(GenerationTask, {
    beforeRequest: async (_request, api) => {
      await touch(String(api.conversationId));

      return undefined;
    },
  });

/** What the library writes, as the whole of a result, for a script rerun after its deadline passed while it was interrupted. */
const INTERRUPTED_PAST_DEADLINE = "Script timed out: its deadline passed while it was interrupted.";

/**
 * Whether `result` is a `codemode` script's that ended because its `timeout_ms` passed, in the library's own words: a
 * failed result whose error is `Script error:` then `Script timed out: …` on lines of their own (the deadline passing
 * while the script ran), or whose only text is the one it writes for a rerun after the deadline (it passed while no
 * instance ran the script: an eviction).
 */
const scriptTimedOut = (result: ToolExecutionResult): boolean => {
  if (result.isError !== true) return false;

  const texts = Arr.filterMap(result.output ?? [], (item) =>
    item.type === "text" ? Result.succeed(item.text) : Result.failVoid,
  );

  return (
    (result.output?.length === 1 && texts[0] === INTERRUPTED_PAST_DEADLINE) ||
    Arr.some(texts, (text) => /^Script error:\nScript timed out: /m.test(text))
  );
};

/**
 * Whether the script of `call` set a timeout: its first line is `// @options: {…"timeout_ms"…}` (`docs/architecture/
 * mcp-server-requests.md` → `codemode`). The library keeps the deadline itself (`CodemodeRunDoc.start.deadline`), which
 * pi-durable does not export, so a hook cannot compare it with the clock; a script that wrote the library's words into its
 * own output, with no timeout of its own, is not taken for one that timed out.
 */
const declaresTimeout = (call: ToolHookCall): boolean => {
  const { code } = call.arguments;

  return Predicate.isString(code) && /^\s*\/\/\s*@options:.*"timeout_ms"/.test(code);
};

/** Whether `call`, with `result`, is a model-issued `codemode` script that ended because the `timeout_ms` it set passed. */
export const endedByTimeout = (call: ToolHookCall, result: ToolExecutionResult): boolean =>
  call.parent === undefined &&
  call.name === "codemode" &&
  declaresTimeout(call) &&
  scriptTimedOut(result);

/**
 * The hook that withdraws a `codemode` script's questions as "the script timed out" when its `timeout_ms` passed: the
 * call's own result is seen before it is stored, and before the script's nested calls are aborted, so what the owner and
 * the agent read of a question says the script ended, not that a Run stopped (`docs/architecture/
 * mcp-server-requests.md` → `codemode`). A failure to withdraw leaves the questions to the abort that follows.
 */
const scriptTimeoutHook = (questions: McpQuestionsService) =>
  hook(ToolTask, {
    afterTool: async (call, result) => {
      if (!endedByTimeout(call, result)) return undefined;

      await Effect.runPromise(questions.withdrawScript(call.id, MCP_SCRIPT_TIMED_OUT_REASON)).catch(
        () => undefined,
      );

      return undefined;
    },
  });

/**
 * The `mcp` extension over `build`: each server's tools (those its inventory lists) by their model-facing names
 * (`mcp__<server>__<tool>`), registered by their Exposure (`./exposure.ts`), then the resource tools when the host lists
 * the `resources` feature and a server has resources (`./resources.ts`). A server switched off or `hidden` registers
 * nothing, nor does a tool whose `_meta` leaves the model out.
 */
export const mcpExtension = (
  build: McpBuild,
  client: McpHostClientService,
  origin: McpCallOrigin = {},
  options: McpToolOptions = {},
): Extension => {
  const resources = resourceTools(build, client, origin, options);
  const appHtml = build.features?.includes(MCP_APP_FEATURE) === true;

  // A link a result carries says how to read it only when the resource tools reach its server.
  const readServerOf = (server: McpBuildServer): string | undefined =>
    resources.length > 0 && server.resources === true && isReachable(server)
      ? normalizeMcpName(server.name)
      : undefined;

  // A Modern server's questions wait for the owner past their round only on a host that resumes the call.
  const keeps: HostKeeps = {
    defers: build.features?.includes(MCP_RESUME_FEATURE) === true,
    pages: build.features?.includes(MCP_RESEND_FEATURE) === true,
  };

  // A Legacy server's Sampling requests are answered only on a host that lists `sampling` (it declares them to the server).
  const samples = samplesOf(build);

  // MCP tasks are followed on a host that knows the ops, by a Session that keeps what following needs.
  const pool = options.tasks === undefined ? undefined : resultPool(options.tasks.storage);

  const follower =
    options.tasks === undefined ||
    pool === undefined ||
    build.features?.includes(MCP_TASKS_FEATURE) !== true
      ? undefined
      : taskFollower({ client, origin, tasks: options.tasks, pool });

  const tasking: McpTasking | undefined =
    options.tasks === undefined || pool === undefined || follower === undefined
      ? undefined
      : { tasks: options.tasks, follower, pool };

  const tools = Arr.flatMap(build.servers, (server) => {
    const listed = listedTools(server);

    if (server.state === "disabled" || listed.length === 0) return [];

    const keys = exposureKeys(server);

    const names = mcpToolNames(
      server.name,
      Arr.map(listed, (tool) => tool.name),
    );

    return Arr.filterMap(listed, (tool) => {
      const name = names.get(tool.name) ?? tool.name;

      const { exposure } = resolveExposure({
        server: keys,
        tool: tool.name,
        modelName: name,
        offered: build.offered,
      });

      return exposure === "hidden" || !reachesModel(tool._meta)
        ? Result.failVoid
        : Result.succeed(
            toolFor(
              client,
              origin,
              server,
              tool,
              name,
              exposure,
              options,
              readServerOf(server),
              appHtml,
              keeps,
              samples,
              tasking,
            ),
          );
    });
  });

  const asking = signInTool(build.servers, client, options);
  const { beforeRequest } = options;

  return defineExtension({
    name: extensionName,
    tools: [
      ...tools,
      ...resources,
      ...(asking === undefined ? [] : [asking]),
      ...(pool === undefined || follower === undefined ? [] : taskTools(client, origin, pool)),
    ],
    sections: options.sections ?? [],
    tasks: follower === undefined ? [] : [follower],
    hooks: [
      ...(beforeRequest === undefined ? [] : [watchHook(beforeRequest)]),
      ...(options.questions === undefined ? [] : [scriptTimeoutHook(options.questions)]),
    ],
  });
};

/**
 * The servers as `codemode` namespaces (`docs/architecture/mcp-in-a-session.md` → The prompt cache): `mcp__<server>`,
 * with the definition's `description` and the server's `instructions`, which the host keeps cut at 16 KiB. An
 * undiscovered server has none, nor one switched off.
 */
export const mcpNamespaces = (
  servers: ReadonlyArray<McpBuildServer>,
): ReadonlyArray<CodemodeNamespace> =>
  Arr.filterMap(servers, (server) => {
    if (server.discoveredAt === undefined || server.state === "disabled") return Result.failVoid;

    const name = mcpServerNamespace(server.name);
    const namespace: Mutable<CodemodeNamespace> = { name, prefix: name };
    const { description } = server.server;

    if (Predicate.isString(description) && description !== "") {
      namespace.description = description;
    }

    if (server.instructions !== undefined && server.instructions !== "") {
      namespace.instructions = server.instructions;
    }

    return Result.succeed(namespace);
  });
