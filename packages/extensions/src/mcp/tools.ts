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
// interrupted and never sends it again.
import {
  type McpExposure,
  mcpServerNamespace,
  mcpToolNames,
  resolveExposure,
} from "@cloudpid/config";
import {
  isJsonObject,
  type JsonObject,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_ELICITATION_WAIT_MS,
  type McpHostRequest,
  type McpAnswers,
  type McpHostRequestHooks,
  pausableDeadline,
} from "@cloudpid/mcp/types";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type Extension,
  type PromptSection,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import { baseDetails } from "./details.ts";
import { agentOf, conversationWorkspace, SubagentsDoc } from "../subagents/state.ts";
import { elicitingHooks, withElicitation } from "./elicit.ts";
import { exposureKeys, flagsOf, reachesModel } from "./exposure.ts";
import {
  failedWith,
  failureResult,
  hostLostResult,
  interruptedResult,
  type McpResultContext,
  resultFor,
  streamFailure,
} from "./result.ts";
import type { McpQuestionsService } from "./questions.ts";
import type { McpSignInsService } from "./sign-in.ts";
import { signInTool } from "./sign-in-tool.ts";
import { scriptSchemaOf } from "./schema.ts";
import { spillTo } from "./spill.ts";
import { readStreamed, type StreamLimits } from "./stream.ts";

export const extensionName = "mcp";

/** A server's `timeout` when its entry has none, in seconds (`DEFAULT_MCP_TIMEOUT`). */
const DEFAULT_TIMEOUT_S = 60;

/**
 * How long past a call's timeout the Session waits for the host's answer before it reads the call as lost: 60 s, the
 * connects a call may make before it is sent (three when the server's era is in doubt, each up to
 * `MCP_CONNECT_TIMEOUT_MS`) and 15 s more for the RPCs, so the host answers first whenever it can.
 */
export const MCP_CALL_SLACK_MS = 3 * MCP_CONNECT_TIMEOUT_MS + 15_000;

/** The longest a result's stream may be quiet while the Session reads it before it is read as lost, in ms. */
export const MCP_STREAM_IDLE_MS = 30_000;

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
    exposure: Schema.optionalKey(Schema.Json),
    toolExposure: Schema.optionalKey(Schema.Json),
  }),
  tools: Schema.Record(Schema.String, Schema.Json).pipe(Schema.Array, Schema.optionalKey),
  instructions: Schema.optionalKey(Schema.String),
  resources: Schema.optionalKey(Schema.Boolean),
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

/** Whether the call is a script's (`codemode`): a nested call of the task `api` runs. */
const isNested = async (api: ToolExecutionApi, context: Context): Promise<boolean> => {
  const task = await api.getTask(api.taskId, context).catch(() => undefined);
  // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
  const input = task?.input as ToolTaskInput | undefined;

  return input?.kind === "nested";
};

/**
 * What a call says it can answer when the Session has questions to show: a Legacy server's elicitation form, for as long
 * as the owner has to answer it and a little more, so the Session's own end of the wait comes first.
 */
const ELICITATION_ANSWERS: McpAnswers = {
  elicitation: true,
  inputWaitMs: MCP_ELICITATION_WAIT_MS + 15_000,
};

/** The marker written before a call's request leaves: a rerun that finds it settles the call, and never sends it again. */
const SENT = "mcp.sent";

/** How long the Session waits for a call to `server`'s tools since its start or its last progress, in ms. */
const waitOf = (server: McpBuildServer, slackMs: number): number => {
  const { timeout } = server.server;

  return (
    (Predicate.isNumber(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_S) * 1000 + slackMs
  );
};

/** How the tools wait: the slack past a call's timeout, `MCP_CALL_SLACK_MS` unless a test shortens it. */
export type McpToolOptions = {
  readonly slackMs?: number;
  /** How long a result's stream may be quiet, `MCP_STREAM_IDLE_MS` unless a test shortens it. */
  readonly streamIdleMs?: number;
  /** How long a result's stream waits for the decode slot, `MCP_STREAM_SLOT_WAIT_MS` unless a test shortens it. */
  readonly streamWaitMs?: number;
  /**
   * A call to Workspace `workspace` (`ws:<id>`) that marks it used (`noteSessionActivity`), awaited before a call to a
   * stdio server, which may start that Workspace's Container; false when it did not answer, and the call is then not sent.
   * Absent: nothing is awaited.
   */
  readonly ready?: ((workspace: string) => Promise<boolean>) | undefined;
  /**
   * The Session's MCP questions. With them, a call says it can answer a Legacy server's elicitation form
   * (`ctx.answers`), which waits for the owner (`docs/architecture/mcp-server-requests.md` → Elicitation requests);
   * without them, every question a server asks is cancelled.
   */
  readonly questions?: McpQuestionsService;
  /**
   * The Session's Sign-in requests, and the Environment they are for: with both, the build registers `mcp_sign_in_ask` when
   * its set has a server that can need a sign-in (`docs/architecture/mcp-sign-in.md` → Sign-in requests).
   */
  readonly signIns?: McpSignInsService | undefined;
  readonly environment?: string | undefined;
  /** How long a signed-in server is waited for to connect, `MCP_SIGN_IN_CONNECT_WAIT_MS` unless a test shortens it. */
  readonly connectWaitMs?: number | undefined;
  /** The extension's system prompt sections: the `mcp_servers` section (`./servers.ts`). */
  readonly sections?: ReadonlyArray<PromptSection>;
};

/** A promise that resolves when any of `signals` aborts, and never without one. */
const abortedBy = (signals: ReadonlyArray<AbortSignal>) =>
  new Promise<void>((resolve) => {
    for (const signal of signals) {
      if (signal.aborted) return resolve();

      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });

/** Who the Session's calls are made for: the Session and its Workspace (`ws:<id>`). */
export type McpCallOrigin = {
  readonly session?: string | undefined;
  readonly workspace?: string | undefined;
};

/** The request a call of `tool` of `server` sends. */
const requestOf = (
  origin: McpCallOrigin,
  server: string,
  tool: string,
  args: JsonObject,
  call: { readonly callId: string; readonly conversation: string },
  answers?: McpAnswers,
): McpHostRequest => {
  const ctx: Mutable<McpHostRequest["ctx"]> = {
    origin: "agent",
    callId: call.callId,
    conversation: call.conversation,
  };

  if (origin.session !== undefined) ctx.session = origin.session;

  if (origin.workspace !== undefined) ctx.workspace = origin.workspace;

  if (answers !== undefined) ctx.answers = answers;

  return { op: "tools/call", server, params: { name: tool, arguments: args }, ctx };
};

/**
 * The Workspace the calling conversation works in (`ws:<id>`): its own Subagent Workspace, or its nearest ancestor's, else
 * `fallback`, the Session's. A read that fails is the Session's too.
 */
const workspaceOfCall = async (
  api: Parameters<ToolRegistration["execute"]>[1],
  context: Parameters<ToolRegistration["execute"]>[2],
  fallback: string | undefined,
): Promise<string | undefined> => {
  try {
    const state = await api.snapshot(SubagentsDoc, context);

    return (
      (state === undefined
        ? undefined
        : conversationWorkspace(state, api.conversationId)?.object) ?? fallback
    );
  } catch {
    return fallback;
  }
};

/** Whether the calling conversation is a subagent's: it reports a needed sign-in to its parent, since only the root asks. */
const isSubagentCall = async (
  api: Parameters<ToolRegistration["execute"]>[1],
  context: Parameters<ToolRegistration["execute"]>[2],
): Promise<boolean> => {
  try {
    const state = await api.snapshot(SubagentsDoc, context);
    const agent = state === undefined ? undefined : agentOf(state, api.conversationId);

    return agent !== undefined && agent !== "root";
  } catch {
    return false;
  }
};

/** The tool that calls `tool` of `server` through `client`. */
const toolFor = (
  client: McpHostClientService,
  origin: McpCallOrigin,
  server: McpBuildServer,
  tool: ToolDeclaration,
  name: string,
  exposure: Exclude<McpExposure, "hidden">,
  options: McpToolOptions,
): ToolRegistration => {
  const base = baseDetails(server.name, tool);
  const wait = waitOf(server, options.slackMs ?? MCP_CALL_SLACK_MS);

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
      // A rerun after a restart: the request was sent once, so the call may have run, and is never sent again.
      if ((await api.memo<boolean>(SENT, context)) !== undefined)
        return interruptedResult(name, base);

      // An HTTP server is called from the Session's Workspace, as it always was. A stdio server runs in the Container of the
      // Workspace that calls it: a conversation in a Subagent Workspace calls for it, not for the Session's, and the
      // Workspace is marked used before the call that may start the Container.
      let workspace = origin.workspace;

      if (server.server.type === "stdio") {
        workspace = await workspaceOfCall(api, context, origin.workspace);

        const ready = workspace !== undefined && (await (options.ready?.(workspace) ?? true));

        if (!ready) {
          return failedWith(
            "The Workspace this server runs in did not answer; the call was not sent",
            base,
          );
        }
      }

      const lost = await Effect.runPromise(
        pausableDeadline(wait, () => new Error("The Session gave up on the host")),
      );

      const stopped = context.abortSignal === undefined ? [] : [context.abortSignal];

      const { questions } = options;

      // A server's question waits for the owner while the call's clock stands still, and Stop withdraws it.
      const asking =
        questions === undefined
          ? undefined
          : elicitingHooks({
              questions,
              server: server.name,
              tool: name,
              callId: api.callId,
              conversationId: api.conversationId,
              signal: context.abortSignal,
              source: server.source,
              pause: lost.pause,
              resume: lost.resume,
            });

      const hooks: Mutable<McpHostRequestHooks> = {
        // Stop, or the Session giving up on the host: either way the host cancels the call.
        untilAborted: () => abortedBy([...stopped, lost.signal]),
        // Progress resets the timeout and rides in the running call's `details`, which the web does not draw: never
        // output text, and gone from the settled call's `details`.
        onProgress: (progress) =>
          Effect.runPromise(lost.reset).then(() =>
            api.details({ ...base, progress }, context).catch(() => undefined),
          ),
      };

      if (asking !== undefined) {
        hooks.onInput = asking.onInput;
        hooks.onInputEnded = asking.onInputEnded;
      }

      const request = requestOf(
        { ...origin, workspace },
        server.name,
        tool.name,
        // SAFETY: the arguments pi-durable validated against the tool's `inputSchema`, an object.
        args as JsonObject,
        { callId: api.callId, conversation: String(api.conversationId) },
        questions === undefined ? undefined : ELICITATION_ANSWERS,
      );

      // Durable before the request leaves, so a restart finds the call sent.
      await api.memo(SENT, true, context);

      const finished = async (): Promise<ToolExecutionResult<JsonValue>> => {
        const result = await Promise.race([
          Effect.runPromise(client.request(request, hooks)),
          abortedBy([lost.signal]).then(() => undefined),
        ]).finally(() => Effect.runPromise(lost.clear));

        if (result === undefined || lost.signal.aborted || Predicate.isTagged(result, "HostLost")) {
          return hostLostResult(base);
        }

        if (!Predicate.isTagged(result, "Completed")) {
          return failureResult(result, base, { subagent: await isSubagentCall(api, context) });
        }

        // A script's call gets its value whole and no spill.
        const call: McpResultContext = (await isNested(api, context))
          ? { kind: "script", details: base }
          : { kind: "model", details: base, spill: spillTo(api.env, context) };

        const finish = (value: Schema.Json) => resultFor(value, result.structuredOutput, call);

        if (result.result.kind !== "stream") return finish(result.result.value);

        const limits: Mutable<StreamLimits> = {
          signal: context.abortSignal,
          idleMs: options.streamIdleMs ?? MCP_STREAM_IDLE_MS,
        };

        if (options.streamWaitMs !== undefined) limits.waitMs = options.streamWaitMs;

        // Over 1 MiB: the engine's bytes, which the host returned unread, are read here, and the result is cut to what the
        // model or the script gets before the decode slot is given up.
        return readStreamed(result.result.body, result.result.bytes, limits, async (streamed) => {
          if (streamed.kind === "aborted") return failedWith("The call was stopped", base);

          return streamed.kind === "value"
            ? finish(streamed.value)
            : streamFailure(streamed.kind, base);
        });
      };

      try {
        const result = await finished();

        // The call is over: a question it still waits on is withdrawn first, so `details` tells of it too.
        if (questions !== undefined) await Effect.runPromise(questions.settleCall(api.callId));

        await asking?.idle();

        return withElicitation(result, asking?.asked ?? []);
      } finally {
        // However it ended, nothing is left waiting (a second settle is a no-op).
        if (questions !== undefined) await Effect.runPromise(questions.settleCall(api.callId));
      }
    },
  };
};

/** What the `mcp` extension is built from: the host's servers with their tools, and the tools the settings offer. */
export type McpBuild = {
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly offered: ReadonlyArray<string>;
};

/**
 * The `mcp` extension over `build`: each server's tools (those its inventory lists) by their model-facing names
 * (`mcp__<server>__<tool>`), registered by their Exposure (`./exposure.ts`). A server switched off or `hidden`
 * registers nothing, nor does a tool whose `_meta` leaves the model out.
 */
export const mcpExtension = (
  build: McpBuild,
  client: McpHostClientService,
  origin: McpCallOrigin = {},
  options: McpToolOptions = {},
): Extension => {
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
        : Result.succeed(toolFor(client, origin, server, tool, name, exposure, options));
    });
  });

  const asking = signInTool(build.servers, client, options);

  return defineExtension({
    name: extensionName,
    tools: asking === undefined ? tools : [...tools, asking],
    sections: options.sections ?? [],
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
