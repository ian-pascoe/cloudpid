import {
  type ContainerSettings,
  resolveContainerOverridesLeniently,
  resolveEnvironmentContainerSettings,
} from "@cloudpid/config";
import { type Migration, type MigrationStorage, migrate } from "@cloudpid/effect-durable/sqlite";
import type { EnvironmentInstructions } from "@cloudpid/extensions/instructions";
import type { SealedValue } from "@cloudpid/extensions/secrets/core";
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentRepo,
  type EnvironmentSecretRecord,
  GLOBAL_SCOPE,
  MarkedOrigin,
  ForkKind,
  MAX_ENVIRONMENT_SECRETS,
  type SessionOrigin,
  SessionAgent,
  type PushSubscription,
  SPARE_BRANCH,
  TitleSource,
  workspaceDirectory,
  readMcpRepoFileState,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { SessionStatus } from "../session/status.ts";
import type { BuildProgress, EnvironmentBuild } from "../workspace/build-record.ts";
import type { McpRepoFileRecord } from "./mcp-repo-files.ts";
import { dropUnreferencedSkillFiles } from "./skills.ts";

// The Registry's tables over the Registry DO's SQLite storage (`docs/architecture/overview.md` → Durable Objects). Synchronous, as
// SQLite in a Durable Object is, and given the time by its caller so tests control it.

export type { SessionAgent, SessionStatus };

/** A Session as the Registry lists it. Times are epoch milliseconds. */
export type SessionRecord = {
  /** The Session DO's name: a UUIDv7. */
  readonly id: string;
  /** Null until the user or the title task gives it one. */
  readonly title: string | null;
  /** Who set the title: null while there is none. A title the owner set is never replaced; a generated one is set once. */
  readonly titleSource: TitleSource | null;
  /** The Environment its Workspace was made from, fixed when it is created. */
  readonly environment: string;
  /** The Workspace it works in, fixed when it is created. */
  readonly workspace: string;
  readonly status: SessionStatus;
  readonly createdAt: number;
  /** When the Session was created or its status last changed. */
  readonly updatedAt: number;
  /** When the owner archived the Session, or null while it is not archived. */
  readonly archivedAt: number | null;
  /** True while a Session import still fills it; absent otherwise. */
  readonly importing?: true;
  /** The Session it is a Fork or Clone of; absent for one started afresh. */
  readonly origin?: SessionOrigin;
  /** How the MCP endpoint's caller got in, for a Session it started or imported. */
  readonly marks?: MarkedOrigin;
  /** Its subagents as it last reported them, parents first; absent until it first reports (ADR-0024). */
  readonly agents?: ReadonlyArray<SessionAgent>;
  /** How many MCP tasks it follows in the background, as it last reported them; absent when none. */
  readonly mcpTasks?: number;
};

/** An Environment as the Registry lists it (ADR-0016). */
export type EnvironmentRecord = {
  readonly id: string;
  /** The owner's label for it, unique among Environments whatever the case. */
  readonly name: string;
  /** Its Repos, in the order they were added. */
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly createdAt: number;
};

/** A Workspace (ADR-0016): a working copy of an Environment, with clones of its own on one branch. */
export type WorkspaceRecord = {
  /** Eight lowercase hex digits. */
  readonly id: string;
  readonly environment: string;
  readonly branch: string;
  /** The branch its own was made from; null for each Repo's default branch. */
  readonly base: string | null;
  /** The Repos it holds, by directory name: the Environment's when it was made. */
  readonly repos: ReadonlyArray<string>;
  /** Where its Sessions work: `workspaceDirectory(repos)`. */
  readonly directory: string;
  readonly createdAt: number;
  /** For a Subagent Workspace: the Session and the subagent it was made for. Absent for any other. */
  readonly subagent?: SubagentOwner;
};

/** Whose a Subagent Workspace is (GLOSSARY.md → Subagent Workspace): a Session's, made for one of its subagents. */
export type SubagentOwner = { readonly session: string; readonly agent: string };

/**
 * A Subagent Workspace asked for (`createSubagentWorkspace`): its id unless the Environment's spare is taken, the Session
 * and subagent it is for, its branch (null: `cloudpid/<id>` of the Workspace it gets) and base, and how many the Session
 * may have at once (the Subagent Workspace limit).
 */
export type SubagentWorkspaceRequest = SubagentOwner & {
  readonly id: string;
  readonly branch: string | null;
  readonly base: string | null;
  readonly limit: number;
};

/**
 * Why the store refused a Subagent Workspace: its Session is not listed, the Session has as many as the limit allows
 * (`count`), or the branch is another Workspace's of the Environment.
 */
export type SubagentWorkspaceRefusal =
  | { readonly refused: "no-session" }
  | { readonly refused: "limit"; readonly count: number }
  | { readonly refused: "branch-taken"; readonly workspace: string };

/** What a Workspace's Durable Object is told to set itself up with: its Repos' addresses, its branch and its base. */
export type WorkspaceSetup = {
  readonly id: string;
  readonly environment: string;
  readonly branch: string;
  readonly base: string | null;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
};

/**
 * A Session's Workspace, as `createSession` is told it: one that exists, or a new one of an Environment, under `id`
 * unless the Environment's spare is taken. A null `branch` is `cloudpid/<id>` of the Workspace it gets.
 */
export type StoredWorkspaceChoice =
  | { readonly kind: "existing"; readonly id: string }
  | {
      readonly kind: "new";
      readonly id: string;
      readonly environment: string;
      readonly branch: string | null;
      readonly base: string | null;
    };

/** Why the store refused to create a Session: what it names is not there, or the branch is another Workspace's. */
export type SessionRefusal =
  | { readonly refused: "no-environment" }
  | { readonly refused: "no-workspace" }
  | { readonly refused: "branch-taken"; readonly workspace: string }
  /** `maxRunning` Sessions started over the MCP endpoint or imported are running already (`createSession`'s `maxRunning`). */
  | { readonly refused: "too-many-running"; readonly limit: number }
  /** `limit` imports of the same identity are open already (`createSession`'s `maxOpenImports`). */
  | { readonly refused: "too-many-imports"; readonly limit: number };

/**
 * A Session `createSession` answers: `repeated` says it was made for an earlier start of the same `requestId`, so a start
 * that is sent again knows it made nothing and does not set it up a second time.
 */
export type CreatedSession = SessionRecord & { readonly repeated?: true };

/** What became of a record: deleted, not registered, or kept because something is still bound to it. */
export type Deletion = "deleted" | "missing" | "in-use";

/** What became of an Environment's record: as a `Deletion`, or `refused` for the default Environment, which stays. */
export type EnvironmentDeletion = Deletion | "refused";

/** How naming an Environment went. */
export type EnvironmentNaming =
  | { readonly status: "named"; readonly environment: EnvironmentRecord }
  | { readonly status: "missing" }
  | { readonly status: "taken" };

/** How changing an Environment's Repos went. */
export type RepoChange = "changed" | "missing" | "taken" | "absent";

/**
 * How long after its last Session was used (made, or its status last changed) an Environment still gets a spare made
 * (docs/architecture/workspace.md → Spare Workspace): 3 days, over a weekend. Past it, the Environment keeps at most the
 * spare it has, so one nobody uses costs no Container time for spares.
 */
export const SPARE_REFILL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** A spare registered now: its set-up, and the Environment's last good Build it is prepared with (null for none). */
export type SpareSetup = WorkspaceSetup & { readonly build: EnvironmentBuild | null };

/**
 * What keeps Environments' spare Workspaces current: the stale spares (whose Repos are no longer their Environment's,
 * or that were made with another Build than its last good one) to remove, by id, and the spares registered now, for
 * their Durable Objects to prepare.
 */
export type SpareUpkeep = {
  readonly stale: ReadonlyArray<string>;
  readonly made: ReadonlyArray<SpareSetup>;
};

/**
 * What the Registry knows of an Environment's Build (docs/architecture/container.md → Builds), as the Build's object last answered: its
 * last good Build, which new Workspaces start from, and the one in progress or the last failure.
 */
export type BuildRecord = {
  readonly build: EnvironmentBuild | null;
  readonly status: BuildProgress | null;
};

/** A kept Secret's sealed value with what it is kept as (`docs/architecture/agent-capabilities.md` → Secrets): the Registry DO opens it. */
export type StoredEnvironmentSecret = EnvironmentSecretRecord & { readonly sealed: SealedValue };

/** How keeping a Secret went: its record, or its Environment does not exist, or its scope holds as many as it may. */
export type SecretPut = EnvironmentSecretRecord | "missing" | "full";

/** The scope column of the Secrets kept Global; no Environment id can be it. */
export { GLOBAL_SCOPE };

/** Something left from before Environments (ADR-0016) whose Durable Object is still to be wiped. */
export type LegacyObject = { readonly kind: "session" | "machine"; readonly id: string };

export type RegistryStore = {
  /**
   * Register a Session, idle, in a Workspace that exists, or in a new one, in the same transaction: the Environment's
   * spare when its Repos are the Environment's (it stops being spare and gets the branch and base), else one registered
   * under the id given. A refusal says why and registers nothing.
   */
  readonly createSession: (
    input: {
      readonly id: string;
      readonly title: string | null;
      readonly workspace: StoredWorkspaceChoice;
      /** The Session it is a Fork or Clone of, or the endpoint's marks, or null. */
      readonly origin?: SessionOrigin | null;
      /** How the MCP endpoint's caller got in, or null. */
      readonly marks?: MarkedOrigin | null;
      /**
       * Made for this request before (within `REQUEST_MEMORY_MS`), and the Session still there: that Session is answered
       * and nothing is registered, so a start that is sent again finds the first.
       */
      readonly requestId?: string | undefined;
      /**
       * Refuse (`too-many-running`) when this many Sessions that the MCP endpoint started or imported are running
       * (`runningMarked`), unless `requestId` finds its Session. The count and the insert are one transaction, so
       * concurrent starts cannot both pass.
       */
      readonly maxRunning?: number | undefined;
      /**
       * For a Session marked `import`: refuse (`too-many-imports`) when `limit` Sessions marked `import` by the same `auth`
       * are still importing (`importing`), unless `requestId` finds its Session. Counted in the same transaction as the insert.
       */
      readonly maxOpenImports?: { readonly limit: number; readonly auth: string } | undefined;
    },
    now: number,
  ) => CreatedSession | SessionRefusal;
  /** The Session's import ended: it is no longer `importing`. A Session that is not registered is ignored. */
  readonly endSessionImport: (id: string) => void;
  /** The Session registered under `id`, or null. */
  readonly getSession: (id: string) => SessionRecord | null;
  /** The Session registered for `requestId` less than `REQUEST_MEMORY_MS` ago, if it is still there. */
  readonly requestedSession: (requestId: string, now: number) => SessionRecord | null;
  /**
   * Register a Subagent Workspace for subagent `agent` of Session `session`, in the Session's Environment, as
   * `createSession` registers a new Workspace (taking the Environment's spare when its Repos are the Environment's), in
   * one transaction. The one the subagent has already is answered again, so a spawn that is run again makes no other.
   * Refused past `limit` Subagent Workspaces of the Session.
   */
  readonly createSubagentWorkspace: (
    input: SubagentWorkspaceRequest,
    now: number,
  ) => WorkspaceRecord | SubagentWorkspaceRefusal;
  /** Session `session`'s Subagent Workspaces, newest first. */
  readonly listSubagentWorkspaces: (session: string) => WorkspaceRecord[];
  /** Every Session, newest first. */
  readonly listSessions: () => SessionRecord[];
  /** Record that a Session's Run started or ended. A Session that is not registered is ignored. */
  readonly setSessionStatus: (id: string, status: SessionStatus, now: number) => void;
  /**
   * Keep the summary of its subagents a Session reported (ADR-0024), replacing the last; an archived Session's too, so
   * the report after its stop lands. It leaves `updatedAt` alone. A Session that is not registered is ignored.
   */
  readonly setSessionAgents: (id: string, agents: ReadonlyArray<SessionAgent>) => void;
  /** Keep how many MCP tasks a Session follows in the background, as it reported it, replacing the last. */
  readonly setSessionMcpTasks: (id: string, count: number) => void;
  /** Give a Session the owner's title, replacing any other; null when the Session is not registered. */
  readonly renameSession: (id: string, title: string) => SessionRecord | null;
  /**
   * Give a Session a generated title, only if it has none: a Session the owner named, or one already titled, keeps its
   * title. Says whether the title was set.
   */
  readonly setGeneratedTitle: (id: string, title: string) => boolean;
  /** Archive a Session; one already archived keeps the time it was. Null when the Session is not registered. */
  readonly archiveSession: (id: string, now: number) => SessionRecord | null;
  /** Put an archived Session back in the list; null when the Session is not registered. */
  readonly unarchiveSession: (id: string) => SessionRecord | null;
  /** Forget a Session; says whether it was registered. */
  readonly deleteSession: (id: string) => boolean;
  /** Register an Environment, with no Repos and no settings overrides, unless another has the name in any case. */
  readonly createEnvironment: (id: string, name: string, now: number) => EnvironmentNaming;
  /** The Environment registered under `id`, or null. */
  readonly getEnvironment: (id: string) => EnvironmentRecord | null;
  /** All Environments, newest first. */
  readonly listEnvironments: () => EnvironmentRecord[];
  /** Give an Environment a new name, which no other may have in any case. */
  readonly renameEnvironment: (id: string, name: string) => EnvironmentNaming;
  /**
   * Forget an Environment and its Secrets, only while no Workspace is made from it. The default Environment is never
   * forgotten, so a new Session always has one to start in.
   */
  readonly deleteEnvironment: (id: string) => EnvironmentDeletion;
  /** Add a Repo to an Environment; `taken` when it has one with that directory name. */
  readonly addRepo: (environment: string, repo: EnvironmentRepo) => RepoChange;
  /** Take a Repo out of an Environment; `absent` when it has none of that name. */
  readonly removeRepo: (environment: string, name: string) => RepoChange;
  /**
   * `environment`'s Repos' `.pi/mcp.json` as last looked at, one record per Repo looked at (`[]` for none, or for an
   * Environment that is not registered).
   */
  readonly getMcpRepoFiles: (environment: string) => McpRepoFileRecord[];
  /** Keep a look at a Repo's `.pi/mcp.json`, replacing the Repo's last. */
  readonly putMcpRepoFile: (record: McpRepoFileRecord) => void;
  /** The Container settings overrides saved for an Environment, or null when it is not registered. */
  readonly getEnvironmentSettings: (environment: string) => Schema.Json | null;
  /** Save an Environment's Container settings overrides; says whether it is registered. */
  readonly putEnvironmentSettings: (environment: string, overrides: Schema.Json) => boolean;
  /**
   * An Environment's Settings Overrides (ADR-0027) as saved, `{}` for none, or null when it is not registered. Text that
   * is not JSON reads as itself, for the reader to report.
   */
  readonly getSettingsOverrides: (environment: string) => Schema.Json | null;
  /** Save an Environment's Settings Overrides; says whether it is registered. */
  readonly putSettingsOverrides: (environment: string, overrides: Schema.Json) => boolean;
  /** An Environment's own Instructions (empty for none) with its name, or null when it is not registered. */
  readonly getEnvironmentInstructions: (environment: string) => EnvironmentInstructions | null;
  /** Save an Environment's own Instructions; says whether it is registered. */
  readonly putEnvironmentInstructions: (environment: string, text: string) => boolean;
  /** The Environments that have Settings Overrides, with them as saved, newest Environment first. */
  readonly listSettingsOverrides: () => Array<{
    readonly id: string;
    readonly name: string;
    readonly overrides: Schema.Json;
  }>;
  /** What the Registry knows of an Environment's Build, or null when the Environment is not registered. */
  readonly getBuild: (environment: string) => BuildRecord | null;
  /** Keep what an Environment's Build object answered; says whether the Environment is registered. */
  readonly putBuild: (environment: string, record: BuildRecord) => boolean;
  /** Each Environment's Build, by Environment id, newest Environment first. */
  readonly listBuilds: () => Array<BuildRecord & { readonly environment: string }>;
  /** The Workspace registered under `id`, or null; a spare is not one until it is taken. */
  readonly getWorkspace: (id: string) => WorkspaceRecord | null;
  /** What Workspace `id` sets itself up with, or null when it is not registered. */
  readonly getWorkspaceSetup: (id: string) => WorkspaceSetup | null;
  /** Every Workspace but the spares, newest first. */
  readonly listWorkspaces: () => WorkspaceRecord[];
  /** Forget a Workspace's record, only while no Session is bound to it. */
  /**
   * Delete Workspace `id`'s record: `in-use` while a Session is bound to it, or (unless `triggers` is `delete`, the
   * owner's Remove, which takes them with it) while a Workspace trigger is. The Triggers the agent removed that were
   * kept for its Workspace go with it.
   */
  readonly deleteWorkspace: (id: string, triggers?: "keep" | "delete") => Deletion;
  /**
   * Keep a spare for each of `environments` that exists (every one when undefined), in one transaction: an Environment
   * whose spare is stale (other Repos, or another Build than its last good one) has it listed, to remove, and one with
   * none gets one registered, under an id from `newId` that no Workspace has, on `SPARE_BRANCH` with the Environment's
   * Repos and its last good Build, which the spare records. Only an Environment that had a Session within
   * `SPARE_REFILL_WINDOW_MS` of `now` gets a spare made: another keeps the one it has while a Session can take it (one
   * of another Build), and has one whose Repos are no longer its own listed but not replaced. An Environment whose Spare
   * Workspace setting is off (`spareWorkspace`) gets none, and has the one it has listed, current or not.
   */
  readonly upkeepSpares: (
    environments: ReadonlyArray<string> | undefined,
    newId: () => string,
    now: number,
    /** The Container settings at Global, whose Spare Workspace setting an Environment without an Override inherits. */
    global: ContainerSettings,
  ) => SpareUpkeep;
  /** The id of an Environment's spare, current or stale, or null. */
  readonly getSpare: (environment: string) => string | null;
  /** Forget a spare's record, only while it is a spare; says whether it was. */
  readonly forgetSpare: (id: string) => boolean;
  /**
   * Up to `limit` of the objects left from before Environments that no caller took in the last `leaseMs`, each taken
   * from `now`, so two callers do not wipe the same one at once.
   */
  readonly takeLegacy: (limit: number, now: number, leaseMs: number) => LegacyObject[];
  /** Forget a legacy object once it is wiped. */
  readonly forgetLegacy: (object: LegacyObject) => void;
  /** Every kept Secret, without its value: those at Global first, then by Environment, each by name. */
  readonly listEnvironmentSecrets: () => EnvironmentSecretRecord[];
  /** The sealed Secrets `environment` uses: those kept Global, and its own. */
  readonly getEnvironmentSecrets: (environment: string) => StoredEnvironmentSecret[];
  /**
   * Keep a sealed value under `name` for `environment` (null: Global), replacing the one kept there; `build`
   * left out keeps a replaced one's flag (false for a new one).
   */
  readonly putEnvironmentSecret: (
    input: {
      readonly environment: string | null;
      readonly name: string;
      readonly sealed: SealedValue;
      readonly build?: boolean | undefined;
    },
    now: number,
  ) => SecretPut;
  /** Set whether a kept Secret reaches the Build; null when none is kept under that scope and name. */
  readonly setEnvironmentSecretBuild: (
    environment: string | null,
    name: string,
    build: boolean,
    now: number,
  ) => EnvironmentSecretRecord | null;
  /** Delete a kept Secret; says whether one was kept. */
  readonly deleteEnvironmentSecret: (environment: string | null, name: string) => boolean;
  /**
   * The JSON text of the document called `name`, or null. Documents hold the Registry's own settings and the variables
   * kept Global.
   */
  readonly getDocument: (name: string) => string | null;
  /** Save a document, replacing the one with its name. */
  readonly putDocument: (name: string, body: string, now: number) => void;
  /** Keep a browser's Web Push subscription, replacing the one with the same endpoint. */
  readonly putPushSubscription: (subscription: PushSubscription, now: number) => void;
  /** Forget the subscription at `endpoint`; one that is not kept is ignored. */
  readonly deletePushSubscription: (endpoint: string) => void;
  /** Whether a subscription at `endpoint` is kept. */
  readonly hasPushSubscription: (endpoint: string) => boolean;
  /** Every kept subscription, oldest first. */
  readonly listPushSubscriptions: () => PushSubscription[];
};

type SessionRow = {
  id: string;
  title: string | null;
  title_source: string | null;
  environment: string;
  workspace: string;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  /** 1 while a Session import fills the Session. */
  importing: number;
  /**
   * A Fork or Clone's source Session and which it is; for `mcp` and `import`, the marks as JSON (`MarkedOrigin`) and
   * which. Both null for one started afresh.
   */
  origin: string | null;
  origin_kind: string | null;
  /** JSON: `SessionAgent[]`, as the Session last reported them; null until it first does. */
  agents: string | null;
  /** How many MCP tasks the Session last reported following in the background; null until it first does. */
  mcp_tasks: number | null;
};

type EnvironmentRow = {
  id: string;
  name: string;
  /** JSON: `EnvironmentRepo[]`. */
  repos: string;
  /** JSON: the Container settings overrides. */
  settings: string;
  created_at: number;
  /** JSON: the last good Build (`EnvironmentBuild`), or null for none yet. */
  build: string | null;
  /** JSON: the Build in progress or the last that failed (`BuildProgress`), or null. */
  build_status: string | null;
};

type WorkspaceRow = {
  id: string;
  environment: string;
  branch: string;
  base: string | null;
  /** JSON: `EnvironmentRepo[]`, as the Environment had them when the Workspace was made. */
  repos: string;
  created_at: number;
  /** 1 while it is its Environment's spare, made ahead and not yet taken; 0 once it is a Session's. */
  spare: number;
  /** The snapshot id of the Build it was made from as a spare; null for none, or a Workspace never spare. */
  spare_build: string | null;
  /** For a Subagent Workspace, the Session and subagent it is for; null for any other. */
  session: string | null;
  subagent: string | null;
};

type PushSubscriptionRow = { endpoint: string; p256dh: string; auth: string };

type EnvironmentSecretRow = {
  /** An Environment's id, or `GLOBAL_SCOPE`. */
  scope: string;
  name: string;
  /** Base64: the AES-GCM nonce and ciphertext of the value (`SealedValue`). */
  iv: string;
  ciphertext: string;
  /** 1 when it reaches the Environment's Build. */
  build: number;
  updated_at: number;
};

const scopeOf = (environment: string | null): string => environment ?? GLOBAL_SCOPE;

const toSecretRecord = (row: EnvironmentSecretRow): EnvironmentSecretRecord => ({
  environment: row.scope === GLOBAL_SCOPE ? null : row.scope,
  name: row.name,
  build: row.build === 1,
  updatedAt: row.updated_at,
});

const isStatus = Schema.is(SessionStatus);

/**
 * The status is plain text in the table, not a `CHECK` constraint, which SQLite cannot alter: the set of statuses
 * will grow, and the table would have to be rebuilt in every stage. A write is checked here instead.
 */
const checkedStatus = (status: string): SessionStatus => {
  if (!isStatus(status)) throw new Error(`Unknown Session status in the Registry: ${status}`);

  return status;
};

/**
 * A stored status as a record shows it. One this build does not know (a row a later build wrote, read after a revert
 * or before this object's code update) falls back to `idle`, an existing member, since an `unknown` one would change
 * the client protocol: a listing shows it not known to run, never a failure that drops the whole list. The running cap
 * counts it as running all the same (`runningMarked`) (`docs/development/workers.md` → Bindings).
 */
const statusOrIdle = (status: string): SessionStatus => (isStatus(status) ? status : "idle");

const isTitleSource = Schema.is(TitleSource);

/**
 * A stored title source. One this build does not know falls back to the owner's, an existing member: a title is there,
 * and a generated one never replaces it (`setGeneratedTitle` writes only where there is no source).
 */
const titleSourceOrOwner = (source: string | null): TitleSource | null => {
  if (source === null) return null;

  return isTitleSource(source) ? source : "owner";
};

// @effect-diagnostics-next-line schemaSync:off -- the store is synchronous, as SQLite in a Durable Object is, and only reads what it wrote.
const decodeRepos = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String }))),
);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** An Environment's `settings` column: its Container settings overrides. Text that is not JSON (never written so) reads as none. */
const settingsOverrides = (text: string): Schema.Json =>
  Option.getOrElse(decodeJson(text), () => ({}));

/**
 * An Environment's `settings_overrides` column: its Settings Overrides, none for null. Text that is not JSON (never
 * written so) reads as the text, which the reader reports as Overrides that are not an object.
 */
const savedSettingsOverrides = (text: string | null): Schema.Json =>
  text === null ? {} : Option.getOrElse(decodeJson(text), () => text);

/** A JSON column the store wrote itself, as `A`; null when it is null or not JSON. */
const jsonColumn = <A>(text: string | null): A | null => {
  if (text === null) return null;

  // SAFETY: only the store writes these columns, from values of type `A`.
  return Option.getOrNull(decodeJson(text)) as A | null;
};

const toBuild = (row: Pick<EnvironmentRow, "build" | "build_status">): BuildRecord => ({
  build: jsonColumn<EnvironmentBuild>(row.build),
  status: jsonColumn<BuildProgress>(row.build_status),
});

const isForkKind = Schema.is(ForkKind);

const decodeMarks = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      client: MarkedOrigin.fields.client,
      auth: MarkedOrigin.fields.auth,
      trigger: MarkedOrigin.fields.trigger,
    }),
  ),
);

/** How long a start remembers its `requestId`. */
export const REQUEST_MEMORY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a Session the MCP endpoint made counts as running before its first Run reports
 * (`docs/architecture/mcp-endpoint.md` → Limits and errors, As built, the running cap): the Session object tells the
 * Registry a Run started a moment after the start's first message reaches it, and starts made in parallel must not all
 * pass the running cap in that moment. A Session whose status never changed in this time is not counted.
 */
export const STARTING_MS = 2 * 60 * 1000;

/**
 * A Session that is idle and whose status has never changed (`setSessionStatus` moves `updated_at`; nothing else of a
 * marked Session does, in the minutes that matter): it was made and its first Run has not reported yet. SQL for
 * `runningMarked`'s `WHERE`.
 */
const STILL_STARTING = "status = 'idle' AND updated_at = created_at";

/**
 * The two columns that keep a Session's origin: a Fork or Clone's source, or the marks of the endpoint or a Trigger as
 * JSON.
 */
const originColumns = (
  origin: SessionOrigin | null,
  marks: MarkedOrigin | null,
): [string | null, string | null] => {
  if (origin !== null) return [origin.session, origin.kind];

  if (marks !== null)
    return [
      JSON.stringify({ client: marks.client, auth: marks.auth, trigger: marks.trigger }),
      marks.kind,
    ];

  return [null, null];
};

/** What a Session's origin columns read as. */
type Origins = { readonly origin?: SessionOrigin; readonly marks?: MarkedOrigin };

/**
 * What the columns keep: a Fork or Clone's `origin`, or the endpoint's `marks`. A kind this version does not know (a
 * newer deploy's) reads as none, never as a failure: the Session is still a Session.
 */
const readOrigins = (row: Pick<SessionRow, "origin" | "origin_kind">): Origins => {
  const { origin, origin_kind: kind } = row;

  if (origin === null || origin === undefined) return {};

  if (isForkKind(kind)) return { origin: { session: origin, kind } };

  if (kind !== "mcp" && kind !== "import" && kind !== "trigger") return {};

  const marks = Option.getOrUndefined(decodeMarks(origin));

  return marks === undefined ? {} : { marks: { ...marks, kind } };
};

const decodeAgents = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(SessionAgent)));

const toSession = (row: SessionRow): SessionRecord => {
  // A summary that does not read (none was ever reported, or a shape this version does not know) shows none.
  const agents = row.agents === null ? undefined : Option.getOrUndefined(decodeAgents(row.agents));

  const record: SessionRecord = {
    id: row.id,
    title: row.title,
    titleSource: titleSourceOrOwner(row.title_source),
    environment: row.environment,
    workspace: row.workspace,
    status: statusOrIdle(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };

  const { origin, marks } = readOrigins(row);
  const full: Types.Mutable<SessionRecord> = record;

  if (origin !== undefined) full.origin = origin;

  if (marks !== undefined) full.marks = marks;

  if (agents !== undefined) full.agents = agents;

  if (row.mcp_tasks !== null && row.mcp_tasks > 0) full.mcpTasks = row.mcp_tasks;

  if (row.importing === 1) full.importing = true;

  return full;
};

/** A row of `mcp_repo_files`. */
type McpRepoFileRow = {
  environment: string;
  repo: string;
  slug: string | null;
  state: string;
  blob: string | null;
  text: string | null;
  size: number | null;
  read_at: number | null;
  looked_at: number;
  error: string | null;
  failing_since: number | null;
};

const toMcpRepoFile = (row: McpRepoFileRow): McpRepoFileRecord => ({
  environment: row.environment,
  repo: row.repo,
  slug: row.slug,
  // A state this build does not know (a row a later build wrote) reads as `unknown`, which holds no copy.
  state: readMcpRepoFileState(row.state),
  blob: row.blob,
  text: row.text,
  size: row.size,
  readAt: row.read_at,
  lookedAt: row.looked_at,
  error: row.error,
  failingSince: row.failing_since,
});

const toEnvironment = (row: EnvironmentRow): EnvironmentRecord => ({
  id: row.id,
  name: row.name,
  repos: decodeRepos(row.repos),
  createdAt: row.created_at,
});

/** Repos in the order of their directory names. */
const byName = Order.mapInput(Order.String, (repo: EnvironmentRepo) => repo.name);

/** Whether two lists of Repos have the same names and addresses, in any order. */
const sameRepos = (
  left: ReadonlyArray<EnvironmentRepo>,
  right: ReadonlyArray<EnvironmentRepo>,
): boolean => {
  const others = Arr.sort(right, byName);

  return (
    left.length === right.length &&
    Arr.every(
      Arr.sort(left, byName),
      (repo, index) => repo.name === others[index]?.name && repo.url === others[index]?.url,
    )
  );
};

const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => {
  const repos = Arr.map(decodeRepos(row.repos), (repo) => repo.name);

  const record: WorkspaceRecord = {
    id: row.id,
    environment: row.environment,
    branch: row.branch,
    base: row.base,
    repos,
    directory: workspaceDirectory(repos),
    createdAt: row.created_at,
  };

  return row.session === null || row.subagent === null
    ? record
    : { ...record, subagent: { session: row.session, agent: row.subagent } };
};

/** The part of a Durable Object's storage the store uses: its SQLite database, and transactions over it. */
export type RegistryStorage = MigrationStorage;

/** The default Machine before Environments (ADR-0016), which migration 3 listed, under the name it had then. */
const DEFAULT_MACHINE = "default";

/**
 * The schema, one step per version, applied in order: version N is in place once step N has run. Steps only add
 * (tables, nullable or defaulted columns, rows), except step 11, the cutover to Environments, which drops. A step is
 * never edited once released: add the next one (`migrations.manifest.ts` fails a step that changed or went missing).
 * Each step and its version record run in one transaction, so a step that fails partway leaves no trace and is retried
 * whole.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  // 1: the first deployed schema, whose stores recorded no version.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS sessions_by_created ON sessions (created_at DESC, id DESC)",
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      slug TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    ) STRICT`);
  },
  // 2: the Workspace a Session works on. Null for Sessions stored before, which read as the default Workspace.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN workspace TEXT");
  },
  // 3: the default Workspace is listed from the start, so a picker finds it before any Session is created in it.
  (sql) => {
    sql.exec(
      `INSERT OR IGNORE INTO workspaces (slug, created_at)
       VALUES (?, CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      DEFAULT_MACHINE,
    );
  },
  // 4: documents by name, which hold the settings overrides.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS documents (
      name TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
  },
  // 5: the browsers Web Push notifies, one row per push endpoint.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
  },
  // 6: the repo directory a Session works in. Null for Sessions stored before, which work at the Workspace root.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN repo TEXT");
  },
  // 7: who set the title. A title stored before this was the owner's (it could only be given at creation).
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN title_source TEXT");
    sql.exec("UPDATE sessions SET title_source = 'owner' WHERE title IS NOT NULL");
  },
  // 8: the owner's name for a Workspace, unique whatever the case. Each is named after its slug, and slugs are unique
  // lowercase text, so no two collide.
  (sql) => {
    sql.exec("ALTER TABLE workspaces ADD COLUMN name TEXT");
    sql.exec("UPDATE workspaces SET name = slug");
    sql.exec("CREATE UNIQUE INDEX workspaces_by_name ON workspaces (name COLLATE NOCASE)");
  },
  // 9: when the owner archived a Session. Null for Sessions stored before, which are not archived.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");
  },
  // 10: the Workspaces of their own (worktrees, ADR-0015), and the one a Session works in. Null for Sessions stored
  // before, which work in their repo's main checkout.
  (sql) => {
    sql.exec(`CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      machine TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    // git checks a branch out in one worktree of a repo at a time.
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS worktrees_by_branch ON worktrees (machine, repo, branch)",
    );
    sql.exec("ALTER TABLE sessions ADD COLUMN worktree TEXT");
  },
  // 11: Environments, and a Container per Workspace (ADR-0016). Machines and their Sessions are reset rather than
  // migrated, so this step is the one that drops: the old tables go, and what their rows named is kept in `legacy`
  // until its Durable Object is wiped. The `default` Environment is there from the start.
  (sql) => {
    sql.exec(`CREATE TABLE legacy (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      taken_at INTEGER,
      PRIMARY KEY (kind, id)
    ) STRICT`);
    sql.exec("INSERT INTO legacy (kind, id) SELECT 'session', id FROM sessions");
    sql.exec("INSERT INTO legacy (kind, id) SELECT 'machine', slug FROM workspaces");
    sql.exec("DROP TABLE sessions");
    sql.exec("DROP TABLE workspaces");
    sql.exec("DROP TABLE worktrees");
    sql.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      title_source TEXT,
      environment TEXT NOT NULL,
      workspace TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    ) STRICT`);
    sql.exec("CREATE INDEX sessions_by_created ON sessions (created_at DESC, id DESC)");
    sql.exec("CREATE INDEX sessions_by_workspace ON sessions (workspace)");
    sql.exec(`CREATE TABLE environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repos TEXT NOT NULL,
      settings TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    sql.exec("CREATE UNIQUE INDEX environments_by_name ON environments (name COLLATE NOCASE)");
    sql.exec(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      branch TEXT NOT NULL,
      base TEXT,
      repos TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    // Two Workspaces of an Environment on one branch would push over each other.
    sql.exec("CREATE UNIQUE INDEX workspaces_by_branch ON workspaces (environment, branch)");
    sql.exec(
      `INSERT INTO environments (id, name, repos, settings, created_at)
       VALUES (?, 'Default', '[]', '{}', CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      DEFAULT_ENVIRONMENT,
    );
  },
  // 12: spare Workspaces (ADR-0016), one per Environment, made ahead of the Session that takes one. Every Workspace
  // stored before is a Session's.
  (sql) => {
    sql.exec("ALTER TABLE workspaces ADD COLUMN spare INTEGER NOT NULL DEFAULT 0");
  },
  // 13: each Environment's Build (ADR-0016), as its Build object last answered: the last good one, and the one in
  // progress or the last failure. Each Environment stored before has none yet.
  (sql) => {
    sql.exec("ALTER TABLE environments ADD COLUMN build TEXT");
    sql.exec("ALTER TABLE environments ADD COLUMN build_status TEXT");
  },
  // 14: the Secrets kept for an Environment, or Global (`*`), each value sealed by the Registry DO
  // under a key bound to its scope and name (docs/architecture/agent-capabilities.md → Secrets). None before.
  (sql) => {
    sql.exec(`CREATE TABLE environment_secrets (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      build INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, name)
    ) STRICT`);
  },
  // 15: the Build a spare Workspace is made from (its snapshot id), so a spare made before the Environment's last good
  // Build is made again. Null for every Workspace stored before: a spare of an Environment that has a Build is made
  // again once.
  (sql) => {
    sql.exec("ALTER TABLE workspaces ADD COLUMN spare_build TEXT");
  },
  // 16: the Session a Fork or Clone was made from, and which it is (GLOSSARY.md → Fork, Clone). Null for every Session
  // stored before, all started afresh.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN origin TEXT");
    sql.exec("ALTER TABLE sessions ADD COLUMN origin_kind TEXT");
  },
  // 17: the Agent changes (ADR-0019), each Environment's (`scope` its id) and the Settings', with the owner's reverts of
  // them (`reverts`), the values before and after as JSON (null: none). None before.
  (sql) => {
    sql.exec(`CREATE TABLE agent_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      session TEXT,
      conversation INTEGER,
      tool TEXT,
      reason TEXT NOT NULL,
      field TEXT NOT NULL,
      before TEXT,
      after TEXT,
      reverts INTEGER
    ) STRICT`);
    sql.exec("CREATE INDEX agent_changes_by_scope ON agent_changes (scope, id DESC)");
    sql.exec("CREATE INDEX agent_changes_by_reverts ON agent_changes (reverts)");
  },
  // 18: whether the owner approved an Agent change before it was made (GLOSSARY.md → Approval): 1 for one to a Limit or a
  // kept Secret deleted, 0 for every other, all of those stored before.
  (sql) => {
    sql.exec("ALTER TABLE agent_changes ADD COLUMN approved INTEGER NOT NULL DEFAULT 0");
  },
  // 19: Subagent Workspaces (GLOSSARY.md), each the Session's and the subagent's it was made for. Null for every Workspace
  // stored before, all Sessions' own or spares.
  (sql) => {
    sql.exec("ALTER TABLE workspaces ADD COLUMN session TEXT");
    sql.exec("ALTER TABLE workspaces ADD COLUMN subagent TEXT");
    sql.exec("CREATE INDEX workspaces_by_session ON workspaces (session, subagent)");
  },
  // 20: whether the owner dismissed an Agent change from its list (`docs/architecture/agent-changes.md`): 1 once dismissed,
  // 0 for every other, all of those stored before. A dismissed change stays recorded, and what it changed stays.
  (sql) => {
    sql.exec("ALTER TABLE agent_changes ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0");
  },
  // 21: the summary of a Session's subagents it reports (ADR-0024), JSON `SessionAgent[]`. Null for every Session
  // stored before, until it next starts and reports.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN agents TEXT");
  },
  // 22: an Environment's own Skills (ADR-0026), by scope (the Environment's id) and name, each with its description and
  // its files as their content hashes (JSON, path to hash), and the files' texts, kept once per hash for the Skills and
  // the Agent changes that refer to them (`registry/skills.ts`). None before.
  (sql) => {
    sql.exec(`CREATE TABLE skill_files (
      hash TEXT PRIMARY KEY,
      content TEXT NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE skills (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      files TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      PRIMARY KEY (scope, name)
    ) STRICT`);
  },
  // 23: where a Skill was installed from (ADR-0026, GLOSSARY.md → Skill source): JSON `SkillSource` (the GitHub repo, the
  // Skill's path in it, the ref named and the commit it resolved to). Null for every Skill kept before, and for one the
  // agent wrote that was never installed; a save from a Workspace keeps the source the Skill had.
  (sql) => {
    sql.exec("ALTER TABLE skills ADD COLUMN source TEXT");
  },
  // 24: updating installed Skills (ADR-0026, GLOSSARY.md → Skill source). `modified`: 1 once the agent saved over a Skill that
  // has a source (an update then refuses it unless asked to overwrite). `folder_hash`: a digest of the git blob SHAs of the
  // files the Skill's folder holds at its source's commit (null until it is recorded: at an install or an update, else
  // lazily at the daily check). `update_available`: 1 when the daily check found that digest changed at the ref's head.
  // 0 / null for every Skill kept before.
  (sql) => {
    sql.exec("ALTER TABLE skills ADD COLUMN modified INTEGER NOT NULL DEFAULT 0");
    sql.exec("ALTER TABLE skills ADD COLUMN folder_hash TEXT");
    sql.exec("ALTER TABLE skills ADD COLUMN update_available INTEGER NOT NULL DEFAULT 0");
  },
  // 25: whether an Agent change's value before or after was inherited from Global rather than an Environment's own
  // Override (ADR-0027): 1 when it was, null for every other, all of those stored before.
  (sql) => {
    sql.exec("ALTER TABLE agent_changes ADD COLUMN before_inherited INTEGER");
    sql.exec("ALTER TABLE agent_changes ADD COLUMN after_inherited INTEGER");
  },
  // 26: Container settings at Global (ADR-0027). An Environment stored then only what differed from the defaults, so an
  // Agent change to one of its Container settings that recorded the default (a size by its name then or now) recorded
  // a field it did not override: it is marked inherited, which is what that field is now while Global is at the
  // defaults. The variables recorded null for one not set, which already reads as no Override.
  (sql) => {
    const defaults: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["instance", ['"cpu-1"', '"custom-1"']],
      ["maxInstance", ['"cpu-2"', '"custom-2"']],
      ["idleMinutes", ["2"]],
      ["ignore", ["[]"]],
      ["setupScript", ['""']],
      ["startScript", ['""']],
      ["toolchains", ['""']],
      ["spareWorkspace", ["true"]],
    ];

    for (const [field, values] of defaults) {
      for (const value of values) {
        for (const side of ["before", "after"] as const) {
          sql.exec(
            `UPDATE agent_changes SET ${side}_inherited = 1
             WHERE scope NOT IN ('*', 'settings') AND field = ? AND ${side} = ?`,
            field,
            value,
          );
        }
      }
    }
  },
  // 27: an Environment's Settings Overrides (ADR-0027, `docs/architecture/overview.md` → Settings): JSON, the fields set on
  // purpose for it (`@cloudpid/config` → `overrideFields`). Null for an Environment stored before: none, so it
  // inherits Global whole, as each of its Sessions did before. Its Container settings stay in `settings`.
  (sql) => {
    sql.exec("ALTER TABLE environments ADD COLUMN settings_overrides TEXT");
  },
  // 28: an Environment's own Instructions (ADR-0027: they add up, shown after Global's; `docs/architecture/workspace.md` →
  // Instructions): Markdown, empty for none, as every Environment stored before has. A column of its own, not an
  // Override in `settings_overrides`, since nothing of Global's is replaced; it goes with its Environment's row.
  (sql) => {
    sql.exec("ALTER TABLE environments ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  },
  // 29: the `requestId` of a Session start over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → Starting,
  // sending and stopping), so a start sent again within 24 h finds the first Session. None before.
  (sql) => {
    sql.exec(
      "CREATE TABLE session_requests (request_id TEXT PRIMARY KEY, session TEXT NOT NULL, at INTEGER NOT NULL)",
    );
  },
  // 30: the MCP sign-in store (`docs/architecture/mcp-sign-in.md` → MCP sign-ins, Storage; ADR-0034), five tables kept
  // Global. A sign-in is keyed by (source, normalized name, URL) hashed; its `sealed` tokens, a registration's
  // `sealed_secret` and a pending row's `sealed_verifier` are AES-GCM under the `mcp-oauth` purpose, each bound to its table
  // and key (`mcp-sign-in-seal.ts`). Rows with no `sealed` are sign-ins that need one (the status `required`), which hold
  // the last challenge. A pending row holds only the SHA-256 of its `state`. The columns left JSON are written and read by
  // the code that owns them (`mcp-sign-ins.ts`).
  (sql) => {
    sql.exec(`CREATE TABLE mcp_sign_ins (
      key_hash TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      issuer TEXT,
      metadata TEXT,
      discovery TEXT,
      resource TEXT,
      client_id TEXT,
      client_kind TEXT,
      client_secret_ref TEXT,
      registration TEXT,
      scope TEXT,
      expires_at INTEGER,
      wanted_scope TEXT,
      step_up_count INTEGER NOT NULL DEFAULT 0,
      challenge TEXT,
      last_error TEXT,
      last_error_at INTEGER,
      created_at INTEGER NOT NULL,
      refreshed_at INTEGER,
      used_at INTEGER NOT NULL,
      sealed TEXT
    ) STRICT`);
    sql.exec("CREATE INDEX mcp_sign_ins_by_use ON mcp_sign_ins (used_at)");
    sql.exec(`CREATE TABLE mcp_client_registrations (
      key_hash TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      client_name TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_info TEXT NOT NULL,
      sealed_secret TEXT,
      client_secret_expires_at INTEGER,
      registered_at INTEGER NOT NULL,
      used_at INTEGER NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_client_bindings (
      key_hash TEXT NOT NULL,
      client_id TEXT NOT NULL,
      issuer TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      PRIMARY KEY (key_hash, client_id)
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_pending_sign_ins (
      key_hash TEXT PRIMARY KEY,
      state_hash TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      issuer TEXT NOT NULL,
      metadata TEXT NOT NULL,
      client TEXT NOT NULL,
      sealed_verifier TEXT NOT NULL,
      scope TEXT,
      resource TEXT,
      step_up INTEGER NOT NULL DEFAULT 0,
      requester TEXT,
      return_path TEXT,
      awaiting_confirmation INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE mcp_sign_in_waiters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL,
      session TEXT NOT NULL,
      request TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE (session, request)
    ) STRICT`);
    sql.exec("CREATE INDEX mcp_sign_in_waiters_by_key ON mcp_sign_in_waiters (key_hash)");
  },
  // 31: whether a Session import still fills a Session (`docs/architecture/mcp-endpoint.md` → Session import): 1 from the
  // Session's creation as an import until the import ends, 0 for every other, all of those stored before. The open imports
  // per identity are counted from it, and `sessions_list` shows the Session `importing` meanwhile.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN importing INTEGER NOT NULL DEFAULT 0");
  },
  // 32: each Environment's Repos' `.pi/mcp.json`, as last looked at on the default branch (ADR-0029,
  // `docs/architecture/mcp-configuration.md` → A Repo's `.pi/mcp.json`), one row per (Environment, Repo directory). `state`
  // is what the look found (`read`, `absent`, `oversize`, `unreadable`, `not_github`); `text` is the last good copy, which
  // `unreadable` keeps; `failing_since` is when the run of failed looks began. A row goes with its Repo and its Environment.
  // None before: a Repo not looked at yet adds no server.
  (sql) => {
    sql.exec(`CREATE TABLE mcp_repo_files (
      environment TEXT NOT NULL,
      repo TEXT NOT NULL,
      slug TEXT,
      state TEXT NOT NULL,
      blob TEXT,
      text TEXT,
      size INTEGER,
      read_at INTEGER,
      looked_at INTEGER NOT NULL,
      error TEXT,
      failing_since INTEGER,
      PRIMARY KEY (environment, repo)
    ) STRICT`);
  },
  // 33: how many MCP tasks a Session follows in the background, as it last reported them (`docs/architecture/
  // mcp-server-requests.md` → MCP tasks, Following, not running): the Session list's "Following n MCP tasks". Null for
  // every Session stored before, until it next settles and reports.
  (sql) => {
    sql.exec("ALTER TABLE sessions ADD COLUMN mcp_tasks INTEGER");
  },
  // 34: Triggers (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047), each a definition at a
  // `revision` every change raises: its `kind` and the Environment it belongs to (fixed at creation), its name, Trigger
  // message, `source` (JSON `TriggerSource`), `when_busy`, the options `base`, `model` and `thinking` (null: the
  // default), and `paused`. `removed_at` keeps a removal the agent made, while its Agent change can bring it back;
  // `last_session` is the last Fire's Session, which overlap looks at. A Trigger goes with its Environment. None before.
  (sql) => {
    sql.exec(`CREATE TABLE triggers (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      environment TEXT NOT NULL,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      source TEXT NOT NULL,
      when_busy TEXT NOT NULL,
      base TEXT,
      model TEXT,
      thinking TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      removed_at INTEGER,
      last_session TEXT
    ) STRICT`);
    sql.exec("CREATE INDEX triggers_by_environment ON triggers (environment)");
  },
  // 35: the Workspace a Workspace trigger is kept for (`docs/architecture/triggers.md` → Kinds and what a Fire delivers
  // to), which it keeps: the Workspace's record is deleted only while no Session and no active Trigger is bound to it.
  // Null for every Trigger stored before, and for Environment triggers.
  (sql) => {
    sql.exec("ALTER TABLE triggers ADD COLUMN workspace TEXT");
    sql.exec("CREATE INDEX triggers_by_workspace ON triggers (workspace)");
  },
];

/** Migrate the tables and return the store over them. Run it from the object's constructor. */
export const openRegistryStore = (storage: RegistryStorage): RegistryStore => {
  migrate(storage, MIGRATIONS);

  const { sql } = storage;

  const getEnvironment = (id: string): EnvironmentRecord | null => {
    const [row] = sql.exec<EnvironmentRow>("SELECT * FROM environments WHERE id = ?", id).toArray();

    return row === undefined ? null : toEnvironment(row);
  };

  /**
   * Whether an Environment other than `id` is named `name`, whatever the case. The names are compared here, folded as
   * the web app folds them (`toLowerCase`), since the index's `NOCASE` folds only ASCII letters; there are few.
   */
  const nameTaken = (name: string, id: string): boolean => {
    const folded = name.toLowerCase();

    return Arr.some(
      sql.exec<{ name: string }>("SELECT name FROM environments WHERE id != ?", id).toArray(),
      (row) => row.name.toLowerCase() === folded,
    );
  };

  /** Workspace `id`'s row, a spare's too. */
  const getWorkspaceRow = (id: string): WorkspaceRow | undefined =>
    sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id).toArray()[0];

  const getSpareRow = (environment: string): WorkspaceRow | undefined =>
    sql
      .exec<WorkspaceRow>(
        "SELECT * FROM workspaces WHERE environment = ? AND spare = 1",
        environment,
      )
      .toArray()[0];

  const toSetup = (row: WorkspaceRow): WorkspaceSetup => ({
    id: row.id,
    environment: row.environment,
    branch: row.branch,
    base: row.base,
    repos: decodeRepos(row.repos),
  });

  const getSession = (id: string): SessionRecord | null => {
    const [row] = sql.exec<SessionRow>("SELECT * FROM sessions WHERE id = ?", id).toArray();

    return row === undefined ? null : toSession(row);
  };

  const writeRepos = (environment: string, repos: ReadonlyArray<EnvironmentRepo>) => {
    sql.exec("UPDATE environments SET repos = ? WHERE id = ?", JSON.stringify(repos), environment);
  };

  /**
   * Register a new Workspace of `choice`'s Environment, inside the caller's transaction: its spare when the spare holds
   * the Environment's Repos (it stops being spare and gets the branch and base), else one under `choice.id`. Answers the
   * Workspace's id and Environment, or why it was refused.
   */
  const registerWorkspace = (
    choice: Extract<StoredWorkspaceChoice, { kind: "new" }>,
    now: number,
  ):
    | { readonly workspace: string; readonly environment: string }
    | Extract<SessionRefusal, { refused: "no-environment" | "branch-taken" }> => {
    const made = getEnvironment(choice.environment);

    if (made === null) return { refused: "no-environment" };

    // The spare is taken only while it holds the Environment's Repos; a stale one is left to be removed.
    const spare = getSpareRow(made.id);

    const taking =
      spare !== undefined && sameRepos(decodeRepos(spare.repos), made.repos) ? spare : undefined;

    const workspace = taking?.id ?? choice.id;
    const branch = choice.branch ?? `cloudpid/${workspace}`;

    const [taken] = sql
      .exec<{ id: string }>(
        "SELECT id FROM workspaces WHERE environment = ? AND branch = ?",
        choice.environment,
        branch,
      )
      .toArray();

    if (taken !== undefined) return { refused: "branch-taken", workspace: taken.id };

    if (taking === undefined) {
      sql.exec(
        "INSERT INTO workspaces (id, environment, branch, base, repos, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        workspace,
        made.id,
        branch,
        choice.base,
        JSON.stringify(made.repos),
        now,
      );
    } else {
      sql.exec(
        "UPDATE workspaces SET spare = 0, branch = ?, base = ?, created_at = ? WHERE id = ?",
        branch,
        choice.base,
        now,
        workspace,
      );
    }

    return { workspace, environment: made.id };
  };

  const subagentWorkspaceRows = (session: string): WorkspaceRow[] =>
    sql
      .exec<WorkspaceRow>(
        "SELECT * FROM workspaces WHERE session = ? ORDER BY created_at DESC, id",
        session,
      )
      .toArray();

  /**
   * The Session registered for `requestId` less than `REQUEST_MEMORY_MS` ago, if it is still there. Rows past the memory
   * are dropped as they are found, so the table holds a day of starts.
   */
  const requestedSession = (requestId: string, now: number): SessionRecord | null => {
    sql.exec("DELETE FROM session_requests WHERE at <= ?", now - REQUEST_MEMORY_MS);

    const row = sql
      .exec<{ session: string }>(
        "SELECT session FROM session_requests WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];

    return row === undefined ? null : getSession(row.session);
  };

  /** How many Sessions marked `import` by `auth` are still importing. */
  const openImports = (auth: string): number => {
    const [row] = sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE origin_kind = 'import' AND importing = 1 AND json_extract(origin, '$.auth') = ?`,
        auth,
      )
      .toArray();

    return row?.count ?? 0;
  };

  /**
   * How many Sessions the MCP endpoint started or imported are running: those the Registry has as anything but idle (a
   * status this build does not know may be one that runs, so a start never passes the cap on it), and those it made less
   * than `STARTING_MS` ago whose first Run has not reported yet (still idle, status never changed). Archived ones are
   * stopped, so they never count.
   */
  const runningMarked = (now: number): number => {
    const [row] = sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE origin_kind IN ('mcp', 'import') AND archived_at IS NULL
            AND (status != 'idle' OR (${STILL_STARTING} AND created_at > ?))`,
        now - STARTING_MS,
      )
      .toArray();

    return row?.count ?? 0;
  };

  return {
    requestedSession,

    createSession: (input, now) =>
      storage.transactionSync((): CreatedSession | SessionRefusal => {
        const { requestId } = input;

        if (requestId !== undefined) {
          const earlier = requestedSession(requestId, now);

          if (earlier !== null) return { ...earlier, repeated: true };
        }

        // Checked before anything is registered: a refusal returned from here does not roll a transaction back.
        if (input.maxRunning !== undefined && runningMarked(now) >= input.maxRunning) {
          return { refused: "too-many-running", limit: input.maxRunning };
        }

        const open = input.maxOpenImports;

        if (
          open !== undefined &&
          input.marks?.kind === "import" &&
          openImports(open.auth) >= open.limit
        ) {
          return { refused: "too-many-imports", limit: open.limit };
        }

        const choice = input.workspace;
        let environment: string;

        let workspace = choice.id;

        if (choice.kind === "existing") {
          const known = getWorkspaceRow(choice.id);

          // A spare, or a subagent's Workspace, is no Workspace a Session can name.
          if (known === undefined || known.spare === 1 || known.session !== null) {
            return { refused: "no-workspace" };
          }

          environment = known.environment;
        } else {
          const registered = registerWorkspace(choice, now);

          if ("refused" in registered) return registered;

          ({ workspace, environment } = registered);
        }

        const origin = input.origin ?? null;
        const marks = input.marks ?? null;

        sql.exec(
          "INSERT INTO sessions (id, title, title_source, environment, workspace, status, created_at, updated_at, origin, origin_kind, importing) VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)",
          input.id,
          input.title,
          input.title === null ? null : "owner",
          environment,
          workspace,
          now,
          now,
          ...originColumns(origin, marks),
          marks?.kind === "import" ? 1 : 0,
        );

        if (requestId !== undefined) {
          sql.exec(
            "INSERT OR REPLACE INTO session_requests (request_id, session, at) VALUES (?, ?, ?)",
            requestId,
            input.id,
            now,
          );
        }

        const record: SessionRecord = {
          id: input.id,
          title: input.title,
          titleSource: input.title === null ? null : "owner",
          environment,
          workspace,
          status: "idle",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };

        const created: Types.Mutable<SessionRecord> = record;

        if (origin !== null) created.origin = origin;

        if (marks !== null) created.marks = marks;

        if (marks?.kind === "import") created.importing = true;

        return created;
      }),

    getSession,

    createSubagentWorkspace: (input, now) =>
      storage.transactionSync((): WorkspaceRecord | SubagentWorkspaceRefusal => {
        const [had] = sql
          .exec<WorkspaceRow>(
            "SELECT * FROM workspaces WHERE session = ? AND subagent = ?",
            input.session,
            input.agent,
          )
          .toArray();

        if (had !== undefined) return toWorkspace(had);

        const session = getSession(input.session);

        if (session === null) return { refused: "no-session" };

        const count = subagentWorkspaceRows(input.session).length;

        if (count >= input.limit) return { refused: "limit", count };

        const registered = registerWorkspace(
          {
            kind: "new",
            id: input.id,
            environment: session.environment,
            branch: input.branch,
            base: input.base,
          },
          now,
        );

        // The Session's Environment is there while the Session is: only a branch is refused.
        if ("refused" in registered) {
          return registered.refused === "branch-taken" ? registered : { refused: "no-session" };
        }

        sql.exec(
          "UPDATE workspaces SET session = ?, subagent = ? WHERE id = ?",
          input.session,
          input.agent,
          registered.workspace,
        );

        // SAFETY: the row was written above, in this transaction.
        return toWorkspace(getWorkspaceRow(registered.workspace)!);
      }),

    listSubagentWorkspaces: (session) => Arr.map(subagentWorkspaceRows(session), toWorkspace),

    listSessions: () =>
      Arr.map(
        sql.exec<SessionRow>("SELECT * FROM sessions ORDER BY created_at DESC, id DESC").toArray(),
        toSession,
      ),

    setSessionStatus: (id, status, now) => {
      checkedStatus(status);
      sql.exec(
        "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND status != ?",
        status,
        now,
        id,
        status,
      );
    },

    endSessionImport: (id) => {
      sql.exec("UPDATE sessions SET importing = 0 WHERE id = ?", id);
    },

    setSessionAgents: (id, agents) => {
      sql.exec("UPDATE sessions SET agents = ? WHERE id = ?", JSON.stringify(agents), id);
    },

    setSessionMcpTasks: (id, count) => {
      sql.exec("UPDATE sessions SET mcp_tasks = ? WHERE id = ?", count, id);
    },

    renameSession: (id, title) => {
      sql.exec("UPDATE sessions SET title = ?, title_source = 'owner' WHERE id = ?", title, id);

      return getSession(id);
    },

    archiveSession: (id, now) => {
      sql.exec("UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL", now, id);

      return getSession(id);
    },

    unarchiveSession: (id) => {
      sql.exec("UPDATE sessions SET archived_at = NULL WHERE id = ?", id);

      return getSession(id);
    },

    deleteSession: (id) => sql.exec("DELETE FROM sessions WHERE id = ?", id).rowsWritten > 0,

    setGeneratedTitle: (id, title) =>
      sql.exec(
        "UPDATE sessions SET title = ?, title_source = 'generated' WHERE id = ? AND title_source IS NULL",
        title,
        id,
      ).rowsWritten > 0,

    createEnvironment: (id, name, now) => {
      if (nameTaken(name, id) || getEnvironment(id) !== null) return { status: "taken" };

      sql.exec(
        "INSERT INTO environments (id, name, repos, settings, created_at) VALUES (?, ?, '[]', '{}', ?)",
        id,
        name,
        now,
      );

      return { status: "named", environment: { id, name, repos: [], createdAt: now } };
    },

    getEnvironment,

    listEnvironments: () =>
      Arr.map(
        sql
          .exec<EnvironmentRow>("SELECT * FROM environments ORDER BY created_at DESC, id")
          .toArray(),
        toEnvironment,
      ),

    renameEnvironment: (id, name) => {
      const known = getEnvironment(id);

      if (known === null) return { status: "missing" };

      if (nameTaken(name, id)) return { status: "taken" };

      sql.exec("UPDATE environments SET name = ? WHERE id = ?", name, id);

      return { status: "named", environment: { ...known, name } };
    },

    deleteEnvironment: (id) => {
      if (id === DEFAULT_ENVIRONMENT) return "refused";

      if (getEnvironment(id) === null) return "missing";

      if (
        sql.exec("SELECT 1 FROM workspaces WHERE environment = ? LIMIT 1", id).toArray().length > 0
      ) {
        return "in-use";
      }

      sql.exec("DELETE FROM environments WHERE id = ?", id);
      // Its Secrets go with it; those kept Global stay. So do its Agent changes and its Skills, and the
      // texts of their files that nothing else refers to.
      sql.exec("DELETE FROM environment_secrets WHERE scope = ?", id);
      sql.exec("DELETE FROM agent_changes WHERE scope = ?", id);
      sql.exec("DELETE FROM skills WHERE scope = ?", id);
      sql.exec("DELETE FROM mcp_repo_files WHERE environment = ?", id);
      // Its Triggers go with it; their objects heal at their next touch (`docs/architecture/triggers.md` → Cascades).
      sql.exec("DELETE FROM triggers WHERE environment = ?", id);
      dropUnreferencedSkillFiles(sql);

      return "deleted";
    },

    addRepo: (environment, repo) =>
      storage.transactionSync((): RepoChange => {
        const known = getEnvironment(environment);

        if (known === null) return "missing";

        if (Arr.some(known.repos, (held) => held.name === repo.name)) return "taken";

        writeRepos(environment, [...known.repos, { name: repo.name, url: repo.url }]);

        return "changed";
      }),

    removeRepo: (environment, name) =>
      storage.transactionSync((): RepoChange => {
        const known = getEnvironment(environment);

        if (known === null) return "missing";

        if (!Arr.some(known.repos, (held) => held.name === name)) return "absent";

        writeRepos(
          environment,
          Arr.filter(known.repos, (held) => held.name !== name),
        );
        // What was read of its `.pi/mcp.json` goes with it: its servers are no longer in the set.
        sql.exec(
          "DELETE FROM mcp_repo_files WHERE environment = ? AND repo = ?",
          environment,
          name,
        );

        return "changed";
      }),

    getMcpRepoFiles: (environment) =>
      Arr.map(
        sql
          .exec<McpRepoFileRow>("SELECT * FROM mcp_repo_files WHERE environment = ?", environment)
          .toArray(),
        toMcpRepoFile,
      ),

    putMcpRepoFile: (record) => {
      sql.exec(
        `INSERT OR REPLACE INTO mcp_repo_files
           (environment, repo, slug, state, blob, text, size, read_at, looked_at, error, failing_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.environment,
        record.repo,
        record.slug,
        record.state,
        record.blob,
        record.text,
        record.size,
        record.readAt,
        record.lookedAt,
        record.error,
        record.failingSince,
      );
    },

    getEnvironmentSettings: (environment) => {
      const [row] = sql
        .exec<{ settings: string }>("SELECT settings FROM environments WHERE id = ?", environment)
        .toArray();

      return row === undefined ? null : settingsOverrides(row.settings);
    },

    putEnvironmentSettings: (environment, overrides) =>
      sql.exec(
        "UPDATE environments SET settings = ? WHERE id = ?",
        JSON.stringify(overrides),
        environment,
      ).rowsWritten > 0,

    getSettingsOverrides: (environment) => {
      const [row] = sql
        .exec<{ settings_overrides: string | null }>(
          "SELECT settings_overrides FROM environments WHERE id = ?",
          environment,
        )
        .toArray();

      return row === undefined ? null : savedSettingsOverrides(row.settings_overrides);
    },

    putSettingsOverrides: (environment, overrides) =>
      sql.exec(
        "UPDATE environments SET settings_overrides = ? WHERE id = ?",
        JSON.stringify(overrides),
        environment,
      ).rowsWritten > 0,

    getEnvironmentInstructions: (environment) => {
      const [row] = sql
        .exec<{ name: string; instructions: string }>(
          "SELECT name, instructions FROM environments WHERE id = ?",
          environment,
        )
        .toArray();

      return row === undefined ? null : { name: row.name, text: row.instructions };
    },

    putEnvironmentInstructions: (environment, text) =>
      sql.exec("UPDATE environments SET instructions = ? WHERE id = ?", text, environment)
        .rowsWritten > 0,

    listSettingsOverrides: () =>
      Arr.map(
        sql
          .exec<{ id: string; name: string; settings_overrides: string }>(
            `SELECT id, name, settings_overrides FROM environments
             WHERE settings_overrides IS NOT NULL ORDER BY created_at DESC, id`,
          )
          .toArray(),
        (row) => ({
          id: row.id,
          name: row.name,
          overrides: savedSettingsOverrides(row.settings_overrides),
        }),
      ),

    getBuild: (environment) => {
      const [row] = sql
        .exec<Pick<EnvironmentRow, "build" | "build_status">>(
          "SELECT build, build_status FROM environments WHERE id = ?",
          environment,
        )
        .toArray();

      return row === undefined ? null : toBuild(row);
    },

    putBuild: (environment, { build, status }) =>
      sql.exec(
        "UPDATE environments SET build = ?, build_status = ? WHERE id = ?",
        build === null ? null : JSON.stringify(build),
        status === null ? null : JSON.stringify(status),
        environment,
      ).rowsWritten > 0,

    listBuilds: () =>
      Arr.map(
        sql
          .exec<Pick<EnvironmentRow, "id" | "build" | "build_status">>(
            "SELECT id, build, build_status FROM environments ORDER BY created_at DESC, id",
          )
          .toArray(),
        (row) => ({ environment: row.id, ...toBuild(row) }),
      ),

    getWorkspace: (id) => {
      const row = getWorkspaceRow(id);

      return row === undefined || row.spare === 1 ? null : toWorkspace(row);
    },

    getWorkspaceSetup: (id) => {
      const row = getWorkspaceRow(id);

      return row === undefined ? null : toSetup(row);
    },

    listWorkspaces: () =>
      Arr.map(
        sql
          .exec<WorkspaceRow>(
            "SELECT * FROM workspaces WHERE spare = 0 ORDER BY created_at DESC, id",
          )
          .toArray(),
        toWorkspace,
      ),

    upkeepSpares: (environments, newId, now, global) =>
      storage.transactionSync((): SpareUpkeep => {
        const stale: string[] = [];
        const made: SpareSetup[] = [];

        const kept = Arr.filter(
          sql
            .exec<EnvironmentRow>("SELECT * FROM environments ORDER BY created_at DESC, id")
            .toArray(),
          (row) => environments === undefined || environments.includes(row.id),
        );

        for (const row of kept) {
          const environment = toEnvironment(row);
          const { build } = toBuild(row);
          const snapshot = build?.snapshot.id ?? null;
          const spare = getSpareRow(environment.id);

          // Its Sessions' last use: made, or their status last changed.
          const lastSessionAt = sql
            .exec<{ at: number | null }>(
              "SELECT MAX(updated_at) AS at FROM sessions WHERE environment = ?",
              environment.id,
            )
            .one().at;

          const hadRecentSession =
            lastSessionAt !== null && now - lastSessionAt <= SPARE_REFILL_WINDOW_MS;

          // Read leniently, as every reader of the settings does: an Override that does not resolve inherits Global's.
          const spareOn = resolveEnvironmentContainerSettings(
            global,
            resolveContainerOverridesLeniently(settingsOverrides(row.settings)).overrides,
          ).spareWorkspace;

          // Turned off: the spare it has is removed, however current, and none is made.
          if (!spareOn) {
            if (spare !== undefined) stale.push(spare.id);

            continue;
          }

          if (spare !== undefined) {
            const reposCurrent = sameRepos(decodeRepos(spare.repos), environment.repos);

            // A spare of another Build is still taken, so one nobody uses keeps it rather than make another.
            if (!reposCurrent || (hadRecentSession && spare.spare_build !== snapshot)) {
              stale.push(spare.id);
            }

            continue;
          }

          if (!hadRecentSession) continue;

          // Eight hex digits rarely collide; one that does is drawn again.
          let id = newId();

          while (getWorkspaceRow(id) !== undefined) id = newId();

          sql.exec(
            "INSERT INTO workspaces (id, environment, branch, base, repos, created_at, spare, spare_build) VALUES (?, ?, ?, NULL, ?, ?, 1, ?)",
            id,
            environment.id,
            SPARE_BRANCH,
            JSON.stringify(environment.repos),
            now,
            snapshot,
          );
          made.push({
            id,
            environment: environment.id,
            branch: SPARE_BRANCH,
            base: null,
            repos: environment.repos,
            build,
          });
        }

        return { stale, made };
      }),

    getSpare: (environment) => getSpareRow(environment)?.id ?? null,

    forgetSpare: (id) =>
      sql.exec("DELETE FROM workspaces WHERE id = ? AND spare = 1", id).rowsWritten > 0,

    deleteWorkspace: (id, triggers = "keep") =>
      storage.transactionSync((): Deletion => {
        if (getWorkspaceRow(id) === undefined) return "missing";

        if (
          sql.exec("SELECT 1 FROM sessions WHERE workspace = ? LIMIT 1", id).toArray().length > 0
        ) {
          return "in-use";
        }

        // A Workspace trigger keeps its Workspace (`docs/architecture/triggers.md` → Kinds and what a Fire delivers to).
        if (
          triggers === "keep" &&
          sql
            .exec("SELECT 1 FROM triggers WHERE workspace = ? AND removed_at IS NULL LIMIT 1", id)
            .toArray().length > 0
        ) {
          return "in-use";
        }

        sql.exec("DELETE FROM triggers WHERE workspace = ?", id);
        sql.exec("DELETE FROM workspaces WHERE id = ?", id);

        return "deleted";
      }),

    takeLegacy: (limit, now, leaseMs) =>
      storage.transactionSync(() => {
        const taken = sql
          .exec<LegacyObject>(
            "SELECT kind, id FROM legacy WHERE taken_at IS NULL OR taken_at <= ? ORDER BY kind DESC, id LIMIT ?",
            now - leaseMs,
            limit,
          )
          .toArray();

        for (const object of taken) {
          sql.exec(
            "UPDATE legacy SET taken_at = ? WHERE kind = ? AND id = ?",
            now,
            object.kind,
            object.id,
          );
        }

        return Arr.map(taken, ({ kind, id }) => ({ kind, id }));
      }),

    forgetLegacy: ({ kind, id }) => {
      sql.exec("DELETE FROM legacy WHERE kind = ? AND id = ?", kind, id);
    },

    listEnvironmentSecrets: () =>
      Arr.map(
        sql
          .exec<EnvironmentSecretRow>(
            "SELECT * FROM environment_secrets ORDER BY scope != ?, scope, name",
            GLOBAL_SCOPE,
          )
          .toArray(),
        toSecretRecord,
      ),

    getEnvironmentSecrets: (environment) =>
      Arr.map(
        sql
          .exec<EnvironmentSecretRow>(
            "SELECT * FROM environment_secrets WHERE scope IN (?, ?) ORDER BY scope != ?, name",
            GLOBAL_SCOPE,
            environment,
            GLOBAL_SCOPE,
          )
          .toArray(),
        (row) => ({
          ...toSecretRecord(row),
          sealed: { version: 1, iv: row.iv, ciphertext: row.ciphertext },
        }),
      ),

    putEnvironmentSecret: ({ environment, name, sealed, build }, now) =>
      storage.transactionSync((): SecretPut => {
        if (environment !== null && getEnvironment(environment) === null) return "missing";

        const scope = scopeOf(environment);

        const [known] = sql
          .exec<EnvironmentSecretRow>(
            "SELECT * FROM environment_secrets WHERE scope = ? AND name = ?",
            scope,
            name,
          )
          .toArray();

        if (known === undefined) {
          const [count] = sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM environment_secrets WHERE scope = ?",
              scope,
            )
            .toArray();

          if ((count?.count ?? 0) >= MAX_ENVIRONMENT_SECRETS) return "full";
        }

        const flag = build ?? known?.build === 1;

        sql.exec(
          "INSERT OR REPLACE INTO environment_secrets (scope, name, iv, ciphertext, build, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          scope,
          name,
          sealed.iv,
          sealed.ciphertext,
          flag ? 1 : 0,
          now,
        );

        return { environment, name, build: flag, updatedAt: now };
      }),

    setEnvironmentSecretBuild: (environment, name, build, now) => {
      const written = sql.exec(
        "UPDATE environment_secrets SET build = ?, updated_at = ? WHERE scope = ? AND name = ?",
        build ? 1 : 0,
        now,
        scopeOf(environment),
        name,
      ).rowsWritten;

      return written > 0 ? { environment, name, build, updatedAt: now } : null;
    },

    deleteEnvironmentSecret: (environment, name) =>
      sql.exec(
        "DELETE FROM environment_secrets WHERE scope = ? AND name = ?",
        scopeOf(environment),
        name,
      ).rowsWritten > 0,

    getDocument: (name) => {
      const [row] = sql
        .exec<{ body: string }>("SELECT body FROM documents WHERE name = ?", name)
        .toArray();

      return row === undefined ? null : row.body;
    },

    putDocument: (name, body, now) => {
      sql.exec(
        "INSERT OR REPLACE INTO documents (name, body, updated_at) VALUES (?, ?, ?)",
        name,
        body,
        now,
      );
    },

    putPushSubscription: ({ endpoint, keys }, now) => {
      sql.exec(
        "INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)",
        endpoint,
        keys.p256dh,
        keys.auth,
        now,
      );
    },

    deletePushSubscription: (endpoint) => {
      sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
    },

    hasPushSubscription: (endpoint) =>
      sql.exec("SELECT 1 FROM push_subscriptions WHERE endpoint = ?", endpoint).toArray().length >
      0,

    listPushSubscriptions: () =>
      Arr.map(
        sql
          .exec<PushSubscriptionRow>(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at, endpoint",
          )
          .toArray(),
        ({ endpoint, p256dh, auth }) => ({ endpoint, keys: { p256dh, auth } }),
      ),
  };
};
