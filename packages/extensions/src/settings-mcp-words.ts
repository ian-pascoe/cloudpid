// What the `settings_mcp` read tools say, as text (`docs/architecture/mcp-configuration.md` → The agent's changes → Lists,
// Results): the words of `settings_mcp_list`, `settings_mcp_get` and `settings_mcp_reload` over their values
// (`./settings-mcp-values.ts`). It says only what a value holds: never a resolved `${NAME}`, a hash or a token.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off globalDate:off -- text built from plain values.
import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";
import {
  GLOBAL_SETTINGS_SCOPE,
  type InventoryRead,
  type ListServerOutput,
  type McpSourceOutput,
  type SettingsMcpGetOutput,
  type SettingsMcpListOutput,
  type Surface,
} from "@cloudpid/protocol/harness-tools";
import type { SettingsMcpReloadOutput } from "./settings-mcp-outputs.ts";

const INVENTORY_WORDS: Readonly<Record<typeof InventoryRead.Type, string>> = {
  read: "State, counts and tools are what the Environment's MCP host already holds; nothing was connected, discovered or started to read them.",
  global:
    "Global has no MCP host, so there is no state, no tool count and no protocol version here; an Environment's set has them (its own entries, Global's and its Repos').",
  no_servers: "The set has no servers, so no MCP host was asked.",
  host_unavailable: "The MCP host did not answer, so state and tools are not given.",
};

/** A time as text. */
const when = (ms: number): string => new Date(ms).toISOString();

const sourceWords = (source: typeof McpSourceOutput.Type): string => {
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

const SAMPLING_WORDS = new Map([
  ["ask", "the user is asked for each of the server's sampling requests"],
  ["allow", "the server may use the user's models without asking"],
  ["off", "sampling is not declared: the server cannot ask"],
]);

type ListServer = typeof ListServerOutput.Type;

/** A server's lines, as `settings_mcp_list` and `settings_mcp_get` say them. */
const serverLines = (server: ListServer): ReadonlyArray<string> => {
  const { inventory } = server;

  const lines = [
    `- ${server.name} (${server.transport}: ${server.target}), from ${sourceWords(server.source)}${server.replaces_global ? ", replacing Global's entry of the name" : ""}; tools are mcp__${server.name.toLowerCase().replaceAll("-", "_")}__*.`,
  ];

  if (server.description !== null) lines.push(`  Description: ${server.description}`);

  lines.push(
    `  enabled ${server.enabled.value} (${keyWords(server.enabled.from)}); exposure ${server.exposure.value} (${keyWords(server.exposure.from)}); ${server.tool_exposure.count} toolExposure ${server.tool_exposure.count === 1 ? "key" : "keys"} (${keyWords(server.tool_exposure.from)}); sampling ${server.sampling} (${SAMPLING_WORDS.get(server.sampling) ?? server.sampling}); timeout ${server.timeout} s.`,
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
export const scopeWords = (scope: { readonly id: string; readonly name: string }): string =>
  scope.id === GLOBAL_SETTINGS_SCOPE
    ? "Global"
    : `Environment ${JSON.stringify(scope.name)} (${scope.id})`;

/** The parts of a value that were cut to fit, by the `<field>_truncated` flags that are true. */
const cutNote = (value: Schema.Json): string | null => {
  const cut = new Set<string>();

  JSON.parse(JSON.stringify(value), (key: string, flag: Schema.Json) => {
    if (key.endsWith("_truncated") && flag === true) cut.add(key.slice(0, -"_truncated".length));

    return flag;
  });

  return cut.size === 0
    ? null
    : `Cut to fit: ${Arr.join(Arr.fromIterable(cut), ", ")} (the value's *_truncated flags say which).`;
};

/** A list's value, whichever surface gave it: only the Session's marks its own Scope. */
export const describeList = (out: Omit<typeof SettingsMcpListOutput.Type, "is_own">): string => {
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

  const cut = cutNote(out);

  if (cut !== null) lines.push(cut);

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

/**
 * A server's value, whichever surface gave it: only the Session's marks its own Scope; the endpoint's leaves out the entry
 * and the layers as written when they are too large.
 */
type GetShown = Omit<typeof SettingsMcpGetOutput.Type, "is_own" | "entry" | "layers"> & {
  readonly entry: Schema.Json | null;
  readonly layers: typeof SettingsMcpGetOutput.Type.layers & { readonly truncated?: boolean };
};

export const describeGet = (out: GetShown): string => {
  const lines = [
    `MCP server ${JSON.stringify(out.server.name)} of ${scopeWords(out.scope)}. ${INVENTORY_WORDS[out.inventory]}`,
    ...serverLines(out.server),
    `Entry in force (every default and adjustment applied, \${NAME} unresolved):\n${out.entry === null ? "too large to show here" : json(out.entry)}`,
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

  if (out.layers.truncated === true) lines.push("- a layer as written was too large to show here");

  if (
    out.layers.global === null &&
    out.layers.environment === null &&
    out.layers.repos.length === 0 &&
    out.layers.truncated !== true
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

  const cut = cutNote(out);

  if (cut !== null) lines.push(cut);

  return Arr.join(lines, "\n");
};

const OUTCOME_WORDS = new Map([
  ["changed", "read again: the file changed"],
  ["unchanged", "read again: unchanged"],
  ["absent", "has no such file: its servers are gone"],
  ["unreadable", "could not be read"],
  ["invalid", "was read, but is not usable: its servers are gone"],
  ["not_github", "is not on GitHub, so it is not read"],
  ["recent", "was looked at in the last 30 s, so it was not read again"],
]);

const PUSH_WORDS = {
  pushed: "The new set was sent to the Environment's MCP host.",
  not_needed: "The Environment's MCP host already has the set (or neither has any server).",
  failed:
    "The new set could not be sent to the Environment's MCP host: it gets it at its next Context Window, or at the next change.",
} as const;

export const describeReload = (
  out: typeof SettingsMcpReloadOutput.Type,
  surface: Surface = "session",
): string => {
  const owner = surface === "session" ? "user" : "owner";
  const lines = [`Reloaded the MCP servers of ${scopeWords(out.scope)}.`];

  if (out.repos.length === 0) lines.push("The Environment has no Repos, so no file was read.");

  for (const repo of out.repos) {
    lines.push(
      `- Repo ${repo.directory}${repo.slug === null ? "" : ` (${repo.slug})`}: ${repo.path} ${OUTCOME_WORDS.get(repo.outcome) ?? repo.outcome}${repo.outcome === "unreadable" ? `${repo.error === null ? "" : ` (${repo.error}${repo.error_since === null ? "" : ` since ${when(repo.error_since)}`})`}; ${repo.kept_copy ? `its last good copy is kept, so its servers still stand (only the ${owner}'s Reload drops it)` : "there is no copy of it"}` : ""}${repo.problem === null ? "" : `; the file ${repo.problem}`}.`,
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
    surface === "session"
      ? "Its tools follow from the next request of a Session in that Environment; the mcp_servers section keeps what it was for a Context Window. This is no Agent change: nothing is recorded."
      : "Its tools follow from the next request of a Session in that Environment. This is no Agent change: nothing is recorded.",
  );

  const cut = cutNote(out);

  if (cut !== null) lines.push(cut);

  return Arr.join(lines, "\n");
};
