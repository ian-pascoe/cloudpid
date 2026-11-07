// `settings_mcp_list` and `settings_mcp_get` for both surfaces (`docs/architecture/mcp-endpoint.md` → Environment and
// Settings tools → Names and surfaces; `docs/architecture/mcp-configuration.md` → Lists): the in-session tools'
// descriptions, parameters and output schemas, which stay as they were (the snapshot in
// `packages/extensions/src/harness-session.test.ts` pins them), and the endpoint's, whose values are cut harder and name no
// Session's own Environment (`packages/extensions/src/settings-mcp-reads.ts`).
// @effect-diagnostics missingPipeableSignature:off

import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NextField } from "./field-page.ts";
import { ScopeRef, SettingsScope } from "./scope.ts";
import {
  InventoryRead,
  ListServerOutput,
  McpRepoOutput,
  OrphanOutput,
  ProblemOutput,
  SettingsMcpGetOutput,
  SettingsMcpListOutput,
} from "./settings-mcp-output.ts";
import { READ_ONLY } from "./surface.ts";

/** The most tools `settings_mcp_get` lists: the rest are counted. */
export const MAX_GET_TOOLS = 500;

/** The most of a server's `instructions` `settings_mcp_get` gives, in bytes of UTF-8 stored. */
export const MAX_GET_INSTRUCTIONS_BYTES = 4 * 1024;

const SCOPE_NOTE =
  "Give scope \"*\" for Global, which lists Global's own entries only, or an Environment's id (environment_list shows them) for its whole set: its own entries, Global's and each Repo's .pi/mcp.json.";

const NEVER_RESOLVED =
  "It reads the Registry and the Environment's MCP host's held inventory: it connects to no server and starts no Container. It shows each ${NAME} an entry reads as a Secret, a Variable or missing, never a value, and no hash. State, tool counts and the negotiated protocol version are what the host already holds (none for Global, or for an Environment with no servers).";

/** `settings_mcp_list` on the endpoint: no Scope is marked a Session's own; each part is cut harder. */
export const SettingsMcpListEndpointOutput = Schema.Struct({
  ...NextField,
  scope: ScopeRef,
  inventory: InventoryRead,
  servers: Schema.Array(ListServerOutput),
  servers_truncated: Schema.Boolean.annotate({
    description: "servers was cut: the list was too large to give",
  }),
  repos: Schema.Array(McpRepoOutput).annotate({
    description: "At an Environment: each Repo's .pi/mcp.json as last looked at; empty at Global",
  }),
  repos_truncated: Schema.Boolean.annotate({ description: "repos was cut" }),
  orphans: Schema.Array(OrphanOutput),
  orphans_truncated: Schema.Boolean.annotate({ description: "orphans was cut" }),
  problems: Schema.Array(ProblemOutput).annotate({
    description: "Every problem of the set, a Repo file's own included",
  }),
  problems_truncated: Schema.Boolean.annotate({ description: "problems was cut" }),
  warnings: Schema.Array(Schema.String),
  warnings_truncated: Schema.Boolean.annotate({ description: "warnings was cut" }),
});

/**
 * `settings_mcp_get` on the endpoint: no Scope is marked a Session's own, each part is cut harder, and the entry and the
 * layers as written, which an entry limit alone bounds, are left out (`entry_truncated`, `layers.truncated`) when they
 * would not fit.
 */
export const SettingsMcpGetEndpointOutput = Schema.Struct({
  ...Struct.omit(SettingsMcpGetOutput.fields, ["is_own", "entry", "layers"]),
  ...NextField,
  entry: Schema.NullOr(Schema.Json).annotate({
    description:
      "The entry in force, every default and adjustment applied, ${NAME} unresolved; null when entry_truncated",
  }),
  entry_truncated: Schema.Boolean.annotate({ description: "entry was too large to give" }),
  layers: Schema.Struct({
    ...SettingsMcpGetOutput.fields.layers.fields,
    truncated: Schema.Boolean.annotate({
      description:
        "A layer as written was left out of global, environment or repos: it was too large",
    }),
  }),
});

export const settingsMcpList = {
  name: "settings_mcp_list",
  annotations: READ_ONLY,
  session: {
    description: `List the MCP servers of one Scope: per server its name and tool prefix, its source (Global, the Environment, or a Repo's file), the Repo entries it shadows, its transport and target, enabled, Exposure and the count of toolExposure keys each with where it is written, its description, the \${NAME} values it reads (marked secret, variable or missing), the settings_reset fields the Environment holds for it, its connection state with tool, direct, prompt and resource counts, the negotiated protocol version and the last error, its MCP sign-in and its problems; then each Repo's file as last read, adjustments with no server, and warnings. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only. To change a server, load the settings_mcp tools that change them with tool_search; a Repo's .pi/mcp.json is edited as a file, in a pull request.`,
    input: Schema.Struct({ scope: SettingsScope }),
    output: SettingsMcpListOutput,
  },
  endpoint: {
    description: `List the MCP servers of one Scope: per server its name and tool prefix, its source (Global, the Environment, or a Repo's file), the Repo entries it shadows, its transport and target, enabled, Exposure and the count of toolExposure keys each with where it is written, its description, the \${NAME} values it reads (marked secret, variable or missing), its connection state with tool, direct, prompt and resource counts, the negotiated protocol version and the last error, its MCP sign-in and its problems; then each Repo's file as last read, adjustments with no server, and warnings. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only. The answer is cut to a size a client can read (_truncated); settings_mcp_get shows one server in full. A Repo's .pi/mcp.json is edited as a file, in a pull request.`,
    input: Schema.Struct({ scope: SettingsScope }),
    output: SettingsMcpListEndpointOutput,
  },
} as const;

const ServerName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The server's name as settings_mcp_list shows it",
});

export const settingsMcpGet = {
  name: "settings_mcp_get",
  annotations: READ_ONLY,
  session: {
    description: `Show one MCP server of one Scope in full: its layers as written (Global's entry, the Environment's entry or adjustment, each Repo's, shadowed ones included), the entry in force, up to ${MAX_GET_TOOLS} of its tools each with its model-facing name, title, effective Exposure and what decided it (the server's, a toolExposure name or pattern, or tools.offered), its annotation hints and problems, the toolExposure keys that match none of its tools, its prompts, its own instructions (cut at 4 KiB), the negotiated protocol version, its sampling setting ("ask", "allow" or "off": whether it may use the user's models) and its state. name is the server in force in that Scope's set. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only.`,
    input: Schema.Struct({ scope: SettingsScope, name: ServerName }),
    output: SettingsMcpGetOutput,
  },
  endpoint: {
    description: `Show one MCP server of one Scope in full: its layers as written (Global's entry, the Environment's entry or adjustment, each Repo's, shadowed ones included), the entry in force, up to ${MAX_GET_TOOLS} of its tools each with its model-facing name, title, effective Exposure and what decided it (the server's, a toolExposure name or pattern, or tools.offered), its annotation hints and problems, the toolExposure keys that match none of its tools, its prompts, its own instructions (cut at 4 KiB), the negotiated protocol version, its sampling setting ("ask", "allow" or "off": whether it may use the owner's models) and its state. name is the server in force in that Scope's set. ${SCOPE_NOTE} ${NEVER_RESOLVED} Read-only. The answer is cut to a size a client can read: a part that is cut says so (_truncated).`,
    input: Schema.Struct({ scope: SettingsScope, name: ServerName }),
    output: SettingsMcpGetEndpointOutput,
  },
} as const;
