// `environment_list` and `environment_get` for both surfaces (`docs/architecture/mcp-endpoint.md` → Environment and
// Settings tools → Names and surfaces): the in-session tools' descriptions, parameters and output schemas, which stay as
// they were (the snapshot in `packages/extensions/src/harness-session.test.ts` pins them), and the endpoint's, whose
// sentences name neither this Session's own Environment nor a tool the endpoint does not serve, whose `environment_get`
// takes `field` and `offset`, and whose values are cut harder (`packages/extensions/src/environment-reads.ts`).
// @effect-diagnostics missingPipeableSignature:off
import { MAX_VARIABLES } from "@cloudpid/config";
import * as Schema from "effect/Schema";
import {
  ENVIRONMENT_FIELD_WORDS,
  EnvironmentField,
  FieldPageFields,
  NextField,
  PageOffset,
} from "./field-page.ts";
import {
  BuildOutput,
  EnvironmentGetOutput,
  EnvironmentListOutput,
  RepoOutput,
  SecretOutput,
  SettingsOutput,
  SkillOutput,
  placement,
} from "./environment-output.ts";
import { GLOBAL_ID, idOrGlobal, ScopeRef } from "./scope.ts";
import { READ_ONLY } from "./surface.ts";

/** The most of a variable's value `environment_get` gives on the endpoint, in bytes stored; `field` reads it whole. */
export const ENDPOINT_VARIABLE_VALUE_BYTES = 160;

/** `environment_list` on the endpoint: the Environments, none marked as a Session's own. */
export const EnvironmentListEndpointOutput = Schema.Struct({
  ...NextField,
  environments: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The Environment's id" }),
      name: Schema.String.annotate({ description: "The Environment's name" }),
      repos: Schema.Array(RepoOutput).annotate({ description: "Its Repos" }),
      build: BuildOutput.annotate({ description: "How its Build stands" }),
    }),
  ).annotate({ description: "The Environments, the first that fit" }),
  environments_truncated: Schema.Boolean.annotate({
    description: "More Environments exist than fit; the first ones are listed",
  }),
  global_variables: Schema.Int.annotate({ description: "How many variables are kept Global" }),
});

/** A variable that applies, on the endpoint: its value cut near `ENDPOINT_VARIABLE_VALUE_BYTES`. */
export const EndpointVariableOutput = Schema.Struct({
  name: Schema.String.annotate({ description: "The variable's name" }),
  value: Schema.String.annotate({
    description:
      "The value, plain; cut when value_truncated (field variables.<NAME> reads it whole)",
  }),
  value_truncated: Schema.Boolean.annotate({ description: "The value is cut" }),
  ...placement,
});

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

/**
 * `environment_get` on the endpoint: the Environment, or a page of one of its texts (`field`, `offset`). A flat object:
 * the Environment's keys are present for the whole Environment, the page's for a page.
 */
export const EnvironmentGetEndpointOutput = Schema.Struct({
  ...FieldPageFields,
  ...NextField,
  scope: optional(ScopeRef.annotate({ description: 'The Environment, or Global (id "*")' })),
  repos: optional(Schema.Array(RepoOutput).annotate({ description: "Its Repos; none for Global" })),
  repos_truncated: optional(
    Schema.Boolean.annotate({ description: "The Repos are cut to what fits" }),
  ),
  build: optional(
    Schema.NullOr(BuildOutput).annotate({ description: "How its Build stands; null for Global" }),
  ),
  settings: optional(
    SettingsOutput.annotate({
      description:
        "The Container settings in force, each with where its value comes from; a long text is cut (its value_truncated), and field reads it whole",
    }),
  ),
  variables: optional(
    Schema.Array(EndpointVariableOutput).annotate({
      description: `Every variable in force (at most ${MAX_VARIABLES}): the Environment's own, then Global's that its own do not override; for Global, its variables`,
    }),
  ),
  variables_truncated: optional(
    Schema.Boolean.annotate({
      description:
        "The variables, or the names in overridden_global_variables, are cut to what fits",
    }),
  ),
  overridden_global_variables: optional(
    Schema.Array(Schema.String).annotate({
      description: "The names of Global's variables the Environment's own override",
    }),
  ),
  secrets: optional(
    Schema.Array(SecretOutput).annotate({
      description: "The Secrets kept for the Environment and Global, by name only",
    }),
  ),
  secrets_truncated: optional(
    Schema.Boolean.annotate({ description: "The Secrets are cut to what fits" }),
  ),
  skills: optional(
    Schema.Array(SkillOutput).annotate({
      description:
        "The Environment's own Skills, then those kept Global that its own do not hide; for Global, its Skills",
    }),
  ),
  skills_truncated: optional(
    Schema.Boolean.annotate({
      description: "The Skills, or the names in overridden_global_skills, are cut to what fits",
    }),
  ),
  overridden_global_skills: optional(
    Schema.Array(Schema.String).annotate({
      description: "The names of Global's Skills the Environment's own hide",
    }),
  ),
  problem: optional(
    Schema.NullOr(Schema.String).annotate({
      description:
        "Why only some of the saved settings apply, when a later release no longer accepts one; else null",
    }),
  ),
  problem_truncated: optional(
    Schema.Boolean.annotate({ description: "The problem is cut to what fits" }),
  ),
  settings_truncated: optional(
    Schema.Boolean.annotate({
      description:
        "A Container setting's text is cut (value_truncated): pass field to read it whole",
    }),
  ),
});

/** The in-session `environment_list`, as it has always been. */
const LIST_SESSION_DESCRIPTION =
  "List the Environments: each one's id, name, Repos and Build, marking this Session's own, and how many variables are kept Global. An Environment is what a Workspace is made from: its Repos and its Container settings. Use environment_get with an id to see an Environment's settings.";

/** The in-session `environment_get`, as it has always been. */
const GET_SESSION_DESCRIPTION = `Show an Environment (the one id names; environment_list marks this Session's own): its name and Repos, every Container setting (size, size limit, idle time, Container-only paths, variables, Setup and Start Scripts, Toolchains, Spare Workspace) in force, each marked as its own (overridden here) or inherited from Global, the variables kept Global that its own do not override, the names of the Secrets kept for it and Global (never their values), its own Skills (name, description, when saved) and the Skills kept Global that its own do not override, and how its Build stands, with the end of the last failed Build's reason. With id "${GLOBAL_ID}", show what is kept Global instead: its Container settings with the Environments that override each, the names of its Secrets and its Skills.`;

export const environmentList = {
  name: "environment_list",
  annotations: READ_ONLY,
  session: {
    description: LIST_SESSION_DESCRIPTION,
    input: Schema.Struct({}),
    output: EnvironmentListOutput,
  },
  endpoint: {
    description:
      "List the Environments to manage: each one's id, name, Repos and Build, and how many variables are kept Global. An Environment is what a Workspace is made from: its Repos and its Container settings. To pick one for a new Session use environments_list; use environment_get with an id to see an Environment's settings.",
    input: Schema.Struct({}),
    output: EnvironmentListEndpointOutput,
  },
} as const;

export const environmentGet = {
  name: "environment_get",
  annotations: READ_ONLY,
  session: {
    description: GET_SESSION_DESCRIPTION,
    input: Schema.Struct({
      id: idOrGlobal("the Container settings, Secrets and Skills kept Global"),
    }),
    output: EnvironmentGetOutput,
  },
  endpoint: {
    description: `Show an Environment (the one id names): its name and Repos, every Container setting (size, size limit, idle time, Container-only paths, variables, Setup and Start Scripts, Toolchains, Spare Workspace) in force, each marked as its own (overridden here) or inherited from Global, every variable in force (at most ${MAX_VARIABLES}, each value cut near ${ENDPOINT_VARIABLE_VALUE_BYTES} bytes), the names of the Secrets kept for it and Global (never their values), its own Skills and the Skills kept Global that its own do not override, and how its Build stands. With id "${GLOBAL_ID}", show what is kept Global instead. The answer is cut to a size a client can read: a part that is cut says so (_truncated, value_truncated), and field reads one long text whole, a page at a time (${ENVIRONMENT_FIELD_WORDS}; pass next_offset as offset for the next page).`,
    input: Schema.Struct({
      id: idOrGlobal("the Container settings, Secrets and Skills kept Global", "endpoint"),
      field: optional(EnvironmentField),
      offset: optional(PageOffset),
    }),
    output: EnvironmentGetEndpointOutput,
  },
} as const;
