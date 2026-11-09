// `settings_get` for both surfaces (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Names and
// surfaces, Reading a whole field): the in-session tool's description, parameters and output schema, which stay as they
// were (the snapshot in `packages/extensions/src/harness-session.test.ts` pins them), and the endpoint's, which takes
// `field` and `offset` for the Scope's own Instructions and whose values are cut harder
// (`packages/extensions/src/settings-reads.ts`).
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import { FieldPageFields, NextField, PageOffset, SettingsField } from "./field-page.ts";
import { InstructionsOutput, SettingOutput, SettingsGetOutput } from "./settings-output.ts";
import { GLOBAL_SETTINGS_SCOPE, ScopeRef, SettingsScope } from "./scope.ts";
import { READ_ONLY } from "./surface.ts";

/** One setting on the endpoint: the field is named as an Agent change names it. */
export const EndpointSettingOutput = Schema.Struct({
  ...SettingOutput.fields,
  field: Schema.String.annotate({
    description:
      "The setting's name as the Agent changes name it, such as model, roles.small, compaction.enabled or extensions.subagents.readToolset",
  }),
});

/** One Scope's Instructions on the endpoint, cut: `field` reads them whole. */
export const EndpointInstructionsOutput = Schema.Struct({
  ...InstructionsOutput.fields,
  text_truncated: Schema.Boolean.annotate({
    description:
      'text was cut: pass field "instructions" to read the whole, with scope "*" for Global\'s, or the Environment\'s id for its own',
  }),
});

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

/**
 * `settings_get` on the endpoint: the Settings at a Scope, or a page of its own Instructions (`field`, `offset`). A flat
 * object: the Settings' keys are present for the Settings, the page's for a page. No Environment is marked a Session's own.
 */
export const SettingsGetEndpointOutput = Schema.Struct({
  ...FieldPageFields,
  ...NextField,
  scope: optional(
    ScopeRef.annotate({ description: "The Scope the settings are of: Global, or an Environment" }),
  ),
  settings: optional(
    Schema.Array(EndpointSettingOutput).annotate({
      description:
        "The settings in force at the Scope: the model and thinking level, each role, compaction, the offered tools, the branch summary prompt, the Limits and the extensions' options",
    }),
  ),
  settings_truncated: optional(Schema.Boolean.annotate({ description: "settings was cut" })),
  instructions: optional(
    Schema.Struct({
      global: EndpointInstructionsOutput.annotate({
        description:
          "Global's Instructions, which every Environment's conversations are shown first",
      }),
      environment: Schema.NullOr(EndpointInstructionsOutput).annotate({
        description:
          "At an Environment, its own Instructions, which add to Global's and win where they disagree; null at Global",
      }),
    }).annotate({ description: "The owner's Instructions, which every conversation is shown" }),
  ),
  mcp_servers: optional(
    Schema.NullOr(Schema.Finite).annotate({
      description:
        "How many MCP servers there are at the Scope (at Global, its own entries; at an Environment, its whole set: Global's, its own and its Repos'), which settings_mcp_list shows; null when the Registry did not say",
    }),
  ),
  problem: optional(
    Schema.NullOr(Schema.String).annotate({
      description:
        "Why some saved overrides were left out, when a later release no longer accepts them; null for none",
    }),
  ),
  problem_truncated: optional(Schema.Boolean.annotate({ description: "problem was cut" })),
});

export const settingsGet = {
  name: "settings_get",
  annotations: READ_ONLY,
  session: {
    description: `Show the Settings of one Scope, which the user edits on the Settings page: the default model and thinking level, the model roles (model and hint), automatic compaction, the offered tools, the branch summary prompt, the Limits (spend limit, subagent depth, Subagent Workspace limit), the extensions' options and the user's Instructions (whole), each with where its value comes from, and any problem with the saved overrides. Pass scope "${GLOBAL_SETTINGS_SCOPE}" for Global (each field's value, whether it is the default or set at Global, and the Environments that override it) or an Environment's id (its settings in force, each overridden for it or inherited from Global); there is no default. This Session runs with its own Environment's Settings (its Overrides over Global over the defaults), and the result names that Environment. Use it before a change, to see what there is and where to change it.`,
    input: Schema.Struct({
      scope: SettingsScope.annotate({
        description: `Whose Settings to show: "${GLOBAL_SETTINGS_SCOPE}" for Global, or an Environment's id as environment_list shows it, for its Overrides over Global. Name it on purpose: there is no default.`,
      }),
    }),
    output: SettingsGetOutput,
  },
  endpoint: {
    description: `Show the Settings of one Scope, which the owner edits on the Settings page: the default model and thinking level, the model roles (model and hint), automatic compaction, the offered tools, the branch summary prompt, the Limits (spend limit, subagent depth, Subagent Workspace limit), the extensions' options, how many MCP servers there are, the size of the Instructions, each with where its value comes from, and any problem with the saved overrides. Pass scope "${GLOBAL_SETTINGS_SCOPE}" for Global (each field's value, whether it is the default or set at Global, and the Environments that override it) or an Environment's id (its settings in force, each overridden for it or inherited from Global); there is no default. \`field: "instructions"\` reads the Scope's own Instructions whole, a page at a time (pass \`next_offset\` as \`offset\`). At an Environment that is its own text only; Global's, which its Sessions are shown first, are \`scope: "*"\`.`,
    input: Schema.Struct({
      scope: SettingsScope.annotate({
        description: `Whose Settings to show: "${GLOBAL_SETTINGS_SCOPE}" for Global, or an Environment's id as environment_list shows it, for its Overrides over Global. Name it on purpose: there is no default.`,
      }),
      field: optional(SettingsField),
      offset: optional(PageOffset),
    }),
    output: SettingsGetEndpointOutput,
  },
} as const;
