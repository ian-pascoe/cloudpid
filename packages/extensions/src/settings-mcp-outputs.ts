// What `settings_mcp_list`, `settings_mcp_get` and `settings_mcp_reload` give programs (`docs/architecture/agent-capabilities.md`
// → Values for programs; `docs/architecture/mcp-configuration.md` → Lists): each tool's `structuredOutput`, declared as its
// `structuredOutputSchema` (`./outputs.ts`). Keys are snake_case and "none" is null. Nothing here holds a resolved `${NAME}`
// value, a hash or a token: an entry is as written, each `${NAME}` it reads is marked `secret`, `variable` or `missing`.
// What can grow is cut as `./outputs.ts` says, with a `*_truncated` flag.
// @effect-diagnostics missingPipeableSignature:off
import {
  InventoryOutput,
  InventoryRead,
  KeyFrom,
  ListServerOutput,
  McpSourceOutput,
  OrphanOutput,
  ProblemOutput,
  ReadOutput,
  SERVER_STATES,
  ServerState,
  SettingsMcpGetOutput,
  SettingsMcpListOutput,
  SignInOutput,
  ToolOutput,
} from "@cloudpid/protocol/harness-tools";
import * as Schema from "effect/Schema";
import { ChangeOutputFields, ScopeRef } from "./outputs.ts";

// The two read tools' schemas are declared once, in `@cloudpid/protocol/harness-tools`, for both surfaces.
export {
  InventoryOutput,
  InventoryRead,
  KeyFrom,
  ListServerOutput,
  McpSourceOutput,
  OrphanOutput,
  ProblemOutput,
  ReadOutput,
  SERVER_STATES,
  ServerState,
  SettingsMcpGetOutput,
  SettingsMcpListOutput,
  SignInOutput,
  ToolOutput,
};

/** What a reload found of one Repo's file. */
export const ReloadRepoOutput = Schema.Struct({
  directory: Schema.String,
  slug: Schema.NullOr(Schema.String),
  path: Schema.String,
  outcome: Schema.String.annotate({
    description:
      "changed, unchanged, absent (no such file: its servers go), unreadable (GitHub gave no answer: the last good copy is kept), invalid (read, but not usable: its servers go), not_github, or recent (looked at in the last 30 s, so not again)",
  }),
  blob: Schema.NullOr(Schema.String),
  read_at: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
  error_since: Schema.NullOr(Schema.Finite),
  kept_copy: Schema.Boolean.annotate({
    description:
      "An unreadable Repo's last good copy is kept, so its servers still stand: only the user's Reload drops it",
  }),
  problem: Schema.NullOr(Schema.String),
});

/** `settings_mcp_reload`. */
export const SettingsMcpReloadOutput = Schema.Struct({
  scope: ScopeRef,
  repos: Schema.Array(ReloadRepoOutput),
  repos_truncated: Schema.Boolean.annotate({ description: "repos was cut" }),
  set: Schema.Struct({
    servers: Schema.Finite.annotate({ description: "The servers the set has now" }),
    added: Schema.Array(Schema.String),
    added_truncated: Schema.Boolean.annotate({ description: "added was cut" }),
    removed: Schema.Array(Schema.String),
    removed_truncated: Schema.Boolean.annotate({ description: "removed was cut" }),
    changed: Schema.Array(Schema.String),
    changed_truncated: Schema.Boolean.annotate({ description: "changed was cut" }),
    problems_added: Schema.Array(Schema.String),
    problems_added_truncated: Schema.Boolean.annotate({ description: "problems_added was cut" }),
    problems_cleared: Schema.Array(Schema.String),
    problems_cleared_truncated: Schema.Boolean.annotate({
      description: "problems_cleared was cut",
    }),
  }),
  push: Schema.Literals(["pushed", "not_needed", "failed"]).annotate({
    description:
      "Whether the new set was sent to the Environment's host: pushed, not_needed (the host has it, or neither it nor the set has any server) or failed",
  }),
  host: Schema.Struct({
    status: Schema.Literals(["reloaded", "not_reached", "unsupported", "failed"]).annotate({
      description:
        "reloaded (the host dropped its eras and Legacy sessions and rediscovers its HTTP servers at once), not_reached (the set has no servers, so the host is not woken), unsupported (an older host) or failed",
    }),
    servers: Schema.Array(Schema.String).annotate({
      description: "The servers the reload reached",
    }),
    note: Schema.NullOr(Schema.String),
  }),
});

/** A server's status once an `add`, `update` or `enable` is made (`docs/architecture/mcp-configuration.md` → Results, Status wait). */
export const ServerStatusOutput = Schema.Struct({
  server: Schema.String.annotate({ description: "The server's name" }),
  state: Schema.Literals([...SERVER_STATES, "not_checked"]).annotate({
    description:
      "The server's state in this Session's Environment's MCP host after the change, waited for up to 10 s: connected, connecting (still, after the wait), needs_sign_in (the user must sign in: load mcp_sign_in_ask with tool_search and ask), failed, skipped, disabled, not_discovered (a stdio server before its first call starts the Container), or not_checked (the change does not reach this Session's Environment, or the host did not answer)",
  }),
  tools: Schema.Int.annotate({ description: "The tools it offers, once connected" }),
  direct: Schema.Int.annotate({ description: "Of those, the tools offered to the model by name" }),
  error: Schema.NullOr(Schema.String).annotate({
    description: "At most 300 characters of the error when it failed; null otherwise",
  }),
  note: Schema.String.annotate({ description: "What to tell the user of it, in a sentence" }),
});

/** What `settings_mcp_add`, `settings_mcp_update` and `settings_mcp_enable` give programs: the change, and the server's status. */
export const McpChangeOutput = Schema.Struct({
  ...ChangeOutputFields,
  server_status: Schema.NullOr(ServerStatusOutput).annotate({
    description:
      "The server's status after the change; null where the change was declined or nothing changed",
  }),
});
