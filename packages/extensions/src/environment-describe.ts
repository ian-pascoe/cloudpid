// Holds: the in-session describers of `environment_list` and `environment_get` (`describeEnvironment`, `describeGlobal`,
// `listingLine`, `describeBuild`, `reposLine`, `namedEnvironment`), `EnvironmentsError` and `notFound`
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared definitions and the core/wrapper split).
// A leaf of the extension: `environment.ts` re-exports it, and the read cores (`environment-reads.ts`) and the wrappers
// both import it, so neither imports the other.
// @effect-diagnostics missingPipeableSignature:off
import type { ContainerSettings } from "@cloudpid/config";
import {
  type BuildView,
  type EnvironmentRepo,
  type EnvironmentSkill,
  SKILLS_ROOT,
  skillSourceText,
  variableField,
} from "@cloudpid/protocol";
import { GLOBAL_ID, GLOBAL_NAME } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  EnvironmentDetails,
  EnvironmentListing,
  GlobalDetails,
  KeptSecretListing,
} from "./environment.ts";
import { FAILED_REASON_TAIL } from "./environment-outputs.ts";
import { NOT_FOUND } from "./harness.ts";
import { secretEnvName } from "./secrets/references.ts";

/** Reaching the Environments failed; its message is what the model sees. */
export class EnvironmentsError extends Schema.TaggedError<
  EnvironmentsError,
  { readonly brand: unique symbol }
>()("EnvironmentsError", {
  message: Schema.String,
  /** Why a call was refused, for the endpoint's dispatcher; none for a refusal that is only a message. */
  code: Schema.optionalKey(Schema.Literals(["not_found", "invalid_argument", "unavailable"])),
}) {}

const iso = (time: number): string => DateTime.formatIso(DateTime.makeUnsafe(time));

/** Where a Build stands, in a line. */
export const describeBuild = (build: BuildView): string => {
  const meanwhile = (lastGoodAt: number | null) =>
    lastGoodAt === null
      ? "new Workspaces start from the image meanwhile"
      : `new Workspaces start from the last good Build, of ${iso(lastGoodAt)}, meanwhile`;

  switch (build.status) {
    case "none":
      return "none (no Repo, Setup Script or Toolchains to build, or none made yet)";
    case "building":
      return `building since ${iso(build.since)}; ${meanwhile(build.lastGoodAt)}`;
    case "ready":
      return `ready, made ${iso(build.at)}`;
    case "failed": {
      const reason =
        build.reason.length > FAILED_REASON_TAIL
          ? `…${build.reason.slice(-FAILED_REASON_TAIL)}`
          : build.reason;

      return `failed at ${iso(build.at)}; ${meanwhile(build.lastGoodAt)}. Its reason ends: ${reason}`;
    }
  }
};

export const reposLine = (repos: ReadonlyArray<EnvironmentRepo>): string =>
  repos.length === 0
    ? "none"
    : Arr.join(
        Arr.map(repos, (repo) => `${repo.name} (${repo.url})`),
        ", ",
      );

/** `text` as a fenced block, or `none` when it is empty. */
const block = (text: string, language: string): string =>
  text === "" ? "none" : `\n\`\`\`${language}\n${text}\n\`\`\``;

const describeSecret = (secret: KeptSecretListing): string =>
  `${secret.name} (${secret.scope === "environment" ? "kept for this Environment" : "kept Global"}${secret.build ? ", reaches the Build" : ""}; commands get it as $${secretEnvName(secret.name)})`;

/** Variables as `environment_get` lists them, one a line. */
const variableLines = (variables: Readonly<Record<string, string>>): string =>
  Arr.join(
    Arr.map(Record.toEntries(variables), ([name, value]) => `\n  ${name}=${value}`),
    "",
  );

/** Skills as `environment_get` lists them, one a line, or `none`. */
const skillLines = (skills: ReadonlyArray<EnvironmentSkill>): string =>
  skills.length === 0
    ? "none"
    : Arr.join(
        Arr.map(
          skills,
          (skill) =>
            `\n  ${skill.name} (saved ${iso(skill.savedAt)}${
              skill.source === undefined ? "" : `, installed from ${skillSourceText(skill.source)}`
            }${skill.modified === true ? ", modified since installed" : ""}${
              skill.updateAvailable === true ? ", update available" : ""
            }): ${skill.description}`,
        ),
        "",
      );

/** What `environment_get` says of an Environment. */
export const describeEnvironment = (details: EnvironmentDetails, current: boolean): string => {
  const { settings, overrides, global } = details;
  const own = overrides.variables ?? {};
  const inherited = Record.filter(global.variables, (_, name) => !Record.has(own, name));
  const overridden = Arr.filter(Record.keys(global.variables), (name) => Record.has(own, name));

  /** Where a setting comes from: the Environment's own Override, or Global's. */
  const from = (field: Exclude<keyof ContainerSettings, "variables">): string =>
    overrides[field] === undefined ? "inherited from Global" : "overridden here";

  const ownSkills = new Set(Arr.map(details.skills, (skill) => skill.name));
  const inheritedSkills = Arr.filter(details.globalSkills, (skill) => !ownSkills.has(skill.name));

  const overriddenSkills = Arr.filterMap(details.globalSkills, (skill) =>
    ownSkills.has(skill.name) ? Result.succeed(skill.name) : Result.failVoid,
  );

  return Arr.join(
    [
      `Environment ${JSON.stringify(details.name)} (id ${details.id}${current ? ", the Environment of this Session" : ""})`,
      `Repos: ${reposLine(details.repos)}`,
      `Container settings: each is the Environment's own (overridden here) or Global's (inherited from Global, environment_get with id "${GLOBAL_ID}"). A set tool makes a field its own; environment_setting_reset makes it inherit Global's again.`,
      `Container size (${from("instance")}): ${settings.instance}`,
      `Size limit (the largest size, container_resize's too; the user sets it on the Environments page; ${from("maxInstance")}): ${settings.maxInstance}`,
      `Idle time (${from("idleMinutes")}): ${settings.idleMinutes} minute${settings.idleMinutes === 1 ? "" : "s"}`,
      `Container-only paths (ignore; ${from("ignore")}): ${settings.ignore.length === 0 ? "none" : Arr.join(settings.ignore, ", ")}`,
      `Variables of its own (plain, in every command's environment): ${
        Record.isEmptyRecord(own) ? "none" : variableLines(own)
      }`,
      `Variables at Global (id "${GLOBAL_ID}"; the Environment's own of the same name win): ${
        Record.isEmptyRecord(global.variables)
          ? "none"
          : `${variableLines(inherited)}${overridden.length === 0 ? "" : `\n  overridden here: ${Arr.join(overridden, ", ")}`}`
      }`,
      `Setup Script (${from("setupScript")}): ${block(settings.setupScript, "bash")}`,
      `Start Script (${from("startScript")}): ${block(settings.startScript, "bash")}`,
      `Toolchains (mise.toml; ${from("toolchains")}): ${settings.toolchains === "" ? "none: the image's base Toolchains" : block(settings.toolchains, "toml")}`,
      `Spare Workspace (${from("spareWorkspace")}): ${settings.spareWorkspace ? "on (a Workspace kept made ahead, so a new Session starts without waiting for the clones and the Setup Scripts)" : "off (a new Session's Workspace is made when the Session starts)"}`,
      `Kept Secrets (values never shown): ${
        details.secrets.length === 0
          ? "none"
          : Arr.join(Arr.map(details.secrets, describeSecret), "; ")
      }`,
      `Skills (its own, served read-only at ${SKILLS_ROOT}/<name> over those kept Global of the same name; environment_skill_save, environment_skill_install, environment_skill_update and environment_skill_remove change them): ${skillLines(details.skills)}`,
      `Skills at Global (id "${GLOBAL_ID}"; the Environment's own of the same name win): ${
        details.globalSkills.length === 0
          ? "none"
          : `${skillLines(inheritedSkills)}${overriddenSkills.length === 0 ? "" : `\n  overridden here: ${Arr.join(overriddenSkills, ", ")}`}`
      }`,
      `Build: ${describeBuild(details.build)}`,
      ...(details.problem === undefined
        ? []
        : [`Saved settings left out, as they no longer apply: ${details.problem}`]),
    ],
    "\n",
  );
};

/** What `environment_get` says of what is kept Global (id `*`). */
export const describeGlobal = (details: GlobalDetails): string => {
  const { settings, overriddenIn } = details;

  /** The Environments that override the field at `path`, if any, so a change here does not reach them. */
  const overriding = (path: string): string => {
    const environments = overriddenIn[path] ?? [];

    return environments.length === 0
      ? ""
      : ` (overridden in ${Arr.join(Arr.map(environments, namedEnvironment), ", ")})`;
  };

  const variables = Arr.join(
    Arr.map(
      Record.toEntries(settings.variables),
      ([name, value]) => `\n  ${name}=${value}${overriding(variableField(name))}`,
    ),
    "",
  );

  return Arr.join(
    [
      `Kept at Global (id "${GLOBAL_ID}"): what every Environment inherits where it has no Override of its own. The set tools change them with id "${GLOBAL_ID}".`,
      `Container size${overriding("instance")}: ${settings.instance}`,
      `Size limit (the largest size, container_resize's too)${overriding("maxInstance")}: ${settings.maxInstance}`,
      `Idle time${overriding("idleMinutes")}: ${settings.idleMinutes} minute${settings.idleMinutes === 1 ? "" : "s"}`,
      `Container-only paths (ignore)${overriding("ignore")}: ${settings.ignore.length === 0 ? "none" : Arr.join(settings.ignore, ", ")}`,
      `Variables (plain, in every command's environment, in any Environment; an Environment's own of the same name wins): ${
        Record.isEmptyRecord(settings.variables) ? "none" : variables
      }`,
      `Setup Script${overriding("setupScript")}: ${block(settings.setupScript, "bash")}`,
      `Start Script${overriding("startScript")}: ${block(settings.startScript, "bash")}`,
      `Toolchains (mise.toml)${overriding("toolchains")}: ${settings.toolchains === "" ? "none: the image's base Toolchains" : block(settings.toolchains, "toml")}`,
      `Spare Workspace${overriding("spareWorkspace")}: ${settings.spareWorkspace ? "on" : "off"}`,
      `Kept Secrets (values never shown): ${
        details.secrets.length === 0
          ? "none"
          : Arr.join(Arr.map(details.secrets, describeSecret), "; ")
      }`,
      `Skills (served read-only at ${SKILLS_ROOT}/<name> in each Environment's Workspaces; an Environment's own of the same name wins there; environment_skill_save, environment_skill_install, environment_skill_update and environment_skill_remove with id "${GLOBAL_ID}" change them, and wait for the user's Approval): ${skillLines(details.skills)}`,
    ],
    "\n",
  );
};

/** What `environment_list` says of an Environment. */
export const listingLine = (environment: EnvironmentListing, current: boolean): string =>
  `- ${environment.id}: ${JSON.stringify(environment.name)}${current ? " (this Session's)" : ""}; repos: ${reposLine(environment.repos)}; Build: ${describeBuild(environment.build)}`;

/** An Environment as a result names it: its name in quotes, then its id; or Global. */
export const namedEnvironment = ({
  id,
  name,
}: {
  readonly id: string;
  readonly name: string;
}): string => (id === GLOBAL_ID ? GLOBAL_NAME : `Environment ${JSON.stringify(name)} (${id})`);

/** The refusal for an `id` that names no Environment. */
export const notFound = (id: string) =>
  EnvironmentsError.make({
    message: `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`,
    code: NOT_FOUND,
  });
