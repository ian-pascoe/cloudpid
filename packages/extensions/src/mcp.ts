// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off -- builders over plain values, and
// pi-durable's Promise-based tool seam.
// The `mcp` extension (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Exposure; ADR-0030): one Session
// extension built from the Environment's MCP inventory, whose tools each call `McpHost.request({ op: "tools/call" })`.
// The Session reaches the host only through `McpHostClient`, whose live adapter is
// `apps/server/src/session/mcp-host.ts` and whose in-memory fake is `./mcp.testing.ts`.
//
// - **`McpTools`** is what the Session holds per runtime: at each request start it asks the host's `requestStart`
//   (skipped when the Environment has no MCP servers) and, when the inventory's `version`, the offered tools or the
//   host's features changed, builds the extension again from `servers({ parts: ["tools", "instructions"] })`; the
//   Session installs it with `codemode`, whose namespaces are the servers (`mcpNamespaces`), and `tool-search`. It
//   builds nothing until the host lists the features its tools use (`MCP_TOOL_FEATURES`), so an older host means no
//   MCP tools, never a failure.
// - **The build is pure** over the host's answer and the offered tools, so building over unchanged tools gives
//   byte-identical declarations, which keeps the provider's prompt cache (AGENTS.md → Prompt cache).
// - **Exposure** (`resolveExposure`) maps onto pi-durable's flags: `direct` is offered, `deferred` is `deferred`,
//   `codemode` is `callers: ["tools"]` and `deferred` (so neither in the `codemode` section's inline list nor
//   loadable by `tool_search`), and `hidden` is not registered, nor is a tool whose visibility leaves out the model.
// - **Calls** send the call's `untilAborted` and `onProgress` hooks and await the request for its whole length, so the
//   stubs outlive it; Stop aborts the call's context, which resolves `untilAborted`, and the host cancels. Progress
//   goes to the running call's `details`. Results are given to the model as text (images as images); the rest of
//   [_Calls and results_](docs/architecture/mcp-in-a-session.md) (spills, the script value, replay) comes with #458.
import {
  type McpExposure,
  mcpToolNames,
  normalizeMcpName,
  resolveExposure,
} from "@cloudpid/config";
import {
  isJsonObject,
  type JsonObject,
  type McpCaller,
  type McpHostCompleted,
  type McpHostRequest,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpProgress,
  type McpRequestStart,
  type McpRequestStartResult,
  type McpServerInventory,
  type McpServersRequest,
  type McpServersResult,
} from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type Extension,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import type { Mutable } from "effect/Types";

export const extensionName = "mcp";

/** The host's features the tool declarations use: none are built until the host lists both (`mcp.md` → Deploys). */
export const MCP_TOOL_FEATURES: ReadonlyArray<string> = ["inventory", "call"];

/** How long a Session's first request waits for servers with no inventory whose tools may be `direct`: 10 s. */
export const MCP_WAIT_MS = 10_000;

/**
 * `McpHost` as a Session calls it. Never fails: a host that cannot be reached, or answers with something this build
 * cannot read, is `HostFailed` (`readMcpRequestStartResult`, `readMcpServersResult`, `readMcpHostRequestResult`).
 */
export type McpHostClientService = {
  readonly requestStart: (input: McpRequestStart) => Effect.Effect<McpRequestStartResult>;
  readonly servers: (input: McpServersRequest) => Effect.Effect<McpServersResult>;
  /** A request with its hooks; the effect lasts as long as the request, so the hooks' stubs do too. */
  readonly request: (
    input: McpHostRequest,
    hooks: McpHostRequestHooks,
  ) => Effect.Effect<McpHostRequestResult>;
};

/** The Environment's `McpHost`, as the Session's `mcp` extension reaches it. */
export class McpHostClient extends Context.Service<McpHostClient, McpHostClientService>()(
  "@cloudpid/extensions/mcp/McpHostClient",
) {}

/** An Exposure as an entry spells it; `codemode-deferred` and anything this build does not know read as `codemode`. */
const ExposureWire = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Literals(["codemode", "deferred", "direct", "hidden"]),
    SchemaTransformation.transform({
      decode: (value): McpExposure =>
        value === "direct" || value === "deferred" || value === "hidden" ? value : "codemode",
      encode: (exposure) => exposure,
    }),
  ),
);

/** The Exposure keys of a server's entry in force; absent keys are the defaults. */
const ExposureKeys = Schema.Struct({
  exposure: ExposureWire.pipe(Schema.withDecodingDefaultKey(Effect.succeed("codemode"))),
  toolExposure: Schema.Record(Schema.String, ExposureWire).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});

const decodeExposureKeys = Schema.decodeUnknownOption(ExposureKeys);

/** A server's Exposure keys as its entry in force carries them; an entry this build cannot read has the defaults. */
const exposureKeys = (server: McpServerInventory) =>
  Option.getOrElse(decodeExposureKeys(server.server), () => ({
    exposure: "codemode" as const,
    toolExposure: {},
  }));

/** Whether `pattern`, an entry of `tools.offered`, can name a tool whose name starts with `prefix`. */
const mayName = (pattern: string, prefix: string): boolean => {
  if (!pattern.includes("*")) return pattern.startsWith(prefix);

  const head = pattern.slice(0, pattern.indexOf("*"));

  return prefix.startsWith(head) || head.startsWith(prefix);
};

/**
 * Whether any tool of `server` may be `direct`: its own Exposure, a `toolExposure` key, or an offered pattern that can
 * name one of its tools. A server none of whose tools can be is never waited for.
 */
export const mayBeDirect = (
  server: McpServerInventory,
  offered: ReadonlyArray<string>,
): boolean => {
  const { exposure, toolExposure } = exposureKeys(server);

  if (exposure === "hidden") return false;

  const prefix = `mcp__${normalizeMcpName(server.name)}__`;

  return (
    exposure === "direct" ||
    Arr.some(Record.values(toolExposure), (each) => each === "direct") ||
    Arr.some(offered, (pattern) => mayName(pattern, prefix))
  );
};

/** What an MCP tool's call keeps in `details`. */
type McpDetails = {
  readonly server: string;
  readonly tool: string;
  readonly title?: string;
  readonly progress?: McpProgress;
};

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

/** The part of a tool's `_meta` that says who sees it (MCP Apps). */
const Visibility = Schema.Struct({
  ui: Schema.Struct({ visibility: Schema.Array(Schema.String) }),
});

const decodeVisibility = Schema.decodeUnknownOption(Visibility);

/** A tool's `_meta.ui.visibility` (MCP Apps): absent, or unreadable, means the model and the App both see it. */
const reachesModel = (tool: ToolDeclaration): boolean =>
  Option.match(decodeVisibility(tool._meta), {
    onNone: () => true,
    onSome: ({ ui }) => ui.visibility.includes("model"),
  });

/** A tool's `inputSchema` as its parameters: an object schema, or a loose object for anything else. */
const parametersOf = (tool: ToolDeclaration): TSchema => {
  const schema = tool.inputSchema;

  // SAFETY: an object JSON Schema, which pi-ai's `TSchema` describes; TypeBox's are JSON Schema too.
  return (
    isJsonObject(schema) && schema["type"] === "object" ? schema : { type: "object" }
  ) as TSchema;
};

/** The flags of a registration for `exposure`; `hidden` is never registered. */
const flagsOf = (exposure: Exclude<McpExposure, "hidden">) => {
  switch (exposure) {
    case "direct":
      return {};
    case "deferred":
      return { deferred: true as const };
    case "codemode":
      return { callers: ["tools"] as const, deferred: true as const };
  }
};

/** A content block of a `tools/call` result, as far as the Session reads it. */
const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: Schema.Struct({ text: Schema.String }),
  }),
  Schema.Struct({ type: Schema.String }),
]);

type ContentBlock = typeof ContentBlock.Type;

/** A `tools/call` result; a block of a type this build does not know keeps only its type. */
const CallToolValue = Schema.Struct({
  content: Schema.Array(ContentBlock).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  structuredContent: Schema.optionalKey(Schema.Json),
  isError: Schema.optionalKey(Schema.Boolean),
});

const decodeCallTool = Schema.decodeUnknownOption(CallToolValue);

/** A content block as the model gets it (`docs/architecture/mcp-in-a-session.md` → Calls and results). */
const blockFor = (block: ContentBlock): TextContent | ImageContent => {
  if ("text" in block) return { type: "text", text: block.text };

  if ("data" in block) return { type: "image", data: block.data, mimeType: block.mimeType };

  if ("resource" in block) return { type: "text", text: block.resource.text };

  return { type: "text", text: `[${block.type} content omitted]` };
};

/** A `tools/call` result as the model gets it: its content, or its `structuredContent` as JSON when it has none. */
const resultFor = (value: Schema.Json, details: McpDetails): ToolExecutionResult<JsonValue> => {
  const decoded = decodeCallTool(value);

  if (Option.isNone(decoded)) {
    return failedWith("The server answered with a result this build cannot read", details);
  }

  const { content, structuredContent, isError = false } = decoded.value;

  const fallback =
    structuredContent === undefined
      ? isError
        ? "The tool failed with no message"
        : ""
      : JSON.stringify(structuredContent);

  const output: ReadonlyArray<TextContent | ImageContent> =
    content.length > 0 ? Arr.map(content, blockFor) : [{ type: "text", text: fallback }];

  const result: Mutable<ToolExecutionResult<JsonValue>> = { output: [...output], details };

  if (isError) result.isError = true;

  return result;
};

/** A call that ended without a result: its message, as an error the model reads. */
const failedWith = (message: string, details: McpDetails): ToolExecutionResult<JsonValue> => ({
  output: [{ type: "text", text: message }],
  isError: true,
  details,
});

/** What the model reads for a request that ended without a result. */
const failureMessage = (result: Exclude<McpHostRequestResult, McpHostCompleted>): string =>
  Match.value(result).pipe(
    Match.tag("CallFailed", ({ error }) =>
      Match.value(error).pipe(
        Match.tag("Cut", (cut) =>
          cut.mayHaveRun
            ? `The call was cut before its answer arrived; it may or may not have run. ${cut.message}`
            : cut.message,
        ),
        Match.orElse((other) => other.message),
      ),
    ),
    Match.orElse((other) => other.message),
  );

/** A promise that resolves when `signal` aborts, and never without one. */
const abortedBy = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal === undefined) return;

    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
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
  server: McpServerInventory,
  tool: ToolDeclaration,
  name: string,
  exposure: Exclude<McpExposure, "hidden">,
): ToolRegistration => {
  const base: Mutable<McpDetails> = { server: server.name, tool: tool.name };

  if (tool.title !== undefined) base.title = tool.title;

  return {
    name,
    description: tool.description ?? "",
    parameters: parametersOf(tool),
    ...flagsOf(exposure),
    execute: async (args, api, context) => {
      const hooks: McpHostRequestHooks = {
        untilAborted: () => abortedBy(context.abortSignal),
        onProgress: (progress) =>
          api.details({ ...base, progress }, context).catch(() => undefined),
      };

      const request = requestOf(
        origin,
        server.name,
        tool.name,
        // SAFETY: the arguments pi-durable validated against the tool's `inputSchema`, an object.
        args as JsonObject,
        { callId: api.callId, conversation: String(api.conversationId) },
      );

      const result = await Effect.runPromise(client.request(request, hooks));

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
  readonly servers: ReadonlyArray<McpServerInventory>;
  readonly offered: ReadonlyArray<string>;
};

/**
 * The `mcp` extension over `build`: each server's tools (those its inventory lists) by their model-facing names
 * (`mcp__<server>__<tool>`), registered by their Exposure. A server switched off or `hidden` registers nothing.
 */
export const mcpExtension = (
  build: McpBuild,
  client: McpHostClientService,
  origin: McpCallOrigin = {},
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

      return exposure === "hidden" || !reachesModel(tool)
        ? Result.failVoid
        : Result.succeed(toolFor(client, origin, server, tool, name, exposure));
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
  servers: ReadonlyArray<McpServerInventory>,
): ReadonlyArray<CodemodeNamespace> =>
  Arr.filterMap(servers, (server) => {
    if (server.discoveredAt === undefined || server.state === "disabled") return Result.failVoid;

    const name = `mcp__${normalizeMcpName(server.name)}`;
    const namespace: Mutable<CodemodeNamespace> = { name, prefix: name };
    const description = server.server["description"];

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

/** What a request start needs to know. */
export type McpRequestStartInput = {
  /**
   * The conversation the request is for, the Session, and its Workspace (`ws:<id>`): the tools it builds make their
   * calls for the Session and its Workspace. Not read when there are no servers.
   */
  readonly caller: McpCaller;
  /** How many MCP servers the Environment's set has, as the Session's Settings last said. */
  readonly servers: number;
  /** `tools.offered`. */
  readonly offered: ReadonlyArray<string>;
  /**
   * A call to the caller's Workspace, awaited before any host call that may reach the bridge for it: a fresh Workspace
   * marks itself then, so the host reads its `no_workspace` as destroyed only when it is
   * (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Request start).
   */
  readonly ready: Effect.Effect<void>;
};

/** What a Session holds of the MCP tools it built, for its runtime. */
export type McpToolsService = {
  /**
   * The request start: the `mcp` extension to install (with `codemode` and `tool-search`) when what it is built from
   * changed, or none to keep the one installed. Never fails: a host that fails keeps the tools built.
   */
  readonly requestStart: (input: McpRequestStartInput) => Effect.Effect<Option.Option<Extension>>;
  /** The servers of the extension last built, as `codemode` namespaces; none before the first build. */
  readonly namespaces: () => ReadonlyArray<CodemodeNamespace>;
};

/** What the tools were built from: none built, the host offered none, or a version for one offered set. */
type Built = {
  readonly key: string;
  readonly version: string | undefined;
  readonly namespaces: ReadonlyArray<CodemodeNamespace>;
};

/** What an extension is built from, as one key: equal keys build byte-identical extensions. */
const keyOf = (version: string, offered: ReadonlyArray<string>, features: ReadonlyArray<string>) =>
  JSON.stringify([
    version,
    offered,
    Arr.filter(features, (each) => MCP_TOOL_FEATURES.includes(each)),
  ]);

/** The key of a Session with no MCP tools: no servers, or a host that offers none. */
const NONE = "none";

/** The Session's `McpTools` over `client`, with nothing built yet. */
export const makeMcpTools = (client: McpHostClientService): McpToolsService => {
  let built: Built = { key: NONE, version: undefined, namespaces: [] };
  const opened = new Set<string>();

  /** Build again for `key` unless it is what is built. */
  const settle = (
    key: string,
    version: string | undefined,
    servers: ReadonlyArray<McpServerInventory>,
    extension: () => Extension,
  ) => {
    if (key === built.key) return Option.none<Extension>();

    built = { key, version, namespaces: mcpNamespaces(servers) };

    return Option.some(extension());
  };

  /** The servers a first request waits for: those with no inventory yet whose tools may be `direct`. */
  const waitFor = (offered: ReadonlyArray<string>) =>
    Effect.map(client.servers({ parts: [] }), (answer) =>
      Predicate.isTagged(answer, "HostFailed")
        ? []
        : Arr.map(
            Arr.filter(
              answer.servers,
              (server) => server.discoveredAt === undefined && mayBeDirect(server, offered),
            ),
            (server) => server.name,
          ),
    );

  const requestStart: McpToolsService["requestStart"] = Effect.fn("mcp.tools.request_start")(
    function* (input: McpRequestStartInput) {
      // No servers and no Resource watch: the host is never woken, and a set that emptied drops its tools.
      if (input.servers === 0) return settle(NONE, undefined, [], () => emptyMcpExtension);

      yield* input.ready;

      const known = built.version;
      const wanted = known === undefined ? yield* waitFor(input.offered) : [];
      const windowOpened = !opened.has(input.caller.conversation);

      const start: Mutable<McpRequestStart> = { caller: input.caller };

      if (windowOpened) start.windowOpened = true;

      if (known !== undefined) start.known = known;

      if (wanted.length > 0) {
        start.waitFor = wanted;
        start.waitMs = MCP_WAIT_MS;
      }

      const started = yield* client.requestStart(start);

      // A host that failed keeps the tools built: a request start never fails for it.
      if (Predicate.isTagged(started, "HostFailed")) return Option.none<Extension>();

      opened.add(input.caller.conversation);

      if (!Arr.every(MCP_TOOL_FEATURES, (feature) => started.features.includes(feature))) {
        return settle(NONE, undefined, [], () => emptyMcpExtension);
      }

      if (keyOf(started.version, input.offered, started.features) === built.key) {
        return Option.none<Extension>();
      }

      const inventory = yield* client.servers({ parts: ["tools", "instructions"] });

      if (Predicate.isTagged(inventory, "HostFailed")) return Option.none<Extension>();

      return settle(
        keyOf(inventory.version, input.offered, started.features),
        inventory.version,
        inventory.servers,
        () =>
          mcpExtension({ servers: inventory.servers, offered: input.offered }, client, {
            session: input.caller.session,
            workspace: input.caller.workspace,
          }),
      );
    },
  );

  return { requestStart, namespaces: () => built.namespaces };
};

/** The Session's MCP tools, for its runtime. */
export class McpTools extends Context.Service<McpTools, McpToolsService>()(
  "@cloudpid/extensions/mcp/McpTools",
) {}

/** `McpTools` over the Session's `McpHostClient`. */
export const mcpToolsOf = Effect.map(McpHostClient, makeMcpTools);
