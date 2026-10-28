import * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { withEveryEnvironmentVariables } from "@cloudpid/config";
import { type KeptSecret, openKeptVault } from "@cloudpid/extensions/secrets/core";
import type {
  AgentChange,
  EnvironmentBuildState,
  EnvironmentRepo,
  EnvironmentSecretRecord,
  EnvironmentSkill,
  PushState,
  PushSubscription,
  SessionOrigin,
  SkillChangeFiles,
} from "@cloudpid/protocol";
import type { SkillSet } from "../workspace/bundled-skill-set.ts";
import {
  previewSkillSave,
  hashBundle,
  hashFiles,
  mergeSkills,
  openSkills,
  type OwnerRemoval,
  removeSkill,
  removeSkillAs,
  saveSkillAs,
  skillChangeFiles,
  type SkillPreview,
  type SkillFiles,
  skillLayers,
  type SkillRemoval,
  type SkillSave,
  skillSetOf,
} from "./skills.ts";
import { installSkills, previewSkillInstall, type SkillInstallation } from "./skill-install.ts";
import { githubSkillReader } from "./skill-reader.ts";
import {
  SETTINGS_SCOPE,
  type SkillExpectation,
  type SkillInstallPin,
  type SkillInstallPreview,
} from "@cloudpid/protocol";
import { SecretsConfig } from "../session/secrets.ts";
import {
  type AgentChangeAuthor,
  type AgentChangeRevert,
  changeEnvironment,
  changeEveryEnvironment,
  type ContainerFieldChange,
  type EnvironmentChange,
  type EveryEnvironmentChange,
  everyChangeReach,
  openAgentChanges,
  revertAgentChange,
  wantsNewBuild,
} from "./agent-changes.ts";
import {
  addRepoAs,
  createEnvironmentAs,
  type EnvironmentCreation,
  type LifecycleChange,
  type LifecycleChanged,
  type LifecycleOutcome,
  recordRebuildAs,
  removeRepoAs,
  renameEnvironmentAs,
} from "./environment-lifecycle.ts";
import {
  deleteSecretAs,
  markSecretBuildAs,
  type SecretBuildMark,
  type SecretDeletion,
  EVERY_ENVIRONMENT_NAME,
} from "./secret-changes.ts";
import {
  buildSecretsOf,
  keepSecret,
  keepSecretAs,
  type SecretsHandover,
  secretsHandover,
  type SecretWrite,
  usedSecrets,
} from "./environment-secrets.ts";
import type { BuildProgress, EnvironmentBuild } from "../workspace/build-record.ts";
import { type BuildWork, buildView } from "./builds.ts";
import { GitHubAppConfig } from "../github/config.ts";
import { PushConfig } from "../push/config.ts";
import { pushNotifier } from "../push/notify.ts";
import type { PushEvent } from "../push/notification.ts";
import { newEnvironmentId, newSessionId, newWorkspaceId, shortId } from "./ids.ts";
import { readSettings, type SettingsState, SettingsUpdate, writeSettings } from "./settings.ts";
import {
  changeSettings,
  revertSettingsChange,
  type SettingsChange,
  type SettingsChangeRevert,
  type SettingsFieldChange,
} from "./settings-changes.ts";
import {
  readEnvironmentSettings,
  type EnvironmentSettingsState,
  writeEnvironmentSettings,
} from "./environment-settings.ts";
import {
  type EveryEnvironmentState,
  everyVariablesOf,
  readEveryEnvironment,
  workspaceOverridesOf,
  writeEveryEnvironment,
} from "./every-environment.ts";
import {
  type Deletion,
  type EnvironmentDeletion,
  type EnvironmentNaming,
  type EnvironmentRecord,
  EVERY_ENVIRONMENT_SCOPE,
  type LegacyObject,
  openRegistryStore,
  type RepoChange,
  type SessionAgent,
  type SessionRecord,
  type SessionRefusal,
  type SubagentWorkspaceRefusal,
  type SessionStatus,
  type SpareUpkeep,
  type WorkspaceRecord,
  type WorkspaceSetup,
} from "./store.ts";

/** The Registry is a singleton: every caller addresses the object with this name. */
export const REGISTRY_NAME = "registry";

/** A new Session's Workspace: one that exists, or a new one of `environment`, on `branch` if given, from `base`. */
export type WorkspaceChoice =
  | { readonly kind: "existing"; readonly id: string }
  | {
      readonly kind: "new";
      readonly environment: string;
      readonly branch?: string | undefined;
      readonly base?: string | undefined;
    };

/**
 * What a Workspace's Durable Object sets itself up with, with its Environment's Container settings overrides, last
 * good Build (null for none yet) and kept Secrets, opened (docs/spec.md → Secrets): the Workspace keeps them sealed,
 * to search a snapshot for and to take out of output. When the Registry cannot open them, `secrets` is absent and
 * `secretsUnavailable` says so (`SECRETS_UNAVAILABLE`), and the Workspace refuses the snapshots that would need them.
 * `skills` is the Environment's Skill set (its own Skills over those kept for every Environment, over the bundle), absent when the Workspace holds it already.
 */
export type WorkspaceSetupWithSettings = WorkspaceSetup & {
  readonly settings: Schema.Json;
  readonly build: EnvironmentBuild | null;
  readonly skills?: SkillSet | undefined;
} & SecretsHandover;

/** `SpareUpkeep`, each spare made with the Container settings it is prepared with. */
export type SpareWork = {
  readonly stale: SpareUpkeep["stale"];
  readonly made: ReadonlyArray<WorkspaceSetupWithSettings>;
};

/** How saving an Environment's Container settings went. */
export type EnvironmentSettingsUpdate =
  | { readonly status: "saved"; readonly state: EnvironmentSettingsState }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/**
 * How an Agent change to an Environment went (`changeEnvironment`): as `EnvironmentChange` says, a change also saying
 * whether the Build upkeep after it asks for a new Build (`wantsNewBuild`).
 */
export type EnvironmentChangeAnswer =
  | {
      readonly status: "changed";
      readonly environment: EnvironmentRecord;
      readonly change: AgentChange;
      readonly state: EnvironmentSettingsState;
      readonly newBuild: boolean;
    }
  | Exclude<EnvironmentChange, { readonly status: "changed" }>;

/** How saving the settings kept for every Environment went. */
export type EveryEnvironmentSettingsUpdate =
  | { readonly status: "saved"; readonly state: EveryEnvironmentState }
  | { readonly status: "rejected"; readonly message: string };

/**
 * How an Agent change to a variable kept for every Environment went (`changeEveryEnvironment`): as
 * `EveryEnvironmentChange` says, a change also saying which Environments override the variable, so it does not reach
 * them, and which want a new Build (`wantsNewBuild`).
 */
export type EveryEnvironmentChangeAnswer =
  | {
      readonly status: "changed";
      readonly change: AgentChange;
      /** The variables kept for every Environment now. */
      readonly variables: Readonly<Record<string, string>>;
      readonly overriddenIn: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      readonly newBuilds: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      /**
       * Whether it reaches the Workspaces of the Environment the caller named: it does not override the variable.
       * Undefined: none named.
       */
      readonly own: boolean | undefined;
    }
  | Exclude<EveryEnvironmentChange, { readonly status: "changed" }>;

/** How keeping one Secret the owner chose to keep in a `secret_ask` form went: a message never holds the value. */
export type KeptAskedResult =
  | { readonly name: string; readonly status: "kept"; readonly shadowed: boolean }
  | { readonly name: string; readonly status: "rejected"; readonly message: string };

/** How keeping the Secrets of an answered `secret_ask` went. */
export type KeptAsked =
  /** The Registry does not list the Session. */
  | { readonly status: "unknown" }
  | {
      readonly status: "done";
      /** Where they were kept: the Session's Environment, or every Environment (id `*`). */
      readonly environment: { readonly id: string; readonly name: string };
      readonly results: ReadonlyArray<KeptAskedResult>;
    };

/** What the Registry DO answers over RPC. */
export type RegistryMethods = {
  /**
   * Register a new Session, idle, under a fresh UUIDv7, in a Workspace that exists, or in a new one of an Environment:
   * its spare when that is current, else one registered with it under a fresh id; on `branch` (default
   * `cloudpid/<id>`) from `base`. A refusal says why.
   */
  readonly createSession: (input: {
    readonly title?: string | undefined;
    readonly workspace: WorkspaceChoice;
    /** The Session it is a Fork or Clone of. */
    readonly origin?: SessionOrigin | undefined;
  }) => Effect.Effect<SessionRecord | SessionRefusal>;
  /** The Session registered under `id`, or null. */
  readonly getSession: (input: { readonly id: string }) => Effect.Effect<SessionRecord | null>;
  /** Every Session, newest first. */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<SessionRecord>>;
  /** The Session DO reports that a Run started or ended. A Session that is not registered is ignored. */
  readonly setSessionStatus: (input: {
    readonly id: string;
    readonly status: SessionStatus;
  }) => Effect.Effect<void>;
  /**
   * The Session DO reports its subagents (ADR-0024), parents first, when they change and when it starts; an archived
   * Session's report is kept too. A Session that is not registered is ignored.
   */
  readonly setSessionAgents: (input: {
    readonly id: string;
    readonly agents: ReadonlyArray<SessionAgent>;
  }) => Effect.Effect<void>;
  /** The owner names a Session: the title is theirs from then on. The Session's record, or null when it is not registered. */
  readonly renameSession: (input: {
    readonly id: string;
    readonly title: string;
  }) => Effect.Effect<SessionRecord | null>;
  /**
   * The Session DO offers the title it generated. It is set only if the Session has no title yet, so the owner's (set
   * before or while it was generated) and an earlier generated one are kept. Says whether it was set.
   */
  readonly setGeneratedTitle: (input: {
    readonly id: string;
    readonly title: string;
  }) => Effect.Effect<boolean>;
  /** Archive a Session; one already archived keeps the time it was. Null when the Session is not registered. */
  readonly archiveSession: (input: { readonly id: string }) => Effect.Effect<SessionRecord | null>;
  /** Put an archived Session back in the list; null when the Session is not registered. */
  readonly unarchiveSession: (input: {
    readonly id: string;
  }) => Effect.Effect<SessionRecord | null>;
  /** Forget a Session, once its object is wiped; says whether it was registered. */
  readonly deleteSession: (input: { readonly id: string }) => Effect.Effect<boolean>;
  /** Register an Environment under a fresh id, unless another has the name in any case. */
  readonly createEnvironment: (input: {
    readonly name: string;
  }) => Effect.Effect<EnvironmentNaming>;
  /** The Environment registered under `id`, or null. */
  readonly getEnvironment: (input: {
    readonly id: string;
  }) => Effect.Effect<EnvironmentRecord | null>;
  readonly listEnvironments: () => Effect.Effect<ReadonlyArray<EnvironmentRecord>>;
  /** Give an Environment a new name, which no other may have in any case. */
  readonly renameEnvironment: (input: {
    readonly id: string;
    readonly name: string;
  }) => Effect.Effect<EnvironmentNaming>;
  /**
   * Forget an Environment and its Secrets once its Workspaces are removed; kept while one is made from it. The default
   * Environment is refused.
   */
  readonly deleteEnvironment: (input: {
    readonly id: string;
  }) => Effect.Effect<EnvironmentDeletion>;
  /** Add a Repo to an Environment, for the Workspaces made from then on. */
  readonly addRepo: (input: {
    readonly environment: string;
    readonly name: string;
    readonly url: string;
  }) => Effect.Effect<RepoChange>;
  /** Take a Repo out of an Environment. */
  readonly removeRepo: (input: {
    readonly environment: string;
    readonly name: string;
  }) => Effect.Effect<RepoChange>;
  /** An Environment's Container settings in force and their overrides, or null when it is not registered. */
  readonly getEnvironmentSettings: (input: {
    readonly environment: string;
  }) => Effect.Effect<EnvironmentSettingsState | null>;
  /** Save an Environment's Container settings overrides if they resolve; otherwise say why not, and save nothing. */
  readonly updateEnvironmentSettings: (input: {
    readonly environment: string;
    readonly overrides: Schema.Json;
  }) => Effect.Effect<EnvironmentSettingsUpdate>;
  /**
   * An Agent change (`docs/spec.md` → Agent changes): give one of `environment`'s Container settings a new value, by the
   * rules of `updateEnvironmentSettings`, and record it with its `author`. Says the values before and after and whether
   * a new Build is wanted; a field that already has the value records nothing. The caller runs the Build upkeep after.
   */
  readonly changeEnvironment: (input: {
    readonly environment: string;
    readonly change: ContainerFieldChange;
    /** The value the field must still have, for a change the owner approved against it (`docs/spec.md` → Approval). */
    readonly expected?: { readonly value: Schema.Json | null } | undefined;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<EnvironmentChangeAnswer>;
  /** The settings kept for every Environment in force (the variables) and their overrides. */
  readonly getEveryEnvironmentSettings: () => Effect.Effect<EveryEnvironmentState>;
  /**
   * Save the settings kept for every Environment if they resolve and no Environment is left with more variables than it
   * may have with its own; otherwise say why not, and save nothing.
   */
  readonly updateEveryEnvironmentSettings: (input: {
    readonly overrides: Schema.Json;
  }) => Effect.Effect<EveryEnvironmentSettingsUpdate>;
  /**
   * An Agent change (`docs/spec.md` → Agent changes): give one variable kept for every Environment a new value, by the
   * rules of `updateEveryEnvironmentSettings`, and record it with its `author` under the scope `*`. Says which
   * Environments override it and which want a new Build; a variable that already has the value records nothing. The
   * caller runs the Build upkeep after. `environment` is the caller's own, to say whether the change reaches it.
   */
  readonly changeEveryEnvironment: (input: {
    readonly change: ContainerFieldChange;
    readonly author: AgentChangeAuthor;
    readonly environment?: string | undefined;
  }) => Effect.Effect<EveryEnvironmentChangeAnswer>;
  /**
   * The Container settings overrides a Workspace of `environment` is handed: its own with the variables kept for every
   * Environment under them. Null when the Environment is not registered.
   */
  readonly workspaceOverrides: (input: {
    readonly environment: string;
  }) => Effect.Effect<Schema.Json | null>;
  /**
   * The agent makes an Environment (`docs/spec.md` → Agent changes): `name` as the owner's `createEnvironment` checks
   * it, `repos` (their directories and addresses, parsed by the caller) added, the default Container settings, recorded
   * as an Agent change. The caller runs the spares' and Builds' upkeep after.
   */
  readonly agentCreateEnvironment: (input: {
    readonly name: string;
    readonly repos: ReadonlyArray<EnvironmentRepo>;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<EnvironmentCreation>;
  /** The agent renames an Environment, as `renameEnvironment` does, and it is recorded. */
  readonly agentRenameEnvironment: (input: {
    readonly environment: string;
    readonly name: string;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<LifecycleChange>;
  /** The agent adds a Repo to an Environment, as `addRepo` does, and it is recorded. The caller runs the upkeep after. */
  readonly agentAddRepo: (input: {
    readonly environment: string;
    readonly repo: EnvironmentRepo;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<LifecycleChange>;
  /** The agent takes a Repo out of an Environment, as `removeRepo` does, and it is recorded. The caller runs the upkeep after. */
  readonly agentRemoveRepo: (input: {
    readonly environment: string;
    readonly name: string;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<LifecycleOutcome<LifecycleChanged>>;
  /** Record that the agent asked for a new Build of an Environment, once it is under way. */
  readonly recordRebuild: (input: {
    readonly environment: string;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<LifecycleOutcome<LifecycleChanged>>;
  /**
   * An Agent change (`docs/spec.md` → Agent changes): mark the Secret `name` kept for `environment` (an Environment's id,
   * or `*` for every Environment) for the Build, or take the mark off, as the owner's switch does, and record it with its
   * `author`; a Secret that has the mark records nothing. The caller runs the Builds' upkeep after.
   */
  readonly agentMarkSecretBuild: (input: {
    readonly environment: string;
    readonly name: string;
    readonly build: boolean;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<SecretBuildMark>;
  /**
   * An Agent change the owner approved (`docs/spec.md` → Approval): delete the Secret `name` kept for `environment` (an
   * Environment's id, or `*` for every Environment), as the owner's delete does, and record it by name with its
   * `author`, provided it was last changed at `expected.updatedAt` (as the owner saw it). The caller runs the Builds'
   * upkeep after.
   */
  readonly agentDeleteSecret: (input: {
    readonly environment: string;
    readonly name: string;
    readonly expected?: { readonly updatedAt: number } | undefined;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<SecretDeletion>;
  /**
   * Keep Secrets the owner chose to keep in the form of a `secret_ask` of `session`'s conversation `conversation`: for
   * the Session's Environment (`scope` "environment") or for every Environment ("every"), sealed here as the owner's form
   * on the Environments page seals them, by the same name and value rules. Each kept Secret is recorded by name in the
   * scope's Agent changes as the owner's choice made on the agent's request (`reason` is the agent's). The caller runs
   * the Builds' upkeep after. For the Session DO only: the values arrive over Durable Object RPC and are never answered.
   */
  readonly keepAskedSecrets: (input: {
    readonly session: string;
    readonly conversation: number;
    readonly scope: "environment" | "every";
    readonly reason: string;
    readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }) => Effect.Effect<KeptAsked>;
  /** An Environment's Agent changes (or those of the Secrets kept for every Environment, `*`), newest first; null when it is not registered. */
  readonly listAgentChanges: (input: {
    readonly environment: string;
  }) => Effect.Effect<ReadonlyArray<AgentChange> | null>;
  /** The owner's revert of an Agent change, unless its field has changed since. */
  readonly revertAgentChange: (input: {
    readonly environment: string;
    readonly change: number;
  }) => Effect.Effect<AgentChangeRevert>;
  /**
   * Take an Agent change of an Environment (or of `*`) out of its list, leaving what it changed and its record; false
   * when the scope has no such change.
   */
  readonly dismissAgentChange: (input: {
    readonly environment: string;
    readonly change: number;
  }) => Effect.Effect<boolean>;
  /**
   * An Agent change (`docs/spec.md` → The Environment's own Skills): save the Skill in folder `folder` with `files` (each by
   * its path in the folder) for `environment` (an Environment's id, or `*` for every Environment), in place of one of its
   * name, if it passes a save's checks, and record it with its files before and after. The same files as kept record
   * nothing. With `expected`, only while the Skill of the name was last saved then (null: none kept), as an Approval
   * asked against it. The caller hands the Session's own Workspace its new Skill set after.
   */
  readonly agentSaveSkill: (input: {
    readonly environment: string;
    readonly folder: string;
    readonly files: SkillFiles;
    readonly author: AgentChangeAuthor;
    readonly expected?: SkillExpectation | undefined;
  }) => Effect.Effect<SkillSave>;
  /**
   * What `agentSaveSkill` would do with the same input: the save's checks and what the scope keeps of the name, with
   * nothing saved or recorded. The agent's Approval card shows it before the owner is asked.
   */
  readonly agentPreviewSkill: (input: {
    readonly environment: string;
    readonly folder: string;
    readonly files: SkillFiles;
  }) => Effect.Effect<SkillPreview>;
  /** An Agent change: remove Skill `name` kept for `environment` (or `*`), recorded with its files before. */
  readonly agentRemoveSkill: (input: {
    readonly environment: string;
    readonly name: string;
    readonly author: AgentChangeAuthor;
    readonly expected?: SkillExpectation | undefined;
  }) => Effect.Effect<SkillRemoval>;
  /**
   * An Agent change (`docs/spec.md` → Installing from GitHub): install from the GitHub `source` the Skills `skills` names
   * (`["*"]` for every one it holds; absent: the only one, else the list of them and nothing installed) for
   * `environment`. Fetched here as the GitHub App at one commit, then each is kept with its Skill source as a save keeps a
   * Skill and recorded with its files before and after. The caller hands the Session's own Workspace its new Skill set after.
   */
  readonly agentInstallSkills: (input: {
    readonly environment: string;
    readonly source: string;
    readonly skills?: ReadonlyArray<string> | undefined;
    readonly author: AgentChangeAuthor;
    /** What the owner's Approval was asked against: read at its commit, and a Skill kept only while it still holds. */
    readonly pin?: SkillInstallPin | undefined;
  }) => Effect.Effect<SkillInstallation>;
  /**
   * What `agentInstallSkills` would do, with nothing kept or recorded: the Skills with their files, and what is refused.
   */
  readonly agentPreviewSkillInstall: (input: {
    readonly environment: string;
    readonly source: string;
    readonly skills?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SkillInstallPreview>;
  /** The owner installs Skills from a GitHub `source` (as `agentInstallSkills`), recorded as no Agent change. */
  readonly installSkills: (input: {
    readonly environment: string;
    readonly source: string;
    readonly skills?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SkillInstallation>;
  /** The Skills kept for `environment` (or `*` for every Environment), by name; null when it is not registered. */
  readonly listSkills: (input: {
    readonly environment: string;
  }) => Effect.Effect<ReadonlyArray<EnvironmentSkill> | null>;
  /**
   * The owner removes Skill `name` kept for `environment` (or `*`; not an Agent change, and no Approval), refused when
   * it would serve a Skill from the layer below that does not fit.
   */
  readonly removeSkill: (input: {
    readonly environment: string;
    readonly name: string;
  }) => Effect.Effect<OwnerRemoval | { readonly status: "missing" }>;
  /** The files before and after Agent change `change` of a Skill of `environment`, with their texts; null for none. */
  readonly skillChangeFiles: (input: {
    readonly environment: string;
    readonly change: number;
  }) => Effect.Effect<SkillChangeFiles | null>;
  /**
   * The Skill set `environment`'s Workspaces serve: its own Skills over those kept for every Environment, over the
   * bundle. Null when it is not registered.
   */
  readonly workspaceSkillSet: (input: {
    readonly environment: string;
  }) => Effect.Effect<SkillSet | null>;
  /** The Workspace registered under `id`, or null. */
  readonly getWorkspace: (input: { readonly id: string }) => Effect.Effect<WorkspaceRecord | null>;
  /**
   * What a Session's Workspace sets itself up with (its Repos, branch and base) and the Container settings in force
   * for its Environment, or null when the Workspace is not registered.
   */
  readonly getWorkspaceSetup: (input: {
    readonly id: string;
    /**
     * The hash of the Skill set the Workspace holds: the set-up carries its Environment's Skill set only when it differs.
     * Absent, it always does.
     */
    readonly skillSetHash?: string | undefined;
  }) => Effect.Effect<WorkspaceSetupWithSettings | null>;
  /** Every Workspace, newest first. */
  readonly listWorkspaces: () => Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
  /**
   * Register a Subagent Workspace for subagent `agent` of Session `session` (`RegistryStore.createSubagentWorkspace`),
   * under a fresh id unless the Environment's spare is taken; the one the subagent has already is answered again. A
   * refusal says why.
   */
  readonly createSubagentWorkspace: (input: {
    readonly session: string;
    readonly agent: string;
    readonly branch: string | null;
    readonly base: string | null;
    readonly limit: number;
  }) => Effect.Effect<WorkspaceRecord | SubagentWorkspaceRefusal>;
  /** Session `session`'s Subagent Workspaces, newest first. */
  readonly listSubagentWorkspaces: (input: {
    readonly session: string;
  }) => Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
  /** Forget a Workspace once its Sessions are deleted and its object wiped; kept while a Session is bound to it. */
  readonly deleteWorkspace: (input: { readonly id: string }) => Effect.Effect<Deletion>;
  /**
   * What keeps the spare Workspace of each of `environments` (every Environment when undefined) current, in one call:
   * the stale spares to remove (`forgetSpare`, then their objects), and the spares registered now, each with what its
   * object prepares itself with. Nothing to do is two empty lists.
   */
  readonly upkeepSpares: (input: {
    readonly environments?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SpareWork>;
  /**
   * What keeping the Builds of `environments` (every Environment when undefined) current needs: each Environment's
   * Repos and Container settings overrides, and what is recorded of its Build.
   */
  readonly buildWork: (input: {
    readonly environments?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ReadonlyArray<BuildWork>>;
  /** Record what an Environment's Build object answered: its last good Build, and the one in progress or the last failure. */
  readonly recordBuild: (input: {
    readonly environment: string;
    readonly build: EnvironmentBuild | null;
    readonly status: BuildProgress | null;
  }) => Effect.Effect<void>;
  /** Where each Environment's Build stands, for the owner. */
  readonly listBuilds: () => Effect.Effect<ReadonlyArray<EnvironmentBuildState>>;
  /** Every kept Secret: names, scopes, build flags and times, never a value. */
  readonly listEnvironmentSecrets: () => Effect.Effect<ReadonlyArray<EnvironmentSecretRecord>>;
  /**
   * Keep `value` under `name` for `environment` (null: every Environment), sealed here; replaces a value kept there.
   * The answer never holds the value.
   */
  readonly setEnvironmentSecret: (input: {
    readonly environment: string | null;
    readonly name: string;
    readonly value: string;
    readonly build?: boolean | undefined;
  }) => Effect.Effect<SecretWrite>;
  /** Set whether a kept Secret reaches the Build; null when none is kept under that scope and name. */
  readonly setEnvironmentSecretBuild: (input: {
    readonly environment: string | null;
    readonly name: string;
    readonly build: boolean;
  }) => Effect.Effect<EnvironmentSecretRecord | null>;
  /** Delete a kept Secret; says whether one was kept. */
  readonly deleteEnvironmentSecret: (input: {
    readonly environment: string | null;
    readonly name: string;
  }) => Effect.Effect<boolean>;
  /**
   * The Secrets `environment` uses, with their values, opened here: its own over those of the same name kept for every
   * Environment. For the main Worker's Builds and spares only: never answered to a client.
   */
  readonly environmentSecrets: (input: {
    readonly environment: string;
  }) => Effect.Effect<ReadonlyArray<KeptSecret>>;
  /**
   * The Secrets the Session `session` holds as kept ones, with their values: its Environment's. None for a Session the
   * Registry does not list. For the Session DO only.
   */
  readonly sessionSecrets: (input: {
    readonly session: string;
  }) => Effect.Effect<ReadonlyArray<KeptSecret>>;
  /** The id of an Environment's spare Workspace, current or stale, or null. */
  readonly getSpare: (input: { readonly environment: string }) => Effect.Effect<string | null>;
  /**
   * Forget a spare's record, before its object is wiped; one taken meanwhile is a Session's and is kept. Says whether
   * it was forgotten, so the object is wiped only then.
   */
  readonly forgetSpare: (input: { readonly id: string }) => Effect.Effect<boolean>;
  /** Take up to `limit` objects left from before Environments to wipe, each for a few minutes (`LEGACY_LEASE_MS`). */
  readonly takeLegacy: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<LegacyObject>>;
  /** Forget a legacy object once its Durable Object is wiped. */
  readonly forgetLegacy: (input: LegacyObject) => Effect.Effect<void>;
  /** The settings in force and the overrides saved over the defaults. */
  readonly getSettings: () => Effect.Effect<SettingsState>;
  /** Save `overrides` in place of the saved ones if they resolve; otherwise say why not, and save nothing. */
  readonly updateSettings: (input: {
    readonly overrides: Schema.Json;
  }) => Effect.Effect<SettingsUpdate>;
  /**
   * An Agent change to the Settings (`docs/spec.md` → Agent changes): give some of their fields new values, by the rules
   * of `updateSettings`, and record each field that changed with its `author`; none of the values before or after is
   * recorded for a field that already has its value. Sessions read the new settings when they next admit input.
   */
  readonly changeSettings: (input: {
    readonly changes: ReadonlyArray<SettingsFieldChange>;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<SettingsChange>;
  /** The Settings' Agent changes, newest first. */
  readonly listSettingsChanges: () => Effect.Effect<ReadonlyArray<AgentChange>>;
  /** The owner's revert of a Settings change, unless its field has changed since. */
  readonly revertSettingsChange: (input: {
    readonly change: number;
  }) => Effect.Effect<SettingsChangeRevert>;
  /** Take a Settings change out of its list, leaving what it changed; false when there is no such change. */
  readonly dismissSettingsChange: (input: { readonly change: number }) => Effect.Effect<boolean>;
  /**
   * The VAPID public key to subscribe with, and whether a subscription at `endpoint` is kept. Pushes to a browser the
   * push service dropped are deleted on the next one, so a client asks before it trusts its own subscription.
   */
  readonly getPush: (input: { readonly endpoint?: string | undefined }) => Effect.Effect<PushState>;
  /** Keep a browser's Web Push subscription, replacing the one with the same endpoint. */
  readonly subscribePush: (input: {
    readonly subscription: PushSubscription;
  }) => Effect.Effect<void>;
  /** Forget the subscription at `endpoint`. */
  readonly unsubscribePush: (input: { readonly endpoint: string }) => Effect.Effect<void>;
  /**
   * A Session DO reports something the owner should hear: push it to every subscribed browser. Never fails; a Session
   * that is not registered is ignored.
   */
  readonly notify: (input: {
    readonly sessionId: string;
    readonly event: PushEvent;
  }) => Effect.Effect<void>;
};

/** How long a legacy object taken to be wiped is left to its taker before another may take it. */
export const LEGACY_LEASE_MS = 5 * 60_000;

/**
 * The index of Sessions, Environments and Workspaces (`docs/spec.md` → Durable Objects), over this object's SQLite storage.
 * The class name is the Durable Object class name in every stage's migrations, so it cannot be renamed once deployed.
 */
export class Registry extends Cloudflare.DurableObject<Registry, RegistryMethods>()("Registry") {}

export const RegistryLive = Registry.make(
  Effect.all({
    state: Cloudflare.DurableObjectState,
    push: PushConfig,
    secrets: SecretsConfig,
    github: GitHubAppConfig,
  }).pipe(
    Effect.map(({ state, push, secrets, github }) =>
      Effect.gen(function* () {
        const store = openRegistryStore(state.raw.storage);
        const changes = openAgentChanges(state.raw.storage);
        const skills = openSkills(state.raw.storage);
        const notify = pushNotifier({ store, vapid: push.vapid });
        // Skills are fetched here, in the main Worker, which holds the GitHub App's key: read-only tokens (contents).
        const skillReader = githubSkillReader(github);

        // The bundle, the lowest layer of every Skill set until it is removed, hashed once. Loaded on first use: the
        // deploy loads this module in Node, which cannot load the bundle's `?raw` imports.
        const bundle = yield* Effect.cached(
          Effect.promise(() => import("../workspace/bundled-skill-set.ts")).pipe(
            Effect.flatMap(({ BUNDLED_SKILL_SET }) =>
              Effect.promise(() => hashBundle(BUNDLED_SKILL_SET)),
            ),
          ),
        );

        /** Install `source`'s Skills into `environment`: as Agent changes by `author`, or as the owner's save with none. */
        const installFromGithub = (input: {
          readonly environment: string;
          readonly source: string;
          readonly skills: ReadonlyArray<string> | undefined;
          readonly author: AgentChangeAuthor | null;
          readonly pin?: SkillInstallPin | undefined;
        }) =>
          Effect.gen(function* () {
            const hashedBundle = yield* bundle;
            const now = yield* Clock.currentTimeMillis;

            return yield* Effect.promise(() =>
              installSkills(
                { storage: state.raw.storage, store, skills, changes, bundle: hashedBundle, now },
                skillReader,
                input,
              ),
            );
          });

        /**
         * `environment`'s Skill set before its texts are read: its own Skills over those kept for every Environment,
         * over the bundle.
         */
        const mergedSkills = (environment: string) =>
          Effect.flatMap(bundle, (hashed) =>
            Effect.promise(() => mergeSkills(skillLayers(skills, environment), hashed)),
          );

        /** `environment`'s Skill set with its texts, unless its hash is `held`'s. */
        const skillSetUnless = (environment: string, held: string | undefined) =>
          Effect.gen(function* () {
            const merged = yield* mergedSkills(environment);

            return merged.hash === held ? undefined : skillSetOf(merged, yield* bundle, skills);
          });

        // The kept Secrets' key, derived once, on first use: a malformed master key fails the calls that need it, not
        // the object. An Environment no Secret reaches never needs it.
        const vault = yield* Effect.cached(
          openKeptVault(Redacted.value(secrets.encryptionKey), "registry"),
        );

        /** The Secrets `environment` uses, opened, for the Session DOs and the Builds: a vault that fails says why. */
        const opened = (environment: string) =>
          usedSecrets(store, vault, environment).pipe(
            Effect.mapError(
              (error) => new Error(`The kept Secrets cannot be opened: ${error.message}`),
            ),
            Effect.orDie,
          );

        /**
         * The Container settings overrides `environment`'s Workspaces are handed (`workspaceOverridesOf`), or null when
         * it is not registered. Only the overrides that still resolve reach a Workspace, which checks them again.
         */
        const workspaceOverrides = (environment: string): Effect.Effect<Schema.Json | null> =>
          Effect.suspend(() => {
            const handed = workspaceOverridesOf(store, environment);

            if (handed === null) return Effect.succeed(null);

            return handed.problem === undefined
              ? Effect.succeed(handed.overrides)
              : Effect.logWarning(
                  `Environment ${environment}'s variables are cut to fit: ${handed.problem}`,
                ).pipe(Effect.as(handed.overrides));
          });

        /**
         * A Workspace's set-up with its Environment's Container settings overrides, last good Build (`build`, the one
         * a spare was registered with, else the Environment's now) and Secrets, or why it gets none.
         */
        const withSettings = (
          setup: WorkspaceSetup & { readonly build?: EnvironmentBuild | null },
          /** The hash of the Skill set the Workspace holds: its Environment's is handed only when it differs. */
          heldSkills: string | undefined,
        ): Effect.Effect<WorkspaceSetupWithSettings> =>
          Effect.map(
            Effect.all([
              secretsHandover(store, vault, setup.environment),
              workspaceOverrides(setup.environment),
              skillSetUnless(setup.environment, heldSkills),
            ]),
            ([handover, overrides, skillSet]) => ({
              ...setup,
              settings: overrides ?? {},
              build:
                setup.build === undefined
                  ? (store.getBuild(setup.environment)?.build ?? null)
                  : setup.build,
              skills: skillSet,
              ...handover,
            }),
          );

        return {
          createSession: ({ title, workspace, origin }) =>
            Effect.gen(function* () {
              const id = yield* newSessionId;
              const now = yield* Clock.currentTimeMillis;

              if (workspace.kind === "existing") {
                return store.createSession(
                  { id, title: title ?? null, workspace, origin: origin ?? null },
                  now,
                );
              }

              // Eight hex digits rarely collide; one that does (a spare's too, which only its set-up shows) is drawn again.
              let workspaceId = yield* newWorkspaceId;

              while (store.getWorkspaceSetup(workspaceId) !== null) {
                workspaceId = yield* newWorkspaceId;
              }

              return store.createSession(
                {
                  id,
                  title: title ?? null,
                  workspace: {
                    kind: "new",
                    id: workspaceId,
                    environment: workspace.environment,
                    branch: workspace.branch ?? null,
                    base: workspace.base ?? null,
                  },
                  origin: origin ?? null,
                },
                now,
              );
            }),
          getSession: ({ id }) => Effect.sync(() => store.getSession(id)),
          listSessions: () => Effect.sync(() => store.listSessions()),
          setSessionStatus: ({ id, status }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => store.setSessionStatus(id, status, now)),
            ),
          setSessionAgents: ({ id, agents }) =>
            Effect.sync(() => store.setSessionAgents(id, agents)),
          renameSession: ({ id, title }) => Effect.sync(() => store.renameSession(id, title)),
          setGeneratedTitle: ({ id, title }) =>
            Effect.sync(() => store.setGeneratedTitle(id, title)),
          archiveSession: ({ id }) =>
            Clock.currentTimeMillis.pipe(Effect.map((now) => store.archiveSession(id, now))),
          unarchiveSession: ({ id }) => Effect.sync(() => store.unarchiveSession(id)),
          deleteSession: ({ id }) => Effect.sync(() => store.deleteSession(id)),
          createEnvironment: ({ name }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              let id = yield* newEnvironmentId;

              while (store.getEnvironment(id) !== null) id = yield* newEnvironmentId;

              return store.createEnvironment(id, name, now);
            }),
          getEnvironment: ({ id }) => Effect.sync(() => store.getEnvironment(id)),
          listEnvironments: () => Effect.sync(() => store.listEnvironments()),
          renameEnvironment: ({ id, name }) => Effect.sync(() => store.renameEnvironment(id, name)),
          deleteEnvironment: ({ id }) => Effect.sync(() => store.deleteEnvironment(id)),
          addRepo: ({ environment, name, url }) =>
            Effect.sync(() => store.addRepo(environment, { name, url })),
          removeRepo: ({ environment, name }) =>
            Effect.sync(() => store.removeRepo(environment, name)),
          getEnvironmentSettings: ({ environment }) =>
            Effect.sync(() => {
              const overrides = store.getEnvironmentSettings(environment);

              return overrides === null ? null : readEnvironmentSettings(overrides);
            }),
          updateEnvironmentSettings: ({ environment, overrides }) =>
            Effect.sync((): EnvironmentSettingsUpdate => {
              if (store.getEnvironment(environment) === null) return { status: "missing" };

              const saved = writeEnvironmentSettings(overrides, everyVariablesOf(store));

              if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure };

              store.putEnvironmentSettings(environment, saved.success.overrides);

              return { status: "saved", state: saved.success };
            }),
          getEveryEnvironmentSettings: () => Effect.sync(() => readEveryEnvironment(store)),
          updateEveryEnvironmentSettings: ({ overrides }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now): EveryEnvironmentSettingsUpdate => {
                const saved = writeEveryEnvironment(store, overrides, now);

                return Result.isSuccess(saved)
                  ? { status: "saved", state: saved.success }
                  : { status: "rejected", message: saved.failure };
              }),
            ),
          workspaceOverrides: ({ environment }) => workspaceOverrides(environment),
          changeEnvironment: ({ environment, change, expected, author }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;

              const outcome = changeEnvironment(
                state.raw.storage,
                store,
                changes,
                { environment, change, expected, author },
                now,
              );

              if (outcome.status !== "changed") return outcome;

              const { previous, ...changed } = outcome;

              const every = everyVariablesOf(store);

              const newBuild = yield* Effect.promise(() =>
                wantsNewBuild(
                  outcome.environment.repos,
                  withEveryEnvironmentVariables(previous, every),
                  withEveryEnvironmentVariables(outcome.state.settings, every),
                ),
              );

              return { ...changed, newBuild } satisfies EnvironmentChangeAnswer;
            }),
          changeEveryEnvironment: ({ change, author, environment }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;

              const outcome = changeEveryEnvironment(
                state.raw.storage,
                store,
                changes,
                { change, author },
                now,
              );

              if (outcome.status !== "changed") return outcome;

              const { name, previous, variables } = outcome;

              const environments = Arr.map(store.listEnvironments(), (record) => ({
                id: record.id,
                name: record.name,
                repos: record.repos,
                settings: readEnvironmentSettings(store.getEnvironmentSettings(record.id) ?? {})
                  .settings,
              }));

              const reach = yield* Effect.promise(() =>
                everyChangeReach(environments, name, previous, variables, environment),
              );

              return {
                status: "changed",
                change: outcome.change,
                variables,
                ...reach,
              } satisfies EveryEnvironmentChangeAnswer;
            }),
          agentCreateEnvironment: ({ name, repos, author }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              let id = yield* newEnvironmentId;

              while (store.getEnvironment(id) !== null) id = yield* newEnvironmentId;

              return createEnvironmentAs(
                state.raw.storage,
                store,
                changes,
                { id, name, repos, author },
                now,
              );
            }),
          agentRenameEnvironment: ({ environment, name, author }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                renameEnvironmentAs(
                  state.raw.storage,
                  store,
                  changes,
                  { environment, name, author },
                  now,
                ),
              ),
            ),
          agentAddRepo: ({ environment, repo, author }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                addRepoAs(state.raw.storage, store, changes, { environment, repo, author }, now),
              ),
            ),
          agentRemoveRepo: ({ environment, name, author }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                removeRepoAs(state.raw.storage, store, changes, { environment, name, author }, now),
              ),
            ),
          recordRebuild: ({ environment, author }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                recordRebuildAs(state.raw.storage, store, changes, { environment, author }, now),
              ),
            ),
          agentMarkSecretBuild: ({ environment, name, build, author }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                markSecretBuildAs(
                  state.raw.storage,
                  store,
                  changes,
                  { environment, name, build, author },
                  now,
                ),
              ),
            ),
          agentDeleteSecret: ({ environment, name, expected, author }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                deleteSecretAs(
                  state.raw.storage,
                  store,
                  changes,
                  { environment, name, expected, author },
                  now,
                ),
              ),
            ),
          keepAskedSecrets: ({ session, conversation, scope, reason, secrets: asked }) =>
            Effect.gen(function* () {
              const known = store.getSession(session);

              if (known === null) return { status: "unknown" } satisfies KeptAsked;

              const now = yield* Clock.currentTimeMillis;
              const environment = scope === "every" ? null : known.environment;

              // The reason is the agent's text and is kept as written: one that holds a value being kept is left out.
              const author = {
                session,
                conversation,
                tool: "secret_ask",
                reason: Arr.some(asked, ({ value }) => reason.includes(value))
                  ? "The user chose to keep the Secret in the form the agent asked it in"
                  : reason,
              };

              const results: KeptAskedResult[] = [];

              for (const { name, value } of asked) {
                const kept = yield* Effect.flatMap(vault, (keys) =>
                  keepSecretAs(
                    state.raw.storage,
                    store,
                    changes,
                    keys,
                    { environment, name, value, sessionEnvironment: known.environment, author },
                    now,
                  ),
                ).pipe(
                  // A fixed message: what a failed seal says may hold more than the Registry should pass on.
                  Effect.orElseSucceed(
                    () =>
                      ({
                        status: "rejected",
                        message: "The Secret cannot be kept: the Registry could not seal it",
                      }) as const,
                  ),
                );

                results.push(
                  kept.status === "kept"
                    ? { name, status: "kept", shadowed: kept.shadowed }
                    : { name, status: "rejected", message: kept.message },
                );
              }

              return {
                status: "done",
                environment:
                  environment === null
                    ? { id: EVERY_ENVIRONMENT_SCOPE, name: EVERY_ENVIRONMENT_NAME }
                    : {
                        id: known.environment,
                        name: store.getEnvironment(known.environment)?.name ?? known.environment,
                      },
                results,
              } satisfies KeptAsked;
            }),
          listAgentChanges: ({ environment }) =>
            Effect.sync(() =>
              environment !== EVERY_ENVIRONMENT_SCOPE && store.getEnvironment(environment) === null
                ? null
                : changes.list(environment),
            ),
          revertAgentChange: ({ environment, change }) =>
            Effect.gen(function* () {
              const hashedBundle = yield* bundle;
              const now = yield* Clock.currentTimeMillis;

              return revertAgentChange(
                state.raw.storage,
                store,
                changes,
                { environment, id: change },
                now,
                { skills, bundle: hashedBundle },
              );
            }),
          dismissAgentChange: ({ environment, change }) =>
            Effect.sync(() => changes.dismiss(environment, change)),
          getWorkspace: ({ id }) => Effect.sync(() => store.getWorkspace(id)),
          getWorkspaceSetup: ({ id, skillSetHash }) =>
            Effect.suspend(() => {
              const setup = store.getWorkspaceSetup(id);

              return setup === null ? Effect.succeed(null) : withSettings(setup, skillSetHash);
            }),
          agentSaveSkill: ({ environment, folder, files, author, expected }) =>
            Effect.gen(function* () {
              const hashed = yield* Effect.promise(() => hashFiles(files));
              const hashedBundle = yield* bundle;
              const now = yield* Clock.currentTimeMillis;

              return saveSkillAs(
                { storage: state.raw.storage, store, skills, changes, bundle: hashedBundle, now },
                { environment, folder, files, hashed, author, expected },
              );
            }),
          agentPreviewSkill: ({ environment, folder, files }) =>
            Effect.gen(function* () {
              const hashed = yield* Effect.promise(() => hashFiles(files));
              const hashedBundle = yield* bundle;

              return previewSkillSave(
                { store, skills, bundle: hashedBundle },
                { environment, folder, files, hashed },
              );
            }),
          agentRemoveSkill: ({ environment, name, author, expected }) =>
            Effect.gen(function* () {
              const hashedBundle = yield* bundle;
              const now = yield* Clock.currentTimeMillis;

              return removeSkillAs(
                { storage: state.raw.storage, store, skills, changes, bundle: hashedBundle, now },
                { environment, name, author, expected },
              );
            }),
          agentInstallSkills: ({ environment, source, skills: names, author, pin }) =>
            installFromGithub({ environment, source, skills: names, author, pin }),
          agentPreviewSkillInstall: ({ environment, source, skills: names }) =>
            Effect.gen(function* () {
              const hashedBundle = yield* bundle;

              return yield* Effect.promise(() =>
                previewSkillInstall({ store, skills, bundle: hashedBundle }, skillReader, {
                  environment,
                  source,
                  skills: names,
                }),
              );
            }),
          installSkills: ({ environment, source, skills: names }) =>
            installFromGithub({ environment, source, skills: names, author: null }),
          listSkills: ({ environment }) =>
            Effect.sync(() =>
              environment !== EVERY_ENVIRONMENT_SCOPE && store.getEnvironment(environment) === null
                ? null
                : Arr.map(skills.list(environment), ({ name, description, savedAt, source }) => {
                    const listed = { name, description, savedAt };

                    return source === null ? listed : { ...listed, source };
                  }),
            ),
          removeSkill: ({ environment, name }) =>
            Effect.gen(function* () {
              if (
                environment !== EVERY_ENVIRONMENT_SCOPE &&
                store.getEnvironment(environment) === null
              ) {
                return { status: "missing" as const };
              }

              const hashedBundle = yield* bundle;

              return removeSkill(
                { storage: state.raw.storage, store, skills, bundle: hashedBundle },
                { environment, name },
              );
            }),
          skillChangeFiles: ({ environment, change }) =>
            Effect.sync(() => {
              const found = changes.get(environment, change);

              return found === null ? null : skillChangeFiles(skills, found);
            }),
          workspaceSkillSet: ({ environment }) =>
            Effect.suspend(() =>
              store.getEnvironment(environment) === null
                ? Effect.succeed(null)
                : Effect.map(skillSetUnless(environment, undefined), (set) => set ?? null),
            ),
          listWorkspaces: () => Effect.sync(() => store.listWorkspaces()),
          createSubagentWorkspace: (input) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              // Eight hex digits rarely collide; one that does (a spare's too) is drawn again.
              let id = yield* newWorkspaceId;

              while (store.getWorkspaceSetup(id) !== null) id = yield* newWorkspaceId;

              return store.createSubagentWorkspace({ ...input, id }, now);
            }),
          listSubagentWorkspaces: ({ session }) =>
            Effect.sync(() => store.listSubagentWorkspaces(session)),
          deleteWorkspace: ({ id }) => Effect.sync(() => store.deleteWorkspace(id)),
          upkeepSpares: ({ environments }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const { stale, made } = store.upkeepSpares(environments, shortId, now);
              const { set } = yield* bundle;

              // A spare is new, so it holds the bundle: it is handed its Environment's Skill set when that differs.
              return {
                stale,
                made: yield* Effect.forEach(made, (setup) => withSettings(setup, set.hash)),
              } satisfies SpareWork;
            }),
          buildWork: ({ environments }) =>
            Effect.gen(function* () {
              const every = everyVariablesOf(store);

              const wanted = Arr.filterMap(store.listEnvironments(), (environment) => {
                const recorded = store.getBuild(environment.id);

                return (environments !== undefined && !environments.includes(environment.id)) ||
                  recorded === null
                  ? Result.failVoid
                  : Result.succeed({ environment, recorded });
              });

              const work = yield* Effect.forEach(wanted, ({ environment, recorded }) =>
                buildSecretsOf(store, vault, environment.id).pipe(
                  Effect.map((digest): BuildWork => ({
                    environment: environment.id,
                    repos: environment.repos,
                    settings: readEnvironmentSettings(
                      store.getEnvironmentSettings(environment.id) ?? {},
                    ).overrides,
                    everyVariables: every,
                    recorded,
                    // The values a Build gets, as a keyed digest only: the key is stored and shown in the clear.
                    secrets: digest,
                  })),
                  // A Build made without the Secrets it needs would not be the Environment's: it waits for the key.
                  Effect.catch((error) =>
                    Effect.logWarning(
                      `Environment ${environment.id}'s Build is left as it is: its Secrets cannot be opened: ${error.message}`,
                    ).pipe(Effect.as(undefined)),
                  ),
                ),
              );

              return Arr.filter(work, (item) => item !== undefined);
            }),
          recordBuild: ({ environment, build, status }) =>
            Effect.sync(() => {
              store.putBuild(environment, { build, status });
            }),
          listBuilds: () =>
            Effect.sync(() =>
              Arr.map(store.listBuilds(), (record) => ({
                environment: record.environment,
                build: buildView(record),
              })),
            ),
          listEnvironmentSecrets: () => Effect.sync(() => store.listEnvironmentSecrets()),
          setEnvironmentSecret: (input) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;

              return yield* Effect.flatMap(vault, (keys) =>
                keepSecret(store, keys, input, now),
              ).pipe(
                Effect.catch((error) =>
                  Effect.succeed<SecretWrite>({
                    status: "rejected",
                    message: `The Secret cannot be kept: ${error.message}`,
                  }),
                ),
              );
            }),
          setEnvironmentSecretBuild: ({ environment, name, build }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => store.setEnvironmentSecretBuild(environment, name, build, now)),
            ),
          deleteEnvironmentSecret: ({ environment, name }) =>
            Effect.sync(() => store.deleteEnvironmentSecret(environment, name)),
          environmentSecrets: ({ environment }) => opened(environment),
          sessionSecrets: ({ session }) =>
            Effect.suspend(() => {
              const known = store.getSession(session);

              return known === null ? Effect.succeed([]) : opened(known.environment);
            }),
          getSpare: ({ environment }) => Effect.sync(() => store.getSpare(environment)),
          forgetSpare: ({ id }) => Effect.sync(() => store.forgetSpare(id)),
          takeLegacy: ({ limit }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => store.takeLegacy(limit, now, LEGACY_LEASE_MS)),
            ),
          forgetLegacy: (object) => Effect.sync(() => store.forgetLegacy(object)),
          getSettings: () => Effect.sync(() => readSettings(store)),
          updateSettings: ({ overrides }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now): SettingsUpdate => {
                const saved = writeSettings(store, overrides, now);

                return Result.isSuccess(saved)
                  ? SettingsUpdate.Saved({ state: saved.success })
                  : SettingsUpdate.Rejected({ message: saved.failure.message });
              }),
            ),
          changeSettings: ({ changes: wanted, author }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                changeSettings(state.raw.storage, store, changes, { changes: wanted, author }, now),
              ),
            ),
          listSettingsChanges: () => Effect.sync(() => changes.list(SETTINGS_SCOPE)),
          revertSettingsChange: ({ change }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) =>
                revertSettingsChange(state.raw.storage, store, changes, { id: change }, now),
              ),
            ),
          dismissSettingsChange: ({ change }) =>
            Effect.sync(() => changes.dismiss(SETTINGS_SCOPE, change)),
          getPush: ({ endpoint }) =>
            Effect.sync(() => ({
              publicKey: push.vapid.publicKey,
              subscribed: endpoint !== undefined && store.hasPushSubscription(endpoint),
            })),
          subscribePush: ({ subscription }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => store.putPushSubscription(subscription, now)),
            ),
          unsubscribePush: ({ endpoint }) =>
            Effect.sync(() => store.deletePushSubscription(endpoint)),
          notify: ({ sessionId, event }) => notify(sessionId, event),
        } satisfies RegistryMethods;
      }),
    ),
  ),
);
