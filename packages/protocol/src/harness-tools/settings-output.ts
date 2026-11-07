// What `settings_get` gives programs, as a schema (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// Shared definitions; `docs/architecture/agent-capabilities.md` → Values for programs): the in-session tool's output
// schema, which `packages/extensions` builds each value for, kept here so one declaration serves both surfaces.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import { ScopeRef } from "./scope.ts";

/** Where a setting's value comes from. */
export const SettingSource = Schema.Literals([
  "default",
  "global",
  "override",
  "inherited",
]).annotate({
  description:
    'At Global: "default" (nobody sets it) or "global" (set at Global). At an Environment: "override" (set on purpose for it, even when equal to Global\'s) or "inherited" (from Global)',
});

/** One setting at a Scope: its value in force and where it comes from. */
export const SettingOutput = Schema.Struct({
  field: Schema.String.annotate({
    description:
      "The setting's name as settings_reset and the Agent changes name it, such as model, roles.small, compaction.enabled or extensions.subagents.readToolset",
  }),
  value: Schema.NullOr(Schema.Json).annotate({
    description:
      "The value in force at the Scope; null for none (or, with value_truncated, a value too long to show)",
  }),
  source: SettingSource,
  global_value: Schema.NullOr(Schema.Json).annotate({
    description:
      "At an Environment, Global's value, which an override replaces; null at Global, or for none",
  }),
  value_truncated: Schema.Boolean.annotate({
    description: "value or global_value was too long to show, and is null",
  }),
  overridden_in: Schema.Array(ScopeRef).annotate({
    description:
      "At Global, the Environments that override the field, whose Sessions a change at Global does not reach; empty at an Environment",
  }),
  overridden_in_truncated: Schema.Boolean.annotate({
    description: "overridden_in was cut: more Environments override the field",
  }),
});

/** One Scope's Instructions. */
export const InstructionsOutput = Schema.Struct({
  text: Schema.String.annotate({ description: "The Instructions as Markdown; empty for none" }),
  bytes: Schema.Finite.annotate({ description: "Their size in bytes of UTF-8, whole" }),
  text_truncated: Schema.Boolean.annotate({ description: "text was cut" }),
});

/** `settings_get`: the Settings at a Scope. */
export const SettingsGetOutput = Schema.Struct({
  scope: ScopeRef.annotate({
    description: "The Scope the settings are of: Global, or an Environment",
  }),
  own_environment: Schema.NullOr(Schema.String).annotate({
    description:
      "The id of this Session's own Environment, whose Settings its requests run with; null when the Registry does not list it",
  }),
  is_own: Schema.Boolean.annotate({
    description: "This Scope is this Session's own Environment: these are the Settings it uses",
  }),
  settings: Schema.Array(SettingOutput).annotate({
    description:
      "The settings in force at the Scope: the model and thinking level, each role, compaction, the offered tools, the branch summary prompt, the Limits and the extensions' options",
  }),
  settings_truncated: Schema.Boolean.annotate({ description: "settings was cut" }),
  instructions: Schema.Struct({
    global: InstructionsOutput.annotate({
      description: "Global's Instructions, which every Environment's conversations are shown first",
    }),
    environment: Schema.NullOr(InstructionsOutput).annotate({
      description:
        "At an Environment, its own Instructions, which add to Global's and win where they disagree; null at Global",
    }),
  }).annotate({ description: "The user's Instructions, which every conversation is shown" }),
  mcp_servers: Schema.NullOr(Schema.Finite).annotate({
    description:
      "How many MCP servers there are at the Scope (at Global, its own entries; at an Environment, its whole set: Global's, its own and its Repos'), which settings_mcp_list shows; null when the Registry did not say",
  }),
  problem: Schema.NullOr(Schema.String).annotate({
    description:
      "Why some saved overrides were left out, when a later release no longer accepts them; null for none",
  }),
  problem_truncated: Schema.Boolean.annotate({ description: "problem was cut" }),
});
