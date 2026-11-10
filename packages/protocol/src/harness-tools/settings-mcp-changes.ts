// The MCP servers' tools the endpoint serves besides the reads, for both surfaces (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Names and surfaces, The tools; `docs/architecture/mcp-configuration.md` → The agent's
// changes): `settings_mcp_reload`, which is no Agent change and takes no `request_id`, and the changes that narrow what is
// reachable: `settings_mcp_disable`, `_exposure_set`, `_tool_exposure_set` and `_remove`. The in-session descriptions,
// parameters and output schemas stay as they were (the snapshot in `packages/extensions/src/harness-session.test.ts` pins
// them). A change that would make something reachable (switching on, taking something out of hidden, a removal that falls
// back to a switched-on server) asks the owner on the endpoint, as the definition tools do (`./approvals.ts`): it answers
// `pending`, so these tools' endpoint output gains the request's optional keys (`McpChangeAskOutput`); one that narrows is
// made at once. The endpoint's words name the owner.
// @effect-diagnostics missingPipeableSignature:off
import { MCP_EXPOSURES } from "@cloudpid/config";
import * as Schema from "effect/Schema";
import { ApprovalRequestFields } from "./approvals.ts";
import { ChangeEndpointOutput, ChangeOutput } from "./change-output.ts";
import { NextField } from "./field-page.ts";
import { RequestIdField, settingsReason } from "./reason.ts";
import { ScopeRef, SettingsScope } from "./scope.ts";
import {
  DESTRUCTIVE,
  type Who,
  WRITE,
  WRITE_IDEMPOTENT,
  WRITE_IDEMPOTENT_OPEN,
} from "./surface.ts";

const Reason = settingsReason("user", "the server is not used by this project");

const ReasonEndpoint = settingsReason("owner", "the server is not used by this project");

/** The `name` of a server, as `settings_mcp_list` shows it. */
export const ServerName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The server's name as settings_mcp_list shows it",
});

const ExposureValue = Schema.Literals(MCP_EXPOSURES).annotate({
  description:
    "codemode (the tools are called from a script, the default), deferred (found with tool_search), direct (offered to the model by name) or hidden (unreachable)",
});

const ExposureValueEndpoint = Schema.Literals(MCP_EXPOSURES).annotate({
  description:
    "codemode (the tools are called from a script, the default), deferred (found when the model looks for a tool), direct (offered to the model by name) or hidden (unreachable)",
});

/** What the descriptions of the tools that change one MCP key say of the Scope and the hosts. */
const SCOPE_AND_HOSTS =
  "A name is the server in force in that Scope's set. At scope \"*\" the key is changed in Global's entry, which reaches every Environment but those whose own entry or adjustment overrides it (the result names them); at an Environment's id the change is that Environment's own, an Override even when it equals Global's (settings_reset removes it).";

/** What the descriptions of the tools that change one MCP key say of the record and the Approval. */
export const MCP_CHANGE_NOTE = `The change is recorded with your reason, and the user can see and revert it on the Settings page. A change that would make something reachable that is not (switch a server on, take it or a tool out of hidden, loosen or remove a hidden toolExposure key, put another key ahead of one) waits for the user's Approval: the call waits for their answer on a card in the Session, with no deadline, and a decline changes nothing; one that narrows (switching off, hiding, moves among codemode, deferred and direct) is made at once. ${SCOPE_AND_HOSTS} The new set is handed to the MCP hosts the change reaches.`;

/**
 * The endpoint's answer to a change of an MCP server's keys: a change's, or, for one that widens what is reachable, the
 * ask's (`status` "pending" with the request), with no changes made yet.
 */
export const McpChangeAskOutput = Schema.Struct({
  ...ChangeEndpointOutput.fields,
  status: Schema.optionalKey(
    Schema.String.annotate({
      description:
        '"pending" when the change would make something reachable that is not, so the owner was asked (approval_wait follows the request); "unchanged" when the field has the value already; absent for a change that narrows, which is made at once',
    }),
  ),
  ...ApprovalRequestFields,
});

/**
 * The same on the endpoint: a change that widens asks the owner. The Approval's words are the Limit tools' (`./approvals.ts`):
 * the call does not wait.
 */
export const MCP_CHANGE_NOTE_ENDPOINT = `The change is recorded with your reason, and the owner can see and revert it on the Settings page. A change that narrows what is reachable is made at once (switching off, hiding, moves among codemode, deferred and direct). One that would make something reachable that is not (switch a server on, take it or a tool out of hidden, loosen or remove a hidden toolExposure key, put another key ahead of one) waits for the owner's Approval, in cloudpid: the call does not wait for them, but answers status "pending" with an approval_id, the url of the card the owner answers, and when the request expires (7 days); follow it with approval_wait. On Approve the change is made only while the key still has the value the owner saw, and is recorded as approved. ${SCOPE_AND_HOSTS} The new set is sent to the MCP host of each Environment the change reaches by cloudpid, after the answer.`;

// ─── settings_mcp_disable ────────────────────────────────────────────────────

const disableFields = { scope: SettingsScope, name: ServerName };

export const settingsMcpDisable = {
  name: "settings_mcp_disable",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: `Switch an MCP server off at one Scope: its connection and streams are closed and its tools are no longer reachable (its inventory is kept). ${MCP_CHANGE_NOTE} Switching a server on again waits for the user's Approval. A Repo's .pi/mcp.json is edited as a file, in a pull request, and is no Agent change; its servers run without Approval but get no Secrets (copy one with settings_mcp_add and from_repo to give it some).`,
    input: Schema.Struct({ ...disableFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: `Switch an MCP server off at one Scope: its connection and streams are closed and its tools are no longer reachable (its inventory is kept). ${MCP_CHANGE_NOTE_ENDPOINT} settings_mcp_enable asks the owner to switch it on again. A Repo's .pi/mcp.json is edited as a file, in a pull request, and is no Agent change; its servers run without Approval but get no Secrets.`,
    input: Schema.Struct({ ...disableFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

// ─── settings_mcp_exposure_set ───────────────────────────────────────────────

export const settingsMcpExposureSet = {
  name: "settings_mcp_exposure_set",
  annotations: WRITE,
  session: {
    description: `Set how an MCP server's tools reach the model, at one Scope: codemode (called from a script; the default), deferred (found with tool_search), direct (offered by name) or hidden (unreachable). A tool the server's toolExposure names keeps its own exposure. ${MCP_CHANGE_NOTE} Taking a server out of hidden waits for the user's Approval.`,
    input: Schema.Struct({
      scope: SettingsScope,
      name: ServerName,
      exposure: ExposureValue,
      reason: Reason,
    }),
    output: ChangeOutput,
  },
  endpoint: {
    description: `Set how an MCP server's tools reach the model, at one Scope: codemode (called from a script; the default), deferred (found when the model looks for a tool), direct (offered by name) or hidden (unreachable). A tool the server's toolExposure names keeps its own exposure. ${MCP_CHANGE_NOTE_ENDPOINT} Taking a server out of hidden waits for the owner's Approval.`,
    input: Schema.Struct({
      scope: SettingsScope,
      name: ServerName,
      exposure: ExposureValueEndpoint,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: McpChangeAskOutput,
  },
} as const;

// ─── settings_mcp_tool_exposure_set ──────────────────────────────────────────

const toolExposureFields = (exposure: typeof ExposureValue) => ({
  scope: SettingsScope,
  name: ServerName,
  tool: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The tool's own name, a pattern with *, or its mcp__<server>__<tool> name",
  }),
  exposure: Schema.NullOr(exposure).annotate({
    description: "The exposure of the tool, or null to remove the key",
  }),
  before: Schema.optionalKey(Schema.String).annotate({
    description: "An existing pattern key to put this key ahead of",
  }),
});

const toolExposureLine = (found: string) =>
  `Set, move or remove one key of an MCP server's toolExposure at one Scope. tool is the server's own tool name (as settings_mcp_get lists it), a pattern with * , or a model-facing mcp__<server>__<tool> name, which is mapped back through the server's discovered tools. exposure is codemode, deferred, direct or hidden; null removes the key. The first key that matches a tool wins and an exact name beats a pattern: a new pattern goes last, an existing key keeps its place, and before names an existing pattern key to put this one ahead of (an exact name ignores it). The result says which known tools the key decides and which it is shadowed for, with the fix; a key that matches no tool is kept with a warning, and for a server not discovered here its tools are not checked. ${found}`;

export const settingsMcpToolExposureSet = {
  name: "settings_mcp_tool_exposure_set",
  annotations: WRITE,
  session: {
    description: toolExposureLine(
      `${MCP_CHANGE_NOTE} Hiding is made at once; removing or loosening a hidden key, or putting another key ahead of one, waits for the user's Approval.`,
    ),
    input: Schema.Struct({ ...toolExposureFields(ExposureValue), reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: toolExposureLine(
      `${MCP_CHANGE_NOTE_ENDPOINT} Hiding is made at once; removing or loosening a hidden key, or putting another key ahead of one, waits for the owner's Approval.`,
    ),
    input: Schema.Struct({
      ...toolExposureFields(ExposureValueEndpoint),
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: McpChangeAskOutput,
  },
} as const;

// ─── settings_mcp_remove ─────────────────────────────────────────────────────

const removeFields = { scope: SettingsScope, name: ServerName };

export const settingsMcpRemove = {
  name: "settings_mcp_remove",
  annotations: DESTRUCTIVE,
  session: {
    description: `Remove an MCP server where it is defined: Global's at "*" (every Environment loses it, but those with an entry of their own), an Environment's own entry at its id (the server then falls back to Global's of the name, or the Repo's it shadowed). A Global server at an Environment is not removed there: settings_mcp_disable switches it off for that Environment. Its MCP sign-in stays, listed as unused, until the user signs out. Removing makes no Approval necessary, unless it falls back to a server that is switched on or a tool that is not hidden (then it waits for the user's Approval as settings_mcp_enable does). A rename is an add (which waits for the user's Approval) and a remove, so an MCP sign-in never follows a new name without the user's yes. The change is recorded with your reason, and the user can see and revert it on the Settings page. A Repo's .pi/mcp.json is edited as a file in a pull request.`,
    input: Schema.Struct({ ...removeFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: `Remove an MCP server where it is defined: Global's at "*" (every Environment loses it, but those with an entry of their own), an Environment's own entry at its id (the server then falls back to Global's of the name, or the Repo's it shadowed). A Global server at an Environment is not removed there: settings_mcp_disable switches it off for that Environment. Its MCP sign-in stays, listed as unused, until the owner signs out. A removal that falls back to a server that is switched on or a tool that is not hidden waits for the owner's Approval, as settings_mcp_enable does: the call does not wait for them, but answers status "pending" with an approval_id, the url of the card the owner answers, and when the request expires (7 days); follow it with approval_wait. Any other removal is made at once. The change is recorded with your reason, and the owner can see and revert it on the Settings page. The new set is sent to the MCP host of each Environment the change reaches by cloudpid, after the answer. A Repo's .pi/mcp.json is edited as a file in a pull request.`,
    input: Schema.Struct({ ...removeFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: McpChangeAskOutput,
  },
} as const;

// ─── settings_mcp_reload ─────────────────────────────────────────────────────

/** What a reload found of one Repo's file; `who` is whoever drops a kept copy on the Settings page. */
const reloadRepoOutput = (who: Who) =>
  Schema.Struct({
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
      description: `An unreadable Repo's last good copy is kept, so its servers still stand: only the ${who}'s Reload drops it`,
    }),
    problem: Schema.NullOr(Schema.String),
  });

/** What a reload's value holds, whoever reads it: the Scope, each Repo's file, the set, the push and the host. */
const reloadFields = (who: Who) => ({
  scope: ScopeRef,
  repos: Schema.Array(reloadRepoOutput(who)),
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

/** `settings_mcp_reload` in a Session. */
export const SettingsMcpReloadOutput = Schema.Struct(reloadFields("user"));

/** `settings_mcp_reload` on the endpoint: the same, with `next`. */
export const SettingsMcpReloadEndpointOutput = Schema.Struct({
  ...NextField,
  ...reloadFields("owner"),
});

const reloadLine = (who: Who) =>
  `Read an Environment's Repos' .pi/mcp.json again (at most once per Repo each 30 seconds, a Repo looked at since being reported as recent), and have the Environment's MCP host drop its eras and Legacy sessions and rediscover its HTTP servers at once: for a server that is stuck, or a file that was just merged. It reports per Repo its directory, slug, path, outcome (changed, unchanged, absent, unreadable, invalid, not_github or recent), blob, read time and error; and for the set the servers added, removed and changed and the problems that appeared and cleared. A Repo that cannot be read keeps its last good copy: only the ${who}'s Reload on the Settings page drops it. scope is an Environment's id only ("*" is refused: Global has no Repos and no host). The set is sent to that Environment's MCP host and the host reloaded, whichever Environment it is (a host is not woken for an Environment whose set is and was empty). It is not an Agent change: no reason, no record, no Approval. A Repo's file is read on its default branch only, so a change on a branch shows once it is merged.`;

export const settingsMcpReload = {
  name: "settings_mcp_reload",
  // It reaches the MCP servers, so it is open-world; a repeat leaves the set as it is.
  annotations: WRITE_IDEMPOTENT_OPEN,
  session: {
    description: reloadLine("user"),
    input: Schema.Struct({ scope: SettingsScope }),
    output: SettingsMcpReloadOutput,
  },
  endpoint: {
    description: reloadLine("owner"),
    input: Schema.Struct({ scope: SettingsScope }),
    output: SettingsMcpReloadEndpointOutput,
  },
} as const;

/** The MCP servers' changing tools the endpoint serves, in the order the `settings_mcp` extension registers them. */
export const SETTINGS_MCP_CHANGE_TOOLS = {
  settings_mcp_disable: settingsMcpDisable,
  settings_mcp_exposure_set: settingsMcpExposureSet,
  settings_mcp_tool_exposure_set: settingsMcpToolExposureSet,
  settings_mcp_remove: settingsMcpRemove,
} as const;

export type SettingsMcpChangeToolName = keyof typeof SETTINGS_MCP_CHANGE_TOOLS;
