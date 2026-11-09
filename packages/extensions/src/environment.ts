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
// tools do not resolve and no command would (`holdsSecret`). Each tool of this file and of `environment-reset.ts` and
// `environment-secret-marks.ts` declares a `structuredOutputSchema` and returns a matching `structuredOutput`, built
// from the same data as its text (`environment-outputs.ts`; `docs/architecture/agent-capabilities.md` → Values for
// programs): `environment_list` and `environment_get` give the Environments and their settings, each setter the outcome
// of the change (an unchanged field says so, as its text does). The setters' and `environment_secret_build`'s checks and
// words are cores the MCP endpoint serves too (`environment-changes.ts`; `docs/architecture/mcp-endpoint.md` → Environment
// and Settings tools → Shared definitions and the core/wrapper split): the tools here are the Session's wrappers over them,
// with their declarations from `@cloudpid/protocol/harness-tools`. Every tool but `environment_list` and `environment_create`
// takes a required `id` and none defaults to the Session's own Environment (`docs/architecture/agent-changes.md` → The
// Scope is named, never assumed; ADR-0027 → The agent names the Scope).
// @effect-diagnostics missingPipeableSignature:off
import {
  type ContainerSettings,
  type ContainerSettingsOverrides,
  INSTANCE_DESCRIPTIONS,
  InstanceType,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  environmentId,
  GLOBAL_ID,
  HARNESS_TOOLS,
  idDescription,
} from "@cloudpid/protocol/harness-tools";
import {
  type AgentChange,
  type BuildView,
  type EnvironmentRef,
  type EnvironmentRepo,
  type EnvironmentSkill,
} from "@cloudpid/protocol";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { Approvals } from "./approvals.ts";
import { type EnvironmentLifecycle, lifecycleTools } from "./environment-lifecycle.ts";
import { lifecycleCores } from "./environment-lifecycle-changes.ts";
import { EnvironmentsError, notFound } from "./environment-describe.ts";
import { environmentGetRead, environmentListRead } from "./environment-reads.ts";
import { resetCore, resetTool } from "./environment-reset.ts";
import { type SecretMarks, secretMarkTools } from "./environment-secret-marks.ts";
import { type EnvironmentSkills, skillTools } from "./environment-skills.ts";
import { environmentChangeCores } from "./environment-changes.ts";
import {
  credentialCheck,
  DeployCredentials,
  describeApplied,
  describeAppliedGlobal,
  environmentTarget,
  refuseSecretsIn,
} from "./environment-change-parts.ts";
import { type HarnessWriteAnswer, loggedOf, toolResult } from "./harness.ts";
import { outputSchema } from "./outputs.ts";
import { holdsPlaceholder } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";

export { type SecretMarked, type SecretMarks } from "./environment-secret-marks.ts";

// The supported import path for these, `apps/server` included, is this module: the leaf is an internal split.
export {
  describeBuild,
  describeEnvironment,
  describeGlobal,
  EnvironmentsError,
  listingLine,
  namedEnvironment,
  notFound,
  reposLine,
} from "./environment-describe.ts";

export type { EnvironmentSkills, SkillRemoved, SkillSaved } from "./environment-skills.ts";

export {
  credentialCheck,
  DeployCredentials,
  describeApplied,
  describeAppliedGlobal,
  describeIdleCost,
  type EnvironmentTarget,
  environmentTarget,
  pathsLine,
  plainValue,
  refuseGlobal,
  textSize,
} from "./environment-change-parts.ts";

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

/**
 * Who makes an Agent change: the conversation that called the tool (none where there is no Session: the endpoint's
 * core, whose service knows the caller instead), the tool, and the agent's reason.
 */
export type ChangeAuthor = {
  readonly conversation?: number | undefined;
  readonly tool: string;
  readonly reason: string;
  /** Set when the owner approved the change before it was made (`./approvals.ts`). */
  readonly approved?: true | undefined;
  /**
   * `owner` when the change is the owner's own act, made through the Session (the Sampling card's *Always allow* and
   * *Never*): the Registry records it as the owner's, with no conversation or tool, and with no revert. Absent: the agent's.
   */
  readonly actor?: "owner" | undefined;
};

/** The Environment a change was made to, by id and name. */
export type ChangedEnvironment = EnvironmentRef;

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

/**
 * A setting changed, as a result is made of it: `newBuild` is known only to the write that made it (the Build upkeep's),
 * so a change rebuilt from the Agent changes the Registry recorded has none, and its result leaves the Build to
 * `environment_get`.
 */
export type ChangedSetting = Omit<
  Extract<AppliedChange, { readonly status: "changed" }>,
  "newBuild"
> & {
  readonly newBuild?: boolean | undefined;
};

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
 * The check of a text a tool that waits for the owner's Approval (or a `trigger_*` tool) keeps or shows on the card: it fails, asking nothing,
 * when `text` (`what`: the reason, the Instructions' text, a Trigger message) holds a Secret the Session holds, a
 * deploy-time credential, or a Secret Reference's placeholder, which these tools do not resolve (the card and the
 * history would show the reference's text); `fix` says what to do instead.
 */
export const plainTextCheck: Effect.Effect<
  (text: string, what: string, fix: string) => Effect.Effect<void, EnvironmentsError>,
  never,
  Secrets | DeployCredentials
> = Effect.gen(function* () {
  const secrets = yield* Secrets;

  const holdsCredential = yield* credentialCheck;

  return (text: string, what: string, fix: string) =>
    holdsPlaceholder(text)
      ? Effect.fail(
          EnvironmentsError.make({
            message: `Nothing was asked or saved: ${what} holds a Secret Reference, which these tools do not resolve, so it would hold the reference's text, not the Secret. ${fix}`,
          }),
        )
      : Effect.flatMap(secrets.refresh, () =>
          secrets.redact(text) === text && !holdsCredential(text)
            ? Effect.void
            : EnvironmentsError.make({
                message: `Nothing was asked or saved: ${what} holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. ${fix}`,
              }),
        );
});

/** The longest reason a change may give. */
export const MAX_CHANGE_REASON = 500;

/** A stored value as a sentence says it: a text as it is, anything else as JSON (`null` when it was not set). */
export const storedText = (value: Schema.Json | null): string =>
  Predicate.isString(value) ? value : JSON.stringify(value);

/**
 * What a change of the size limit (`maxInstance`) says of whom it reaches. A change from the Registry's write says it all;
 * one built from the recorded Agent change does not know the Builds the upkeep asked for, and says where to look.
 */
export const describeLimitReach = (result: ChangedSetting, own: boolean): string => {
  if (result.global !== undefined) return describeAppliedGlobal("maxInstance", result.global);

  if (result.environment.id === GLOBAL_ID) {
    return "It applies at the next Container start of every Workspace that inherits it: a Container that runs keeps what it started with. environment_get shows the Builds.";
  }

  return describeApplied(own, result.newBuild);
};

/** How the write of one Container setting went: the Registry's answer, or one built from the Agent change it recorded. */
export type ContainerSettingResult =
  | Exclude<AppliedChange, { readonly status: "changed" }>
  | ChangedSetting;

/**
 * The Session's after-step of a change of one Container setting: tell the Run's Notification of a change that was made
 * (`applied` of a core, whose `result` is `ContainerSettingResult`).
 */
export const recordContainerSettingChange =
  (
    log: { readonly record: (change: RunChange) => Effect.Effect<void> },
    tool: string,
    field: string,
  ) =>
  ({ result }: { readonly result: ContainerSettingResult }): Effect.Effect<undefined> =>
    result.status === "changed"
      ? log
          .record({ tool, environmentName: result.environment.name, field })
          .pipe(Effect.as(undefined))
      : Effect.undefined;

/** A size as the owner reads it on an Approval card: its name, with its resources. */
export const sizeWords = (size: InstanceType): string => `${size} (${INSTANCE_DESCRIPTIONS[size]})`;

/** A tool's required `id`: one Environment, named even when it is this Session's own. */
export const Id = environmentId();

/** The `id` of `environment_setting_reset`: an Environment's, never `*`, since Global inherits nothing. */
export const IdNotGlobal = Id.annotate({
  description: `${idDescription()}. Not "*": Global's settings are not reset here`,
});

/** A changing tool's required `reason`, 1 to `MAX_CHANGE_REASON` characters; a tool may annotate its own example. */
export const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Environment's Agent changes, such as 'the tests read the API address from API_URL'",
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

  const target = environmentTarget(environments, "session");

  // The cores the endpoint serves too (`./environment-changes.ts`), here on the session surface.
  const cores = environmentChangeCores({ environments, holdsSecret });

  /** A core's answer as the Session's tool returns it, once the Run's Notification is told of the change it made. */
  const inSession = (answer: Effect.Effect<HarnessWriteAnswer, EnvironmentsError>) =>
    answer.pipe(
      Effect.tap(({ logged }) => Effect.forEach(loggedOf(logged), log.record, { discard: true })),
      Effect.map(toolResult),
    );

  const listRead = environmentListRead(environments);
  const getRead = environmentGetRead(environments);

  const list = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_list.name,
    description: HARNESS_TOOLS.environment_list.session.description,
    parameters: HARNESS_TOOLS.environment_list.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_list.session.output),
    replay: "safe",
    execute: () => Effect.map(listRead({}, "session"), toolResult),
  });

  const get = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_get.name,
    description: HARNESS_TOOLS.environment_get.session.description,
    parameters: HARNESS_TOOLS.environment_get.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_get.session.output),
    replay: "safe",
    execute: (args) => Effect.map(getRead(args, "session"), toolResult),
  });

  const set = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_variable_set.name,
    description: HARNESS_TOOLS.environment_variable_set.session.description,
    parameters: HARNESS_TOOLS.environment_variable_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_variable_set.session.output),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_variable_set(args, "session", api.conversationId)),
  });

  const unset = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_variable_unset.name,
    description: HARNESS_TOOLS.environment_variable_unset.session.description,
    parameters: HARNESS_TOOLS.environment_variable_unset.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_variable_unset.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_variable_unset(args, "session", api.conversationId)),
  });

  const resize = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_container_resize.name,
    description: HARNESS_TOOLS.environment_container_resize.session.description,
    parameters: HARNESS_TOOLS.environment_container_resize.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_container_resize.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_container_resize(args, "session", api.conversationId)),
  });

  const idleTime = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_idle_time_set.name,
    description: HARNESS_TOOLS.environment_idle_time_set.session.description,
    parameters: HARNESS_TOOLS.environment_idle_time_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_idle_time_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_idle_time_set(args, "session", api.conversationId)),
  });

  const setupScript = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_setup_script_set.name,
    description: HARNESS_TOOLS.environment_setup_script_set.session.description,
    parameters: HARNESS_TOOLS.environment_setup_script_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_setup_script_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_setup_script_set(args, "session", api.conversationId)),
  });

  const startScript = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_start_script_set.name,
    description: HARNESS_TOOLS.environment_start_script_set.session.description,
    parameters: HARNESS_TOOLS.environment_start_script_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_start_script_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_start_script_set(args, "session", api.conversationId)),
  });

  const toolchains = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_toolchains_set.name,
    description: HARNESS_TOOLS.environment_toolchains_set.session.description,
    parameters: HARNESS_TOOLS.environment_toolchains_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_toolchains_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_toolchains_set(args, "session", api.conversationId)),
  });

  const ignore = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_ignore_set.name,
    description: HARNESS_TOOLS.environment_ignore_set.session.description,
    parameters: HARNESS_TOOLS.environment_ignore_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_ignore_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_ignore_set(args, "session", api.conversationId)),
  });

  const spareWorkspace = yield* defineEffectTool({
    name: HARNESS_TOOLS.environment_spare_workspace_set.name,
    description: HARNESS_TOOLS.environment_spare_workspace_set.session.description,
    parameters: HARNESS_TOOLS.environment_spare_workspace_set.session.input,
    structuredOutputSchema: outputSchema(
      HARNESS_TOOLS.environment_spare_workspace_set.session.output,
    ),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_spare_workspace_set(args, "session", api.conversationId)),
  });

  /**
   * Fails, saving nothing (`outcome` says what was not done), when a text holds a Secret the Session holds or a
   * deploy-time credential.
   */
  const refuseSecrets = (
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
    outcome = "Nothing was saved",
  ) => refuseSecretsIn(holdsSecret)("session", texts, outcome);

  const lifecycle = yield* lifecycleTools(
    { environments, log, refuseSecrets, target, notFound },
    lifecycleCores({ environments, holdsSecret }),
  );

  const settingReset = yield* resetTool(
    {
      environments,
      approvals,
      log,
      refuseSecrets,
      target,
      notFound,
    },
    resetCore({ environments, holdsSecret }),
  );

  const secretMarks = yield* secretMarkTools({ core: cores.environment_secret_build, log });

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
