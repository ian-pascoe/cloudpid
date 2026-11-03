// The `settings_mcp` extension (`docs/architecture/mcp-configuration.md` → The agent's changes; `docs/architecture/agent-changes.md`
// → MCP server changes): the agent's tools for the MCP servers of either Scope, as deferred tools of the root conversation
// only (`settings_` is in `PARENT_ONLY_TOOL_PREFIXES`), in an extension of their own and not in `mcp`, which is rebuilt
// whenever the inventory changes. Here are its three read-only tools: `settings_mcp_list`, `settings_mcp_get` and
// `settings_mcp_reload`. The seven that change servers (`add`, `update`, `remove`, `enable`, `disable`, `exposure_set` and
// `tool_exposure_set`) join this extension, and are not built yet.
//
// What the tools read has two sources, neither of which connects to a server or wakes a Container. The Registry
// (`SettingsMcpAccess`) gives the configuration: the Scope's servers as the owner's set resolves them, where each key comes
// from, what each `${NAME}` reads (`secret`, `variable` or `missing`, never its value), the MCP sign-in, the problems and
// the Repos' files. The Environment's `McpHost`, through `McpHostClient.servers` (no Workspace, no wait), gives the
// inventory: the state, the tools and the negotiated protocol version. A Session reaches its own Environment's host only,
// so at another Scope, and at Global, which has none, the inventory fields are null. Nothing they give holds a resolved value
// or a hash.
//
// A reload reads the Repos' files again, under the throttle the scheduled looks share, then (for this Session's Environment,
// which it alone can reach) pushes the set the Registry now computes to the host, since the Registry never calls out, and has
// the host drop its eras and Legacy sessions and rediscover its HTTP servers at once. It is no Agent change.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferSchemaOverJson:off globalDate:off -- builders over plain values; values pretty-printed for a result's text.
import {
  matchesToolPattern,
  type McpResolvedServer,
  type McpSource,
  mcpToolNames,
  mcpToolPrefix,
  resolveExposure,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  type McpApplySet,
  type McpServerInventory,
  type McpServerState,
  type McpSetRevision,
  readMcpServerState,
} from "@cloudpid/mcp/types";
import type {
  SettingsMcpEnvironment,
  SettingsMcpReload,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { McpHostClient, type McpHostClientService } from "./mcp/client.ts";
import { reachesModel } from "./mcp/exposure.ts";
import { asOutput, boundItems, boundText, outputSchema, scopeRef } from "./outputs.ts";
import { GLOBAL_SETTINGS_SCOPE, SettingsAccessError, SettingsScope } from "./settings.ts";
import {
  type ServerState,
  SettingsMcpGetOutput,
  SettingsMcpListOutput,
  SettingsMcpReloadOutput,
} from "./settings-mcp-outputs.ts";

export const extensionName = "settings_mcp";

/** The tools of the extension that are built: the read-only three. */
export const SETTINGS_MCP_READ_TOOLS = [
  "settings_mcp_list",
  "settings_mcp_get",
  "settings_mcp_reload",
] as const;

/** The most tools `settings_mcp_get` lists: the rest are counted. */
export const MAX_GET_TOOLS = 500;

/** The most of a server's `instructions` `settings_mcp_get` gives, in bytes. */
export const MAX_GET_INSTRUCTIONS_BYTES = 4 * 1024;

/** The most characters of a server's error `settings_mcp_list` and `_get` give. */
const MAX_ERROR_BYTES = 300;

/** The most the servers of a list, and the problems, weigh stored: the list is a part of a value that stays under 1 MiB. */
const MAX_LIST_BYTES = 512 * 1024;

const MAX_PROBLEMS_BYTES = 64 * 1024;

/**
 * The Registry's MCP read and the pushes of a changed set, as the Session reaches them. `view` and `reload` fail, saying
 * so, for an id no Environment has.
 */
export type SettingsMcpAccessService = {
  /** The MCP servers of `scope` (`*`, or an Environment's id), only `name`'s when given, with its layers as written. */
  readonly view: (input: {
    readonly scope: string;
    readonly name?: string | undefined;
  }) => Effect.Effect<SettingsMcpView, SettingsAccessError>;
  /** The Session's own Environment; null when the Registry does not list it. */
  readonly own: Effect.Effect<string | null, SettingsAccessError>;
  /** Look at `environment`'s Repos' files again, under the shared throttle, and what that made of the set. */
  readonly reload: (environment: string) => Effect.Effect<SettingsMcpReload, SettingsAccessError>;
  /** The sets the Registry has yet to hand `environment`'s host (`mcpPending`'s pushes for it), each with its revision. */
  readonly pushes: (
    environment: string,
  ) => Effect.Effect<ReadonlyArray<McpApplySet>, SettingsAccessError>;
  /** Tell the Registry its host took a set (`mcpPushed`), so it is not sent again. */
  readonly pushed: (
    input: McpSetRevision & { readonly environment: string },
  ) => Effect.Effect<void, SettingsAccessError>;
};

export class SettingsMcpAccess extends Context.Service<
  SettingsMcpAccess,
  SettingsMcpAccessService
>()("@cloudpid/extensions/settings-mcp/SettingsMcpAccess") {}

/** The MCP hints of a source, as an output gives it. */
const sourceOutput = (source: McpSource) =>
  source.kind === "repo"
    ? { kind: source.kind, directory: source.directory, slug: source.slug, path: source.path }
    : { kind: source.kind, directory: null, slug: null, path: null };

/** The Environments as a value gives them. */
const environmentsOutput = (environments: ReadonlyArray<SettingsMcpEnvironment> | undefined) =>
  Arr.map(environments ?? [], scopeRef);

/** The words a state of the host goes by: `sign_in` is `needs_sign_in`, and a state this build does not know reads as `failed`. */
const STATE_WORDS: Readonly<Record<McpServerState, typeof ServerState.Type>> = {
  not_discovered: "not_discovered",
  connecting: "connecting",
  connected: "connected",
  sign_in: "needs_sign_in",
  rejected: "sign_in_rejected",
  unavailable: "unavailable",
  failed: "failed",
  skipped: "skipped",
  disabled: "disabled",
  unknown: "failed",
};

const stateOf = (raw: string): typeof ServerState.Type => STATE_WORDS[readMcpServerState(raw)];

/** A tool of the inventory, as far as these tools read it. */
const Tool = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  annotations: Schema.optionalKey(Schema.Json),
  _meta: Schema.optionalKey(Schema.Json),
});

type Tool = typeof Tool.Type;

const decodeTool = Schema.decodeUnknownOption(Tool);

/** The tools the host's inventory gives for a server; those this build cannot read are left out. */
const toolsOf = (inventory: McpServerInventory | undefined): ReadonlyArray<Tool> =>
  Arr.filterMap(inventory?.tools ?? [], (tool) => Result.fromOption(decodeTool(tool), () => tool));

/** The model-facing names of `tools`, by the server's own name for each. */
const namesOf = (server: McpResolvedServer, tools: ReadonlyArray<Tool>) =>
  mcpToolNames(
    server.name,
    Arr.map(tools, (tool) => tool.name),
  );

/** The names of the inventory's prompts. */
const promptsOf = (inventory: McpServerInventory | undefined): ReadonlyArray<string> =>
  Arr.filterMap(inventory?.prompts ?? [], (prompt) =>
    Predicate.hasProperty(prompt, "name") && Predicate.isString(prompt.name)
      ? Result.succeed(prompt.name)
      : Result.failVoid,
  );

/** What the host's inventory could be read as, for a Scope. */
type InventoryRead = typeof SettingsMcpListOutput.Type.inventory;

/** What `McpHostClient.servers` gave for a Scope's servers, or why it was not asked. */
type Inventory = {
  readonly read: InventoryRead;
  readonly byName: ReadonlyMap<string, McpServerInventory>;
};

const notRead = (read: Exclude<InventoryRead, "read">): Inventory => ({
  read,
  byName: new Map(),
});

/**
 * The host's inventory of `view`'s servers, with `parts`. Asked only for this Session's own Environment, whose host a
 * Session reaches, and only when it has servers (a host is never woken for an Environment without any). It names no
 * Workspace and waits for nothing: it reads what the host holds, as the Settings page's status chips do, and starts no Container.
 */
const readInventory = (
  host: McpHostClientLike,
  input: {
    readonly view: SettingsMcpView;
    readonly own: string | null;
    readonly names?: ReadonlyArray<string>;
    readonly parts: ReadonlyArray<string>;
  },
): Effect.Effect<Inventory> =>
  Effect.gen(function* () {
    const { view } = input;

    if (view.scope === GLOBAL_SETTINGS_SCOPE) return notRead("global");

    if (view.scope !== input.own) return notRead("other_environment");

    if (view.servers.length === 0) return notRead("no_servers");

    const answer = yield* host.servers(
      input.names === undefined
        ? { parts: input.parts }
        : { names: input.names, parts: input.parts },
    );

    return Predicate.isTagged(answer, "HostFailed")
      ? notRead("host_unavailable")
      : {
          read: "read",
          byName: new Map(Arr.map(answer.servers, (server) => [server.name, server] as const)),
        };
  });

type McpHostClientLike = Pick<McpHostClientService, "servers" | "apply">;

/** The entry's Exposure keys, which decide each tool's. */
const exposureOf = ({ server }: McpResolvedServer) => ({
  exposure: server.exposure,
  toolExposure: server.toolExposure,
});

/** One tool's effective Exposure, and what decided it. */
const decide = (
  entry: SettingsMcpServer,
  offered: ReadonlyArray<string>,
  names: ReadonlyMap<string, string>,
  tool: Tool,
) =>
  resolveExposure({
    server: exposureOf(entry.server),
    tool: tool.name,
    modelName: names.get(tool.name) ?? tool.name,
    offered,
  });

/** The server's inventory as a value gives it: from the host's row, or what the entry alone says when it has none. */
const inventoryOutput = (
  entry: SettingsMcpServer,
  offered: ReadonlyArray<string>,
  inventory: McpServerInventory | undefined,
) => {
  const tools = toolsOf(inventory);
  const names = namesOf(entry.server, tools);

  const direct = Arr.filter(
    tools,
    (tool) => reachesModel(tool._meta) && decide(entry, offered, names, tool).exposure === "direct",
  ).length;

  const error =
    inventory?.error === undefined ? null : boundText(inventory.error, MAX_ERROR_BYTES).text;

  return {
    state:
      inventory === undefined
        ? entry.server.server.enabled
          ? ("not_discovered" as const)
          : ("disabled" as const)
        : stateOf(inventory.state),
    error,
    protocol_version: inventory?.protocolVersion ?? null,
    discovered_at: inventory?.discoveredAt ?? null,
    discovered_in: inventory?.discoveredIn ?? null,
    tools: inventory?.counts.tools ?? 0,
    direct,
    prompts: inventory?.counts.prompts ?? 0,
    resources_offered: inventory?.resources ?? false,
  };
};

/** A problem as a value gives it. */
const problemOutput = (problem: SettingsMcpView["problems"][number]) => ({
  source: sourceOutput(problem.source),
  server: problem.name,
  message: problem.message,
  reset: problem.reset ?? [],
});

/** The target of an entry: a stdio server's command line as written, an HTTP server's URL. */
const targetOf = ({ server }: McpResolvedServer): string =>
  server.type === "stdio" ? Arr.join([server.command, ...server.args], " ") : server.url;

/**
 * One server as `settings_mcp_list` gives it. `inventory` is `null` when the inventory was not read, `undefined` when it
 * was and the host holds no row for the server (the host was not handed the set yet).
 */
const listServerOutput = (
  entry: SettingsMcpServer,
  offered: ReadonlyArray<string>,
  inventory: McpServerInventory | undefined | null,
) => {
  const { server } = entry.server;

  return {
    name: entry.server.name,
    tool_prefix: mcpToolPrefix(entry.server.name),
    source: sourceOutput(entry.server.source),
    replaces_global: entry.server.replacesGlobal,
    shadowed: Arr.map(entry.server.shadowed, (hidden) => ({
      source: sourceOutput(hidden.source),
      name: hidden.name,
      differs: hidden.differs,
    })),
    transport: server.type,
    target: targetOf(entry.server),
    enabled: { value: server.enabled, from: entry.origins.enabled },
    exposure: { value: server.exposure, from: entry.origins.exposure },
    tool_exposure: { count: Record.size(server.toolExposure), from: entry.origins.toolExposure },
    sampling: server.sampling,
    timeout: server.timeout,
    description: server.description ?? null,
    reads: Arr.map(entry.reads, (read) => ({
      name: read.name,
      kind: read.kind,
      where: read.where,
      missing_in: environmentsOutput(read.missingIn),
    })),
    reset_fields: entry.resetFields,
    inventory: inventory === null ? null : inventoryOutput(entry, offered, inventory),
    sign_in:
      entry.signIn === null
        ? null
        : {
            status: entry.signIn.status,
            issuer_host: entry.signIn.issuerHost,
            scopes: Arr.filter((entry.signIn.scopes ?? "").split(/\s+/), (scope) => scope !== ""),
            client_kind: entry.signIn.clientKind,
          },
    problems: Arr.map(entry.problems, problemOutput),
    overridden_in: environmentsOutput(entry.overriddenIn),
    adjusted_in: environmentsOutput(entry.adjustedIn),
  };
};

/** The Scope of a view as a value gives it. */
const scopeOutput = (view: { readonly scope: string; readonly name: string }) =>
  scopeRef({ id: view.scope, name: view.name });

/** `settings_mcp_list`'s value. */
const listOutput = (view: SettingsMcpView, own: string | null, inventory: Inventory) => {
  const servers = boundItems(
    Arr.map(view.servers, (entry) =>
      listServerOutput(
        entry,
        view.offered,
        inventory.read === "read" ? inventory.byName.get(entry.server.name) : null,
      ),
    ),
    MAX_LIST_BYTES,
  );

  const problems = boundItems(Arr.map(view.problems, problemOutput), MAX_PROBLEMS_BYTES);

  return {
    scope: scopeOutput(view),
    is_own: view.scope === own,
    inventory: inventory.read,
    servers: servers.items,
    servers_truncated: servers.truncated,
    repos: Arr.map(view.repos, (repo) => ({
      directory: repo.repo,
      slug: repo.slug ?? null,
      path: repo.path,
      state: repo.state,
      blob: repo.blob ?? null,
      read_at: repo.readAt ?? null,
      looked_at: repo.lookedAt ?? null,
      error: repo.error ?? null,
      error_since: repo.errorSince ?? null,
      problem: repo.problem ?? null,
    })),
    orphans: Arr.map(view.orphans, (orphan) => ({
      source: sourceOutput(orphan.source),
      server: orphan.name,
      keys: orphan.keys,
    })),
    problems: problems.items,
    problems_truncated: problems.truncated,
    warnings: view.warnings,
  };
};

/** A tool's annotation hint: the boolean it gives, or null for none. */
const hintOf = (annotations: Schema.Json | undefined, key: string): boolean | null => {
  const value = Predicate.hasProperty(annotations, key) ? annotations[key] : undefined;

  return Predicate.isBoolean(value) ? value : null;
};

/** What decided a tool's Exposure, as a value gives it. */
const decidedBy = (reason: ReturnType<typeof resolveExposure>["reason"]) => {
  switch (reason.kind) {
    case "server":
      return { kind: reason.kind, key: null };
    case "offered":
      return { kind: reason.kind, key: reason.pattern };
    case "tool":
    case "pattern":
      return { kind: reason.kind, key: reason.key };
  }
};

/** One tool as `settings_mcp_get` lists it. */
const toolOutput = (
  entry: SettingsMcpServer,
  offered: ReadonlyArray<string>,
  names: ReadonlyMap<string, string>,
  inventory: McpServerInventory | undefined,
  tool: Tool,
) => {
  const decision = decide(entry, offered, names, tool);
  const { reason } = decision;

  const annotationTitle =
    Predicate.hasProperty(tool.annotations, "title") && Predicate.isString(tool.annotations.title)
      ? tool.annotations.title
      : null;

  return {
    name: tool.name,
    model_name: names.get(tool.name) ?? tool.name,
    title: tool.title ?? annotationTitle,
    exposure: decision.exposure,
    decided_by: decidedBy(reason),
    model_visible: reachesModel(tool._meta),
    hints: {
      read_only: hintOf(tool.annotations, "readOnlyHint"),
      destructive: hintOf(tool.annotations, "destructiveHint"),
      idempotent: hintOf(tool.annotations, "idempotentHint"),
      open_world: hintOf(tool.annotations, "openWorldHint"),
    },
    problems: Arr.filterMap(inventory?.problems ?? [], (problem) =>
      problem.tool === tool.name ? Result.succeed(problem.problem) : Result.failVoid,
    ),
  };
};

/** The `toolExposure` keys of the entry that match none of `tools`: an exact name that is none's, a pattern that none matches. */
const unmatchedKeys = (
  entry: McpResolvedServer,
  tools: ReadonlyArray<Tool>,
): ReadonlyArray<string> =>
  Arr.filter(
    Record.keys(entry.server.toolExposure),
    (key) =>
      !Arr.some(tools, (tool) =>
        key.includes("*") ? matchesToolPattern(key, tool.name) : key === tool.name,
      ),
  );

/** `settings_mcp_get`'s value. */
const getOutput = (
  view: SettingsMcpView,
  entry: SettingsMcpServer,
  layers: NonNullable<SettingsMcpView["layers"]>,
  own: string | null,
  inventory: Inventory,
) => {
  const row = inventory.read === "read" ? inventory.byName.get(entry.server.name) : undefined;
  const tools = toolsOf(row);
  const names = namesOf(entry.server, tools);

  const listed = Arr.take(tools, MAX_GET_TOOLS);

  const instructions =
    row?.instructions === undefined
      ? null
      : boundText(row.instructions, MAX_GET_INSTRUCTIONS_BYTES);

  return {
    scope: scopeOutput(view),
    is_own: view.scope === own,
    inventory: inventory.read,
    server: listServerOutput(entry, view.offered, inventory.read === "read" ? row : null),
    // SAFETY: the entry in force is plain data; only its top-level optional keys may hold undefined, which are left out.
    entry: Record.filter(
      // SAFETY: the same entry, read as the record of its keys.
      entry.server.server as Readonly<Record<string, Schema.Json | undefined>>,
      Predicate.isNotUndefined,
    ) as Schema.Json,
    layers: {
      global: layers.global,
      environment: layers.environment,
      repos: Arr.map(layers.repos, (repo) => ({
        source: sourceOutput(repo.source),
        name: repo.name,
        kind: repo.kind,
        value: repo.value,
        shadowed: repo.shadowed,
      })),
    },
    tool_count: tools.length,
    tools: Arr.map(listed, (tool) => toolOutput(entry, view.offered, names, row, tool)),
    tools_truncated: tools.length > listed.length,
    unmatched_tool_exposure: row?.tools === undefined ? null : unmatchedKeys(entry.server, tools),
    prompts: promptsOf(row),
    instructions:
      instructions === null ? null : { text: instructions.text, truncated: instructions.truncated },
    status:
      row?.status === undefined
        ? null
        : {
            since: row.status.since,
            failures: row.status.failures,
            next_retry_at: row.status.nextRetryAt ?? null,
            last_ok_at: row.status.lastOkAt ?? null,
          },
    // The host does not report forms it declined for asking a credential yet (`mcp-configuration.md` → Lists).
    declined_forms: null,
    warnings: view.warnings,
  };
};

// ---- Words ----

const INVENTORY_WORDS: Readonly<Record<InventoryRead, string>> = {
  read: "State, counts and tools are what this Session's Environment's MCP host holds; nothing was connected or started to read them.",
  global:
    "Global has no MCP host, so there is no state, no tool count and no protocol version here; an Environment's set has them (its own entries, Global's and its Repos').",
  other_environment:
    "State and tools are not given: a Session reaches only its own Environment's MCP host and never wakes another's. Use this Session's own Environment's id for them.",
  no_servers: "The set has no servers, so no MCP host was asked.",
  host_unavailable: "The MCP host did not answer, so state and tools are not given.",
};

/** A time as text. */
const when = (ms: number): string => new Date(ms).toISOString();

const sourceWords = (source: ReturnType<typeof sourceOutput>): string => {
  switch (source.kind) {
    case "repo":
      return `Repo ${source.directory} (${source.path})`;
    case "global":
      return "Global";
    case "environment":
      return "this Environment";
  }
};

const READ_WORDS = { secret: "a Secret", variable: "a Variable", missing: "missing" } as const;

const keyWords = (from: string): string => from.replaceAll("_", " ");

const SAMPLING_WORDS: Readonly<Record<string, string>> = {
  ask: "the user is asked for each of the server's sampling requests",
  allow: "the server may use the user's models without asking",
  off: "sampling is not declared: the server cannot ask",
};

type ListServer = ReturnType<typeof listServerOutput>;

/** A server's lines, as `settings_mcp_list` and `settings_mcp_get` say them. */
const serverLines = (server: ListServer): ReadonlyArray<string> => {
  const { inventory } = server;

  const lines = [
    `- ${server.name} (${server.transport}: ${server.target}), from ${sourceWords(server.source)}${server.replaces_global ? ", replacing Global's entry of the name" : ""}; tools are mcp__${server.name.toLowerCase().replaceAll("-", "_")}__*.`,
  ];

  if (server.description !== null) lines.push(`  Description: ${server.description}`);

  lines.push(
    `  enabled ${server.enabled.value} (${keyWords(server.enabled.from)}); exposure ${server.exposure.value} (${keyWords(server.exposure.from)}); ${server.tool_exposure.count} toolExposure ${server.tool_exposure.count === 1 ? "key" : "keys"} (${keyWords(server.tool_exposure.from)}); sampling ${server.sampling} (${SAMPLING_WORDS[server.sampling] ?? server.sampling}); timeout ${server.timeout} s.`,
  );

  if (inventory !== null) {
    lines.push(
      `  State: ${inventory.state}${inventory.error === null ? "" : ` (${inventory.error})`}; ${inventory.tools} ${inventory.tools === 1 ? "tool" : "tools"} (${inventory.direct} direct), ${inventory.prompts} ${inventory.prompts === 1 ? "prompt" : "prompts"}, resources ${inventory.resources_offered ? "offered" : "not offered"}; ${inventory.protocol_version === null ? "no protocol version negotiated yet" : `protocol ${inventory.protocol_version}`}${inventory.discovered_at === null ? "; never discovered" : `; discovered ${when(inventory.discovered_at)}${inventory.discovered_in === null ? "" : ` in ${inventory.discovered_in}`}`}.`,
    );
  }

  for (const hidden of server.shadowed) {
    lines.push(
      `  Shadows the ${sourceWords(hidden.source)} entry "${hidden.name}"${hidden.differs ? ", which differs from it" : ""}.`,
    );
  }

  if (server.reads.length > 0) {
    lines.push(
      `  Reads: ${Arr.join(
        Arr.map(
          server.reads,
          (read) =>
            `\${${read.name}} is ${READ_WORDS[read.kind]} (${Arr.join(read.where, ", ")})${
              read.missing_in.length === 0
                ? ""
                : `, missing in ${Arr.join(
                    Arr.map(
                      read.missing_in,
                      (environment) => `${environment.name} (${environment.id})`,
                    ),
                    ", ",
                  )}`
            }`,
        ),
        "; ",
      )}.`,
    );
  }

  if (server.sign_in !== null) {
    lines.push(
      `  MCP sign-in: ${server.sign_in.status}${server.sign_in.issuer_host === null ? "" : `, issuer ${server.sign_in.issuer_host}`}${server.sign_in.scopes.length === 0 ? "" : `, scopes ${Arr.join(server.sign_in.scopes, " ")}`}${server.sign_in.client_kind === null ? "" : `, ${server.sign_in.client_kind} client`}.`,
    );
  }

  if (server.reset_fields.length > 0) {
    lines.push(
      `  This Environment's adjustments (settings_reset removes them): ${Arr.join(server.reset_fields, ", ")}.`,
    );
  }

  if (server.overridden_in.length > 0) {
    lines.push(
      `  Replaced by an Environment's own entry in: ${Arr.join(
        Arr.map(server.overridden_in, (each) => `${each.name} (${each.id})`),
        ", ",
      )}.`,
    );
  }

  if (server.adjusted_in.length > 0) {
    lines.push(
      `  Adjusted in: ${Arr.join(
        Arr.map(server.adjusted_in, (each) => `${each.name} (${each.id})`),
        ", ",
      )}.`,
    );
  }

  for (const problem of server.problems) lines.push(`  Problem: ${problem.message}`);

  return lines;
};

/** `scope` as a result says it. */
const scopeWords = (scope: { readonly id: string; readonly name: string }): string =>
  scope.id === GLOBAL_SETTINGS_SCOPE
    ? "Global"
    : `Environment ${JSON.stringify(scope.name)} (${scope.id})`;

const describeList = (out: ReturnType<typeof listOutput>): string => {
  const lines = [
    `MCP servers of ${scopeWords(out.scope)}: ${out.servers.length}${out.servers_truncated ? "+ (the list was cut)" : ""}. ${out.scope.id === GLOBAL_SETTINGS_SCOPE ? "Global's own entries only: an Environment's set adds its own entries and its Repos'. " : ""}${INVENTORY_WORDS[out.inventory]}`,
  ];

  for (const server of out.servers) lines.push(...serverLines(server));

  for (const repo of out.repos) {
    lines.push(
      `Repo ${repo.directory}${repo.slug === null ? "" : ` (${repo.slug})`}: ${repo.path} ${repo.state}${repo.blob === null ? "" : `, blob ${repo.blob.slice(0, 12)}`}${repo.read_at === null ? "" : `, read ${when(repo.read_at)}`}${repo.looked_at === null ? "" : `, looked at ${when(repo.looked_at)}`}${repo.error === null ? "" : `; last look failed${repo.error_since === null ? "" : ` since ${when(repo.error_since)}`}: ${repo.error}`}${repo.problem === null ? "" : `; the file ${repo.problem}`}.`,
    );
  }

  for (const orphan of out.orphans) {
    lines.push(
      `Adjustment with no server: ${orphan.server} (${Arr.join(orphan.keys, ", ")}) from ${sourceWords(orphan.source)}.`,
    );
  }

  // The problems of a server are on its lines; what is left is a file's, and an orphan's.
  const named = new Set(Arr.map(out.servers, (server) => server.name));

  for (const problem of out.problems) {
    if (problem.server !== null && named.has(problem.server)) continue;

    lines.push(
      `Problem (${sourceWords(problem.source)}${problem.server === null ? "" : `, ${problem.server}`}): ${problem.message}${problem.reset.length === 0 ? "" : ` Reset: ${Arr.join(problem.reset, ", ")}.`}`,
    );
  }

  for (const warning of out.warnings) lines.push(`Warning: ${warning}`);

  return Arr.join(lines, "\n");
};

const json = (value: Schema.Json): string => JSON.stringify(value, null, 2);

/** What decided a tool's Exposure, in words. */
const decidedWords = (decided: { readonly kind: string; readonly key: string | null }): string => {
  switch (decided.kind) {
    case "server":
      return "the server's exposure";
    case "offered":
      return `tools.offered ${JSON.stringify(decided.key)}`;
    case "tool":
      return `toolExposure name ${JSON.stringify(decided.key)}`;
    default:
      return `toolExposure pattern ${JSON.stringify(decided.key)}`;
  }
};

const describeGet = (out: ReturnType<typeof getOutput>): string => {
  const lines = [
    `MCP server ${JSON.stringify(out.server.name)} of ${scopeWords(out.scope)}. ${INVENTORY_WORDS[out.inventory]}`,
    ...serverLines(out.server),
    `Entry in force (every default and adjustment applied, \${NAME} unresolved):\n${json(out.entry)}`,
    "Layers as written:",
  ];

  if (out.layers.global !== null) {
    lines.push(`- Global's ${out.layers.global.kind}:\n${json(out.layers.global.value)}`);
  }

  if (out.layers.environment !== null) {
    lines.push(
      `- This Environment's ${out.layers.environment.kind}:\n${json(out.layers.environment.value)}`,
    );
  }

  for (const repo of out.layers.repos) {
    lines.push(
      `- ${sourceWords(repo.source)} ${repo.kind} "${repo.name}"${repo.shadowed ? " (shadowed: an owner's entry of the name wins)" : ""}:\n${json(repo.value)}`,
    );
  }

  if (
    out.layers.global === null &&
    out.layers.environment === null &&
    out.layers.repos.length === 0
  ) {
    lines.push("- none");
  }

  if (out.server.inventory === null) {
    lines.push("Tools: not given (see above).");
  } else {
    lines.push(
      `Tools (${out.tool_count}${out.tools_truncated ? `, the first ${out.tools.length} listed` : ""}):`,
    );

    for (const tool of out.tools) {
      lines.push(
        `- ${tool.name} → ${tool.model_name}${tool.title === null ? "" : ` ("${tool.title}")`}: ${tool.exposure}, by ${decidedWords(tool.decided_by)}${tool.model_visible ? "" : "; only an MCP App's View may call it"}${
          Arr.filter(
            ["read_only", "destructive", "idempotent", "open_world"] as const,
            (key) => tool.hints[key] === true,
          ).length === 0
            ? ""
            : `; hints: ${Arr.join(
                Arr.filter(
                  ["read_only", "destructive", "idempotent", "open_world"] as const,
                  (key) => tool.hints[key] === true,
                ),
                ", ",
              )}`
        }${Arr.join(
          Arr.map(tool.problems, (problem) => `; problem: ${problem}`),
          "",
        )}`,
      );
    }
  }

  if (out.unmatched_tool_exposure === null) {
    lines.push(
      "toolExposure keys that match no tool: not checked (the server's tools are not known).",
    );
  } else if (out.unmatched_tool_exposure.length > 0) {
    lines.push(
      `toolExposure keys that match no tool: ${Arr.join(out.unmatched_tool_exposure, ", ")} (a hidden key then hides nothing).`,
    );
  }

  if (out.prompts.length > 0) lines.push(`Prompts: ${Arr.join(out.prompts, ", ")}.`);

  if (out.instructions !== null) {
    lines.push(
      `Instructions (the server's own words${out.instructions.truncated ? ", cut" : ""}):\n${out.instructions.text}`,
    );
  }

  if (out.status !== null) {
    lines.push(
      `In its state since ${when(out.status.since)}; ${out.status.failures} failures in a row${out.status.next_retry_at === null ? "" : `; retried from ${when(out.status.next_retry_at)}`}${out.status.last_ok_at === null ? "" : `; last ok ${when(out.status.last_ok_at)}`}.`,
    );
  }

  lines.push("Forms declined for asking a credential: not reported by the host yet.");

  for (const warning of out.warnings) lines.push(`Warning: ${warning}`);

  return Arr.join(lines, "\n");
};

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  changed: "read again: the file changed",
  unchanged: "read again: unchanged",
  absent: "has no such file: its servers are gone",
  unreadable: "could not be read",
  invalid: "was read, but is not usable: its servers are gone",
  not_github: "is not on GitHub, so it is not read",
  recent: "was looked at in the last 30 s, so it was not read again",
};

const PUSH_WORDS = {
  pushed: "The new set was sent to the Environment's MCP host.",
  not_needed: "The Environment's MCP host already has the set.",
  not_attempted:
    "The set was not sent: a Session reaches only its own Environment's MCP host, which gets the set at its next Context Window.",
  failed:
    "The new set could not be sent to the Environment's MCP host: it gets it at its next Context Window, or at the next change.",
} as const;

const describeReload = (out: typeof SettingsMcpReloadOutput.Type): string => {
  const lines = [`Reloaded the MCP servers of ${scopeWords(out.scope)}.`];

  if (out.repos.length === 0) lines.push("The Environment has no Repos, so no file was read.");

  for (const repo of out.repos) {
    lines.push(
      `- Repo ${repo.directory}${repo.slug === null ? "" : ` (${repo.slug})`}: ${repo.path} ${OUTCOME_WORDS[repo.outcome] ?? repo.outcome}${repo.outcome === "unreadable" ? `${repo.error === null ? "" : ` (${repo.error}${repo.error_since === null ? "" : ` since ${when(repo.error_since)}`})`}; ${repo.kept_copy ? "its last good copy is kept, so its servers still stand (only the user's Reload drops it)" : "there is no copy of it"}` : ""}${repo.problem === null ? "" : `; the file ${repo.problem}`}.`,
    );
  }

  const { set } = out;

  lines.push(
    `The set has ${set.servers} ${set.servers === 1 ? "server" : "servers"}: ${Arr.join(
      [
        `added ${set.added.length === 0 ? "none" : Arr.join(set.added, ", ")}`,
        `removed ${set.removed.length === 0 ? "none" : Arr.join(set.removed, ", ")}`,
        `changed ${set.changed.length === 0 ? "none" : Arr.join(set.changed, ", ")}`,
      ],
      "; ",
    )}.`,
  );

  for (const problem of set.problems_added) lines.push(`New problem: ${problem}`);

  for (const problem of set.problems_cleared) lines.push(`Problem cleared: ${problem}`);

  lines.push(PUSH_WORDS[out.push]);

  lines.push(
    out.host.status === "reloaded"
      ? `The MCP host dropped its eras and Legacy sessions for ${Arr.join(out.host.servers, ", ")} and rediscovers their HTTP servers now.`
      : `The MCP host was not reloaded${out.host.note === null ? "" : `: ${out.host.note}`}.`,
  );

  lines.push(
    "Its tools follow from this Session's next request; the mcp_servers section keeps what it was for this Context Window. This is no Agent change: nothing is recorded.",
  );

  return Arr.join(lines, "\n");
};

// ---- The pushes ----

/**
 * Send the Environment's host the set the Registry has not handed it (`mcpPending`'s push for `environment`), as the main
 * Worker does after the owner's save: the Registry never calls out, so the Session carries the push of its own change
 * (`docs/architecture/mcp-configuration.md` → From the Registry to the host). It tells the Registry once the host took it.
 * `not_needed` when the host has the set (or holds a later one), `failed` when the push could not be made: nothing fails
 * the tool for it, and the host's next pull heals it.
 */
export const pushMcpSet = (
  access: SettingsMcpAccessService,
  host: McpHostClientLike,
  environment: string,
): Effect.Effect<"pushed" | "not_needed" | "failed"> =>
  Effect.gen(function* () {
    const sets = yield* access.pushes(environment);

    if (sets.length === 0) return "not_needed" as const;

    let sent = false;

    for (const set of sets) {
      const answer = yield* host.apply(set);

      if (Predicate.isTagged(answer, "Applied")) {
        yield* access.pushed({ environment, hash: set.hash, revision: set.revision });
        sent = true;
      } else if (!Predicate.isTagged(answer, "Stale")) {
        return "failed" as const;
      }
    }

    return sent ? ("pushed" as const) : ("not_needed" as const);
  }).pipe(Effect.orElseSucceed(() => "failed" as const));

// ---- The extension ----

const SCOPE_NOTE =
  "Give scope \"*\" for Global, which lists Global's own entries only, or an Environment's id (environment_list shows them) for its whole set: its own entries, Global's and each Repo's .pi/mcp.json.";

const NEVER_RESOLVED =
  "It shows each ${NAME} an entry reads as a Secret, a Variable or missing, never a value, and no hash. It connects to no server, starts no Container and wakes none: the state, tool counts and negotiated protocol version are what this Session's Environment's MCP host already holds, and are null at Global and at another Environment.";

/**
 * The `settings_mcp` extension: its read-only tools over the Session's `SettingsMcpAccess` (the Registry's MCP read) and
 * `McpHostClient` (the Environment's host).
 */
export const SettingsMcpTools: Effect.Effect<Extension, never, SettingsMcpAccess | McpHostClient> =
  Effect.gen(function* () {
    const access = yield* SettingsMcpAccess;
    const host = yield* McpHostClient;

    const list = yield* defineEffectTool({
      name: "settings_mcp_list",
      description: `List the MCP servers of one Scope: per server its name and tool prefix, its source (Global, the Environment, or a Repo's file), the Repo entries it shadows, its transport and target, enabled, Exposure and the count of toolExposure keys each with where it is written, its description, the \${NAME} values it reads (marked secret, variable or missing), the settings_reset fields the Environment holds for it, its connection state with tool, direct, prompt and resource counts, the negotiated protocol version and the last error, its MCP sign-in and its problems; then each Repo's file as last read, adjustments with no server, and warnings. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only. To change a server, load the settings_mcp tools that change them with tool_search; a Repo's .pi/mcp.json is edited as a file, in a pull request.`,
      parameters: Schema.Struct({ scope: SettingsScope }),
      structuredOutputSchema: outputSchema(SettingsMcpListOutput),
      replay: "safe",
      execute: ({ scope }) =>
        Effect.gen(function* () {
          const view = yield* access.view({ scope });
          const own = yield* access.own;
          const inventory = yield* readInventory(host, { view, own, parts: ["tools"] });
          const out = listOutput(view, own, inventory);

          return {
            output: [{ type: "text" as const, text: describeList(out) }],
            structuredOutput: asOutput(SettingsMcpListOutput, out),
            details: { scope: view.scope, servers: view.servers.length },
          };
        }),
    });

    const get = yield* defineEffectTool({
      name: "settings_mcp_get",
      description: `Show one MCP server of one Scope in full: its layers as written (Global's entry, the Environment's entry or adjustment, each Repo's, shadowed ones included), the entry in force, up to ${MAX_GET_TOOLS} of its tools each with its model-facing name, title, effective Exposure and what decided it (the server's, a toolExposure name or pattern, or tools.offered), its annotation hints and problems, the toolExposure keys that match none of its tools, its prompts, its own instructions (cut at 4 KiB), the negotiated protocol version, its sampling setting ("ask", "allow" or "off": whether it may use the user's models) and its state. name is the server in force in that Scope's set. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only.`,
      parameters: Schema.Struct({
        scope: SettingsScope,
        name: Schema.String.check(Schema.isMinLength(1)).annotate({
          description: "The server's name as settings_mcp_list shows it",
        }),
      }),
      structuredOutputSchema: outputSchema(SettingsMcpGetOutput),
      replay: "safe",
      execute: ({ scope, name }) =>
        Effect.gen(function* () {
          const view = yield* access.view({ scope, name });
          const own = yield* access.own;
          const entry = Arr.head(view.servers);

          if (Option.isNone(entry) || view.layers === null) {
            return yield* SettingsAccessError.make({
              message: `No MCP server ${JSON.stringify(name)} in ${scopeWords(scopeOutput(view))}. ${
                view.names.length === 0
                  ? "It has none."
                  : `Its servers: ${Arr.join(view.names, ", ")}.`
              }${
                view.scope === GLOBAL_SETTINGS_SCOPE
                  ? " Global lists its own entries only: a Repo's server is in the set of an Environment that has the Repo (give its id)."
                  : ""
              }`,
            });
          }

          const inventory = yield* readInventory(host, {
            view,
            own,
            names: [entry.value.server.name],
            parts: ["tools", "prompts", "instructions", "status"],
          });

          const out = getOutput(view, entry.value, view.layers, own, inventory);

          return {
            output: [{ type: "text" as const, text: describeGet(out) }],
            structuredOutput: asOutput(SettingsMcpGetOutput, out),
            details: { scope: view.scope, server: entry.value.server.name },
          };
        }),
    });

    const reload = yield* defineEffectTool({
      name: "settings_mcp_reload",
      description: `Read an Environment's Repos' .pi/mcp.json again (at most once per Repo each 30 seconds, a Repo looked at since being reported as recent), and have the Environment's MCP host drop its eras and Legacy sessions and rediscover its HTTP servers at once: for a server that is stuck, or a file that was just merged. It reports per Repo its directory, slug, path, outcome (changed, unchanged, absent, unreadable, invalid, not_github or recent), blob, read time and error; and for the set the servers added, removed and changed and the problems that appeared and cleared. A Repo that cannot be read keeps its last good copy: only the user's Reload on the Settings page drops it. scope is an Environment's id only ("*" is refused: Global has no Repos and no host). The host is reloaded only for this Session's own Environment. It is not an Agent change: no reason, no record, no Approval. A Repo's file is read on its default branch only, so a change on a branch shows once it is merged.`,
      parameters: Schema.Struct({ scope: SettingsScope }),
      structuredOutputSchema: outputSchema(SettingsMcpReloadOutput),
      replay: "safe",
      execute: ({ scope }) =>
        Effect.gen(function* () {
          if (scope === GLOBAL_SETTINGS_SCOPE) {
            return yield* SettingsAccessError.make({
              message:
                "settings_mcp_reload takes an Environment's id: Global has no Repos to read and no MCP host to reload. Give the id as environment_list shows it.",
            });
          }

          const own = yield* access.own;
          const report = yield* access.reload(scope);
          const ours = scope === own;

          const push = ours ? yield* pushMcpSet(access, host, scope) : ("not_attempted" as const);

          // A set with no server has nothing to rediscover, and the host is not woken for none.
          const reloaded =
            ours && report.servers > 0 ? yield* host.apply({ kind: "reload" }) : undefined;

          const hostOutput =
            reloaded === undefined
              ? {
                  status: "not_reached" as const,
                  servers: [],
                  note: ours
                    ? "the set has no servers"
                    : "a Session reaches only its own Environment's MCP host",
                }
              : Predicate.isTagged(reloaded, "Reloaded")
                ? { status: "reloaded" as const, servers: reloaded.servers, note: null }
                : Predicate.isTagged(reloaded, "HostUnsupported")
                  ? {
                      status: "unsupported" as const,
                      servers: [],
                      note: "the host is an older build that does not reload yet: it heals at the next deploy",
                    }
                  : { status: "failed" as const, servers: [], note: "the host did not answer" };

          const out = {
            scope: scopeOutput({ scope: report.scope, name: report.name }),
            repos: Arr.map(report.repos, (repo) => ({
              directory: repo.directory,
              slug: repo.slug,
              path: repo.path,
              outcome: repo.outcome,
              blob: repo.blob,
              read_at: repo.readAt,
              error: repo.error,
              error_since: repo.errorSince,
              kept_copy: repo.keptCopy,
              problem: repo.problem,
            })),
            set: {
              servers: report.servers,
              added: report.set.added,
              removed: report.set.removed,
              changed: report.set.changed,
              problems_added: report.set.problemsAdded,
              problems_cleared: report.set.problemsCleared,
            },
            push,
            host: hostOutput,
          };

          return {
            output: [{ type: "text" as const, text: describeReload(out) }],
            structuredOutput: asOutput(SettingsMcpReloadOutput, out),
            details: { scope: report.scope, servers: report.servers },
          };
        }),
    });

    return defineExtension({ name: extensionName, tools: [list, get, reload] });
  });
