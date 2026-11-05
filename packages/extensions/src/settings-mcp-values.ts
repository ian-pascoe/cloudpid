// What the `settings_mcp` read tools give programs (`docs/architecture/mcp-configuration.md` → The agent's changes → Lists,
// Results): each tool's value (`SettingsMcpListOutput`, `SettingsMcpGetOutput`, `SettingsMcpReloadOutput`) built from the
// Registry's view (`SettingsMcpView`, `SettingsMcpReload`) and the host's inventory. Nothing here holds a resolved `${NAME}`
// value, a hash or a token. Every list that can grow is cut by the bytes it weighs stored, with a `<field>_truncated`
// flag, so that a value stays under 1 MiB (`docs/architecture/agent-capabilities.md` → Bounds).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off globalDate:off -- builders over plain values.
import {
  matchesToolPattern,
  type McpResolvedServer,
  type McpSource,
  mcpToolNames,
  mcpToolPrefix,
  resolveExposure,
} from "@cloudpid/config";
import {
  type McpServerInventory,
  type McpServerState,
  readMcpServerState,
} from "@cloudpid/mcp/types";
import type {
  SettingsMcpEnvironment,
  SettingsMcpReload,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { reachesModel } from "./mcp/exposure.ts";
import { boundItems, boundText, scopeRef } from "./outputs.ts";
import type {
  InventoryRead,
  ServerState,
  ListServerOutput,
  SettingsMcpGetOutput,
  SettingsMcpReloadOutput,
} from "./settings-mcp-outputs.ts";

/** The most of a server's error the values give, in bytes stored. */
const MAX_ERROR_BYTES = 300;

/** The most tools `settings_mcp_get` lists: the rest are counted. */
export const MAX_GET_TOOLS = 500;

/** The most of a server's `instructions` `settings_mcp_get` gives, in bytes of UTF-8 stored. */
export const MAX_GET_INSTRUCTIONS_BYTES = 4 * 1024;

/**
 * What each growable part of a value weighs at most, stored (`docs/architecture/agent-capabilities.md` → Bounds). Each
 * tool's parts add up to well under 1 MiB: `settings_mcp_list` at most 432 KiB (servers, problems, repos, orphans,
 * warnings), `settings_mcp_reload` at most 176 KiB, and `settings_mcp_get` at most about 520 KiB (tools, prompts,
 * unmatched keys, warnings, the layers, and its one server's own lists, about 80 KiB, with the entry in force, 16 KiB,
 * and the two owner layers, 32 KiB, which the entry limit keeps).
 */
export const BOUNDS = {
  /** `settings_mcp_list`'s servers; its other parts (below) add 192 KiB at most. */
  servers: 256 * 1024,
  problems: 64 * 1024,
  repos: 64 * 1024,
  orphans: 32 * 1024,
  warnings: 16 * 1024,
  /** `settings_mcp_get`'s tools, and below them its prompts, unmatched keys and the Repos' layers of the server. */
  tools: 192 * 1024,
  layers: 128 * 1024,
  prompts: 32 * 1024,
  unmatched: 16 * 1024,
  /** One server's own lists (reads, what it shadows, problems, and the Environments named at Global), each. */
  perServer: 8 * 1024,
  /** The Environments one `${NAME}` read is missing in, at Global, each. */
  missingIn: 2 * 1024,
  /** What a reload names: servers added, removed and changed, each; its problems, each. */
  names: 16 * 1024,
  reloadProblems: 32 * 1024,
} as const;

/** The MCP hints of a source, as an output gives it. */
export const sourceOutput = (source: McpSource) =>
  source.kind === "repo"
    ? { kind: source.kind, directory: source.directory, slug: source.slug, path: source.path }
    : { kind: source.kind, directory: null, slug: null, path: null };

/** The Environments as a value gives them. */
const environmentsOutput = (
  environments: ReadonlyArray<SettingsMcpEnvironment> | undefined,
  maxBytes: number,
) => {
  const bounded = boundItems(Arr.map(environments ?? [], scopeRef), maxBytes);

  return { items: bounded.items, truncated: bounded.truncated };
};

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

/** What `McpHostClient.servers` gave for a Scope's servers, or why it was not asked. */
export type Inventory = {
  readonly read: typeof InventoryRead.Type;
  readonly byName: ReadonlyMap<string, McpServerInventory>;
};

/** An inventory that was not read, and why. */
export const notRead = (read: Exclude<typeof InventoryRead.Type, "read">): Inventory => ({
  read,
  byName: new Map(),
});

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
export const inventoryOutput = (
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
): typeof ListServerOutput.Type => {
  const { server } = entry.server;

  const shadowed = boundItems(
    Arr.map(entry.server.shadowed, (hidden) => ({
      source: sourceOutput(hidden.source),
      name: hidden.name,
      differs: hidden.differs,
    })),
    BOUNDS.perServer,
  );

  const reads = boundItems(
    Arr.map(entry.reads, (read) => {
      const missing = environmentsOutput(read.missingIn, BOUNDS.missingIn);

      return {
        name: read.name,
        kind: read.kind,
        where: read.where,
        missing_in: missing.items,
        missing_in_truncated: missing.truncated,
      };
    }),
    BOUNDS.perServer,
  );

  const problems = boundItems(Arr.map(entry.problems, problemOutput), BOUNDS.perServer);
  const overridden = environmentsOutput(entry.overriddenIn, BOUNDS.perServer);
  const adjusted = environmentsOutput(entry.adjustedIn, BOUNDS.perServer);

  return {
    name: entry.server.name,
    tool_prefix: mcpToolPrefix(entry.server.name),
    source: sourceOutput(entry.server.source),
    replaces_global: entry.server.replacesGlobal,
    shadowed: shadowed.items,
    shadowed_truncated: shadowed.truncated,
    transport: server.type,
    target: targetOf(entry.server),
    enabled: { value: server.enabled, from: entry.origins.enabled },
    exposure: { value: server.exposure, from: entry.origins.exposure },
    tool_exposure: { count: Record.size(server.toolExposure), from: entry.origins.toolExposure },
    sampling: server.sampling,
    timeout: server.timeout,
    description: server.description ?? null,
    reads: reads.items,
    reads_truncated: reads.truncated,
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
    problems: problems.items,
    problems_truncated: problems.truncated,
    overridden_in: overridden.items,
    overridden_in_truncated: overridden.truncated,
    adjusted_in: adjusted.items,
    adjusted_in_truncated: adjusted.truncated,
  };
};

/** The Scope of a view as a value gives it. */
export const scopeOutput = (view: { readonly scope: string; readonly name: string }) =>
  scopeRef({ id: view.scope, name: view.name });

/** `settings_mcp_list`'s value. */
export const listOutput = (view: SettingsMcpView, own: string | null, inventory: Inventory) => {
  const servers = boundItems(
    Arr.map(view.servers, (entry) =>
      listServerOutput(
        entry,
        view.offered,
        inventory.read === "read" ? inventory.byName.get(entry.server.name) : null,
      ),
    ),
    BOUNDS.servers,
  );

  const problems = boundItems(Arr.map(view.problems, problemOutput), BOUNDS.problems);

  const repos = boundItems(
    Arr.map(view.repos, (repo) => ({
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
    BOUNDS.repos,
  );

  const orphans = boundItems(
    Arr.map(view.orphans, (orphan) => ({
      source: sourceOutput(orphan.source),
      server: orphan.name,
      keys: orphan.keys,
    })),
    BOUNDS.orphans,
  );

  const warnings = boundItems(view.warnings, BOUNDS.warnings);

  return {
    scope: scopeOutput(view),
    is_own: view.scope === own,
    inventory: inventory.read,
    servers: servers.items,
    servers_truncated: servers.truncated,
    repos: repos.items,
    repos_truncated: repos.truncated,
    orphans: orphans.items,
    orphans_truncated: orphans.truncated,
    problems: problems.items,
    problems_truncated: problems.truncated,
    warnings: warnings.items,
    warnings_truncated: warnings.truncated,
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
export const getOutput = (
  view: SettingsMcpView,
  entry: SettingsMcpServer,
  layers: NonNullable<SettingsMcpView["layers"]>,
  own: string | null,
  inventory: Inventory,
): typeof SettingsMcpGetOutput.Type => {
  const row = inventory.read === "read" ? inventory.byName.get(entry.server.name) : undefined;
  const tools = toolsOf(row);
  const names = namesOf(entry.server, tools);

  // At most MAX_GET_TOOLS, and as many of them as weigh BOUNDS.tools stored.
  const listed = boundItems(
    Arr.map(Arr.take(tools, MAX_GET_TOOLS), (tool) =>
      toolOutput(entry, view.offered, names, row, tool),
    ),
    BOUNDS.tools,
  );

  const prompts = boundItems(promptsOf(row), BOUNDS.prompts);

  const unmatched =
    row?.tools === undefined
      ? null
      : boundItems(unmatchedKeys(entry.server, tools), BOUNDS.unmatched);

  const warnings = boundItems(view.warnings, BOUNDS.warnings);

  // Each Repo that defines the name: up to a file's worth of entries (16 KiB each), so by bytes.
  const layerRepos = boundItems(
    Arr.map(layers.repos, (repo) => ({
      source: sourceOutput(repo.source),
      name: repo.name,
      kind: repo.kind,
      value: repo.value,
      shadowed: repo.shadowed,
    })),
    BOUNDS.layers,
  );

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
      repos: layerRepos.items,
      repos_truncated: layerRepos.truncated,
    },
    tool_count: tools.length,
    tools: listed.items,
    tools_truncated: listed.items.length < tools.length,
    unmatched_tool_exposure: unmatched === null ? null : unmatched.items,
    unmatched_tool_exposure_truncated: unmatched?.truncated ?? false,
    prompts: prompts.items,
    prompts_truncated: prompts.truncated,
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
    warnings: warnings.items,
    warnings_truncated: warnings.truncated,
  };
};

/** How a reload went with the host, as `settings_mcp_reload` gives it. */
export type ReloadHost = typeof SettingsMcpReloadOutput.Type.host;

/** `settings_mcp_reload`'s value, from what the Registry's look found and what was sent to the host. */
export const reloadOutput = (
  report: SettingsMcpReload,
  push: typeof SettingsMcpReloadOutput.Type.push,
  host: ReloadHost,
): typeof SettingsMcpReloadOutput.Type => {
  const repos = boundItems(
    Arr.map(report.repos, (repo) => ({
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
    BOUNDS.repos,
  );

  const added = boundItems(report.set.added, BOUNDS.names);
  const removed = boundItems(report.set.removed, BOUNDS.names);
  const changed = boundItems(report.set.changed, BOUNDS.names);
  const problemsAdded = boundItems(report.set.problemsAdded, BOUNDS.reloadProblems);
  const problemsCleared = boundItems(report.set.problemsCleared, BOUNDS.reloadProblems);

  return {
    scope: scopeOutput(report),
    repos: repos.items,
    repos_truncated: repos.truncated,
    set: {
      servers: report.servers,
      added: added.items,
      added_truncated: added.truncated,
      removed: removed.items,
      removed_truncated: removed.truncated,
      changed: changed.items,
      changed_truncated: changed.truncated,
      problems_added: problemsAdded.items,
      problems_added_truncated: problemsAdded.truncated,
      problems_cleared: problemsCleared.items,
      problems_cleared_truncated: problemsCleared.truncated,
    },
    push,
    host,
  };
};
