import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { ContainerPatch, ContainerSettings } from "@cloudpid/config";
import { MCP_ENGINE_BINDING } from "@cloudpid/mcp-worker/binding";
import type {
  McpPending,
  McpServerSetAnswer,
  McpServerValuesAnswer,
  McpSetRevision,
} from "@cloudpid/mcp/types";
import { type KeptSecret, openKeptVault } from "@cloudpid/extensions/secrets/core";
import type {
  AgentChange,
  EnvironmentBuildState,
  EnvironmentRepo,
  EnvironmentSecretRecord,
  EnvironmentSkill,
  MarkedOrigin,
  McpRepoFileView,
  OverridingEnvironment,
  PushState,
  PushSubscription,
  SessionOrigin,
  SessionsQuery,
  SettingsMcpChangeCheck,
  SettingsMcpReload,
  SettingsMcpView,
  SkillChangeFiles,
  SkillFile,
  TriggerDefinition,
} from "@cloudpid/protocol";
import { pageSessions, type SessionsResult } from "./session-page.ts";
import {
  mcpHandedUnreadable,
  mcpServerNamesOf,
  mcpServerSetAnswer,
  mcpServerValuesAnswer,
  type McpValuesInput,
  pendingMcpPushes,
  recordMcpDeleted,
  recordMcpDestroyed,
  readsSecrets,
  recordMcpPushed,
} from "./mcp-registry.ts";
import { EMPTY_SKILL_SET_HASH, type SkillSet } from "../workspace/skill-set-schema.ts";
import {
  previewSkillSave,
  hashFiles,
  mergeSkills,
  openSkills,
  type OwnerRemoval,
  removeSkill,
  removeSkillAs,
  saveSkillAs,
  skillChangeFiles,
  keptSkillFiles,
  type SkillPreview,
  type SkillFiles,
  skillLayers,
  type SkillRemoval,
  type SkillSave,
  skillSetOf,
  unapprovedGlobalChange,
} from "./skills.ts";
import { type InstalledSkillRef, installedSkillRefs } from "./skill-badges.ts";
import { installSkills, previewSkillInstall } from "./skill-install.ts";
import { buildMovedRepos, MCP_FIRST_LOOK_WAIT, mcpRepoFileViews } from "./mcp-repo-files.ts";
import { firstMcpLook, type McpRepoLookReason, openMcpRepoLooks } from "./mcp-repo-look.ts";
import { mcpChangeCheck, mcpGuard } from "./mcp-change-check.ts";
import { mcpReloadReport, mcpReloadSnapshot, mcpSettingsView } from "./mcp-settings-view.ts";
import { githubSkillReader } from "./skill-reader.ts";
import {
  previewSkillUpdates,
  runDailySkillCheck,
  type UpdateRequest,
  updateSkills,
} from "./skill-updates.ts";
import {
  SETTINGS_SCOPE,
  type McpChangeGuard,
  type McpFieldChange,
  type McpSignInsListing,
  type McpSignOutView,
  type SettingsOverridesState,
  type SkillExpectation,
  type SkillInstallation,
  type SkillInstallPin,
  type SkillInstallPreview,
  type SkillUpdatePreview,
  type SkillUpdateRun,
} from "@cloudpid/protocol";

import { SecretsConfig } from "../session/secrets.ts";
import {
  type AgentChangeAuthor,
  type AgentChangeRevert,
  changeEnvironment,
  changeGlobal,
  type ContainerFieldChange,
  type EnvironmentChange,
  type GlobalChange,
  globalChangeReach,
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
  GLOBAL_NAME,
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
import { pushNotifier, pushToAll } from "../push/notify.ts";
import { describeTriggerFailure, type PushEvent } from "../push/notification.ts";
import { newEnvironmentId, newSessionId, newTriggerId, newWorkspaceId, shortId } from "./ids.ts";
import {
  deleteEnvironmentWithTriggers,
  type EnvironmentRemoval,
  type EnvironmentTriggerInput,
  type FireAdmission,
  type FireAdmitted,
  openTriggers,
  type TriggerPatch,
  type TriggerWrite,
} from "./triggers.ts";
import {
  putEnvironmentInstructions,
  readSettings,
  readSettingsOverrides,
  type SessionSettingsSource,
  sessionSettingsSource,
  type SettingsAnswer,
  settingsOverriddenIn,
  SettingsUpdate,
  updateSettingsOverrides,
  writeSettings,
} from "./settings.ts";
import {
  changeSettings,
  changeSettingsOverrides,
  revertSettingsChange,
  type SettingsChange,
  type SettingsChangeRevert,
  type SettingsFieldChange,
} from "./settings-changes.ts";
import { type EnvironmentSettingsState, patchEnvironmentSettings } from "./environment-settings.ts";
import {
  environmentSettingsOf,
  globalSettingsOf,
  overridesOf,
  type GlobalState,
  overriddenIn,
  patchGlobal,
  readGlobal,
  workspaceOverridesOf,
} from "./global.ts";
import {
  type Deletion,
  type EnvironmentDeletion,
  type EnvironmentNaming,
  type EnvironmentRecord,
  GLOBAL_SCOPE,
  type LegacyObject,
  openRegistryStore,
  type RepoChange,
  STARTING_MS,
  type SessionAgent,
  type SessionRecord,
  type CreatedSession,
  type SessionRefusal,
  type SubagentWorkspaceRefusal,
  type SessionStatus,
  type SpareUpkeep,
  type WorkspaceRecord,
  type WorkspaceSetup,
} from "./store.ts";
import {
  MCP_SIGN_IN_GLOBAL,
  type McpAccessTokenAnswer,
  type McpAccessTokenInput,
  type McpAuthReport,
  type McpAuthReportAnswer,
  type McpSignInAskAnswer,
  type McpSignInAskInput,
  type McpSignInWithdrawInput,
  type McpSignInCompleteAnswer,
  type McpSignInCompleteInput,
  type McpSignInConfirmAnswer,
  type McpSignInConfirmInput,
  type McpSignInStartAnswer,
  type McpSignInStartInput,
} from "@cloudpid/mcp/types";
import { guardedOAuthFetch } from "../mcp/oauth-fetch.ts";
import { type PublicReader, signInNetwork } from "../mcp/own-host-transport.ts";
import { mcpAccessToken, reportMcpAuth, type SignInDeps } from "./mcp-sign-in-registry.ts";
import { mcpClientGrant } from "./mcp-sign-in-client-grant.ts";
import { askMcpSignIn, withdrawMcpSignIn } from "./mcp-sign-in-ask.ts";
import { listMcpSignIns, signOutMcpSignIn } from "./mcp-sign-in-manage.ts";
import { mcpTokenRefresh } from "./mcp-sign-in-refresh.ts";
import {
  completeMcpSignIn,
  confirmMcpSignIn,
  environmentsUsing,
  type FlowDeps,
  startMcpSignIn,
} from "./mcp-sign-in-flow.ts";
import { MCP_OAUTH_PURPOSE } from "./mcp-sign-in-seal.ts";
import { openMcpSignIns } from "./mcp-sign-ins.ts";

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
 * good Build (null for none yet) and kept Secrets, opened (docs/architecture/agent-capabilities.md → Secrets): the Workspace keeps them sealed,
 * to search a snapshot for and to take out of output. When the Registry cannot open them, `secrets` is absent and
 * `secretsUnavailable` says so (`SECRETS_UNAVAILABLE`), and the Workspace refuses the snapshots that would need them.
 * `skills` is the Environment's Skill set (its own Skills over those kept Global), absent when the
 * Workspace holds it already.
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

/** How the owner's change of an Environment's Settings Overrides, or of its own Instructions, went. */
export type SettingsOverridesUpdate =
  | { readonly status: "saved"; readonly state: SettingsOverridesState }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** A write of an Environment's Settings as an update says how it went: `null` is an Environment the store has not. */
const settingsOverridesUpdate = (
  saved: Result.Result<SettingsOverridesState, { readonly message: string }> | null,
): SettingsOverridesUpdate => {
  if (saved === null) return { status: "missing" };

  return Result.isSuccess(saved)
    ? { status: "saved", state: saved.success }
    : { status: "rejected", message: saved.failure.message };
};

export type { SessionSettingsSource } from "./settings.ts";

/** The Container settings at Global, with the Environments that override each field (ADR-0027). */
export type GlobalContainerState = GlobalState & {
  readonly overriddenIn: Readonly<Record<string, ReadonlyArray<OverridingEnvironment>>>;
};

/** How saving the Container settings at Global went: once saved, also what they were before. */
export type GlobalContainerUpdate =
  | {
      readonly status: "saved";
      readonly state: GlobalContainerState;
      readonly previous: ContainerSettings;
    }
  | { readonly status: "rejected"; readonly message: string };

/**
 * How an Agent change to a Container setting at Global went (`changeGlobal`): as `GlobalChange` says, a change also
 * saying which Environments override the field, so it does not reach them, and which want a new Build
 * (`wantsNewBuild`).
 */
export type GlobalChangeAnswer =
  | {
      readonly status: "changed";
      readonly change: AgentChange;
      /** The Container settings at Global now. */
      readonly settings: ContainerSettings;
      readonly overriddenIn: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      readonly newBuilds: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      /**
       * Whether it reaches the Workspaces of the Environment the caller named: it does not override the field.
       * Undefined: none named.
       */
      readonly own: boolean | undefined;
    }
  | Exclude<GlobalChange, { readonly status: "changed" }>;

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
      /** Where they were kept: the Session's Environment, or Global (id `*`). */
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
    /** How the MCP endpoint's caller got in, for a Session it starts or imports. */
    readonly marks?: MarkedOrigin | undefined;
    /**
     * Made for this request within the last 24 h and still there: that Session is answered (with `repeated: true`), and no other is registered.
     */
    readonly requestId?: string | undefined;
    /**
     * Refused (`too-many-running`) while this many Sessions the MCP endpoint started or imported are running: the
     * endpoint's running cap, counted here so concurrent starts cannot pass it together (a `requestId` that finds its Session is answered first).
     */
    readonly maxRunning?: number | undefined;
    /**
     * For an import: refused (`too-many-imports`) while `limit` imports with the same `auth` are still importing; counted
     * here with the insert, so concurrent begins cannot pass it together.
     */
    readonly maxOpenImports?: { readonly limit: number; readonly auth: string } | undefined;
  }) => Effect.Effect<CreatedSession | SessionRefusal>;
  /** The Session DO reports that its import ended: it is no longer `importing`. A Session that is not registered is ignored. */
  readonly endSessionImport: (input: { readonly id: string }) => Effect.Effect<void>;
  /** The Session registered under `id`, or null. */
  readonly getSession: (input: { readonly id: string }) => Effect.Effect<SessionRecord | null>;
  /** Every Session, newest first. */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<SessionRecord>>;
  /** A page of the Sessions, newest first, filtered (`pageSessions`): for the MCP endpoint's `sessions_list`. */
  readonly sessions: (query: SessionsQuery) => Effect.Effect<SessionsResult>;
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
  /**
   * The Session DO reports how many MCP tasks it follows in the background, at each settle where that changed; an
   * archived Session's report is kept too. A Session that is not registered is ignored.
   */
  readonly setSessionMcpTasks: (input: {
    readonly id: string;
    readonly count: number;
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
  /**
   * An Environment's Container settings in force, its Overrides and Global's settings, or null when it is not
   * registered.
   */
  readonly getEnvironmentSettings: (input: {
    readonly environment: string;
  }) => Effect.Effect<EnvironmentSettingsState | null>;
  /**
   * Set or reset an Environment's Container Overrides (`ContainerPatch`) if the result resolves; otherwise say why not,
   * and save nothing.
   */
  readonly updateEnvironmentSettings: (
    input: { readonly environment: string } & ContainerPatch,
  ) => Effect.Effect<EnvironmentSettingsUpdate>;
  /**
   * An Agent change (`docs/architecture/agent-changes.md`): give one of `environment`'s Container settings a new
   * Override, or reset it to inherit Global's (`value` null), by the rules of `updateEnvironmentSettings`, and record
   * it with its `author`. Says the values before and after and whether a new Build is wanted; a field that already has
   * the value as its Override (or is inherited, for a reset) records nothing. The caller runs the Build upkeep after.
   */
  readonly changeEnvironment: (input: {
    readonly environment: string;
    readonly change: ContainerFieldChange;
    /** The value the field must still have, for a change the owner approved against it (`docs/architecture/agent-changes.md` → Approval). */
    readonly expected?: { readonly value: Schema.Json | null } | undefined;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<EnvironmentChangeAnswer>;
  /** The Container settings at Global in force, what is saved of them, and the Environments that override each field. */
  readonly getGlobalContainerSettings: () => Effect.Effect<GlobalContainerState>;
  /**
   * Set or reset Container settings at Global (`ContainerPatch`) if they resolve and no Environment that inherits a
   * field changed is left above its size limit or with more variables than it may have; otherwise say why not, and
   * save nothing.
   */
  readonly updateGlobalContainerSettings: (
    input: ContainerPatch,
  ) => Effect.Effect<GlobalContainerUpdate>;
  /**
   * An Agent change (`docs/architecture/agent-changes.md`): give one Container setting at Global a new value, by the
   * rules of `updateGlobalContainerSettings`, and record it with its `author` under the scope `*`. Says which
   * Environments override it and which want a new Build; a field that already has the value records nothing. The
   * caller runs the Build upkeep after. `environment` is the caller's own, to say whether the change reaches it.
   */
  readonly changeGlobal: (input: {
    readonly change: ContainerFieldChange;
    /** The value the field must still have, for a change the owner approved against it. */
    readonly expected?: { readonly value: Schema.Json | null } | undefined;
    readonly author: AgentChangeAuthor;
    readonly environment?: string | undefined;
  }) => Effect.Effect<GlobalChangeAnswer>;
  /**
   * The Container settings overrides a Workspace of `environment` is handed: its settings in force (its Overrides over
   * Global's) as overrides of the defaults. Null when the Environment is not registered.
   */
  readonly workspaceOverrides: (input: {
    readonly environment: string;
  }) => Effect.Effect<Schema.Json | null>;
  /**
   * The agent makes an Environment (`docs/architecture/agent-changes.md`): `name` as the owner's `createEnvironment` checks
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
   * An Agent change (`docs/architecture/agent-changes.md`): mark the Secret `name` kept for `environment` (an Environment's id,
   * or `*` at Global) for the Build, or take the mark off, as the owner's switch does, and record it with its
   * `author`; a Secret that has the mark records nothing. The caller runs the Builds' upkeep after.
   */
  readonly agentMarkSecretBuild: (input: {
    readonly environment: string;
    readonly name: string;
    readonly build: boolean;
    readonly author: AgentChangeAuthor;
  }) => Effect.Effect<SecretBuildMark>;
  /**
   * An Agent change the owner approved (`docs/architecture/agent-changes.md` → Approval): delete the Secret `name` kept for `environment` (an
   * Environment's id, or `*` at Global), as the owner's delete does, and record it by name with its
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
   * the Session's Environment (`scope` "environment") or Global ("every"), sealed here as the owner's form
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
  /** An Environment's Agent changes (or those of the Secrets kept Global, `*`), newest first; null when it is not registered. */
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
   * An Agent change (`docs/architecture/workspace.md` → The Environment's own Skills): save the Skill in folder `folder` with `files` (each by
   * its path in the folder) for `environment` (an Environment's id, or `*` at Global), in place of one of its
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
   * An Agent change (`docs/architecture/workspace.md` → Installing from GitHub): install from the GitHub `source` the Skills `skills` names
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
  /**
   * The owner installs Skills from a GitHub `source` (as `agentInstallSkills`), recorded as no Agent change: those `skills`
   * names, or exactly the Skills in `folders` (the repo page's picks; the agent's tool has no such choice).
   */
  readonly installSkills: (input: {
    readonly environment: string;
    readonly source: string;
    readonly skills?: ReadonlyArray<string> | undefined;
    readonly folders?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SkillInstallation>;
  /**
   * An Agent change (`docs/architecture/workspace.md` → Installing from GitHub → Updates): update the Skills `names` (absent: every one marked
   * update available) kept for `environment` (or `*`) to the latest commit of their recorded ref, fetched here as the GitHub
   * App. A modified Skill is refused unless `overwrite`. Each Skill moved is recorded with its files and source before and
   * after; one whose folder is the same records nothing. With `pins` (the owner's Approval of an update at
   * Global), the commits and folders the owner was shown, and only while each Skill was last saved then. The caller
   * hands the Session's own Workspace the new Skill set after.
   */
  readonly agentUpdateSkills: (
    input: UpdateRequest & { readonly author: AgentChangeAuthor },
  ) => Effect.Effect<SkillUpdateRun>;
  /**
   * What `agentUpdateSkills` would do, with nothing saved or recorded: the files each Skill would take, for the owner's
   * Approval card of an update at Global.
   */
  readonly previewSkillUpdates: (
    input: Omit<UpdateRequest, "pins">,
  ) => Effect.Effect<SkillUpdatePreview>;
  /** The owner updates Skills (as `agentUpdateSkills`), recorded as no Agent change and waiting for no Approval. */
  readonly updateSkills: (input: Omit<UpdateRequest, "pins">) => Effect.Effect<SkillUpdateRun>;
  /**
   * The daily check of the installed Skills (`checkSkillUpdates`): once a day at most, one request for each repo and ref the
   * Skills of every scope came from (and one more for the tree at the installed commit of Skills kept before their hash was
   * recorded), marking those whose folder changed. Applies nothing, tells nobody, and never fails:
   * what GitHub refuses is logged and the marks are left as they are.
   */
  readonly checkSkillUpdates: () => Effect.Effect<void>;
  /** The Skills kept for `environment` (or `*` at Global), by name; null when it is not registered. */
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
   * Every Skill kept in any scope that has a Skill source, for the Skill directory's badges (`skill-badges.ts`): the
   * Environment's id that keeps it, or `*` at Global.
   */
  readonly installedSkills: () => Effect.Effect<ReadonlyArray<InstalledSkillRef>>;
  /** The files kept for Skill `name` of `environment` (or `*`), with their texts, by path; null when it keeps none of the name. */
  readonly skillFiles: (input: {
    readonly environment: string;
    readonly name: string;
  }) => Effect.Effect<ReadonlyArray<SkillFile> | null>;
  /**
   * The Skill set `environment`'s Workspaces serve: its own Skills over those kept Global. Null
   * when it is not registered.
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
   * What keeps the spare Workspace of each of `environments` (all of them when undefined) current, in one call:
   * the stale spares to remove (`forgetSpare`, then their objects), and the spares registered now, each with what its
   * object prepares itself with, only for an Environment that had a Session in the last `SPARE_REFILL_WINDOW_MS`.
   * Nothing to do is two empty lists.
   */
  readonly upkeepSpares: (input: {
    readonly environments?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SpareWork>;
  /**
   * What keeping the Builds of `environments` (all of them when undefined) current needs: each Environment's
   * Repos and Container settings overrides, and what is recorded of its Build.
   */
  readonly buildWork: (input: {
    readonly environments?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ReadonlyArray<BuildWork>>;
  /**
   * Record what an Environment's Build object answered: its last good Build, and the one in progress or the last failure.
   * It looks at the `.pi/mcp.json` of each Repo whose default branch the Build found moved, and answers those Repos (so
   * that the caller pushes what that changed).
   */
  readonly recordBuild: (input: {
    readonly environment: string;
    readonly build: EnvironmentBuild | null;
    readonly status: BuildProgress | null;
  }) => Effect.Effect<ReadonlyArray<string>>;
  /** Where each Environment's Build stands, for the owner. */
  readonly listBuilds: () => Effect.Effect<ReadonlyArray<EnvironmentBuildState>>;
  /** Every kept Secret: names, scopes, build flags and times, never a value. */
  readonly listEnvironmentSecrets: () => Effect.Effect<ReadonlyArray<EnvironmentSecretRecord>>;
  /**
   * Keep `value` under `name` for `environment` (null: Global), sealed here; replaces a value kept there.
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
   * The Secrets `environment` uses, with their values, opened here: its own over those of the same name kept
   * Global. For the main Worker's Builds and spares only: never answered to a client.
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
  /**
   * The Global Settings in force, the overrides saved over the defaults, and the Environments that override each field.
   */
  readonly getSettings: () => Effect.Effect<SettingsAnswer>;
  /** Save `overrides` in place of the saved ones if they resolve; otherwise say why not, and save nothing. */
  readonly updateSettings: (input: {
    readonly overrides: Schema.Json;
  }) => Effect.Effect<SettingsUpdate>;
  /** Environment `environment`'s Settings: its Overrides, Global's, and the two resolved; null when it is not registered. */
  readonly getSettingsOverrides: (input: {
    readonly environment: string;
  }) => Effect.Effect<SettingsOverridesState | null>;
  /**
   * The owner's change of Environment `environment`'s Overrides: `set` field by field, then `reset` removed. Says why
   * not, saving nothing, when they do not resolve; `missing` when the Environment is not registered.
   */
  readonly updateSettingsOverrides: (input: {
    readonly environment: string;
    readonly set?: Schema.Json | undefined;
    readonly reset?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SettingsOverridesUpdate>;
  /**
   * The owner's change of Environment `environment`'s own Instructions: `instructions` replaces them (empty for none).
   * Says why not, saving nothing, for a text over the cap; `missing` when the Environment is not registered.
   */
  readonly updateEnvironmentInstructions: (input: {
    readonly environment: string;
    readonly instructions: string;
  }) => Effect.Effect<SettingsOverridesUpdate>;
  /**
   * What Session `session` resolves its Settings from (ADR-0027): Global's overrides that apply, its Environment's
   * Overrides as saved, and the Environment's name with its own Instructions; `{}` and a null Environment (and no
   * Instructions of its own) for a Session the Registry does not list. For the Session DO only.
   */
  readonly sessionSettings: (input: {
    readonly session: string;
  }) => Effect.Effect<SessionSettingsSource>;
  /**
   * The host's pull (`docs/architecture/mcp-configuration.md` → From the Registry to the host): `environment`'s MCP server
   * set's hash with a new `revision`, noted as handed to the host, and the set unless the host holds it (`heldHash`;
   * none held is the empty set). An Environment the Registry does not list gets neither revision nor set. For the
   * `McpHost` DO only.
   */
  readonly mcpServerSet: (input: {
    readonly environment: string;
    readonly heldHash?: string | undefined;
  }) => Effect.Effect<McpServerSetAnswer>;
  /**
   * The `env` and `headers` of `environment`'s MCP server `server` with every `${NAME}` resolved against the Secrets,
   * then the Variables (a Repo's entries read Variables only), when its connection key is `conn`. Never logged and never
   * kept by the Registry. For the `McpHost` DO only.
   */
  readonly mcpServerValues: (input: McpValuesInput) => Effect.Effect<McpServerValuesAnswer>;
  /**
   * Each of `environment`'s Repos' `.pi/mcp.json` as last looked at, in the Environment's Repo order, or null when it is not
   * registered (`docs/architecture/mcp-configuration.md` → A Repo's `.pi/mcp.json`). Read-only: it asks GitHub for nothing.
   */
  readonly mcpRepoFiles: (input: {
    readonly environment: string;
  }) => Effect.Effect<ReadonlyArray<McpRepoFileView> | null>;
  /**
   * Look at `environment`'s Repos' `.pi/mcp.json` on GitHub (only `repo`'s when given) and answer them as `mcpRepoFiles` does.
   * `added` (a Repo was just added) looks at once; `reload` (the owner's) looks at once, and a Repo that cannot be read loses
   * its last good copy, even when another look was running. The Registry never calls out, so the caller pushes the set
   * after. Never fails.
   */
  readonly mcpLookRepoFiles: (input: {
    readonly environment: string;
    readonly repo?: string | undefined;
    readonly reason: Extract<McpRepoLookReason, "added" | "reload">;
  }) => Effect.Effect<ReadonlyArray<McpRepoFileView> | null>;
  /**
   * The names of `environment`'s MCP servers, in the set's order, or null when it is not registered. Read-only: it
   * notes nothing as handed. For the main Worker's MCP status reads, which wake a host only for an Environment with servers.
   */
  readonly mcpServerNames: (input: {
    readonly environment: string;
  }) => Effect.Effect<ReadonlyArray<string> | null>;
  /**
   * The MCP servers of a Scope for the agent's `settings_mcp_list` and `settings_mcp_get`
   * (`docs/architecture/mcp-configuration.md` → Lists): `environment`'s whole set, or Global's own entries when `environment`
   * is absent; with `name`, only that server and its layers as written. Null when no Environment has the id. Read-only: it asks
   * GitHub and the host for nothing, and holds no value, hash or file text. For the Session DO only.
   */
  readonly mcpSettingsView: (input: {
    readonly environment?: string | undefined;
    readonly name?: string | undefined;
  }) => Effect.Effect<SettingsMcpView | null>;
  /**
   * What a change of server `name`'s keys (`changes`, `settings_mcp_*`'s fields) would do to each Environment's set, by the
   * pure resolvers before and after: whether the entry in force changes there, and what it makes reachable that was not
   * (`docs/architecture/mcp-configuration.md` → Approval, The check). At Global every Environment whose set has the server;
   * with `environment`, only that one. Writes nothing. Null when no Environment has the id. For the Session DO only.
   */
  readonly mcpChangeCheck: (input: {
    readonly environment?: string | undefined;
    readonly name: string;
    readonly changes: ReadonlyArray<McpFieldChange>;
    /** The `${NAME}`s the entry written reads: each Environment reached says what they are there (`reads` of its reach). */
    readonly reads?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SettingsMcpChangeCheck | null>;
  /**
   * The agent's `settings_mcp_reload`: look at each of `environment`'s Repos' `.pi/mcp.json` again, under the throttle the
   * scheduled looks share (`agent`: a Repo looked at in the last 30 s is `recent`), keeping the last good copy of a Repo that
   * cannot be read, and report what each Repo came to and what the set gained, lost and changed. Null when no Environment has
   * the id. The Registry never calls out, so the caller pushes the set after (`mcpPending`). For the Session DO only.
   */
  readonly mcpSettingsReload: (input: {
    readonly environment: string;
  }) => Effect.Effect<SettingsMcpReload | null>;
  /**
   * What the main Worker is to do: the MCP server sets to push (`environment`'s, every Environment's when undefined)
   * when its hash differs from what its host was last handed, an empty set only after a non-empty one, each with a new
   * revision; and every deleted Environment whose host was handed a set and is yet to be wiped (`environment` or not,
   * so any sync retries a wipe that was lost), each with the revision of its deletion. The Registry never calls out:
   * the main Worker sends each to `McpHost.apply`.
   */
  readonly mcpPending: (input: {
    readonly environment?: string | undefined;
  }) => Effect.Effect<McpPending>;
  /**
   * Note that the host of `environment` took the set with `hash` at `revision`, so it is not pushed again. A revision
   * older than the one noted (the host was handed a later set since) is ignored.
   */
  readonly mcpPushed: (
    input: McpSetRevision & { readonly environment: string },
  ) => Effect.Effect<void>;
  /** Note that the host of the deleted Environment `environment` was wiped, so it is not asked again. */
  readonly mcpDestroyed: (input: { readonly environment: string }) => Effect.Effect<void>;
  /**
   * An Agent change to the Settings (`docs/architecture/agent-changes.md`): give some of their fields new values, by the rules
   * of `updateSettings` (Global, `environment` absent) or of `updateSettingsOverrides` (an Environment's Overrides), and
   * record each field that changed with its `author`, under the scope `settings` or the Environment's id; none of the
   * values before or after is recorded for a field that already has its value. Sessions read the new settings when
   * they next admit input.
   */
  readonly changeSettings: (input: {
    readonly environment?: string | undefined;
    readonly changes: ReadonlyArray<SettingsFieldChange>;
    readonly author: AgentChangeAuthor;
    /**
     * An agent's MCP change: what to check again in the transaction that writes it (`McpChangeGuard`: that it widens nothing,
     * and that the `${NAME}`s its entry reads resolve at the Environment), refusing it as `rejected` otherwise. A Registry from
     * before it ignores it.
     */
    readonly guard?: McpChangeGuard | undefined;
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
  /**
   * Keep a new Trigger (`docs/architecture/triggers.md`, ADR-0047) under a fresh UUIDv7, at revision 1, or say why not.
   * The caller wakes its object (`Trigger.sync`): the Registry never calls out.
   */
  readonly createTrigger: (input: {
    readonly trigger: EnvironmentTriggerInput;
  }) => Effect.Effect<TriggerWrite>;
  /** Change a Trigger's fields at its next revision; its kind and Environment never change. The caller wakes its object. */
  readonly updateTrigger: (input: {
    readonly id: string;
    readonly patch: TriggerPatch;
  }) => Effect.Effect<TriggerWrite>;
  /** Pause or resume a Trigger, at its next revision. The caller wakes its object. */
  readonly setTriggerPaused: (input: {
    readonly id: string;
    readonly paused: boolean;
  }) => Effect.Effect<TriggerWrite>;
  /** Forget a Trigger; says whether it was there. The caller wipes its object (`Trigger.remove`). */
  readonly removeTrigger: (input: { readonly id: string }) => Effect.Effect<boolean>;
  /** Every Trigger, or `environment`'s, newest first. */
  readonly listTriggers: (input: {
    readonly environment?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<TriggerDefinition>>;
  /** A Trigger's definition, or null once it is gone: what its object reads at each touch (self-healing). */
  readonly triggerDefinition: (input: {
    readonly id: string;
  }) => Effect.Effect<TriggerDefinition | null>;
  /**
   * The one place a Fire is let through (`docs/architecture/triggers.md` → `admitFire`): active, the revision current,
   * the overlap, and the Fire's Session registered in the same transaction. A reader treats a status it does not know as
   * `failed`.
   */
  readonly admitFire: (fire: FireAdmission) => Effect.Effect<FireAdmitted>;
  /** A Trigger's Fire failed: tell the owner, naming the Trigger. A Trigger that is gone is ignored. Never fails. */
  readonly notifyTriggerFailed: (input: {
    readonly trigger: string;
    readonly reason: string;
  }) => Effect.Effect<void>;
  /**
   * `deleteEnvironment`, answering the ids of the Triggers that went with the Environment (deleted in the same
   * transaction), whose objects the caller wipes (`docs/architecture/triggers.md` → Cascades).
   */
  readonly deleteEnvironmentWithTriggers: (input: {
    readonly id: string;
  }) => Effect.Effect<EnvironmentRemoval>;
  /**
   * The host's ask for the access token of `server` in `environment`'s MCP set (`docs/architecture/mcp-sign-in.md` →
   * Tokens reach the host object): `ok` with the token and the resource it is bound to, or why there is none. The
   * Registry works out the sign-in from the Environment's own set. Only the Registry holds tokens at rest; the host keeps
   * the answer in memory only. For the `McpHost` DO only.
   */
  readonly mcpAccessToken: (input: McpAccessTokenInput) => Effect.Effect<McpAccessTokenAnswer>;
  /**
   * What a host saw of a server's sign-in, on transitions only: `needs_sign_in`, `step_up`, `rejected` or `working`, with
   * the challenge. The Registry never calls out; the answer lists the Sign-in requests a `working` report resolved. For the
   * `McpHost` DO only.
   */
  readonly reportMcpAuth: (input: McpAuthReport) => Effect.Effect<McpAuthReportAnswer>;
  /**
   * The revision of the MCP sign-ins: it rises with a sign-in, sign-out, rebind or drop of tokens. A host compares it at
   * `windowOpened`, so a push it lost heals (`mcpServerSet` carries it too).
   */
  readonly signInsRevision: () => Effect.Effect<number>;
  /**
   * A Session's Sign-in request for a server of its Environment's set (`docs/architecture/mcp-sign-in.md` → Sign-in
   * requests): `signed_in` or `not_applicable` at once, else a waiter row kept for the key (`open`, with whether it is the
   * first, which sends the one Notification, and what the card shows). Asking again with the same Session and request
   * joins the waiter and re-checks the sign-in. For the Session DOs only.
   */
  readonly mcpSignInAsk: (input: McpSignInAskInput) => Effect.Effect<McpSignInAskAnswer>;
  /** A Session's Sign-in request ended (declined or withdrawn): its waiter row goes. For the Session DOs only. */
  readonly mcpSignInWithdraw: (
    input: McpSignInWithdrawInput,
  ) => Effect.Effect<{ readonly removed: boolean }>;
  /**
   * The owner's start of an MCP sign-in (`docs/architecture/mcp-sign-in.md` → Starting and completing a sign-in): discovers the
   * authorization server, picks the client by the ladder, and keeps the one pending row of the sign-in. The answer is where
   * to send the owner's browser, the issuer interstitial to show, or why there is no sign-in to start. For the main Worker's
   * `/oauth/mcp/start` only, which has checked the owner and the request.
   */
  readonly startMcpSignIn: (input: McpSignInStartInput) => Effect.Effect<McpSignInStartAnswer>;
  /** Continue or Cancel of the issuer interstitial; the `state` the start put in the page is its one-time field. */
  readonly confirmMcpSignIn: (
    input: McpSignInConfirmInput,
  ) => Effect.Effect<McpSignInConfirmAnswer>;
  /**
   * What the public callback received: checks the pending row of the `state`, its path, `error` and `iss`, exchanges the
   * code and writes the sign-in. For the main Worker's callback only, which has checked the shape of what it passes. The
   * answer carries the Environments that use the sign-in and the Sign-in requests it resolved; the hosts take the raised
   * `signInsRevision` at their next pull.
   */
  readonly completeMcpSignIn: (
    input: McpSignInCompleteInput,
  ) => Effect.Effect<McpSignInCompleteAnswer>;
  /**
   * The owner's MCP sign-ins with who uses each, for Settings (`docs/architecture/mcp-sign-in.md` → Settings); never a token
   * or a secret. The main Worker adds the stage and answers the client. For the main Worker's `RegistryRpcs` only.
   */
  readonly listMcpSignIns: () => Effect.Effect<McpSignInsListing>;
  /**
   * Sign out of the sign-in named by its key's `hash` (→ Sign-out): RFC 7009 revocation, best effort, then the row and its
   * pending start are deleted, keeping the registration and the binding. The Registry never calls out to a host: the
   * answer names the Environments that used the sign-in and the new revision, which the main Worker carries as
   * `signed_out`. For the main Worker's `RegistryRpcs` only.
   */
  readonly signOutMcpSignIn: (input: { readonly hash: string }) => Effect.Effect<McpSignOutView>;
};

/** How long a legacy object taken to be wiped is left to its taker before another may take it. */
export const LEGACY_LEASE_MS = 5 * 60_000;

/**
 * The index of Sessions, Environments and Workspaces (`docs/architecture/overview.md` → Durable Objects), over this object's SQLite storage.
 * The class name is the Durable Object class name in every stage's migrations, so it cannot be renamed once deployed.
 */
export class Registry extends Cloudflare.DurableObject<Registry, RegistryMethods>()("Registry") {}

export const RegistryLive = Registry.make(
  Effect.all({
    state: Cloudflare.DurableObjectState,
    push: PushConfig,
    secrets: SecretsConfig,
    github: GitHubAppConfig,
    worker: Cloudflare.WorkerEnvironment,
  }).pipe(
    Effect.map(({ state, push, secrets, github, worker }) =>
      Effect.gen(function* () {
        const store = openRegistryStore(state.raw.storage);
        const changes = openAgentChanges(state.raw.storage);
        const triggers = openTriggers(state.raw.storage, store);
        const skills = openSkills(state.raw.storage);
        const mcpSignIns = openMcpSignIns(state.raw.storage, store);
        const notify = pushNotifier({ store, vapid: push.vapid });
        // Skills are fetched here, in the main Worker, which holds the GitHub App's key: read-only tokens (contents).
        const skillReader = githubSkillReader(github);
        // The Repos' `.pi/mcp.json` are read through the same reader (one token), and kept in the Registry.
        const mcpLooks = openMcpRepoLooks(store, skillReader);

        /** Install `source`'s Skills into `environment`: as Agent changes by `author`, or as the owner's save with none. */
        const installFromGithub = (input: {
          readonly environment: string;
          readonly source: string;
          readonly skills: ReadonlyArray<string> | undefined;
          readonly folders?: ReadonlyArray<string> | undefined;
          readonly author: AgentChangeAuthor | null;
          readonly pin?: SkillInstallPin | undefined;
        }) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            return yield* Effect.promise(() =>
              installSkills(
                { storage: state.raw.storage, store, skills, changes, now },
                skillReader,
                input,
              ),
            );
          });

        /** Update `environment`'s Skills: as Agent changes by `author`, or as the owner's save with none. */
        const updateFromGithub = (
          input: UpdateRequest & { readonly author: AgentChangeAuthor | null },
        ) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            return yield* Effect.promise(() =>
              updateSkills(
                { storage: state.raw.storage, store, skills, changes, now },
                skillReader,
                input,
              ),
            );
          });

        /**
         * The daily check of the installed Skills, at most once a day (`SKILL_CHECK_DOCUMENT` keeps when it last ran). A
         * run is claimed before it reads GitHub, so two calls at once make one; one the rate limit ended is tried again in
         * an hour. Whatever goes wrong is logged and the marks are left alone.
         */
        const checkInstalledSkills = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const check = yield* Effect.promise(() =>
            runDailySkillCheck({ skills, documents: store }, skillReader, now),
          );

          if (check === undefined) return;

          yield* Effect.logInfo(
            `Skill update check: ${check.checked} Skills compared, ${check.marked} marked update available, ${check.cleared} cleared${check.rateLimited ? ", stopped by GitHub's rate limit" : ""}${check.problems.length === 0 ? "" : `; left alone: ${Arr.join(check.problems, "; ")}`}`,
          );
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("The Skill update check failed", cause)),
        );

        /** `environment`'s Skill set before its texts are read: its own Skills over those kept Global. */
        const mergedSkills = (environment: string) =>
          Effect.promise(() => mergeSkills(skillLayers(skills, environment)));

        /** `environment`'s Skill set with its texts, unless its hash is `held`'s. */
        const skillSetUnless = (environment: string, held: string | undefined) =>
          Effect.gen(function* () {
            const merged = yield* mergedSkills(environment);

            return merged.hash === held ? undefined : skillSetOf(merged, skills);
          });

        // A vault for `purpose`, its key derived once, on first use: a malformed master key fails the calls that need it, not
        // the object.
        const cachedVault = (purpose: string) =>
          Effect.cached(openKeptVault(Redacted.value(secrets.encryptionKey), purpose));

        // The kept Secrets', which an Environment no Secret reaches never needs.
        const vault = yield* cachedVault("registry");

        let handedWarned = false;

        /** Say once, when the `mcp-handed` document cannot be read, that its revisions start again from 0. */
        const checkHanded = Effect.suspend(() => {
          if (handedWarned || !mcpHandedUnreadable(store)) return Effect.void;

          handedWarned = true;

          return Effect.logWarning(
            "The record of what the MCP hosts were handed cannot be read: its revisions start again from 0, and a host holding a later one answers Stale until they pass it",
          );
        });

        // The MCP sign-ins': a malformed key makes token requests answer `unavailable` and leaves the rows unopened.
        const mcpVault = yield* cachedVault(MCP_OAUTH_PURPOSE);

        // What a start and a callback read: every OAuth request goes through `guardedFetch` (a hop to one of cloudpid's own
        // hosts read from `McpWorker`, `signInNetwork`), and an entry's `${NAME}` client secret is read from the Secrets and
        // Variables of the Environment the sign-in started in (Global's for `all`).
        const signInFlow: FlowDeps = {
          store,
          signIns: mcpSignIns,
          vault: mcpVault,
          // SAFETY: the Server Worker binds `McpWorker`'s `McpEngine` entrypoint as `MCP_ENGINE` (`worker.ts`), whose stub
          // answers `fetchPublic` (or fails as a method it does not have, on an older `McpWorker`); absent in tests.
          fetch: guardedOAuthFetch(
            signInNetwork(worker[MCP_ENGINE_BINDING] as PublicReader | undefined),
          ),
          sources: (environment, resolvesSecrets) =>
            Effect.gen(function* () {
              const global = environment === MCP_SIGN_IN_GLOBAL;

              const kept = resolvesSecrets
                ? yield* usedSecrets(store, vault, global ? GLOBAL_SCOPE : environment)
                : [];

              return {
                secrets: Record.fromEntries(
                  Arr.map(kept, ({ name, value }) => [name, value] as const),
                ),
                variables: global
                  ? globalSettingsOf(store).variables
                  : (environmentSettingsOf(store, environment)?.settings.variables ?? {}),
              };
            }),
        };

        // Refreshing is single-flight per sign-in and keeps its backoff for as long as this object lives.
        const mcpRefresh = mcpTokenRefresh(signInFlow);
        // A server that signs in on its own is asked for a token the same way: one at a time per sign-in.
        const mcpGrant = mcpClientGrant(signInFlow);

        /** What a token request and a Session's Sign-in ask read. */
        const tokenDeps: SignInDeps = {
          store,
          signIns: mcpSignIns,
          vault: mcpVault,
          refresh: mcpRefresh,
          clientGrant: mcpGrant,
          environmentsUsing: (hash, kind) => environmentsUsing(store, hash, kind),
        };

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
          createSession: ({
            title,
            workspace,
            origin,
            marks,
            requestId,
            maxRunning,
            maxOpenImports,
          }) =>
            Effect.gen(function* () {
              const id = yield* newSessionId;
              const now = yield* Clock.currentTimeMillis;

              if (workspace.kind === "existing") {
                return store.createSession(
                  {
                    id,
                    title: title ?? null,
                    workspace,
                    origin: origin ?? null,
                    marks: marks ?? null,
                    requestId,
                    maxRunning,
                    maxOpenImports,
                  },
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
                  marks: marks ?? null,
                  requestId,
                  maxRunning,
                  maxOpenImports,
                },
                now,
              );
            }),
          endSessionImport: ({ id }) => Effect.sync(() => store.endSessionImport(id)),
          getSession: ({ id }) => Effect.sync(() => store.getSession(id)),
          listSessions: () => Effect.sync(() => store.listSessions()),
          sessions: (query) => Effect.sync(() => pageSessions(store.listSessions(), query)),
          setSessionStatus: ({ id, status }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => store.setSessionStatus(id, status, now)),
            ),
          setSessionAgents: ({ id, agents }) =>
            Effect.sync(() => store.setSessionAgents(id, agents)),
          setSessionMcpTasks: ({ id, count }) =>
            Effect.sync(() => store.setSessionMcpTasks(id, count)),
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
          deleteEnvironment: ({ id }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                const deletion = store.deleteEnvironment(id);

                // The host is wiped by the main Worker's next sync: the Registry never calls out.
                if (deletion === "deleted") recordMcpDeleted(store, id, now);

                return deletion;
              }),
            ),
          addRepo: ({ environment, name, url }) =>
            Effect.sync(() => store.addRepo(environment, { name, url })),
          removeRepo: ({ environment, name }) =>
            Effect.sync(() => store.removeRepo(environment, name)),
          getEnvironmentSettings: ({ environment }) =>
            Effect.sync(() => environmentSettingsOf(store, environment)),
          updateEnvironmentSettings: ({ environment, set, reset }) =>
            Effect.sync((): EnvironmentSettingsUpdate =>
              state.raw.storage.transactionSync((): EnvironmentSettingsUpdate => {
                const stored = store.getEnvironmentSettings(environment);

                if (store.getEnvironment(environment) === null || stored === null) {
                  return { status: "missing" };
                }

                const saved = patchEnvironmentSettings(
                  stored,
                  { set, reset },
                  globalSettingsOf(store),
                );

                if (Result.isFailure(saved)) {
                  return { status: "rejected", message: saved.failure };
                }

                store.putEnvironmentSettings(environment, saved.success.overrides);

                return { status: "saved", state: saved.success };
              }),
            ),
          getGlobalContainerSettings: () =>
            Effect.sync(() => ({ ...readGlobal(store), overriddenIn: overriddenIn(store) })),
          updateGlobalContainerSettings: ({ set, reset }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now): GlobalContainerUpdate =>
                state.raw.storage.transactionSync((): GlobalContainerUpdate => {
                  const previous = globalSettingsOf(store);
                  const saved = patchGlobal(store, { set, reset }, now);

                  return Result.isSuccess(saved)
                    ? {
                        status: "saved",
                        state: { ...saved.success, overriddenIn: overriddenIn(store) },
                        previous,
                      }
                    : { status: "rejected", message: saved.failure };
                }),
              ),
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

              const newBuild = yield* Effect.promise(() =>
                wantsNewBuild(outcome.environment.repos, previous, outcome.state.settings),
              );

              return { ...changed, newBuild } satisfies EnvironmentChangeAnswer;
            }),
          changeGlobal: ({ change, expected, author, environment }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;

              const outcome = changeGlobal(
                state.raw.storage,
                store,
                changes,
                { change, expected, author },
                now,
              );

              if (outcome.status !== "changed") return outcome;

              const { previous, settings } = outcome;

              const environments = Arr.map(store.listEnvironments(), (record) => ({
                id: record.id,
                name: record.name,
                repos: record.repos,
                overrides: overridesOf(store, record.id),
              }));

              const reach = yield* Effect.promise(() =>
                globalChangeReach(environments, change.field, previous, settings, environment),
              );

              return {
                status: "changed",
                change: outcome.change,
                settings,
                ...reach,
              } satisfies GlobalChangeAnswer;
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
                    ? { id: GLOBAL_SCOPE, name: GLOBAL_NAME }
                    : {
                        id: known.environment,
                        name: store.getEnvironment(known.environment)?.name ?? known.environment,
                      },
                results,
              } satisfies KeptAsked;
            }),
          listAgentChanges: ({ environment }) =>
            Effect.sync(() =>
              environment !== GLOBAL_SCOPE && store.getEnvironment(environment) === null
                ? null
                : changes.list(environment),
            ),
          revertAgentChange: ({ environment, change }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;

              return revertAgentChange(
                state.raw.storage,
                store,
                changes,
                { environment, id: change },
                now,
                skills,
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
              // A change to the Skills kept Global is made only against what the owner approved.
              const unapproved = unapprovedGlobalChange(environment, expected !== undefined);

              if (unapproved !== undefined)
                return { status: "rejected" as const, message: unapproved };

              const hashed = yield* Effect.promise(() => hashFiles(files));
              const now = yield* Clock.currentTimeMillis;

              return saveSkillAs(
                { storage: state.raw.storage, store, skills, changes, now },
                { environment, folder, files, hashed, author, expected },
              );
            }),
          agentPreviewSkill: ({ environment, folder, files }) =>
            Effect.gen(function* () {
              const hashed = yield* Effect.promise(() => hashFiles(files));

              return previewSkillSave({ store, skills }, { environment, folder, files, hashed });
            }),
          agentRemoveSkill: ({ environment, name, author, expected }) =>
            Effect.gen(function* () {
              const unapproved = unapprovedGlobalChange(environment, expected !== undefined);

              if (unapproved !== undefined)
                return { status: "rejected" as const, message: unapproved };

              const now = yield* Clock.currentTimeMillis;

              return removeSkillAs(
                { storage: state.raw.storage, store, skills, changes, now },
                { environment, name, author, expected },
              );
            }),
          agentInstallSkills: ({ environment, source, skills: names, author, pin }) =>
            Effect.suspend(() => {
              const unapproved = unapprovedGlobalChange(environment, pin !== undefined);

              return unapproved === undefined
                ? installFromGithub({ environment, source, skills: names, author, pin })
                : Effect.succeed({ status: "refused" as const, message: unapproved });
            }),
          agentPreviewSkillInstall: ({ environment, source, skills: names }) =>
            Effect.promise(() =>
              previewSkillInstall({ store, skills }, skillReader, {
                environment,
                source,
                skills: names,
              }),
            ),
          installSkills: ({ environment, source, skills: names, folders }) =>
            installFromGithub({ environment, source, skills: names, folders, author: null }),
          agentUpdateSkills: ({ environment, names, overwrite, pins, author }) =>
            Effect.suspend(() => {
              const unapproved = unapprovedGlobalChange(environment, pins !== undefined);

              return unapproved === undefined
                ? updateFromGithub({ environment, names, overwrite, pins, author })
                : Effect.succeed({ status: "refused" as const, message: unapproved });
            }),
          updateSkills: ({ environment, names, overwrite }) =>
            updateFromGithub({ environment, names, overwrite, author: null }),
          previewSkillUpdates: ({ environment, names, overwrite }) =>
            Effect.promise(() =>
              previewSkillUpdates({ store, skills }, skillReader, {
                environment,
                names,
                overwrite,
              }),
            ),
          checkSkillUpdates: () => checkInstalledSkills,
          listSkills: ({ environment }) =>
            Effect.sync(() =>
              environment !== GLOBAL_SCOPE && store.getEnvironment(environment) === null
                ? null
                : Arr.map(
                    skills.list(environment),
                    ({ name, description, savedAt, source, modified, updateAvailable }) => {
                      const listed = { name, description, savedAt, modified, updateAvailable };

                      return source === null ? listed : { ...listed, source };
                    },
                  ),
            ),
          removeSkill: ({ environment, name }) =>
            Effect.sync(() =>
              environment !== GLOBAL_SCOPE && store.getEnvironment(environment) === null
                ? { status: "missing" as const }
                : removeSkill({ storage: state.raw.storage, store, skills }, { environment, name }),
            ),
          skillChangeFiles: ({ environment, change }) =>
            Effect.sync(() => {
              const found = changes.get(environment, change);

              return found === null ? null : skillChangeFiles(skills, found);
            }),
          skillFiles: ({ environment, name }) =>
            Effect.sync(() => keptSkillFiles(skills, environment, name)),
          installedSkills: () => Effect.sync(() => installedSkillRefs(skills)),
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

              const { stale, made } = store.upkeepSpares(
                environments,
                shortId,
                now,
                globalSettingsOf(store),
              );

              // A spare is new, so it holds the empty Skill set: it is handed its Environment's when that differs.
              return {
                stale,
                made: yield* Effect.forEach(made, (setup) =>
                  withSettings(setup, EMPTY_SKILL_SET_HASH),
                ),
              } satisfies SpareWork;
            }),
          buildWork: ({ environments }) =>
            Effect.gen(function* () {
              const global = globalSettingsOf(store);

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
                    overrides: overridesOf(store, environment.id),
                    global,
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
            Effect.gen(function* () {
              const moved = buildMovedRepos(store.getBuild(environment)?.build ?? null, build);

              store.putBuild(environment, { build, status });

              // A Build that found a default branch moved: that Repo's `.pi/mcp.json` may have changed with it.
              if (moved.length > 0) {
                const now = yield* Clock.currentTimeMillis;

                yield* Effect.promise(() =>
                  mcpLooks.look({ environment, repos: moved, reason: "moved", now }),
                );
              }

              return moved;
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
          getSettings: () =>
            Effect.sync(() => ({
              ...readSettings(store),
              overriddenIn: settingsOverriddenIn(store),
            })),
          updateSettings: ({ overrides }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now): SettingsUpdate => {
                const saved = writeSettings(store, overrides, now);

                return Result.isSuccess(saved)
                  ? SettingsUpdate.Saved({
                      state: { ...saved.success, overriddenIn: settingsOverriddenIn(store) },
                    })
                  : SettingsUpdate.Rejected({ message: saved.failure.message });
              }),
            ),
          getSettingsOverrides: ({ environment }) =>
            Effect.sync(() => readSettingsOverrides(store, environment)),
          updateSettingsOverrides: ({ environment, set, reset }) =>
            Effect.sync(() =>
              settingsOverridesUpdate(
                updateSettingsOverrides(state.raw.storage, store, environment, { set, reset }),
              ),
            ),
          updateEnvironmentInstructions: ({ environment, instructions }) =>
            Effect.sync(() =>
              settingsOverridesUpdate(putEnvironmentInstructions(store, environment, instructions)),
            ),
          sessionSettings: ({ session }) =>
            Effect.gen(function* () {
              // A Repo added before its file was read is looked at once, for a bounded wait (`firstMcpLook`).
              const environment = store.getSession(session)?.environment;

              if (environment !== undefined) {
                yield* firstMcpLook(mcpLooks, store, environment, MCP_FIRST_LOOK_WAIT);
              }

              return sessionSettingsSource(store, session);
            }),
          mcpServerSet: (input) =>
            checkHanded.pipe(
              Effect.andThen(Clock.currentTimeMillis),
              // A Repo not looked at in 10 minutes is looked at first, so a Context Window opens on its current file.
              Effect.tap((now) =>
                Effect.promise(() =>
                  mcpLooks.look({ environment: input.environment, reason: "due", now }),
                ),
              ),
              Effect.map((now) => mcpServerSetAnswer(store, input, now)),
            ),
          mcpRepoFiles: ({ environment }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => mcpRepoFileViews(store, environment, now)),
            ),
          mcpLookRepoFiles: ({ environment, repo, reason }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;

              yield* Effect.promise(() =>
                mcpLooks.look({
                  environment,
                  repos: repo === undefined ? undefined : [repo],
                  reason,
                  now,
                }),
              );

              return mcpRepoFileViews(store, environment, now);
            }),
          mcpServerValues: (input) =>
            Effect.gen(function* () {
              // Only an entry that may read Secrets opens the vault.
              const kept = readsSecrets(store, input.environment, input.server)
                ? yield* opened(input.environment)
                : [];

              return mcpServerValuesAnswer(
                store,
                input,
                Record.fromEntries(Arr.map(kept, ({ name, value }) => [name, value] as const)),
              );
            }),
          mcpServerNames: ({ environment }) =>
            Effect.sync(() => mcpServerNamesOf(store, environment)),
          mcpSettingsView: ({ environment, name }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => mcpSettingsView(store, mcpSignIns, { environment, name }, now)),
            ),
          mcpChangeCheck: ({ environment, name, changes: wanted, reads }) =>
            Effect.sync(() => mcpChangeCheck(store, { environment, name, changes: wanted, reads })),
          mcpSettingsReload: ({ environment }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const before = mcpReloadSnapshot(store, environment, now);

              if (before === null) return null;

              yield* Effect.promise(() => mcpLooks.look({ environment, reason: "agent", now }));

              const after = mcpReloadSnapshot(store, environment, now);

              return after === null ? null : mcpReloadReport(environment, before, after);
            }),
          mcpPending: ({ environment }) =>
            checkHanded.pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map((now) => pendingMcpPushes(store, environment, now)),
            ),
          mcpPushed: (pushed) =>
            Clock.currentTimeMillis.pipe(Effect.map((now) => recordMcpPushed(store, pushed, now))),
          mcpDestroyed: ({ environment }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => recordMcpDestroyed(store, environment, now)),
            ),
          changeSettings: ({ environment, changes: wanted, author, guard }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                const refuse =
                  guard === undefined ? undefined : mcpGuard(store, environment, guard);

                return environment === undefined
                  ? changeSettings(
                      state.raw.storage,
                      store,
                      changes,
                      { changes: wanted, author },
                      now,
                      refuse,
                    )
                  : changeSettingsOverrides(
                      state.raw.storage,
                      store,
                      changes,
                      { environment, changes: wanted, author },
                      now,
                      refuse,
                    );
              }),
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
          createTrigger: ({ trigger }) =>
            Effect.gen(function* () {
              const id = yield* newTriggerId;

              return triggers.create(id, trigger, yield* Clock.currentTimeMillis);
            }),
          updateTrigger: ({ id, patch }) =>
            Clock.currentTimeMillis.pipe(Effect.map((now) => triggers.update(id, patch, now))),
          setTriggerPaused: ({ id, paused }) =>
            Clock.currentTimeMillis.pipe(Effect.map((now) => triggers.setPaused(id, paused, now))),
          removeTrigger: ({ id }) => Effect.sync(() => triggers.remove(id)),
          listTriggers: ({ environment }) => Effect.sync(() => triggers.list(environment)),
          triggerDefinition: ({ id }) => Effect.sync(() => triggers.get(id)),
          admitFire: (fire) =>
            Effect.gen(function* () {
              const session = yield* newSessionId;
              // Eight hex digits rarely collide; one that does is drawn again, as `createSession` draws.
              let workspace = yield* newWorkspaceId;

              while (store.getWorkspaceSetup(workspace) !== null) workspace = yield* newWorkspaceId;

              const now = yield* Clock.currentTimeMillis;

              return triggers.admit(fire, { session, workspace }, now, STARTING_MS);
            }),
          notifyTriggerFailed: ({ trigger, reason }) =>
            Effect.suspend(() => {
              const known = triggers.get(trigger);

              return known === null
                ? Effect.void
                : pushToAll({ store, vapid: push.vapid })(describeTriggerFailure(known, reason));
            }),
          deleteEnvironmentWithTriggers: ({ id }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                const removal = deleteEnvironmentWithTriggers(
                  state.raw.storage,
                  store,
                  triggers,
                  id,
                );

                // The host is wiped by the main Worker's next sync: the Registry never calls out.
                if (removal.deletion === "deleted") recordMcpDeleted(store, id, now);

                return removal;
              }),
            ),
          mcpAccessToken: (input) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => mcpAccessToken(tokenDeps, input, now)),
            ),
          mcpSignInAsk: (input) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => askMcpSignIn(tokenDeps, input, now)),
            ),
          mcpSignInWithdraw: (input) =>
            Effect.sync(() => withdrawMcpSignIn({ signIns: mcpSignIns }, input)),
          reportMcpAuth: (report) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => reportMcpAuth({ store, signIns: mcpSignIns }, report, now)),
            ),
          signInsRevision: () => Effect.sync(() => mcpSignIns.revision()),
          startMcpSignIn: (input) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => startMcpSignIn(signInFlow, input, now)),
            ),
          confirmMcpSignIn: (input) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => confirmMcpSignIn(signInFlow, input, now)),
            ),
          completeMcpSignIn: (input) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => completeMcpSignIn(signInFlow, input, now)),
            ),
          listMcpSignIns: () =>
            Clock.currentTimeMillis.pipe(Effect.flatMap((now) => listMcpSignIns(signInFlow, now))),
          signOutMcpSignIn: ({ hash }) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => signOutMcpSignIn(signInFlow, hash, now)),
            ),
        } satisfies RegistryMethods;
      }),
    ),
  ),
);
