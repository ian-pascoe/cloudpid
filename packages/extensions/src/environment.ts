// The `environment` extension (`docs/architecture/agent-changes.md`, ADR-0019, ADR-0027): the agent's tools for its
// Environments, `environment_list`, `environment_get`, `environment_variable_set` and `environment_variable_unset`, and
// one tool for each of the other Container settings (`environment_container_resize`, `environment_idle_time_set`,
// `environment_setup_script_set`, `environment_start_script_set`, `environment_toolchains_set`,
// `environment_ignore_set` and `environment_spare_workspace_set`), each of which sets an Environment's Override or,
// with the id `*`, the setting at Global, and `environment_setting_reset`, which takes an Override back, and `environment_secret_build` for the Build mark of a kept Secret, and
// `environment_skill_save`, `environment_skill_install`, `environment_skill_update` and `environment_skill_remove` for
// its own Skills and, saved, installed, updated or removed, those kept Global (`environment-skills.ts`; a
// change to the latter waits for the owner's Approval, so this extension needs the Session's `Approvals`). Each change is an Agent change: the Registry applies it as the owner's save
// is applied and records it, the Session hands a change to its own Environment to its Workspace
// at once, and the Run's end notifies the owner of the changes it made (`AgentChangeLog`). They are the root
// conversation's only (`PARENT_ONLY_TOOL_PREFIXES`), as `secret_ask` is. Values are plain: a change is refused when a
// text it keeps holds a Secret the Session holds or a GitHub credential, or a Secret Reference's placeholder, which these
// tools do not resolve and no command would (`holdsSecret`).
// @effect-diagnostics missingPipeableSignature:off
import {
  type ContainerSettings,
  type ContainerSettingsOverrides,
  compareInstances,
  containerRates,
  INSTANCE_DESCRIPTIONS,
  INSTANCE_RESOURCES,
  InstanceType,
  MAX_IDLE_MINUTES,
  MAX_IGNORE_PATTERNS,
  MAX_SCRIPT_BYTES,
  MAX_TOOLCHAINS_BYTES,
  SPARE_WORKSPACE_FIELD,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  type AgentChange,
  type BuildView,
  type EnvironmentRepo,
  type EnvironmentSkill,
  SKILLS_ROOT,
  skillSourceText,
  variableField,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Approvals } from "./approvals.ts";
import { SIZE_LINES } from "./container.ts";
import { type EnvironmentLifecycle, lifecycleTools } from "./environment-lifecycle.ts";
import { resetTool } from "./environment-reset.ts";
import {
  GLOBAL_ID,
  GLOBAL_NAME,
  type SecretMarks,
  secretMarkTools,
} from "./environment-secret-marks.ts";
import { type EnvironmentSkills, skillTools } from "./environment-skills.ts";
import { holdsGitHubToken } from "./github-tokens.ts";
import { Redactions } from "./secrets/redaction.ts";
import { holdsPlaceholder, secretEnvName } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";

export {
  GLOBAL_ID,
  GLOBAL_NAME,
  type SecretMarked,
  type SecretMarks,
} from "./environment-secret-marks.ts";

export type { EnvironmentSkills, SkillRemoved, SkillSaved } from "./environment-skills.ts";

export const extensionName = "environment";

/** The prefix of every tool of the extension: all of them are the root conversation's only. */
export const ENVIRONMENT_TOOL_PREFIX = "environment_";

/** An Environment as `environment_list` shows it. */
export type EnvironmentListing = {
  readonly id: string;
  readonly name: string;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly build: BuildView;
};

/** A Secret kept for an Environment, by name only: where it is kept, and whether it reaches the Build. */
export type KeptSecretListing = {
  readonly name: string;
  /** Kept for this Environment, or Global. */
  readonly scope: "environment" | "every";
  readonly build: boolean;
};

/**
 * An Environment as `environment_get` shows it: its listing, every Container setting, its kept Secrets' names and its
 * own Skills.
 */
export type EnvironmentDetails = EnvironmentListing & {
  /** Its Container settings in force: its Overrides over Global's, the variables merged by name. */
  readonly settings: ContainerSettings;
  /** Its Overrides of Global's Container settings: a field here is its own, any other inherited. */
  readonly overrides: ContainerSettingsOverrides;
  /** The Container settings at Global, which a field without an Override inherits. */
  readonly global: ContainerSettings;
  /** Why only some of the saved settings apply, when a later release no longer accepts one. */
  readonly problem?: string | undefined;
  readonly secrets: ReadonlyArray<KeptSecretListing>;
  /** The Skills it keeps of its own, as `environment_get` lists them. */
  readonly skills: ReadonlyArray<EnvironmentSkill>;
  /** The Skills kept Global, which the Environment's own of the same name hide. */
  readonly globalSkills: ReadonlyArray<EnvironmentSkill>;
};

/**
 * What is kept Global, as `environment_get` shows it for the id `*`: the Container settings (the variables among them)
 * with the Environments that override each, the Secrets' names and the Skills.
 */
export type GlobalDetails = {
  readonly settings: ContainerSettings;
  /** The Environments that override each field, by its path (`idleMinutes`, `variables.<NAME>`). */
  readonly overriddenIn: Readonly<Record<string, ReadonlyArray<ChangedEnvironment>>>;
  readonly secrets: ReadonlyArray<KeptSecretListing>;
  readonly skills: ReadonlyArray<EnvironmentSkill>;
};

/** One Container setting given a new value: a setting's name or `variables.<NAME>`; null takes it back (unsets). */
export type SettingChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
};

/** Who makes an Agent change: the conversation that called the tool, the tool, and the agent's reason. */
export type ChangeAuthor = {
  readonly conversation: number;
  readonly tool: string;
  readonly reason: string;
  /** Set when the owner approved the change before it was made (`./approvals.ts`). */
  readonly approved?: true | undefined;
};

/** The Environment a change was made to, by id and name. */
export type ChangedEnvironment = { readonly id: string; readonly name: string };

/** How a change of a Container setting at Global reached the Environments. */
export type GlobalChanged = {
  /** The Environments that override the field (a variable: their own of the name wins), so it does not reach them. */
  readonly overriddenIn: ReadonlyArray<ChangedEnvironment>;
  /** The Environments for which the Build upkeep after it asked for a new Build. */
  readonly newBuilds: ReadonlyArray<ChangedEnvironment>;
  /** Whether it reaches this Session's own Workspace: its Environment does not override the field. */
  readonly own: boolean;
};

/** How an Agent change went, as the Session reports it. */
export type AppliedChange =
  | {
      readonly status: "changed";
      readonly environment: ChangedEnvironment;
      /** The change as the Registry recorded it, with the values before and after. */
      readonly change: AgentChange;
      /** Whether the Build upkeep after it asked for a new Build. */
      readonly newBuild: boolean;
      /** Set for a change at Global (the environment is then `GLOBAL_ID`). */
      readonly global?: GlobalChanged;
    }
  /** The setting already had the value: nothing was saved or recorded. */
  | {
      readonly status: "unchanged";
      readonly environment: ChangedEnvironment;
      readonly value: Schema.Json | null;
    }
  /** Not a value the setting takes, said as the owner's save says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  /** The setting no longer has the value the change was approved against: it is `current`, and nothing was saved. */
  | { readonly status: "changed-since"; readonly current: Schema.Json | null }
  | { readonly status: "missing" };

/** Reaching the Environments failed; its message is what the model sees. */
export class EnvironmentsError extends Schema.TaggedError<
  EnvironmentsError,
  { readonly brand: unique symbol }
>()("EnvironmentsError", { message: Schema.String }) {}

/** Why a text that holds a Secret Reference is refused: these tools resolve none, so it would be saved as written. */
const PLACEHOLDER_REFUSAL =
  "Nothing was saved: a text of the call holds a Secret Reference, which these tools do not resolve, so what they save would hold the reference's text, not the Secret. A credential belongs in a Secret kept for the Environment, which the user keeps on the Environments page: every command then gets it as $PI_SECRET_<NAME>, and it is taken out of their output.";

/**
 * The Environments, as the Session reaches them through the Registry. `change` applies an Agent change as the owner's
 * save does, hands it to the Session's own Workspace at once when it is the Session's Environment, and runs the Build
 * upkeep after it.
 */
export type EnvironmentsService = {
  /** The Session's own Environment; null for a Session the Registry does not list. */
  readonly current: Effect.Effect<string | null, EnvironmentsError>;
  readonly list: Effect.Effect<ReadonlyArray<EnvironmentListing>, EnvironmentsError>;
  /** Environment `id`, or null when there is none. */
  readonly get: (id: string) => Effect.Effect<EnvironmentDetails | null, EnvironmentsError>;
  /** What is kept Global: its variables, its Secrets' names and its Skills. */
  readonly global: Effect.Effect<GlobalDetails, EnvironmentsError>;
  readonly change: (input: {
    readonly environment: string;
    readonly change: SettingChange;
    /** The value the setting must still have: the one the owner saw when they approved the change. */
    readonly expected?: { readonly value: Schema.Json | null } | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<AppliedChange, EnvironmentsError>;
} & EnvironmentLifecycle &
  SecretMarks &
  EnvironmentSkills;

export class Environments extends Context.Service<Environments, EnvironmentsService>()(
  "@cloudpid/extensions/environment/Environments",
) {}

/**
 * An Agent change of the Run, for the Notification its end sends: the tool, the Environment's name (absent for a change
 * to the Settings) and the field.
 */
export type RunChange = {
  readonly tool: string;
  readonly environmentName?: string | undefined;
  readonly field: string;
};

/** Where the Session keeps the Run's Agent changes until its end notifies the owner of them. */
export class AgentChangeLog extends Context.Service<
  AgentChangeLog,
  { readonly record: (change: RunChange) => Effect.Effect<void> }
>()("@cloudpid/extensions/environment/AgentChangeLog") {}

/**
 * The deploy-time credentials no plain value may hold: the GitHub App's private key. The GitHub tokens minted from it
 * are never seen here; any text shaped like one is refused instead (`holdsGitHubToken`).
 */
export class DeployCredentials extends Context.Service<
  DeployCredentials,
  { readonly values: ReadonlyArray<string> }
>()("@cloudpid/extensions/environment/DeployCredentials") {}

/**
 * Whether a text holds a deploy-time credential, as written or in an encoding redaction knows, or anything shaped like
 * a GitHub token: what no plain value the agent saves may hold.
 */
export const credentialCheck: Effect.Effect<(text: string) => boolean, never, DeployCredentials> =
  Effect.gen(function* () {
    const credentials = new Redactions();

    for (const value of (yield* DeployCredentials).values) {
      credentials.hold("GITHUB_APP_PRIVATE_KEY", value);
    }

    return (text: string) => credentials.redact(text) !== text || holdsGitHubToken(text);
  });

/** The longest reason a change may give. */
export const MAX_CHANGE_REASON = 500;

const iso = (time: number): string => DateTime.formatIso(DateTime.makeUnsafe(time));

/** The last characters of a failed Build's reason that `environment_get` shows. */
const FAILED_REASON_TAIL = 1_000;

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

const reposLine = (repos: ReadonlyArray<EnvironmentRepo>): string =>
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
const describeGlobal = (details: GlobalDetails): string => {
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
const listingLine = (environment: EnvironmentListing, current: boolean): string =>
  `- ${environment.id}: ${JSON.stringify(environment.name)}${current ? " (this Session's)" : ""}; repos: ${reposLine(environment.repos)}; Build: ${describeBuild(environment.build)}`;

/** A variable's value as the result shows it: plain, in full. */
const shownValue = (value: Schema.Json | null): string =>
  value === null ? "not set" : JSON.stringify(value);

/** An Environment as a result names it: its name in quotes, then its id; or Global. */
const namedEnvironment = ({ id, name }: { readonly id: string; readonly name: string }): string =>
  id === GLOBAL_ID ? GLOBAL_NAME : `Environment ${JSON.stringify(name)} (${id})`;

/** When a change applies, and whether a Build was asked for. */
export const describeApplied = (own: boolean, newBuild: boolean): string =>
  Arr.join(
    [
      "It applies at the next Container start of each of the Environment's Workspaces: a Container that runs keeps what it started with.",
      ...(own
        ? [
            "This is this Session's own Environment, and its Workspace has the change already: container_restart applies it to this Workspace's Container now.",
          ]
        : []),
      ...(newBuild
        ? [
            "The Environment's Build is made with it, so a new Build was asked for (environment_get shows how it goes; environment_rebuild asks for another now, such as after it failed).",
          ]
        : []),
    ],
    " ",
  );

/**
 * When a change of a Container setting at Global (`field`) applies, whom it does not reach, and whose Build was asked
 * for.
 */
export const describeAppliedGlobal = (
  field: string,
  { overriddenIn, newBuilds, own }: GlobalChanged,
): string =>
  Arr.join(
    [
      overriddenIn.length === 0
        ? "No Environment overrides it, so it reaches them all."
        : `An Environment's own value wins; it does not reach ${Arr.join(Arr.map(overriddenIn, namedEnvironment), ", ")}, which override it.`,
      ...(field === SPARE_WORKSPACE_FIELD
        ? ["It applies at once: no Container restarts."]
        : [
            "It applies at the next Container start of every Workspace that inherits it: a Container that runs keeps what it started with.",
          ]),
      ...(own && field !== SPARE_WORKSPACE_FIELD
        ? [
            "This Session's Workspace has the change already: container_restart applies it to its Container now.",
          ]
        : []),
      ...(newBuilds.length === 0
        ? []
        : [
            `The Builds are made with it, so a new Build was asked for in ${Arr.join(Arr.map(newBuilds, namedEnvironment), ", ")} (environment_get shows how each goes).`,
          ]),
    ],
    " ",
  );

/** What a result says of a Container-setting change's recording, after the setting itself. */
// The id is written out: `GLOBAL_ID` is not there yet when this module loads first (`idOrGlobal`).
const RECORDED = `With id "*" the setting is changed at Global: every Environment that does not override it inherits it, and a new Build is asked for in each whose Build is made with it. Setting an Environment's value makes it the Environment's own (an Override), which a later change at Global does not reach; environment_setting_reset makes it inherit Global's again. The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.`;

/** US dollars, to two significant digits. */
const money = (dollars: number): string => `$${dollars.toPrecision(2)}`;

/** The memory cost of idle time: a Container that sits unused is billed for its memory until the idle stop. */
export const describeIdleCost = (minutes: number, instance: InstanceType): string => {
  const { memoryMib } = INSTANCE_RESOURCES[instance];
  const perMinute = containerRates(instance).memory * 60;

  return `A Container that sits unused is billed for its memory until the idle stop: at ${instance} (${memoryMib / 1024} GiB) about ${money(perMinute)} a minute, so up to ${money(perMinute * minutes)} for each idle stretch of ${minutes} minute${minutes === 1 ? "" : "s"}, per Workspace. A shorter idle time costs less but loses the warm Container (the next command starts a new one from the snapshot, several seconds).`;
};

/** A size as the owner reads it on an Approval card: its name, with its resources. */
export const sizeWords = (size: InstanceType): string => `${size} (${INSTANCE_DESCRIPTIONS[size]})`;

/** A script or Toolchains value as a result sizes it: the card shows the user the difference. */
export const textSize = (value: Schema.Json | null): string => {
  const text = Predicate.isString(value) ? value : "";
  const lines = text.replace(/\n$/, "").split("\n").length;

  return text === ""
    ? "none"
    : `${lines} line${lines === 1 ? "" : "s"}, ${new TextEncoder().encode(text).length} bytes`;
};

/** A size or a number of minutes as a result says it: a text bare, a number as it is. */
export const plainValue = (value: Schema.Json | null): string =>
  Predicate.isString(value) ? value : JSON.stringify(value);

/** A list of Container-only paths as a result says it. */
export const pathsLine = (value: Schema.Json | null): string =>
  Arr.isArray(value) && value.length > 0 ? Arr.join(Arr.map(value, String), ", ") : "none";

/** Where a tool's `id` description says to find this Session's own Environment: it is named like any other. */
const FIND_OWN = "environment_list marks this Session's own";

/** A tool's required `id`: one Environment, named even when it is this Session's own. */
export const Id = Schema.String.annotate({
  description: `The id of the Environment, as environment_list shows it (${FIND_OWN}). Name it on purpose: there is no default`,
});

/**
 * The `id` of a tool that also takes `*`, `kept` saying what that addresses. Built when used: the constant is not there
 * when this module loads first.
 */
export const idOrGlobal = (kept: string) =>
  Schema.String.annotate({
    description: `The id of the Environment, as environment_list shows it (${FIND_OWN}), or "${GLOBAL_ID}" for ${kept}. Name it on purpose: there is no default`,
  });

/**
 * Fails when `id` is `*`, which only the tools that keep something at Global take: the others change one
 * Environment's own record, or (`environment_setting_reset`) make one Environment's field inherit Global's.
 */
export const refuseGlobal = (id: string) =>
  id === GLOBAL_ID
    ? EnvironmentsError.make({
        message: `The id "${GLOBAL_ID}" names what is kept Global (the Container settings, Secrets and Skills): only environment_get, the Container setting tools (environment_variable_set, environment_variable_unset, environment_container_resize, environment_container_size_limit_set, environment_idle_time_set, environment_ignore_set, environment_setup_script_set, environment_start_script_set, environment_toolchains_set, environment_spare_workspace_set), environment_secret_build, environment_secret_delete, environment_skill_save, environment_skill_install, environment_skill_update and environment_skill_remove take it. Name one Environment with its id (environment_list shows them).`,
      })
    : Effect.void;

/** A changing tool's required `reason`, 1 to `MAX_CHANGE_REASON` characters; a tool may annotate its own example. */
export const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Environment's Agent changes, such as 'the tests read the API address from API_URL'",
});

const VariableName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The variable's name, such as API_URL: letters, digits and _, not starting with a digit",
});

const PLAIN_VALUES =
  "Variables are plain: every command, and you, can read them, and they are not taken out of output. Never put a credential in one: a value holding a Secret this Session holds, or a GitHub token, is refused, and so is a Secret Reference, which is not resolved here.";

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json): JsonValue => value as JsonValue;

const notFound = (id: string) =>
  EnvironmentsError.make({
    message: `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`,
  });

/**
 * The `environment` extension: its tools over the Session's `Environments`, refusing values that hold a Secret
 * (`Secrets`) or a deploy-time credential (`DeployCredentials`), and telling the Session of each change for the Run's
 * Notification (`AgentChangeLog`).
 */
export const EnvironmentTools: Effect.Effect<
  Extension,
  never,
  Environments | AgentChangeLog | DeployCredentials | Secrets | Approvals
> = Effect.gen(function* () {
  const environments = yield* Environments;
  const log = yield* AgentChangeLog;
  const secrets = yield* Secrets;
  const approvals = yield* Approvals;

  const holdsCredential = yield* credentialCheck;

  /** The `id` of a Container setting tool: one Environment, or `*` for Global's. */
  const SettingId = idOrGlobal(
    "the Container setting at Global, which each Environment that does not override it inherits",
  );

  /**
   * Whether `value` holds a Secret's value or a credential, as written or in an encoding redaction knows: checked once
   * the Secrets are fresh, so one the owner has just kept for the Environment counts. A text these tools keep that holds
   * a Secret Reference (held or not, such as one a message was scrubbed to) fails the call instead: these tools resolve
   * none, so what they save would hold the reference's text, not the Secret.
   */
  const holdsSecret = (value: string) =>
    holdsPlaceholder(value)
      ? Effect.fail(EnvironmentsError.make({ message: PLACEHOLDER_REFUSAL }))
      : Effect.map(
          secrets.refresh,
          () => secrets.redact(value) !== value || holdsCredential(value),
        );

  /** The Environment `id` names (never assumed: a call without one fails to decode), with whether it is this Session's. */
  const target = (id: string) =>
    Effect.gen(function* () {
      yield* refuseGlobal(id);

      return { environment: id, own: id === (yield* environments.current) };
    });

  /**
   * Apply the change of `field` to `value` as `tool`, and say how it went: refused when any of `texts` holds a Secret
   * (`refusal` says it) or the reason does, then `prepare`d with the Environment found (which may refuse it too, or hand
   * `changed` what it read), then made by the Registry. `id` may be `*`: the change is then to the Container settings
   * at Global; a `value` of null resets the field (an Environment's then inherits Global's).
   */
  const applyChange = <Prepared>({
    tool,
    id,
    field,
    value,
    texts = [],
    refusal = "",
    reason,
    conversation,
    prepare,
    unchanged,
    changed,
  }: {
    readonly tool: string;
    readonly id: string;
    readonly field: string;
    readonly value: Schema.Json | null;
    /** The text the value is made of, kept as written: none holds a Secret's value or a credential. */
    readonly texts?: ReadonlyArray<string>;
    /** What a refusal for a text that holds a Secret says. */
    readonly refusal?: string;
    readonly reason: string;
    readonly conversation: number;
    readonly prepare: (environment: string) => Effect.Effect<Prepared, EnvironmentsError>;
    /** The result for a field that already has the value, given the Environment named. */
    readonly unchanged: (where: string) => string;
    /** The result for a change made, given the Environment named. */
    readonly changed: (made: {
      readonly where: string;
      readonly change: AgentChange;
      readonly own: boolean;
      readonly newBuild: boolean;
      /** Set for a change at Global. */
      readonly global: GlobalChanged | undefined;
      /** When the change applies, whom it reaches, and whose Build was asked for. */
      readonly applies: string;
      readonly prepared: Prepared;
    }) => string;
  }) =>
    Effect.gen(function* () {
      if (texts.length > 0 && (yield* holdsSecret(Arr.join(texts, "\n")))) {
        return yield* EnvironmentsError.make({ message: refusal });
      }

      // The reason is kept with the change as written, for the user to read.
      if (yield* holdsSecret(reason)) {
        return yield* EnvironmentsError.make({
          message:
            "Nothing was saved: the reason holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Say why without it.",
        });
      }

      const { environment, own } =
        id === GLOBAL_ID ? { environment: GLOBAL_ID, own: false } : yield* target(id);

      const prepared = yield* prepare(environment);

      const applied = yield* environments.change({
        environment,
        change: { field, value },
        author: { conversation, tool, reason },
      });

      switch (applied.status) {
        case "missing":
          return yield* notFound(environment);
        case "rejected":
          return yield* EnvironmentsError.make({
            message: `Nothing was saved: ${applied.message}`,
          });
        // Only a change made against an expected value, which these tools never give.
        case "changed-since":
          return yield* EnvironmentsError.make({
            message: `Nothing was saved: ${field} changed meanwhile, to ${shownValue(applied.current)}`,
          });
        case "unchanged": {
          const where = namedEnvironment(applied.environment);

          return {
            output: [
              {
                type: "text" as const,
                text: unchanged(where),
              },
            ],
            details: { unchanged: { environment: applied.environment, field } },
          };
        }

        case "changed": {
          const { change } = applied;
          // A change at Global reaches the Session's own Workspace unless its Environment overrides it.
          const reaches = applied.global?.own ?? own;

          yield* log.record({ tool, environmentName: applied.environment.name, field });

          return {
            output: [
              {
                type: "text" as const,
                text: changed({
                  where: namedEnvironment(applied.environment),
                  change,
                  own: reaches,
                  newBuild: applied.newBuild,
                  global: applied.global,
                  applies:
                    applied.global === undefined
                      ? describeApplied(own, applied.newBuild)
                      : describeAppliedGlobal(field, applied.global),
                  prepared,
                }),
              },
            ],
            details: {
              agentChange: {
                id: change.id,
                environment: applied.environment,
                field,
                before: asJsonValue(change.before),
                after: asJsonValue(change.after),
              },
              own: reaches,
              newBuild: applied.newBuild,
            },
          };
        }
      }
    });

  /**
   * The Container settings in force where a change is made, with how a result names the place: Environment
   * `environment`'s, or Global's (`GLOBAL_ID`).
   */
  const settingsAt = (environment: string) =>
    Effect.gen(function* () {
      if (environment === GLOBAL_ID) {
        return { where: GLOBAL_NAME, settings: (yield* environments.global).settings };
      }

      const details = yield* environments.get(environment);

      if (details === null) return yield* notFound(environment);

      return { where: namedEnvironment(details), settings: details.settings };
    });

  /** Apply `change` of variable `name` as `tool`, and say how it went. */
  const changeVariable = (
    tool: string,
    {
      id,
      name,
      value,
      reason,
    }: {
      readonly id: string;
      readonly name: string;
      readonly value: string | null;
      readonly reason: string;
    },
    conversation: number,
  ) => {
    const atGlobal = id === GLOBAL_ID;
    const preposition = atGlobal ? "for" : "in";

    return applyChange({
      tool,
      id,
      field: variableField(name),
      value,
      texts: value === null ? [] : [value],
      refusal: `Nothing was saved: the value holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Variables are plain, so every command and the agent read them. Ask the user to keep the value as a Secret for the Environment on the Environments page instead: every command then gets it as $PI_SECRET_<NAME>, and it is taken out of their output.${atGlobal ? ` If the value is not secret (an email, a URL) and is kept as a Secret only so it is kept Global, ask the user to delete that Secret first (environment_secret_delete asks for their Approval, or they delete it on the Environments page): then this call saves it as a variable at Global.` : ""}`,
      reason,
      conversation,
      prepare: () => Effect.void,
      unchanged: (where) =>
        value === null
          ? `${name} is not set ${preposition} ${where}: nothing changed, and nothing was recorded.`
          : `${name} already has that value ${preposition} ${where}: nothing changed, and nothing was recorded.`,
      changed: ({ where, change, applies }) =>
        `${value === null ? `Unset ${name}` : `Set ${name}`} ${preposition} ${where}: it was ${shownValue(change.before)}, and is ${shownValue(change.after)} now. ${applies}`,
    });
  };

  /** The refusal of a script, Toolchains or path that holds a Secret's value: they are stored as written. */
  const storedAsWritten = (what: string) =>
    `Nothing was saved: the ${what} holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. It is stored as written, and every command and the agent can read it. Use the Secret's name instead: ask the user to keep the value as a Secret for the Environment on the Environments page, and a command or script then gets it as $PI_SECRET_<NAME> (a Setup Script too, when the user marks the Secret for the Build).`;

  /** Apply a change of a text setting (a script or the Toolchains) as `tool`. */
  const changeText = (
    tool: string,
    {
      field,
      what,
      id,
      text,
      reason,
      note,
    }: {
      readonly field: "setupScript" | "startScript" | "toolchains";
      /** What the setting is called in a result. */
      readonly what: string;
      readonly id: string;
      readonly text: string;
      readonly reason: string;
      /** What the result adds of when the setting runs or is used. */
      readonly note: string;
    },
    conversation: number,
  ) =>
    applyChange({
      tool,
      id,
      field,
      value: text,
      texts: [text],
      refusal: storedAsWritten(what),
      reason,
      conversation,
      prepare: () => Effect.void,
      unchanged: (where) =>
        `The ${what} of ${where} is that text already: nothing changed, and nothing was recorded.`,
      changed: ({ where, change, newBuild, global, applies }) =>
        `${text === "" ? `Removed the ${what}` : `Set the ${what}`} of ${where}: it was ${textSize(change.before)}, and is ${textSize(change.after)} now (the user sees the difference on the Environments page). ${note} ${applies}${newBuild || global !== undefined ? "" : " No new Build was asked for."}`,
    });

  const list = yield* defineEffectTool({
    name: "environment_list",
    description:
      "List the Environments: each one's id, name, Repos and Build, marking this Session's own, and how many variables are kept Global. An Environment is what a Workspace is made from: its Repos and its Container settings. Use environment_get with an id to see an Environment's settings.",
    parameters: Schema.Struct({}),
    replay: "safe",
    execute: () =>
      Effect.gen(function* () {
        const current = yield* environments.current;
        const listed = yield* environments.list;
        const globalDetails = yield* environments.global;

        return {
          output: [
            {
              type: "text" as const,
              text:
                listed.length === 0
                  ? "There are no Environments."
                  : `Environments (id: name):\n${Arr.join(
                      Arr.map(listed, (environment) =>
                        listingLine(environment, environment.id === current),
                      ),
                      "\n",
                    )}\nVariables at Global: ${Record.size(globalDetails.settings.variables)} (environment_get with id "${GLOBAL_ID}" shows them and the other Container settings at Global)`,
            },
          ],
          details: { current, environments: Arr.map(listed, ({ id, name }) => ({ id, name })) },
        };
      }),
  });

  const get = yield* defineEffectTool({
    name: "environment_get",
    description: `Show an Environment (the one id names; environment_list marks this Session's own): its name and Repos, every Container setting (size, size limit, idle time, Container-only paths, variables, Setup and Start Scripts, Toolchains, Spare Workspace) in force, each marked as its own (overridden here) or inherited from Global, the variables kept Global that its own do not override, the names of the Secrets kept for it and Global (never their values), its own Skills (name, description, when saved) and the Skills kept Global that its own do not override, and how its Build stands, with the end of the last failed Build's reason. With id "${GLOBAL_ID}", show what is kept Global instead: its Container settings with the Environments that override each, the names of its Secrets and its Skills.`,
    parameters: Schema.Struct({
      id: idOrGlobal("the Container settings, Secrets and Skills kept Global"),
    }),
    replay: "safe",
    execute: ({ id }) =>
      Effect.gen(function* () {
        if (id === GLOBAL_ID) {
          return {
            output: [{ type: "text" as const, text: describeGlobal(yield* environments.global) }],
            details: {
              environment: { id: GLOBAL_ID, name: GLOBAL_NAME },
              current: false,
            },
          };
        }

        const { environment, own } = yield* target(id);
        const details = yield* environments.get(environment);

        if (details === null) return yield* notFound(environment);

        return {
          output: [{ type: "text" as const, text: describeEnvironment(details, own) }],
          details: { environment: { id: details.id, name: details.name }, current: own },
        };
      }),
  });

  const set = yield* defineEffectTool({
    name: "environment_variable_set",
    description: Arr.join(
      [
        "Set one of an Environment's variables (the one id names): every command on its Workspaces' Containers, their Setup and Start Scripts and the Environment's Build get it. The same rules as the user's Edit dialog: at most 50 variables, values of at most 4096 characters, and names a shell can export, other than those the Container sets itself (PATH, HOME, GITHUB_TOKEN, CLOUDPID_…).",
        `With id "${GLOBAL_ID}" the variable is kept Global, for a value that is shared and not secret (an email, a URL); an Environment's own variable of the same name wins, and the 50 counts an Environment's own and the ones it inherits together, so a call that would leave any Environment with more is refused. Each Environment's Build is made with it, so a new Build is asked for in each Environment that does not override it.`,
        PLAIN_VALUES,
        "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: idOrGlobal("a variable kept Global"),
      name: VariableName,
      value: Schema.String.annotate({ description: "The value, saved as written" }),
      reason: Reason,
    }),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: (args, api) => changeVariable("environment_variable_set", args, api.conversationId),
  });

  const unset = yield* defineEffectTool({
    name: "environment_variable_unset",
    description: `Unset one of an Environment's variables (the one id names; id "${GLOBAL_ID}" is a variable kept Global, which no Environment inherits any more, and a new Build is asked for in each that did). The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now. A variable that is not set is left as it is, and nothing is recorded.`,
    parameters: Schema.Struct({
      id: idOrGlobal("a variable kept Global"),
      name: VariableName,
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      changeVariable("environment_variable_unset", { ...args, value: null }, api.conversationId),
  });

  const resize = yield* defineEffectTool({
    name: "environment_container_resize",
    description: Arr.join(
      [
        "Set the Container size of an Environment (the one id names): the size the next Container of every one of its Workspaces starts on, and the size they keep after each idle stop.",
        `Sizes, by memory, then vCPU:\n${SIZE_LINES}`,
        "Memory is what a running Container costs, so a larger size costs more for every Workspace of the Environment. The Environment's size limit bounds the size: a larger one is refused, and the limit is a Limit that only the user can raise, with environment_container_size_limit_set, which asks for their Approval.",
        "This changes the Environment, not a Container that runs: it keeps the size it started on, and a size container_resize gave it holds there until its idle stop. To restart only this Workspace's current Container at another size, for more memory now, use container_resize, which changes no Environment.",
        RECORDED,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: SettingId,
      size: InstanceType.annotate({ description: "The size of the Environment's next Containers" }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, size, reason }, api) =>
      applyChange({
        tool: "environment_container_resize",
        id,
        field: "instance",
        value: size,
        reason,
        conversation: api.conversationId,
        prepare: (environment) =>
          Effect.gen(function* () {
            const { where, settings } = yield* settingsAt(environment);
            const limit = settings.maxInstance;

            if (compareInstances(size, limit) > 0) {
              return yield* EnvironmentsError.make({
                message: `Nothing was saved: ${size} is above the size limit of ${where}, ${limit}. Pick a size up to ${limit}, or ask the user to raise the limit: environment_container_size_limit_set asks for their Approval to raise it.`,
              });
            }
          }),
        unchanged: (where) =>
          `The Container size of ${where} is ${size} already: nothing changed, and nothing was recorded.`,
        changed: ({ where, change, own, applies }) =>
          `Set the Container size of ${where}: it was ${plainValue(change.before)}, and is ${plainValue(change.after)} now (${INSTANCE_DESCRIPTIONS[size]}). It is the size of the next Container of every Workspace it reaches, and of those after each idle stop; Containers that run keep their size, and container_resize changes only this Workspace's current Container, until its idle stop, and no Environment. ${applies}${own ? " If container_resize gave this Workspace's Container another size, that size holds through container_restart until the idle stop." : ""}`,
      }),
  });

  const idleTime = yield* defineEffectTool({
    name: "environment_idle_time_set",
    description: Arr.join(
      [
        `Set an Environment's idle time (the one id names): the minutes a Container may sit without a command before its Workspace stops it, from 1 to ${MAX_IDLE_MINUTES}. A disk snapshot is taken first, so the next command starts a new Container from it in several seconds.`,
        "A Container is billed for its memory for as long as it runs, idle or not, so a long idle time costs more; a short one stops a Container between a few minutes of thought and work. The result names the cost at the Environment's size.",
        RECORDED,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: SettingId,
      minutes: Schema.Finite.annotate({
        description: `Minutes of idle time, a whole number from 1 to ${MAX_IDLE_MINUTES}`,
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, minutes, reason }, api) =>
      applyChange({
        tool: "environment_idle_time_set",
        id,
        field: "idleMinutes",
        value: minutes,
        reason,
        conversation: api.conversationId,
        prepare: settingsAt,
        unchanged: (where) =>
          `The idle time of ${where} is ${minutes} already: nothing changed, and nothing was recorded.`,
        changed: ({ where, change, applies, prepared }) =>
          `Set the idle time of ${where}: it was ${plainValue(change.before)} minutes, and is ${plainValue(change.after)} now. ${describeIdleCost(minutes, prepared.settings.instance)} ${applies}`,
      }),
  });

  const setupScript = yield* defineEffectTool({
    name: "environment_setup_script_set",
    description: Arr.join(
      [
        `Set an Environment's own Setup Script (the one id names): the whole bash text, at most ${MAX_SCRIPT_BYTES / 1024} KiB of UTF-8; an empty script removes it. It prepares what the Environment's Workspaces need whatever their Repos (system packages, a Docker image), in /workspace.`,
        "It runs once per content on each Container (when the content changes, or on a Container started from the image; one restored from a snapshot has run it already), before the Repos' own Setup Scripts, and in the Environment's Build. A Setup Script is part of what a Build is made with, so a changed one makes a new Build. It gets the Environment's variables and the Secrets marked for the Build, runs for 15 minutes at most, and a failure stops no command. Nothing validates the bash before it runs.",
        "A step that belongs to one Repo (installing its dependencies) is usually better in that Repo's own .cloudpid/setup.sh, which is committed with the code; use this one for what is the Environment's.",
        "The text is stored as written: a Secret this Session holds, or a GitHub token, in it is refused.",
        RECORDED,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: SettingId,
      script: Schema.String.annotate({
        description: "The whole script, replacing the one there is; empty removes it",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, script, reason }, api) =>
      changeText(
        "environment_setup_script_set",
        {
          field: "setupScript",
          what: "Setup Script",
          id,
          text: script,
          reason,
          note: "It runs once with this content on each Container: at each Workspace's next Container start (one restored from a snapshot has run the old script, not this one), and in the Environment's Build.",
        },
        api.conversationId,
      ),
  });

  const startScript = yield* defineEffectTool({
    name: "environment_start_script_set",
    description: Arr.join(
      [
        `Set an Environment's own Start Script (the one id names): the whole bash text, at most ${MAX_SCRIPT_BYTES / 1024} KiB of UTF-8; an empty script removes it. It brings up what a snapshot cannot hold, such as a database or docker compose up, in /workspace.`,
        "It runs at every Container start (a restored Container too), after the Setup Scripts and before the Repos' own Start Scripts, for 5 minutes at most; a failure stops no command. A service it starts must detach, or the script never ends: setsid nohup cmd >/tmp/cmd.log 2>&1 &. It may run again on a Container that already runs, so it should leave a service that is up alone. A Start Script is not part of the Build.",
        "A step that belongs to one Repo is usually better in that Repo's own .cloudpid/start.sh, which is committed with the code; use this one for what is the Environment's.",
        "The text is stored as written: a Secret this Session holds, or a GitHub token, in it is refused.",
        RECORDED,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: SettingId,
      script: Schema.String.annotate({
        description: "The whole script, replacing the one there is; empty removes it",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, script, reason }, api) =>
      changeText(
        "environment_start_script_set",
        {
          field: "startScript",
          what: "Start Script",
          id,
          text: script,
          reason,
          note: "It runs at every Container start of each Workspace, a restored one too; a service it starts must detach.",
        },
        api.conversationId,
      ),
  });

  const toolchains = yield* defineEffectTool({
    name: "environment_toolchains_set",
    description: Arr.join(
      [
        `Set an Environment's Toolchains (the one id names): the text of a mise.toml, at most ${MAX_TOOLCHAINS_BYTES / 1024} KiB of UTF-8 with no NUL; empty means the image's base Toolchains. mise reads it, not the save: a bad one fails the install at the next Container start.`,
        "The bootstrap writes it as /workspace/mise.toml where a Workspace has none or still has the copy it wrote last, and installs from it; a Workspace whose own mise.toml was changed keeps that one. Toolchains are part of what a Build is made with, so a changed text makes a new Build.",
        "The text is stored as written: a Secret this Session holds, or a GitHub token, in it is refused.",
        RECORDED,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: SettingId,
      mise_toml: Schema.String.annotate({
        description:
          "The whole mise.toml, replacing the one there is; empty means the base Toolchains",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, mise_toml, reason }, api) =>
      changeText(
        "environment_toolchains_set",
        {
          field: "toolchains",
          what: "Toolchains",
          id,
          text: mise_toml,
          reason,
          note: "mise installs them at each Workspace's next Container start.",
        },
        api.conversationId,
      ),
  });

  const ignore = yield* defineEffectTool({
    name: "environment_ignore_set",
    description: Arr.join(
      [
        `Set an Environment's extra Container-only paths (the one id names): the full list, replacing the one there is, of at most ${MAX_IGNORE_PATTERNS} patterns. A path matching one lives on the Container's disk only: it is not synced to the Workspace, so it is fast and kept out of its storage, and it is gone when the Workspace's Container is restarted fresh. The built-in list already covers node_modules, .venv, caches and build tools' output directories.`,
        'A pattern starts with "/" (from /workspace: "/data" is /workspace/data) or "**/" (at any depth), may start with "!" to keep a path synced again, and has only "*" and "**" (a whole segment) as wildcards. The last pattern that matches a path wins. A bad pattern is refused as the user\'s save refuses it.',
        "A changed list means the next Container of each Workspace starts without the Workspace's snapshot (a snapshot is tied to the list its Container launched with): from the Environment's Build once there is one for the new list, else from the image, so dependency directories, build output and caches are made again and the Setup Scripts run again, which takes minutes.",
        "The patterns are stored as written: a Secret this Session holds, or a GitHub token, in one is refused.",
        RECORDED,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: SettingId,
      patterns: Schema.Array(Schema.String).annotate({
        description: "The whole list of extra Container-only paths; empty removes them all",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, patterns, reason }, api) =>
      applyChange({
        tool: "environment_ignore_set",
        id,
        field: "ignore",
        value: patterns,
        texts: patterns,
        refusal: storedAsWritten("list of patterns"),
        reason,
        conversation: api.conversationId,
        prepare: () => Effect.void,
        unchanged: (where) =>
          `The extra Container-only paths of ${where} are that list already: nothing changed, and nothing was recorded.`,
        changed: ({ where, change, applies }) =>
          `Set the extra Container-only paths of ${where}: they were ${pathsLine(change.before)}, and are ${pathsLine(change.after)} now. Warning: the next Container of each Workspace it reaches starts without the Workspace's snapshot, from the Environment's Build once there is one for this list, else from the image: dependency directories, build output and caches are made again, and the Setup Scripts run again (minutes). ${applies}`,
      }),
  });

  const spareWorkspace = yield* defineEffectTool({
    name: "environment_spare_workspace_set",
    description: Arr.join(
      [
        "Turn an Environment's Spare Workspace on or off (the one id names). On (the default), the Environment keeps one Workspace made ahead from its last good Build while it had a Session in the last 3 days: cloned, its Setup Scripts run, its Container snapshotted and stopped, so a new Session takes it and starts without waiting for the clones and the Setup Scripts. Each spare prepared runs a Container for a minute or two and keeps a Snapshot, after every Session that takes one and every new Build.",
        "Off: no spare is prepared, the one there is is removed with its Snapshot, and a new Session's Workspace is made when the Session starts, waiting for the clones and the Setup Scripts as the first Workspace after a Build does. Off saves that Container time for an Environment whose new Sessions can wait; on suits one whose new Sessions should start fast.",
        `With id "${GLOBAL_ID}" the setting is changed at Global: every Environment that does not override it inherits it. Setting an Environment's value makes it the Environment's own, which a later change at Global does not reach; environment_setting_reset makes it inherit Global's again.`,
        "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at once: no Container restarts, and no new Build is made.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: SettingId,
      enabled: Schema.Boolean.annotate({
        description: "true keeps a spare made ahead; false removes it and prepares none",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, enabled, reason }, api) =>
      applyChange({
        tool: "environment_spare_workspace_set",
        id,
        field: SPARE_WORKSPACE_FIELD,
        value: enabled,
        reason,
        conversation: api.conversationId,
        prepare: () => Effect.void,
        unchanged: (where) =>
          `The Spare Workspace of ${where} is ${enabled ? "on" : "off"} already: nothing changed, and nothing was recorded.`,
        changed: ({ where, global }) =>
          `${
            enabled
              ? `Turned the Spare Workspace of ${where} on: a spare is prepared now for each Environment it reaches that had a Session in the last 3 days, else after its next Session, and a new Session that takes it starts without waiting for the clones and the Setup Scripts.`
              : `Turned the Spare Workspace of ${where} off: the spare of each Environment it reaches, if it had one, is removed with its Snapshot, and none is prepared. A new Session's Workspace is made when the Session starts, waiting for the clones and the Setup Scripts.`
          }${global === undefined ? "" : ` ${describeAppliedGlobal(SPARE_WORKSPACE_FIELD, global)}`}`,
      }),
  });

  /**
   * Fails, saving nothing (`outcome` says what was not done), when a text holds a Secret the Session holds or a
   * deploy-time credential.
   */
  const refuseSecrets = (
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
    outcome = "Nothing was saved",
  ) =>
    Effect.gen(function* () {
      for (const { what, text } of texts) {
        if (text !== "" && (yield* holdsSecret(text))) {
          return yield* EnvironmentsError.make({
            message: `${outcome}: ${what} holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Say it without the value; a credential belongs in a Secret kept for the Environment, which the user keeps on the Environments page.`,
          });
        }
      }
    });

  const lifecycle = yield* lifecycleTools({ environments, log, refuseSecrets, target, notFound });

  const settingReset = yield* resetTool({
    environments,
    approvals,
    log,
    refuseSecrets,
    target,
    notFound,
  });

  const secretMarks = yield* secretMarkTools({ environments, log, refuseSecrets, target });

  const skills = yield* skillTools({
    environments,
    approvals,
    log,
    refuseSecrets,
    target,
    notFound,
  });

  return defineExtension({
    name: extensionName,
    tools: [
      list,
      get,
      set,
      unset,
      resize,
      idleTime,
      setupScript,
      startScript,
      toolchains,
      ignore,
      spareWorkspace,
      settingReset,
      ...lifecycle,
      ...secretMarks,
      ...skills,
    ],
  });
});
