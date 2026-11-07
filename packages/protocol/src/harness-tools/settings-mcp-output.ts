// What `settings_mcp_list` and `settings_mcp_get` give programs, as schemas (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions; `docs/architecture/mcp-configuration.md` → Lists): the in-session
// tools' output schemas, which `packages/extensions` builds each value for, kept here so one declaration serves both
// surfaces. Keys are snake_case and "none" is null. Nothing here holds a resolved `${NAME}` value, a hash or a token: an
// entry is as written, each `${NAME}` it reads is marked `secret`, `variable` or `missing`.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import { ScopeRef } from "./scope.ts";

/** Where a server, an entry or a problem comes from: Global, the Environment, or a Repo's file. */
export const McpSourceOutput = Schema.Struct({
  kind: Schema.Literals(["global", "environment", "repo"]).annotate({
    description:
      "global (Global's entry), environment (this Environment's own entry), or repo (a Repo's .pi/mcp.json)",
  }),
  directory: Schema.NullOr(Schema.String).annotate({
    description: "For a Repo's entry: the Repo's directory name in the Environment; otherwise null",
  }),
  slug: Schema.NullOr(Schema.String).annotate({
    description: "For a Repo's entry: its owner/repo on GitHub; otherwise null",
  }),
  path: Schema.NullOr(Schema.String).annotate({
    description: "For a Repo's entry: the file's path in the Repo; otherwise null",
  }),
});

/** Where a key's value in force is written. */
export const KeyFrom = Schema.Literals([
  "default",
  "global",
  "environment",
  "repo",
  "environment_adjustment",
  "repo_adjustment",
]).annotate({
  description:
    "default (written nowhere), global/environment/repo (in the entry that defines the server), or environment_adjustment/repo_adjustment (an adjustment over it)",
});

/** The states a server is in, as the host reports them. */
export const SERVER_STATES = [
  "connected",
  "connecting",
  "needs_sign_in",
  "sign_in_rejected",
  "unavailable",
  "failed",
  "disabled",
  "skipped",
  "not_discovered",
] as const;

export const ServerState = Schema.Literals(SERVER_STATES).annotate({
  description:
    "connected, connecting, needs_sign_in, sign_in_rejected (the server refused the token it was given), unavailable (unreachable for now, retried on demand), failed, disabled (switched off or hidden), skipped (its definition cannot be used yet, such as a ${NAME} that resolves to nothing) or not_discovered (never asked yet: a stdio server is discovered only in a Workspace's Container while it runs)",
});

/** One `${NAME}` an entry reads. */
export const ReadOutput = Schema.Struct({
  name: Schema.String.annotate({ description: "The name in ${NAME}" }),
  kind: Schema.Literals(["secret", "variable", "missing"]).annotate({
    description:
      "secret (a kept Secret has it: only an owner's entry reads Secrets), variable (an Environment Variable has it), or missing (neither: the server cannot use the value). Never the value",
  }),
  where: Schema.Array(Schema.String).annotate({
    description:
      "Where in the entry it is read: env.<KEY>, headers.<Name>, oauth.clientSecret or oauth.privateKey",
  }),
  missing_in: Schema.Array(ScopeRef).annotate({
    description:
      "At Global: the Environments where the name is neither a Secret nor a Variable; empty at an Environment",
  }),
  missing_in_truncated: Schema.Boolean.annotate({ description: "missing_in was cut" }),
});

/** A problem with an entry, an adjustment or a Repo's file. */
export const ProblemOutput = Schema.Struct({
  source: McpSourceOutput,
  server: Schema.NullOr(Schema.String).annotate({
    description: "The server's name; null for a Repo's file as a whole",
  }),
  message: Schema.String,
  reset: Schema.Array(Schema.String).annotate({
    description:
      "For an orphaned Environment adjustment: the Override fields settings_reset removes it with",
  }),
});

/** The MCP sign-in a server uses. */
export const SignInOutput = Schema.NullOr(
  Schema.Struct({
    status: Schema.String.annotate({
      description: "ok, required, step_up, rejected or refresh_failing",
    }),
    issuer_host: Schema.NullOr(Schema.String).annotate({
      description: "The host of the authorization server; the URL itself is never given",
    }),
    scopes: Schema.Array(Schema.String).annotate({ description: "The scopes granted" }),
    client_kind: Schema.NullOr(Schema.String).annotate({
      description:
        "configured, document, registered or client_grant (the server signs in on its own with client credentials); null for a row that only remembers a challenge",
    }),
  }),
).annotate({
  description:
    "The user's MCP sign-in the server uses; null for none (no sign-in applies, or none was made)",
});

/** A key of an entry in force and where it is written. */
const keyOf = <S extends Schema.Top>(value: S) => Schema.Struct({ value, from: KeyFrom });

/** What the host's inventory says of one server. */
export const InventoryOutput = Schema.NullOr(
  Schema.Struct({
    state: ServerState,
    error: Schema.NullOr(Schema.String).annotate({
      description: "What the host last failed with, cut to 300 characters; null for none",
    }),
    protocol_version: Schema.NullOr(Schema.String).annotate({
      description: "The MCP protocol version negotiated at initialize; null until discovered",
    }),
    discovered_at: Schema.NullOr(Schema.Finite).annotate({
      description: "When it was last discovered, in epoch milliseconds; null if never",
    }),
    discovered_in: Schema.NullOr(Schema.String).annotate({
      description:
        "A stdio server: the Workspace it was discovered in; null for an HTTP server or none",
    }),
    tools: Schema.Finite.annotate({ description: "The tools it offers" }),
    direct: Schema.Finite.annotate({
      description:
        "How many of its tools are offered to the model as direct tools, by Exposure and tools.offered",
    }),
    prompts: Schema.Finite.annotate({ description: "The MCP prompts it offers" }),
    resources_offered: Schema.Boolean.annotate({
      description: "It offers resources (the host says whether, not how many)",
    }),
  }),
).annotate({
  description:
    "The host's inventory of the server; null when the inventory was not read (see inventory on the list)",
});

/** What a listed server holds, for `settings_mcp_list`. */
export const ListServerOutput = Schema.Struct({
  name: Schema.String,
  tool_prefix: Schema.String.annotate({
    description: "The start of the model-facing names of its tools: mcp__<server>__",
  }),
  source: McpSourceOutput,
  replaces_global: Schema.Boolean.annotate({
    description: "An Environment's own entry that replaces Global's of the same name",
  }),
  shadowed: Schema.Array(
    Schema.Struct({
      source: McpSourceOutput,
      name: Schema.String,
      differs: Schema.Boolean.annotate({
        description: "The Repo's entry differs from the one that hides it",
      }),
    }),
  ).annotate({
    description:
      "The Repo entries this server hides: an owner's entry wins over a Repo's of the name",
  }),
  shadowed_truncated: Schema.Boolean.annotate({ description: "shadowed was cut" }),
  transport: Schema.Literals(["stdio", "http"]),
  target: Schema.String.annotate({
    description: "A stdio server's command line, as written; an HTTP server's URL",
  }),
  enabled: keyOf(Schema.Boolean),
  exposure: keyOf(Schema.String).annotate({
    description: "The server's Exposure: codemode, deferred, direct or hidden",
  }),
  tool_exposure: Schema.Struct({
    count: Schema.Finite.annotate({ description: "The keys of its toolExposure map" }),
    from: KeyFrom,
  }),
  sampling: Schema.String.annotate({
    description: "ask, allow or off: whether the server may use the user's models",
  }),
  timeout: Schema.Finite.annotate({ description: "Its timeout in seconds" }),
  description: Schema.NullOr(Schema.String),
  reads: Schema.Array(ReadOutput),
  reads_truncated: Schema.Boolean.annotate({ description: "reads was cut" }),
  reset_fields: Schema.Array(Schema.String).annotate({
    description:
      "The Override fields this Environment holds for it that settings_reset takes; empty at Global",
  }),
  inventory: InventoryOutput,
  sign_in: SignInOutput,
  problems: Schema.Array(ProblemOutput),
  problems_truncated: Schema.Boolean.annotate({ description: "problems was cut" }),
  overridden_in: Schema.Array(ScopeRef).annotate({
    description:
      "At Global: the Environments whose own entry of the name replaces Global's there; empty otherwise",
  }),
  overridden_in_truncated: Schema.Boolean.annotate({ description: "overridden_in was cut" }),
  adjusted_in: Schema.Array(ScopeRef).annotate({
    description:
      "At Global: the Environments that adjust this server (enabled, exposure or toolExposure); empty otherwise",
  }),
  adjusted_in_truncated: Schema.Boolean.annotate({ description: "adjusted_in was cut" }),
});

/** A Repo's file as last looked at. */
export const McpRepoOutput = Schema.Struct({
  directory: Schema.String,
  slug: Schema.NullOr(Schema.String),
  path: Schema.String,
  state: Schema.String.annotate({
    description:
      "never (not looked at yet), read, absent (no such file), oversize, unreadable (GitHub gave no answer: the last copy is kept), not_github or unknown",
  }),
  blob: Schema.NullOr(Schema.String).annotate({ description: "The blob SHA of the copy held" }),
  read_at: Schema.NullOr(Schema.Finite).annotate({
    description: "When the copy held was read, in epoch milliseconds",
  }),
  looked_at: Schema.NullOr(Schema.Finite).annotate({
    description: "When the Repo was last looked at, in epoch milliseconds",
  }),
  error: Schema.NullOr(Schema.String).annotate({ description: "Why the last look failed" }),
  error_since: Schema.NullOr(Schema.Finite).annotate({
    description: "Since when looks have been failing, in epoch milliseconds",
  }),
  problem: Schema.NullOr(Schema.String).annotate({
    description: "What is wrong with the file as a whole",
  }),
});

/** An adjustment with no server to adjust. */
export const OrphanOutput = Schema.Struct({
  source: McpSourceOutput,
  server: Schema.String,
  keys: Schema.Array(Schema.String),
});

/** Why the inventory fields are null, or that they are read. */
export const InventoryRead = Schema.Literals([
  "read",
  "global",
  "no_servers",
  "host_unavailable",
]).annotate({
  description:
    "read (from the Environment's MCP host, which holds the state it already has: nothing is connected or started to read it), global (Global has no host), no_servers (the set has none, so the host is not asked) or host_unavailable (the host did not answer)",
});

/** `settings_mcp_list`: the MCP servers of a Scope. */
export const SettingsMcpListOutput = Schema.Struct({
  scope: ScopeRef,
  is_own: Schema.Boolean.annotate({ description: "The Scope is this Session's own Environment" }),
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

/** A tool of a server, as `settings_mcp_get` lists it. */
export const ToolOutput = Schema.Struct({
  name: Schema.String.annotate({ description: "The tool's name as its server calls it" }),
  model_name: Schema.String.annotate({
    description: "Its model-facing name: mcp__<server>__<tool>",
  }),
  title: Schema.NullOr(Schema.String),
  exposure: Schema.String.annotate({
    description: "Its effective Exposure: codemode, deferred, direct or hidden",
  }),
  decided_by: Schema.Struct({
    kind: Schema.Literals(["server", "tool", "pattern", "offered"]).annotate({
      description:
        "server (the server's own exposure), tool (a toolExposure key that is its name), pattern (the first toolExposure pattern that matches) or offered (a tools.offered entry lifted it to direct)",
    }),
    key: Schema.NullOr(Schema.String).annotate({
      description:
        "The toolExposure key or tools.offered pattern; null when the server's exposure decided",
    }),
  }),
  model_visible: Schema.Boolean.annotate({
    description:
      "The model may see it: false for a tool only an MCP App's View may call (_meta.ui.visibility)",
  }),
  hints: Schema.Struct({
    read_only: Schema.NullOr(Schema.Boolean),
    destructive: Schema.NullOr(Schema.Boolean),
    idempotent: Schema.NullOr(Schema.Boolean),
    open_world: Schema.NullOr(Schema.Boolean),
  }).annotate({
    description:
      "The tool's annotation hints, which its server gives and nothing enforces; null for absent",
  }),
  problems: Schema.Array(Schema.String).annotate({ description: "Problems found at discovery" }),
});

/** One layer of a server as written. */
const WrittenOutput = Schema.NullOr(
  Schema.Struct({
    kind: Schema.Literals(["entry", "adjustment"]),
    value: Schema.Json.annotate({ description: "As written: ${NAME} unresolved" }),
  }),
);

/** `settings_mcp_get`: one server. */
export const SettingsMcpGetOutput = Schema.Struct({
  scope: ScopeRef,
  is_own: Schema.Boolean,
  inventory: InventoryRead,
  server: ListServerOutput,
  entry: Schema.Json.annotate({
    description: "The entry in force, every default and adjustment applied, ${NAME} unresolved",
  }),
  layers: Schema.Struct({
    global: WrittenOutput.annotate({ description: "Global's entry of the name, as written" }),
    environment: WrittenOutput.annotate({
      description: "This Environment's own entry or adjustment, as written",
    }),
    repos: Schema.Array(
      Schema.Struct({
        source: McpSourceOutput,
        name: Schema.String,
        kind: Schema.Literals(["entry", "adjustment"]),
        value: Schema.Json,
        shadowed: Schema.Boolean.annotate({ description: "An owner's entry of the name hides it" }),
      }),
    ),
    repos_truncated: Schema.Boolean.annotate({ description: "layers.repos was cut" }),
  }),
  tool_count: Schema.Finite,
  tools: Schema.Array(ToolOutput),
  tools_truncated: Schema.Boolean.annotate({
    description: "tools was cut: only the first 500, or as many as fit, are given",
  }),
  unmatched_tool_exposure: Schema.Array(Schema.String).pipe(Schema.NullOr).annotate({
    description:
      "The toolExposure keys that match none of the discovered tools (a hidden key then hides nothing); null when the server's tools are not known yet: not checked",
  }),
  unmatched_tool_exposure_truncated: Schema.Boolean.annotate({
    description: "unmatched_tool_exposure was cut",
  }),
  prompts: Schema.Array(Schema.String).annotate({
    description: "The MCP prompts it offers, by name",
  }),
  prompts_truncated: Schema.Boolean.annotate({ description: "prompts was cut" }),
  instructions: Schema.NullOr(
    Schema.Struct({
      text: Schema.String.annotate({
        description: "What the server says of itself at initialize, cut to 4 KiB",
      }),
      truncated: Schema.Boolean,
    }),
  ),
  status: Schema.NullOr(
    Schema.Struct({
      since: Schema.Finite,
      failures: Schema.Finite,
      next_retry_at: Schema.NullOr(Schema.Finite),
      last_ok_at: Schema.NullOr(Schema.Finite),
    }),
  ).annotate({
    description:
      "Since when it has been in its state, and its failures in a row; null when the host gave none",
  }),
  declined_forms: Schema.NullOr(Schema.Finite).annotate({
    description:
      "How many forms asking for a credential the host declined: not reported by the host yet, so always null",
  }),
  warnings: Schema.Array(Schema.String),
  warnings_truncated: Schema.Boolean.annotate({ description: "warnings was cut" }),
});
