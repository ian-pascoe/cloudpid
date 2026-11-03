// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off globalTimers:off -- builders over
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
  type McpHostRequest,
  type McpHostRequestHooks,
} from "@cloudpid/mcp/types";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import { exposureKeys, flagsOf, reachesModel } from "./exposure.ts";
import {
  failedWith,
  failureMessage,
  hostLostResult,
  type McpDetails,
  resultFor,
} from "./result.ts";

export const extensionName = "mcp";

/** A server's `timeout` when its entry has none, in seconds (`DEFAULT_MCP_TIMEOUT`). */
const DEFAULT_TIMEOUT_S = 60;

/**
 * How long past a call's timeout the Session waits for the host's answer before it reads the call as lost: 60 s, the
 * connects a call may make before it is sent (three when the server's era is in doubt, each up to
 * `MCP_CONNECT_TIMEOUT_MS`) and 15 s more for the RPCs, so the host answers first whenever it can.
 */
export const MCP_CALL_SLACK_MS = 3 * MCP_CONNECT_TIMEOUT_MS + 15_000;

/**
 * A server as the tools are built from it: its name, state, tools and `instructions`, and of its entry only what the
 * build reads (`timeout`, `description` and the Exposure keys), so what a Session keeps of a build never holds the
 * entry's URL, headers, `env` or OAuth, where a literal credential may be. Decoding an inventory's server drops the rest.
 */
export const McpBuildServer = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  discoveredAt: Schema.optionalKey(Schema.Finite),
  server: Schema.Struct({
    timeout: Schema.optionalKey(Schema.Json),
    description: Schema.optionalKey(Schema.Json),
    exposure: Schema.optionalKey(Schema.Json),
    toolExposure: Schema.optionalKey(Schema.Json),
  }),
  tools: Schema.Record(Schema.String, Schema.Json).pipe(Schema.Array, Schema.optionalKey),
  instructions: Schema.optionalKey(Schema.String),
});

export type McpBuildServer = typeof McpBuildServer.Type;

/** A tool of the inventory, as far as the Session reads it; the rest of its definition stays the host's. */
const ToolDeclaration = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.optionalKey(Schema.Json),
  _meta: Schema.optionalKey(Schema.Json),
});

type ToolDeclaration = typeof ToolDeclaration.Type;

const decodeTool = Schema.decodeUnknownOption(ToolDeclaration);

/** A tool's `inputSchema` as its parameters: an object schema, or a loose object for anything else. */
const parametersOf = (tool: ToolDeclaration): TSchema => {
  const schema = tool.inputSchema;

  // SAFETY: an object JSON Schema, which pi-ai's `TSchema` describes; TypeBox's are JSON Schema too.
  return (
    isJsonObject(schema) && schema["type"] === "object" ? schema : { type: "object" }
  ) as TSchema;
};

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
};

/** A promise that resolves when any of `signals` aborts, and never without one. */
const abortedBy = (signals: ReadonlyArray<AbortSignal>) =>
  new Promise<void>((resolve) => {
    for (const signal of signals) {
      if (signal.aborted) return resolve();

      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });

/** A deadline `ms` away, which `reset` moves `ms` from now; `signal` aborts when it passes. */
const deadline = (ms: number) => {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    reset: () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ms);
    },
    clear: () => clearTimeout(timer),
  };
};

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
): McpHostRequest => {
  const ctx: Mutable<McpHostRequest["ctx"]> = {
    origin: "agent",
    callId: call.callId,
    conversation: call.conversation,
  };

  if (origin.session !== undefined) ctx.session = origin.session;

  if (origin.workspace !== undefined) ctx.workspace = origin.workspace;

  return { op: "tools/call", server, params: { name: tool, arguments: args }, ctx };
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
  const base: Mutable<McpDetails> = { server: server.name, tool: tool.name };

  if (tool.title !== undefined) base.title = tool.title;

  const wait = waitOf(server, options.slackMs ?? MCP_CALL_SLACK_MS);

  return {
    name,
    description: tool.description ?? "",
    parameters: parametersOf(tool),
    ...flagsOf(exposure),
    execute: async (args, api, context) => {
      const lost = deadline(wait);
      const stopped = context.abortSignal === undefined ? [] : [context.abortSignal];

      const hooks: McpHostRequestHooks = {
        // Stop, or the Session giving up on the host: either way the host cancels the call.
        untilAborted: () => abortedBy([...stopped, lost.signal]),
        onProgress: (progress) => {
          lost.reset();

          return api.details({ ...base, progress }, context).catch(() => undefined);
        },
      };

      const request = requestOf(
        origin,
        server.name,
        tool.name,
        // SAFETY: the arguments pi-durable validated against the tool's `inputSchema`, an object.
        args as JsonObject,
        { callId: api.callId, conversation: String(api.conversationId) },
      );

      const result = await Promise.race([
        Effect.runPromise(client.request(request, hooks)),
        abortedBy([lost.signal]).then(() => undefined),
      ]).finally(lost.clear);

      if (result === undefined || lost.signal.aborted || Predicate.isTagged(result, "HostLost")) {
        return hostLostResult(base);
      }

      if (!Predicate.isTagged(result, "Completed")) {
        return failedWith(failureMessage(result), base);
      }

      if (result.result.kind === "stream") {
        // A result over 1 MiB comes as a stream, which the Session reads with #458; it is not read here.
        void result.result.body.cancel().catch(() => undefined);

        return failedWith(
          "The tool's result is over 1 MiB, which this build does not read yet",
          base,
        );
      }

      return resultFor(result.result.value, base);
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
    const listed = Arr.filterMap(server.tools ?? [], (tool) =>
      Result.fromOption(decodeTool(tool), () => undefined),
    );

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

  return defineExtension({ name: extensionName, tools });
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

/** The `mcp` extension with no tools: before the first build, and for a Session whose host offers none. */
export const emptyMcpExtension: Extension = defineExtension({ name: extensionName, tools: [] });
