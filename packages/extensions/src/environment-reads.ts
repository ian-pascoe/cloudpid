// The cores of `environment_list` and `environment_get` (`docs/architecture/mcp-endpoint.md` → Environment and Settings
// tools → Shared definitions and the core/wrapper split, Reading a whole field, and the endpoint's limits): each reads the
// Environments through plain services and answers its text, its structured value and its details, for the Session
// (`surface: "session"`, byte for byte what the in-session tools answered before the split) or the endpoint
// (`surface: "endpoint"`: no Environment is marked a Session's own, the value is cut to `ENDPOINT_GET_BOUNDS`, its text is
// built from that value and cut to `ENDPOINT_TEXT_CHARS`, and `environment_get` takes `field` and `offset`). The
// in-session wrappers are in `./environment.ts`; the services are the Registry's, which `apps/server` builds with no
// Session (`environmentReads`).
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off -- text built from plain values.
import type { ContainerSettings } from "@cloudpid/config";
import {
  type BuildOutput,
  EnvironmentGetEndpointOutput,
  EnvironmentGetOutput,
  EnvironmentListEndpointOutput,
  EnvironmentListOutput,
  ENVIRONMENT_FIELD_PATTERN,
  GLOBAL_ID,
  GLOBAL_NAME,
  type HARNESS_TOOLS,
} from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import {
  describeEnvironment,
  describeGlobal,
  EnvironmentsError,
  listingLine,
  notFound,
  reposLine,
} from "./environment-describe.ts";
import type { EnvironmentsService } from "./environment.ts";
import {
  type EnvironmentGetEndpointWhole,
  environmentGetEndpointOutput,
  environmentGetOutput,
  environmentListEndpointOutput,
  environmentListOutput,
  globalGetEndpointOutput,
  globalGetOutput,
} from "./environment-outputs.ts";
import {
  cutNote,
  cutText,
  fitted,
  type HarnessRead,
  INVALID_ARGUMENT,
  NOT_FOUND,
  pageFields,
  pageOf,
  pageText,
} from "./harness.ts";
import { asOutput } from "./outputs.ts";

/** What the cores read: the Registry's Environments, and the Session's own among them. */
export type EnvironmentReadServices = Pick<
  EnvironmentsService,
  "current" | "list" | "get" | "global"
>;

type ListArgs = typeof HARNESS_TOOLS.environment_list.endpoint.input.Type;

type GetArgs = typeof HARNESS_TOOLS.environment_get.endpoint.input.Type;

/** What the endpoint's cut text ends with. */
const CUT_NOTE = cutNote("pass `field` to read a long text whole.");

/** What `environment_list`'s cut text ends with: it takes no `field`. */
const LIST_CUT_NOTE = cutNote("environment_get shows one Environment.");

/** The sentence that says some of an answer is cut, and how to read it whole. */
const PASS_FIELD =
  "Some of this is cut: pass `field` (setupScript, startScript, toolchains, ignore or variables.<NAME>) to read a long text whole.";

/** A Build's standing in a line, from its value. */
const buildWords = (build: typeof BuildOutput.Type): string => {
  switch (build.status) {
    case "none":
      return "none (no Repo, Setup Script or Toolchains to build, or none made yet)";
    case "building":
      return `building; new Workspaces start from ${build.last_good_at === null ? "the image" : "the last good Build"} meanwhile`;
    case "ready":
      return "ready";
    case "failed":
      return `failed; new Workspaces start from ${build.last_good_at === null ? "the image" : "the last good Build"} meanwhile. Its reason ends: ${build.reason ?? ""}`;
  }
};

/** `text` as a fenced block, `none` when empty, and a note when it is cut: `field` reads it whole. */
const textBlock = (
  setting: {
    readonly value: string;
    readonly value_truncated: boolean;
  },
  language: string,
  field: string,
): string =>
  setting.value === ""
    ? "none"
    : `\n\`\`\`${language}\n${setting.value}\n\`\`\`${setting.value_truncated ? `\n(cut: pass field "${field}" to read it whole)` : ""}`;

/** What `environment_list` says on the endpoint, from its value. */
const describeEndpointList = (out: typeof EnvironmentListEndpointOutput.Type): string =>
  out.environments.length === 0
    ? "There are no Environments."
    : Arr.join(
        [
          "Environments (id: name):",
          ...Arr.map(
            out.environments,
            (environment) =>
              `- ${environment.id}: ${JSON.stringify(environment.name)}; repos: ${reposLine(environment.repos)}; Build: ${buildWords(environment.build)}`,
          ),
          ...(out.environments_truncated ? ["(more Environments exist than are listed)"] : []),
          `Variables at Global: ${out.global_variables} (environment_get with id "${GLOBAL_ID}" shows them and the other Container settings at Global)`,
        ],
        "\n",
      );

/** What `environment_get` says on the endpoint, from its value. */
const describeEndpointGet = (out: EnvironmentGetEndpointWhole): string => {
  const { settings } = out;
  const atGlobal = out.scope.id === GLOBAL_ID;

  const where = (
    source: "own" | "inherited" | "global",
    overriding: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) =>
    atGlobal
      ? overriding.length === 0
        ? ""
        : ` (overridden in ${Arr.join(
            Arr.map(overriding, (each) => `${JSON.stringify(each.name)} (${each.id})`),
            ", ",
          )})`
      : ` (${source === "own" ? "overridden here" : "inherited from Global"})`;

  const variableLines = Arr.map(
    out.variables,
    (variable) =>
      `  ${variable.name}=${variable.value}${variable.value_truncated ? ` (cut: pass field "variables.${variable.name}" to read it whole)` : ""}${where(variable.source, variable.overridden_in)}`,
  );

  const cut =
    out.settings_truncated ||
    out.repos_truncated ||
    out.variables_truncated ||
    out.secrets_truncated ||
    out.skills_truncated ||
    out.problem_truncated ||
    Arr.some(out.variables, (variable) => variable.value_truncated) ||
    (out.build?.reason_truncated ?? false);

  return Arr.join(
    [
      atGlobal
        ? `Kept at Global (id "${GLOBAL_ID}"): what every Environment inherits where it has no Override of its own.`
        : `Environment ${JSON.stringify(out.scope.name)} (id ${out.scope.id})`,
      ...(atGlobal ? [] : [`Repos: ${reposLine(out.repos)}`]),
      `Container size${where(settings.instance.source, settings.instance.overridden_in)}: ${settings.instance.value}`,
      `Size limit${where(settings.max_instance.source, settings.max_instance.overridden_in)}: ${settings.max_instance.value}`,
      `Idle time${where(settings.idle_minutes.source, settings.idle_minutes.overridden_in)}: ${settings.idle_minutes.value} minute${settings.idle_minutes.value === 1 ? "" : "s"}`,
      `Container-only paths (ignore)${where(settings.ignore.source, settings.ignore.overridden_in)}: ${settings.ignore.value.length === 0 ? "none" : Arr.join(settings.ignore.value, ", ")}${settings.ignore.value_truncated ? ' (cut: pass field "ignore" to read them whole)' : ""}`,
      `Variables (${out.variables.length}, plain, in every command's environment): ${out.variables.length === 0 ? "none" : `\n${Arr.join(variableLines, "\n")}`}`,
      `Setup Script${where(settings.setup_script.source, settings.setup_script.overridden_in)}: ${textBlock(settings.setup_script, "bash", "setupScript")}`,
      `Start Script${where(settings.start_script.source, settings.start_script.overridden_in)}: ${textBlock(settings.start_script, "bash", "startScript")}`,
      `Toolchains (mise.toml)${where(settings.toolchains.source, settings.toolchains.overridden_in)}: ${settings.toolchains.value === "" ? "none: the image's base Toolchains" : textBlock(settings.toolchains, "toml", "toolchains")}`,
      `Spare Workspace${where(settings.spare_workspace.source, settings.spare_workspace.overridden_in)}: ${settings.spare_workspace.value ? "on" : "off"}`,
      `Kept Secrets (values never shown): ${
        out.secrets.length === 0
          ? "none"
          : Arr.join(
              Arr.map(
                out.secrets,
                (secret) =>
                  `${secret.name} (${secret.scope === "environment" ? "kept for this Environment" : "kept Global"}${secret.build ? ", reaches the Build" : ""}; commands get it as $${secret.env_var})`,
              ),
              "; ",
            )
      }`,
      `Skills: ${
        out.skills.length === 0
          ? "none"
          : Arr.join(
              Arr.map(
                out.skills,
                (skill) => `\n  ${skill.name} (${skill.origin}): ${skill.description}`,
              ),
              "",
            )
      }`,
      ...(out.build === null ? [] : [`Build: ${buildWords(out.build)}`]),
      ...(out.problem === null
        ? []
        : [`Saved settings left out, as they no longer apply: ${out.problem}`]),
      ...(cut ? [PASS_FIELD] : []),
    ],
    "\n",
  );
};

/** The text of `field` in the settings in force, `undefined` for a variable that is not set. */
const fieldText = (settings: ContainerSettings, field: string): string | undefined => {
  switch (field) {
    case "setupScript":
      return settings.setupScript;
    case "startScript":
      return settings.startScript;
    case "toolchains":
      return settings.toolchains;
    case "ignore":
      return Arr.join(settings.ignore, "\n");
    default:
      return Option.getOrUndefined(
        Record.get(settings.variables, field.slice("variables.".length)),
      );
  }
};

/**
 * The page of `field` of the settings in force at `scope`: refused as `not_found` for a variable that is not set and as
 * `invalid_argument` for an `offset` past the text's end.
 */
const readField = (
  scope: { readonly id: string; readonly name: string },
  settings: ContainerSettings,
  { field, offset }: { readonly field: string; readonly offset: number | undefined },
) =>
  Effect.gen(function* () {
    // The tool's schema holds `field` to the pattern; the core holds it again, as a path it can read.
    if (!ENVIRONMENT_FIELD_PATTERN.test(field)) {
      return yield* EnvironmentsError.make({
        message: `${JSON.stringify(field)} is not a field to read: pass setupScript, startScript, toolchains, ignore or variables.<NAME>.`,
        code: INVALID_ARGUMENT,
      });
    }

    const text = fieldText(settings, field);

    if (text === undefined) {
      return yield* EnvironmentsError.make({
        message: `${field.slice("variables.".length)} is not a variable in force at ${scope.name} (id ${scope.id}). environment_get without field lists them.`,
        code: NOT_FOUND,
      });
    }

    const page = pageOf(text, offset ?? 0);

    if (page === undefined) {
      return yield* EnvironmentsError.make({
        message: `offset ${offset} is past the end of ${field}, which is ${text.length} characters.`,
        code: INVALID_ARGUMENT,
      });
    }

    return {
      text: pageText(page),
      structured: asOutput(EnvironmentGetEndpointOutput, pageFields(scope.id, field, page)),
      details: { environment: { id: scope.id, name: scope.name }, field },
    };
  });

/** `environment_list`: the Environments, with the Session's own marked on the Session's surface. */
export const environmentListRead =
  (services: EnvironmentReadServices): HarnessRead<ListArgs, EnvironmentsError> =>
  (_args, surface) =>
    Effect.gen(function* () {
      if (surface === "endpoint") {
        const listed = yield* services.list;
        const globalDetails = yield* services.global;

        const out = environmentListEndpointOutput(
          listed,
          Record.size(globalDetails.settings.variables),
        );

        return {
          text: cutText(describeEndpointList(out), LIST_CUT_NOTE),
          structured: asOutput(EnvironmentListEndpointOutput, out),
          details: { environments: Arr.map(listed, ({ id, name }) => ({ id, name })) },
        };
      }

      const current = yield* services.current;
      const listed = yield* services.list;
      const globalDetails = yield* services.global;

      return {
        text:
          listed.length === 0
            ? "There are no Environments."
            : `Environments (id: name):\n${Arr.join(
                Arr.map(listed, (environment) =>
                  listingLine(environment, environment.id === current),
                ),
                "\n",
              )}\nVariables at Global: ${Record.size(globalDetails.settings.variables)} (environment_get with id "${GLOBAL_ID}" shows them and the other Container settings at Global)`,
        structured: asOutput(
          EnvironmentListOutput,
          environmentListOutput(listed, current, Record.size(globalDetails.settings.variables)),
        ),
        details: { current, environments: Arr.map(listed, ({ id, name }) => ({ id, name })) },
      };
    });

/**
 * `environment_get`: an Environment's settings in force, or what is kept Global (id `*`). On the endpoint, `field` reads one
 * text whole, a page at a time (`offset`), and the value is cut to the endpoint's bounds.
 */
export const environmentGetRead =
  (services: EnvironmentReadServices): HarnessRead<GetArgs, EnvironmentsError> =>
  (args, surface) =>
    Effect.gen(function* () {
      const { id } = args;

      if (surface === "endpoint") {
        if (args.field === undefined && args.offset !== undefined) {
          return yield* EnvironmentsError.make({
            message: "offset reads a page of a field: pass field with it.",
            code: INVALID_ARGUMENT,
          });
        }

        const named = { id: GLOBAL_ID, name: GLOBAL_NAME };

        if (id === GLOBAL_ID) {
          const kept = yield* services.global;

          if (args.field !== undefined) {
            return yield* readField(named, kept.settings, {
              field: args.field,
              offset: args.offset,
            });
          }

          return endpointWhole(globalGetEndpointOutput(kept, named), named);
        }

        const details = yield* services.get(id);

        if (details === null) return yield* notFound(id);

        if (args.field !== undefined) {
          return yield* readField({ id: details.id, name: details.name }, details.settings, {
            field: args.field,
            offset: args.offset,
          });
        }

        return endpointWhole(environmentGetEndpointOutput(details), {
          id: details.id,
          name: details.name,
        });
      }

      if (id === GLOBAL_ID) {
        const kept = yield* services.global;

        return {
          text: describeGlobal(kept),
          structured: asOutput(
            EnvironmentGetOutput,
            globalGetOutput(kept, { id: GLOBAL_ID, name: GLOBAL_NAME }),
          ),
          details: { environment: { id: GLOBAL_ID, name: GLOBAL_NAME }, current: false },
        };
      }

      const own = id === (yield* services.current);
      const details = yield* services.get(id);

      if (details === null) return yield* notFound(id);

      return {
        text: describeEnvironment(details, own),
        structured: asOutput(EnvironmentGetOutput, environmentGetOutput(details, own)),
        details: { environment: { id: details.id, name: details.name }, current: own },
      };
    });

/** The endpoint's answer for a whole Environment: its value fitted to the structured limit, and its text cut to the text limit. */
const endpointWhole = (
  whole: EnvironmentGetEndpointWhole,
  environment: { readonly id: string; readonly name: string },
) => {
  // A value whose parts' bounds still add up to too much loses its longest lists first, each flagged.
  const out = fitted(whole, [
    (value) => ({ ...value, skills: [], skills_truncated: true, overridden_global_skills: [] }),
    (value) => ({ ...value, secrets: [], secrets_truncated: true }),
    (value) => ({ ...value, repos: [], repos_truncated: true }),
    (value) => ({ ...value, variables: [], variables_truncated: true }),
  ]);

  return {
    text: cutText(describeEndpointGet(out), CUT_NOTE),
    structured: asOutput(EnvironmentGetEndpointOutput, out),
    details: { environment, current: false },
  };
};
