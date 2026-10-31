// The Registry operations (`docs/architecture/client-and-protocol.md`): listing and creating Sessions, Environments and
// Workspaces. They hold no stream, so they are an Effect `RpcGroup` over HTTP, served by the main Worker at `RPC_PATH`.
import { Settings, SettingsError, ContainerOverrides, ContainerSettings } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { EnvironmentSecretRecord, SecretName } from "./environment-secrets.ts";
import { BranchName, EnvironmentError, RepoName, WorkspaceId } from "./repo.ts";
import { Catalog, FileMatches, MAX_FILE_QUERY_LENGTH, TreePoint } from "./session.ts";
import {
  DirectorySkill,
  EnvironmentSkill,
  SkillChangeFiles,
  SkillDirectoryError,
  SkillDirectoryPage,
  SkillDirectoryPageNumber,
  SkillDirectoryView,
  SkillFile,
  SkillInstall,
  MAX_REPO_PART_LENGTH,
  SkillRepoError,
  SkillOwnerListing,
  SkillRepoListing,
  SkillViewAnswer,
  SkillSearchResult,
  SkillUpdate,
} from "./skills.ts";

/** Where the main Worker serves `RegistryRpcs`, with JSON serialization. */
export const RPC_PATH = "/rpc";

/** Whether a Session has a Run in progress. */
export const SessionStatus = Schema.Literals(["idle", "running"]);

export type SessionStatus = typeof SessionStatus.Type;

/** The longest title a Session may have. */
export const MAX_TITLE_LENGTH = 200;

/** A Session title: trimmed, then neither empty nor longer than `MAX_TITLE_LENGTH`. */
export const SessionTitle = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TITLE_LENGTH),
);

/** What a Session with no title is called where one is shown, and what a Fork or Clone of it is named after. */
export const UNTITLED_SESSION = "Untitled session";

/** Who gave a Session its title: the owner by naming it, or the `small` role's model after the first answer. */
export const TitleSource = Schema.Literals(["generated", "owner"]);

export type TitleSource = typeof TitleSource.Type;

/** An Environment's id: what its Workspaces and Sessions are bound to. New ones get eight hex digits. */
export const EnvironmentId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));

/** Where a Secret is kept (`docs/architecture/agent-capabilities.md` → Secrets): an Environment's id, or null at Global. */
export const SecretScope = Schema.NullOr(EnvironmentId);

/**
 * The scope of the Agent changes of the Secrets, variables and Skills kept Global (`docs/architecture/agent-changes.md`),
 * where an Environment's are kept under its id, and the scope the Skills kept Global
 * themselves are kept under (ADR-0026). No Environment id can be it.
 */
export const GLOBAL_SCOPE = "*";

/**
 * Whose Agent changes `listAgentChanges` lists and `revertAgentChange` reverts, and whose Skills `listEnvironmentSkills`,
 * `removeEnvironmentSkill` and `skillChangeFiles` answer, and into which `installEnvironmentSkills` installs: an
 * Environment's, or those of Global.
 */
export const AgentChangeScope = Schema.Union([EnvironmentId, Schema.Literal(GLOBAL_SCOPE)]);

/**
 * The Environment a Session is made in when it names none: it is there from the start, has no Repos until the owner
 * adds some, and cannot be deleted.
 */
export const DEFAULT_ENVIRONMENT = "default";

/** How a Session was made from another (GLOSSARY.md → Fork, Clone). */
export const ForkKind = Schema.Literals(["fork", "clone"]);

export type ForkKind = typeof ForkKind.Type;

/** The title of a `kind` of the Session titled `title` (none: untitled): its own with " (fork)" or " (clone)", cut to fit. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain function of two values.
export const forkTitle = (title: string | null, kind: ForkKind): string => {
  const suffix = ` (${kind})`;

  return `${(title ?? UNTITLED_SESSION).slice(0, MAX_TITLE_LENGTH - suffix.length).trimEnd()}${suffix}`;
};

/** The Session a Fork or Clone was made from, which may have been deleted since. */
export const SessionOrigin = Schema.Struct({ session: Schema.String, kind: ForkKind });

export type SessionOrigin = typeof SessionOrigin.Type;

/**
 * One of a Session's subagents as the Session list shows it (ADR-0024): a summary of its task graph's agent, which the
 * Session DO keeps in the Registry.
 */
export const SessionAgent = Schema.Struct({
  /** Its canonical ID, such as `agent-1` or `agent-1.reviewer`; unique among the Session's live subagents. */
  id: Schema.String,
  /** The agent that started it: `root` or another subagent's ID. */
  parent: Schema.String,
  /** The model role it was started with, if any. */
  role: Schema.NullOr(Schema.String),
  /** `working` while its conversation has live work, otherwise `idle`. */
  status: Schema.Literals(["working", "idle"]),
  /** The branch of the Subagent Workspace it works in; absent for one that works in the Session's Workspace. */
  branch: Schema.optionalKey(Schema.String),
});

export type SessionAgent = typeof SessionAgent.Type;

/** A Session as the Registry lists it. Times are epoch milliseconds. */
export const SessionRecord = Schema.Struct({
  /** The Session DO's name: a UUIDv7. Its socket is at `sessionSocketPath(id)`. */
  id: Schema.String,
  /** Null until the user or the title task gives it one. */
  title: Schema.NullOr(Schema.String),
  /**
   * Who set the title; null while there is none. A generated title is set at most once, and never replaces an owner's
   * (`docs/architecture/client-and-protocol.md` → Titles).
   */
  titleSource: Schema.NullOr(TitleSource),
  /** The id of the Environment the Session's Workspace was made from; it never changes. */
  environment: Schema.String,
  /** The id of the Workspace the Session works in (`WorkspaceRecord`); it never changes. */
  workspace: Schema.String,
  status: SessionStatus,
  createdAt: Schema.Finite,
  /** When the Session was created or its status last changed. */
  updatedAt: Schema.Finite,
  /** When the owner archived the Session (out of the Session list, read-only until unarchived), or null. */
  archivedAt: Schema.NullOr(Schema.Finite),
  /** The Session it is a Fork or Clone of; absent for a Session started afresh. */
  origin: Schema.optionalKey(SessionOrigin),
  /**
   * Its subagents, parents before their children, as the Session last reported them (ADR-0024); absent for a Session
   * that has not reported any since the field was added, which shows none.
   */
  agents: SessionAgent.pipe(Schema.Array, Schema.optionalKey),
});

export type SessionRecord = typeof SessionRecord.Type;

/** A Session the Registry does not know. */
export class SessionNotFound extends Schema.TaggedError<
  SessionNotFound,
  { readonly brand: unique symbol }
>()("SessionNotFound", {
  message: Schema.String,
}) {}

/** A Session action that reached the Session but did not finish there, such as stopping or wiping it. */
export class SessionActionError extends Schema.TaggedError<
  SessionActionError,
  { readonly brand: unique symbol }
>()("SessionActionError", {
  message: Schema.String,
}) {}

/**
 * A Workspace (ADR-0016): a working copy of an Environment, with its own clones of the Environment's Repos (as they
 * were when it was made), all on one branch, and a Container of its own. Its clones are made when a Session first works
 * in it.
 */
export const WorkspaceRecord = Schema.Struct({
  /** Eight lowercase hex digits (`WorkspaceId`). */
  id: Schema.String,
  /** The id of the Environment it was made from. */
  environment: Schema.String,
  /** The branch its clones work on: `cloudpid/<id>` unless the owner named one. It outlives the Workspace on the remote. */
  branch: Schema.String,
  /** The branch it was made from, when its own branch is new; null for each Repo's default branch. */
  base: Schema.NullOr(Schema.String),
  /** The Repos it holds, by directory name, below `/workspace`. */
  repos: Schema.Array(Schema.String),
  /** Where its Sessions work: its one repo's clone, or `/workspace` (`workspaceDirectory`). */
  directory: Schema.String,
  createdAt: Schema.Finite,
  /**
   * For a Subagent Workspace (GLOSSARY.md): the Session and the subagent (its canonical ID) it was made for. Absent for a
   * Workspace Sessions are started in.
   */
  subagent: Schema.optionalKey(Schema.Struct({ session: Schema.String, agent: Schema.String })),
});

export type WorkspaceRecord = typeof WorkspaceRecord.Type;

/**
 * What one clone of a Workspace holds that is not on the remote, or not known to be (`workspaceWork`): one whose clone
 * is missing or has another branch than the Workspace's checked out is listed too, as not set up.
 */
export const WorkspaceWork = Schema.Struct({
  repo: Schema.String,
  /** Uncommitted changes, untracked files that are not ignored included. */
  uncommitted: Schema.Finite,
  /** Commits of the Workspace's branch that no remote branch has. */
  unpushed: Schema.Finite,
  /** Why the clone is not known to hold the Workspace's work, in words (`not set up (on cloudpid/spare, not …)`). */
  unsettled: Schema.optionalKey(Schema.String),
});

export type WorkspaceWork = typeof WorkspaceWork.Type;

/** What `createSession` is told to make the Session a new Workspace. */
export const NEW_WORKSPACE = "new";

/** What `forkSession` is told to start the Fork or Clone in its source's Workspace. */
export const SAME_WORKSPACE = "same";

/** A Fork or Clone made (`forkSession`), with the owner's message to put back in its composer, if any. */
export const ForkedSession = Schema.Struct({
  session: SessionRecord,
  text: Schema.NullOr(Schema.String),
});

export type ForkedSession = typeof ForkedSession.Type;

/** The longest Environment name. */
export const MAX_ENVIRONMENT_NAME_LENGTH = 80;

/** An Environment name: trimmed, then neither empty nor longer than `MAX_ENVIRONMENT_NAME_LENGTH`. */
export const EnvironmentName = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ENVIRONMENT_NAME_LENGTH),
);

/** A Repo an Environment names: the address its Workspaces clone, and the directory they clone it into. */
export const EnvironmentRepo = Schema.Struct({
  /** The directory below `/workspace` (`RepoName`). */
  name: Schema.String,
  /** The `https` URL `git clone` gets (`parseRepoSource`). */
  url: Schema.String,
});

export type EnvironmentRepo = typeof EnvironmentRepo.Type;

/** An Environment as the Registry lists it. */
export const EnvironmentRecord = Schema.Struct({
  /** Its fixed identifier (`EnvironmentId`). */
  id: Schema.String,
  /** The owner's label for it, unique among Environments whatever the case. */
  name: Schema.String,
  /** Its Repos, in the order they were added. A Workspace made after a change holds the Repos as they are then. */
  repos: Schema.Array(EnvironmentRepo),
  createdAt: Schema.Finite,
});

export type EnvironmentRecord = typeof EnvironmentRecord.Type;

/** The most branches of one Repo the draft's Start from menu lists: the most recently committed to. */
export const MAX_REPO_BRANCHES = 100;

/** One branch of a Repo on its remote, for the draft's Start from menu. */
export const RemoteBranch = Schema.Struct({
  /** The branch's name, one a new Workspace may start from (`BranchName`). */
  name: Schema.String,
  /** When its head commit was made, in ms; null when GitHub did not say. */
  committedAt: Schema.NullOr(Schema.Finite),
});

export type RemoteBranch = typeof RemoteBranch.Type;

/** Why a Repo's branches are not listed: it is not on GitHub, GitHub refused the token, or anything else. */
export const RepoBranchesErrorKind = Schema.Literals(["no_github", "refused", "failed"]);

export type RepoBranchesErrorKind = typeof RepoBranchesErrorKind.Type;

/**
 * One Repo's branches on its remote (`draftBranches`): its default branch, and up to `MAX_REPO_BRANCHES` branches, most
 * recently committed to first, the default always among them; or why they are not listed.
 */
export const RepoBranches = Schema.Union([
  Schema.Struct({
    repo: Schema.String,
    status: Schema.Literal("ok"),
    defaultBranch: Schema.NullOr(Schema.String),
    branches: Schema.Array(RemoteBranch),
  }),
  Schema.Struct({
    repo: Schema.String,
    status: Schema.Literal("error"),
    kind: RepoBranchesErrorKind,
    message: Schema.String,
  }),
]);

export type RepoBranches = typeof RepoBranches.Type;

/**
 * Where an Environment's Build stands (`docs/architecture/container.md` → Builds): none made yet, one being made (with when the last good
 * one is from, which Workspaces start from meanwhile), the last good one (when it finished), or the last attempt failed
 * (why, when, and when the last good one is from, which stays in use).
 */
export const BuildView = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({
    status: Schema.Literal("building"),
    since: Schema.Finite,
    lastGoodAt: Schema.NullOr(Schema.Finite),
  }),
  Schema.Struct({ status: Schema.Literal("ready"), at: Schema.Finite }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.String,
    at: Schema.Finite,
    lastGoodAt: Schema.NullOr(Schema.Finite),
  }),
]);

export type BuildView = typeof BuildView.Type;

/** An Environment's Build, by the Environment's id. */
export const EnvironmentBuildState = Schema.Struct({
  environment: Schema.String,
  build: BuildView,
});

export type EnvironmentBuildState = typeof EnvironmentBuildState.Type;

/** An Environment as a Global setting's "overridden in" names it. */
export const OverridingEnvironment = Schema.Struct({ id: Schema.String, name: Schema.String });

export type OverridingEnvironment = typeof OverridingEnvironment.Type;

/**
 * The Global Settings in force, and the overrides saved over the defaults (`docs/architecture/overview.md` → Settings).
 */
export const SettingsState = Schema.Struct({
  settings: Settings,
  overrides: Schema.Json,
  /** Why the saved overrides were not used, when they no longer resolve: the settings are then the defaults. */
  problem: Schema.optionalKey(Schema.String),
  /**
   * By field (`@cloudpid/config` → `overrideFields`: `model`, `roles.small`, `extensions.<extension>.<key>`), the
   * Environments that override it, newest first, so a change at Global does nothing for them. A field none overrides
   * is left out.
   */
  overriddenIn: Schema.Record(Schema.String, Schema.Array(OverridingEnvironment)),
});

export type SettingsState = typeof SettingsState.Type;

/**
 * An Environment's Settings (ADR-0027): its Overrides, the fields set on purpose for it (a deep partial of the
 * settings, read field by field with `overrideFields`; a field it does not hold is inherited), Global's settings it
 * inherits, and the settings it resolves to, its Overrides over Global over the defaults.
 */
export const SettingsOverridesState = Schema.Struct({
  environment: Schema.String,
  /** The settings in force for the Environment's Sessions. */
  settings: Settings,
  /** The Global settings, what each field without an Override has. */
  global: Settings,
  overrides: Schema.Json,
  /** Why some saved Overrides were left out, when they no longer resolve: those fields inherit Global. */
  problem: Schema.optionalKey(Schema.String),
  /**
   * The Environment's own Instructions, empty for none: no Override, since they add up (ADR-0027). Its Sessions are
   * shown Global's (`settings.instructions`), then these.
   */
  instructions: Schema.String,
});

export type SettingsOverridesState = typeof SettingsOverridesState.Type;

/**
 * An Environment's Container settings in force (`docs/architecture/container.md` → Container settings, ADR-0027): its
 * Overrides over Global's. Each of its Workspaces applies them at its next Container launch.
 */
export const ContainerSettingsState = Schema.Struct({
  /** The settings in force: the Overrides over `global`, the variables merged by name. */
  settings: ContainerSettings,
  /** Global's Container settings in force: what a field without an Override inherits. */
  global: ContainerSettings,
  /**
   * The Environment's Overrides: exactly the fields set on purpose (a field here is Overridden, any other Inherited),
   * the variables name by name.
   */
  overrides: ContainerOverrides,
  /** Why the saved Overrides were only partly used, when some no longer resolve: those fields inherit Global's. */
  problem: Schema.optionalKey(Schema.String),
});

export type ContainerSettingsState = typeof ContainerSettingsState.Type;

/**
 * The Container settings at Global in force (`docs/architecture/container.md` → Container settings, ADR-0027), and what is
 * saved of them: what differs from the defaults. Every Workspace of an Environment that does not override a field
 * applies it at its next Container launch.
 */
export const GlobalContainerSettingsState = Schema.Struct({
  settings: ContainerSettings,
  overrides: ContainerOverrides,
  /**
   * The Environments that override each field, by the field's path as an Agent change names it (`idleMinutes`, and
   * `variables.<NAME>` for each variable): a field none overrides is left out.
   */
  overriddenIn: Schema.Record(Schema.String, Schema.Array(OverridingEnvironment)),
  /** Why the saved overrides were only partly used, when some no longer resolve: the rest still apply. */
  problem: Schema.optionalKey(Schema.String),
});

export type GlobalContainerSettingsState = typeof GlobalContainerSettingsState.Type;

/**
 * A change to a Scope's Container settings (ADR-0027): `set` merges into what is saved field by field, the variables
 * name by name; `reset` takes fields out by their path (`idleMinutes`, `variables.<NAME>`), which an Environment then
 * inherits from Global, and Global takes from the defaults. Fields neither names keep what they are.
 */
const ContainerPatchPayload = {
  set: Schema.optionalKey(Schema.Json),
  reset: Schema.String.pipe(Schema.Array, Schema.optionalKey),
};

const VARIABLE_FIELD = "variables.";

/** An Agent change's field for one of the variables: `variables.<NAME>`. Any other field is a setting's name. */
export const variableField = (name: string): string => `${VARIABLE_FIELD}${name}`;

/** The variable an Agent change's field names, or null for a field that is a setting's name. */
export const fieldVariable = (field: string): string | null =>
  field.startsWith(VARIABLE_FIELD) ? field.slice(VARIABLE_FIELD.length) : null;

/** How many Agent changes each scope keeps: the oldest go once there are more. */
export const MAX_AGENT_CHANGES = 200;

/**
 * The scope of the Settings' Agent changes, where an Environment's are kept under its id (`default`, or eight hex
 * digits). A change's `field` is then a settings field (`settingsFieldPath` in `@cloudpid/config`).
 */
export const SETTINGS_SCOPE = "settings";

/**
 * One Agent change (GLOSSARY.md → Agent change; `docs/architecture/agent-changes.md`): a change the agent made to an
 * Environment or to the Settings, or the owner's revert of one. `field` names what changed (`variableField` for a variable), and `before`
 * and `after` are its values then, null where it had none (a variable not set).
 */
export const AgentChange = Schema.Struct({
  /** Its number, which grows with each change in the Registry. */
  id: Schema.Finite,
  /** The Environment's id, or `GLOBAL_SCOPE` for a Secret, variable or Skill kept Global. */
  scope: Schema.String,
  at: Schema.Finite,
  /** Who made it: the agent, or the owner reverting an Agent change. */
  actor: Schema.Literals(["agent", "owner"]),
  /** The Session whose agent made it; null for the owner's. */
  session: Schema.NullOr(Schema.String),
  /** The conversation that called the tool, in that Session; null for the owner's. */
  conversation: Schema.NullOr(Schema.Finite),
  /** The tool that made it; null for the owner's. */
  tool: Schema.NullOr(Schema.String),
  /** Why: the agent's reason, or what the owner's revert undid. */
  reason: Schema.String,
  field: Schema.String,
  before: Schema.NullOr(Schema.Json),
  after: Schema.NullOr(Schema.Json),
  /**
   * Set on a change to an Environment's setting whose value before was inherited from Global, not an Override of its
   * own (`before` is then the value it inherited). Left out otherwise.
   */
  beforeInherited: Schema.optionalKey(Schema.Boolean),
  /** Set on a change that left an Environment's setting inherited from Global (a reset): `after` is what it inherits. */
  afterInherited: Schema.optionalKey(Schema.Boolean),
  /** The change this one reverted, for the owner's revert. */
  reverts: Schema.NullOr(Schema.Finite),
  /** The owner's revert of this change, once there is one. */
  revertedBy: Schema.NullOr(Schema.Finite),
  /**
   * Set on a change the owner approved before it was made (GLOSSARY.md → Approval): one to a Limit, or a kept Secret
   * deleted. Left out for every other change.
   */
  approved: Schema.optionalKey(Schema.Literal(true)),
});

export type AgentChange = typeof AgentChange.Type;

/** The hosts of the push services browsers use: Google's FCM, Mozilla's autopush, Apple's and Windows'. */
const PUSH_SERVICE_HOSTS: ReadonlyArray<(host: string) => boolean> = [
  (host) => host === "fcm.googleapis.com",
  (host) => host.endsWith(".push.services.mozilla.com"),
  (host) => host.endsWith(".push.apple.com"),
  (host) => host.endsWith(".notify.windows.com"),
];

/** `text` as a URL, or undefined when it is not one (`URL.canParse` is missing from Safari before 17). */
const parseUrl = (text: string): URL | undefined => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

/**
 * Whether `endpoint` is an `https:` URL at a known push service, with no credentials and no port of its own. The
 * Registry POSTs to every endpoint it keeps, so an address of anywhere else (loopback, an internal name) is refused.
 */
export const isPushServiceEndpoint = (endpoint: string): boolean => {
  const url = parseUrl(endpoint);

  return (
    url !== undefined &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    Arr.some(PUSH_SERVICE_HOSTS, (matches) => matches(url.hostname))
  );
};

/**
 * A browser's Web Push subscription, as `PushSubscription.toJSON()` gives it: the push service's endpoint and the keys
 * a message is encrypted to (RFC 8291). The endpoint must be at a known push service (`isPushServiceEndpoint`).
 */
export const PushSubscription = Schema.Struct({
  endpoint: Schema.String.check(
    Schema.isMaxLength(2048),
    Schema.makeFilter((endpoint: string) =>
      isPushServiceEndpoint(endpoint) ? undefined : "Not the endpoint of a known push service",
    ),
  ),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
    auth: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  }),
});

export type PushSubscription = typeof PushSubscription.Type;

/** What a browser needs to subscribe to Web Push, and whether the Registry holds its subscription. */
export const PushState = Schema.Struct({
  /** The deployment's VAPID public key (an uncompressed P-256 point, base64url): `applicationServerKey`. */
  publicKey: Schema.String,
  /** Whether the Registry holds a subscription with the asked `endpoint`; false when none was asked. */
  subscribed: Schema.Boolean,
});

export type PushState = typeof PushState.Type;

/** The path of Session `sessionId`'s page in the web app, which a notification opens. */
export const sessionPagePath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}`;

/** The path of Session `sessionId`'s socket on the main Worker. */
export const sessionSocketPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}/socket`;

export class RegistryRpcs extends RpcGroup.make(
  /** Every Session, newest first. */
  Rpc.make("listSessions", { success: Schema.Array(SessionRecord) }),
  /**
   * Register a new Session, idle, under a fresh UUIDv7, in a new Workspace of an Environment or in one that exists.
   * Fails with an `EnvironmentError` when the Environment or the Workspace is not listed, or the branch is taken.
   */
  Rpc.make("createSession", {
    payload: {
      title: Schema.optionalKey(SessionTitle),
      /** Defaults to `DEFAULT_ENVIRONMENT`, or the Workspace's when `workspace` names one (it must then be that one). */
      environment: Schema.optionalKey(EnvironmentId),
      /**
       * `NEW_WORKSPACE` (the default) makes the Session a new Workspace of the Environment; a `WorkspaceId` names one
       * that exists, which the Session then shares with the Sessions already in it.
       */
      workspace: Schema.optionalKey(Schema.Union([Schema.Literal(NEW_WORKSPACE), WorkspaceId])),
      /**
       * A new Workspace's branch: one a Repo's `origin` has is checked out, any other is made from `base`. Defaults to
       * `cloudpid/<id>`. A branch another Workspace of the Environment is on fails, since both would push to it.
       */
      branch: Schema.optionalKey(BranchName),
      /** The branch a new Workspace's own branch is made from, in each Repo. Defaults to each Repo's default branch. */
      base: Schema.optionalKey(BranchName),
    },
    success: SessionRecord,
    error: EnvironmentError,
  }),
  /**
   * Make a Fork or Clone of Session `source` (GLOSSARY.md → Fork, Clone): a new Session carrying its active branch up to
   * `point` (just `before` an owner's message, or through an entry: `at`), or, without one, as it is now (a Clone). It
   * starts in the source's Workspace, or in a new Workspace of its Environment that carries the source's files as they
   * are now, uncommitted Changes included, on `branch` (default `cloudpid/<id>`). Its title is `forkTitle`'s. A Clone is
   * refused while the active branch is busy, and a Fork or Clone in a new Workspace while anything of the source runs
   * (any branch, any subagent); the source then takes no message until the files are carried. Refused too while the
   * source is itself still being filled. Answered once the new Session holds what it carries; when anything fails,
   * nothing is made.
   */
  Rpc.make("forkSession", {
    payload: {
      source: Schema.String,
      point: Schema.optionalKey(TreePoint),
      workspace: Schema.optionalKey(Schema.Literals([SAME_WORKSPACE, NEW_WORKSPACE])),
      branch: Schema.optionalKey(BranchName),
    },
    success: ForkedSession,
    error: Schema.Union([SessionNotFound, SessionActionError, EnvironmentError]),
  }),
  /**
   * Name a Session. The title is the owner's from then on: the title task never replaces it. Fails with a
   * `SessionNotFound` when the Registry has no Session `id`.
   */
  Rpc.make("renameSession", {
    payload: { id: Schema.String, title: SessionTitle },
    success: SessionRecord,
    error: SessionNotFound,
  }),
  /**
   * Archive a Session: stop everything it runs (its root and every subagent), then take it out of the Session list.
   * It is kept whole and can be unarchived. Fails with a `SessionNotFound` when the Registry has no Session `id`, and
   * with a `SessionActionError` when the Session could not be stopped (it is then not archived).
   */
  Rpc.make("archiveSession", {
    payload: { id: Schema.String },
    success: SessionRecord,
    error: Schema.Union([SessionNotFound, SessionActionError]),
  }),
  /** Put an archived Session back in the Session list. */
  Rpc.make("unarchiveSession", {
    payload: { id: Schema.String },
    success: SessionRecord,
    error: SessionNotFound,
  }),
  /**
   * Delete a Session for good: stop everything it runs, close its browser and its clients' sockets, wipe its storage,
   * then forget it. Its Workspace stays, with the files it wrote, while another Session (archived too) is bound to it;
   * the last one's delete removes the Workspace too, with what was not committed or pushed. A `SessionActionError`
   * leaves the Session listed, to try again; a Workspace that cannot be removed is kept listed, for the owner to remove.
   */
  Rpc.make("deleteSession", {
    payload: { id: Schema.String },
    error: Schema.Union([SessionNotFound, SessionActionError]),
  }),
  /** All Environments, the default one included, newest first. */
  Rpc.make("listEnvironments", { success: Schema.Array(EnvironmentRecord) }),
  /** Make an Environment, with no Repos and the default Container settings. The name must be free, whatever the case. */
  Rpc.make("createEnvironment", {
    payload: { name: EnvironmentName },
    success: EnvironmentRecord,
    error: EnvironmentError,
  }),
  /** Name an Environment. Its id never changes. The name must be free among the others, whatever the case. */
  Rpc.make("renameEnvironment", {
    payload: { environment: EnvironmentId, name: EnvironmentName },
    success: EnvironmentRecord,
    error: EnvironmentError,
  }),
  /**
   * Delete an Environment for good: every Workspace made from it (each as `removeWorkspace`), its spare Workspace, its
   * Build object, then its record and the Secrets kept for it. The default Environment cannot be deleted. A failure
   * partway leaves what is not yet deleted listed, to try again.
   */
  Rpc.make("deleteEnvironment", {
    payload: { environment: EnvironmentId },
    error: EnvironmentError,
  }),
  /**
   * Add a Repo to an Environment: `source` is `owner/repo` or an `https` URL (`parseRepoSource`), cloned into
   * `/workspace/<name>` of each Workspace made from then on; `name` defaults to the repo's own. Nothing is cloned now:
   * a Workspace's first use clones, and reports git's message when it cannot. Answers the directory name.
   */
  Rpc.make("addRepo", {
    payload: {
      environment: EnvironmentId,
      source: Schema.String,
      name: Schema.optionalKey(RepoName),
    },
    success: RepoName,
    error: EnvironmentError,
  }),
  /** Take a Repo out of an Environment. Workspaces made before keep their clones of it. */
  Rpc.make("removeRepo", {
    payload: { environment: EnvironmentId, repo: RepoName },
    error: EnvironmentError,
  }),
  /**
   * An Environment's Container settings in force (size, idle time, Container-only paths, variables, Setup and Start
   * Scripts, Toolchains, Spare Workspace), its Overrides, and Global's settings it inherits the rest from.
   */
  Rpc.make("getEnvironmentSettings", {
    payload: { environment: EnvironmentId },
    success: ContainerSettingsState,
    error: EnvironmentError,
  }),
  /**
   * Set or reset an Environment's Container Overrides (`set`, `reset`: a field set is kept even when it equals
   * Global's; one reset inherits Global's again). Overrides that do not resolve, a size above the size limit, or more
   * than 50 variables with Global's fail with an `EnvironmentError` whose message lists each problem, and nothing is
   * saved. Each Workspace applies them at its next Container launch: a running Container keeps the settings it
   * started with.
   */
  Rpc.make("updateEnvironmentSettings", {
    payload: { environment: EnvironmentId, ...ContainerPatchPayload },
    success: ContainerSettingsState,
    error: EnvironmentError,
  }),
  /** The Container settings at Global in force, what is saved of them, and the Environments that override each field. */
  Rpc.make("getGlobalContainerSettings", { success: GlobalContainerSettingsState }),
  /**
   * Set or reset Container settings at Global (`set`, `reset`: a field reset takes the default again). Values that do
   * not resolve, a size above the size limit, or a change that would put an Environment that inherits it above its
   * size limit or past 50 variables fail with an `EnvironmentError` whose message lists each problem (naming those
   * Environments), and nothing is saved. Each Workspace of an Environment that inherits a field applies it at its next
   * Container start.
   */
  Rpc.make("updateGlobalContainerSettings", {
    payload: ContainerPatchPayload,
    success: GlobalContainerSettingsState,
    error: EnvironmentError,
  }),
  /**
   * Every Secret kept for an Environment or Global (`docs/architecture/agent-capabilities.md` → Secrets): names, scopes, build
   * flags and times, never a value.
   */
  Rpc.make("listEnvironmentSecrets", { success: Schema.Array(EnvironmentSecretRecord) }),
  /**
   * An Environment's Agent changes (`docs/architecture/agent-changes.md`), newest first: those of the last
   * `MAX_AGENT_CHANGES` the owner has not dismissed, the owner's reverts among them.
   */
  Rpc.make("listAgentChanges", {
    payload: { environment: AgentChangeScope },
    success: Schema.Array(AgentChange),
    error: EnvironmentError,
  }),
  /**
   * Revert Agent change `change` of `environment`: write its `before` value back, recorded as the owner's change, which
   * this answers. Refused with an `EnvironmentError` showing the value now when the field has changed since, and for a
   * change that is the owner's own revert. Each Workspace applies it at its next Container start, as any save.
   */
  Rpc.make("revertAgentChange", {
    payload: { environment: AgentChangeScope, change: Schema.Finite },
    success: AgentChange,
    error: EnvironmentError,
  }),
  /**
   * Dismiss Agent change `change` of `environment`: `listAgentChanges` no longer lists it. What it changed stays, and so
   * does its record. Fails with an `EnvironmentError` when `environment` has no such change.
   */
  Rpc.make("dismissAgentChange", {
    payload: { environment: AgentChangeScope, change: Schema.Finite },
    error: EnvironmentError,
  }),
  /**
   * The files before and after Agent change `change` of a Skill of `environment` (or of `*`, the Skills kept
   * Global; `docs/architecture/agent-changes.md`), with their texts, for the Skills page to show as diffs. Fails
   * with an `EnvironmentError` when the scope has no such change, or it is not a Skill's.
   */
  Rpc.make("skillChangeFiles", {
    payload: { environment: AgentChangeScope, change: Schema.Finite },
    success: SkillChangeFiles,
    error: EnvironmentError,
  }),
  /**
   * The Skills kept for an Environment, or Global (`*`; ADR-0026), by name, each with its description
   * and when it was saved.
   */
  Rpc.make("listEnvironmentSkills", {
    payload: { environment: AgentChangeScope },
    success: Schema.Array(EnvironmentSkill),
    error: EnvironmentError,
  }),
  /**
   * The files the Registry keeps for Skill `name` of an Environment, or of Global (`*`), with their texts, by
   * path: what the Skills page shows of a Skill with no Skill source. Fails with an `EnvironmentError` when the scope
   * keeps no Skill of the name.
   */
  Rpc.make("environmentSkillFiles", {
    payload: { environment: AgentChangeScope, name: Schema.String },
    success: Schema.Array(SkillFile),
    error: EnvironmentError,
  }),
  /**
   * Remove a Skill kept for an Environment, or Global (`*`): the owner's own save, with no Approval. Its
   * Workspaces stop serving it at their next readying (the Skill of the name kept Global, if any, is
   * served again). Fails with an `EnvironmentError` when the scope keeps no Skill of the name.
   */
  Rpc.make("removeEnvironmentSkill", {
    payload: { environment: AgentChangeScope, name: Schema.String },
    error: EnvironmentError,
  }),
  /**
   * Update Skills kept for an Environment, or Global (`*`), to the latest commit of each one's recorded ref
   * (ADR-0026): `names` the Skills (absent: every one marked update available), each fetched by the Registry as the GitHub
   * App and kept in place of itself with its new Skill source, unless the agent edited it (**modified**) and `overwrite` is
   * not set. The owner's own save: not an Agent change, no Approval, not revertible. Answers how each Skill went
   * (none when none is named and none is marked update available), and fails with an `EnvironmentError` when the
   * Environment is not there.
   */
  Rpc.make("updateEnvironmentSkills", {
    payload: {
      environment: AgentChangeScope,
      names: Schema.optionalKey(Schema.String.pipe(Schema.Array)),
      overwrite: Schema.optionalKey(Schema.Boolean),
    },
    success: SkillUpdate,
    error: EnvironmentError,
  }),
  /**
   * Install Skills for an Environment, or Global (`*`), from a GitHub `source` (`owner/repo`,
   * `owner/repo@skill`, or a GitHub URL: ADR-0026), fetched by the Registry as the GitHub App and pinned to the commit the
   * ref resolved to; each is kept with its Skill source, in place of one of its name, if it passes a save's checks (not an
   * Agent change, as an owner's save is not, and with no Approval for `*`: it is the owner's own). `skills`
   * names the Skills to take (`["*"]` for all of them); a repo that holds several and is given none installs nothing and
   * answers the list for the page to tick. `folders` (repo-relative paths, `""` for the repo's root) names the Skills by
   * the folder that holds each instead, which is exact where names are not (two folders can declare one name, a name can be
   * another folder's): exactly those folders are read, whatever the repo's other Skills are called, and the Skill source
   * kept records each folder; it names at least one. It is exclusive with `skills`. Fails with an `EnvironmentError` saying why (no such repo, a private one the
   * GitHub App cannot see, the rate limit, a source that is not GitHub's).
   */
  Rpc.make("installEnvironmentSkills", {
    payload: {
      environment: AgentChangeScope,
      source: Schema.String,
      skills: Schema.optionalKey(Schema.String.pipe(Schema.Array)),
      folders: Schema.optionalKey(
        Schema.String.pipe(
          Schema.Array,
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        ),
      ),
    },
    success: SkillInstall,
    error: EnvironmentError,
  }),
  /**
   * Search skills.sh for Skills (its undocumented `/api/search`): their ID, source and install count. Records nothing.
   * Fails with an `EnvironmentError` when skills.sh cannot be reached or answers otherwise; installing does not depend on it.
   */
  Rpc.make("searchSkills", {
    payload: { query: Schema.String },
    success: Schema.Array(SkillSearchResult),
    error: EnvironmentError,
  }),
  /**
   * One page of a Skill directory list (GLOSSARY.md → Skill directory): skills.sh's all-time, trending or hot leaderboard,
   * 200 rows a page from page 0, which the main Worker asks for and keeps about an hour. Each row says where its Skill is
   * installed here, matched by Skill source repo and path. Fails with a `SkillDirectoryError` when skills.sh cannot be
   * reached or answers otherwise; nothing else on the Skills page depends on it.
   */
  Rpc.make("listSkillDirectory", {
    payload: { view: SkillDirectoryView, page: SkillDirectoryPageNumber },
    success: SkillDirectoryPage,
    error: SkillDirectoryError,
  }),
  /**
   * Search the Skill directory (skills.sh's undocumented `/api/search`, fuzzy, at most 200 results) for `query`, each
   * result with where its Skill is installed here, as `listSkillDirectory`'s rows. Records nothing. Fails with a
   * `SkillDirectoryError` when the query is too short or long, or skills.sh cannot be reached or answers otherwise.
   */
  Rpc.make("searchSkillDirectory", {
    payload: { query: Schema.String },
    success: Schema.Array(DirectorySkill),
    error: SkillDirectoryError,
  }),
  /**
   * Every Skill GitHub has in repo `owner`/`repo` at `ref` (a branch, tag or commit; absent: the default branch's head),
   * as the walk an install uses finds them, read by the main Worker as the GitHub App with a read-only token, so a private
   * repo the app can read works and a repo skills.sh does not list does too. Each Skill has its description (from its
   * SKILL.md's frontmatter, kept by blob), its installs when skills.sh knows them, and where it is installed here, matched
   * by the repo and the Skill's folder. A repo with no Skills answers an empty list. Fails with a `SkillRepoError` when GitHub
   * gives no listing: no such repo or a private one the app cannot read, a ref the repo does not have, a refused token or the
   * rate limit.
   */
  Rpc.make("listRepoSkills", {
    payload: {
      owner: Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH)),
      repo: Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH)),
      ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH))),
    },
    success: SkillRepoListing,
    error: SkillRepoError,
  }),
  /**
   * The repos of `owner` (a GitHub user or organization) that the Skill directory (skills.sh) lists Skills of, grouped from
   * its search: each repo with the number of its Skills found and their installs added up, the most installed first. The
   * search is fuzzy and answers at most 200 results, so the list can be incomplete (`capped` says the limit was hit); a
   * repo the directory does not list is still opened on its own page, where GitHub gives the full list. An owner the
   * directory lists nothing of answers an empty list. Fails with a `SkillDirectoryError` when skills.sh cannot be reached
   * or does not answer as expected.
   */
  Rpc.make("listOwnerRepos", {
    payload: { owner: Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH)) },
    success: SkillOwnerListing,
    error: SkillDirectoryError,
  }),
  /**
   * One Skill of a GitHub repo as a Skill's page shows it: Skill `skill` of `owner`/`repo` at `ref` (a branch, tag or
   * commit; absent: the default branch's head), found by the rules an install by name uses (the same
   * SKILL.md files are read and the same test picks it: the name its SKILL.md gives, or its folder's name), or, with `path`, exactly the Skill in that folder of the repo (`""`: its root), whatever it is
   * called. It answers the SKILL.md (and the name the file has on GitHub) and the files an install would take, read at one commit by the main Worker as the
   * GitHub App with a read-only token (so a private repo the app can read works), with the Skill's installs when skills.sh
   * knows them and where it is installed here; or, when the name means several Skills and no `path` was given, every
   * Skill that answers to the name, where an install takes the first. Fails with a `SkillRepoError` as `listRepoSkills`
   * does, with kind `no_skill` when the repo has no such Skill, and with `too_many` when a name is asked of a repo with
   * more SKILL.md files than an install reads, none in a folder named so.
   */
  Rpc.make("viewSkill", {
    payload: {
      owner: Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH)),
      repo: Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH)),
      skill: Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH)),
      path: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH * 4))),
      ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_REPO_PART_LENGTH))),
    },
    success: SkillViewAnswer,
    error: SkillRepoError,
  }),
  /**
   * Keep a Secret for `environment` (null: Global), or replace the value of the one kept under `name`. The
   * value is sealed in the Registry and never comes back. `build` says whether it reaches the Environment's Build;
   * left out, a new Secret does not, and a replaced one keeps its flag. A value that is empty, holds a NUL or is over
   * `MAX_ENVIRONMENT_SECRET_BYTES`, an Environment that does not exist, or a scope already holding
   * `MAX_ENVIRONMENT_SECRETS` fails with an `EnvironmentError`. A Session takes it at its first use of Secrets 30 s or
   * more after it last asked, and hands it to its Workspace first.
   */
  Rpc.make("setEnvironmentSecret", {
    payload: {
      environment: SecretScope,
      name: SecretName,
      value: Schema.String,
      build: Schema.optionalKey(Schema.Boolean),
    },
    success: EnvironmentSecretRecord,
    error: EnvironmentError,
  }),
  /** Say whether a kept Secret reaches the Environment's Build (each Environment's, for one kept Global). */
  Rpc.make("setEnvironmentSecretBuild", {
    payload: { environment: SecretScope, name: SecretName, build: Schema.Boolean },
    success: EnvironmentSecretRecord,
    error: EnvironmentError,
  }),
  /**
   * Delete a kept Secret. A Session stops using it when it next asks (as for a new value); what a command already wrote
   * stays where it is.
   */
  Rpc.make("deleteEnvironmentSecret", {
    payload: { environment: SecretScope, name: SecretName },
    error: EnvironmentError,
  }),
  /** Where each Environment's Build stands (`docs/architecture/container.md` → Builds). */
  Rpc.make("listBuilds", { success: Schema.Array(EnvironmentBuildState) }),
  /**
   * Make the Environment's Build again now, whatever the last one was made from; one already being made is left to
   * finish. Fails with an `EnvironmentError` when the Environment does not exist or its Build could not be asked for.
   */
  Rpc.make("rebuildEnvironment", {
    payload: { environment: EnvironmentId },
    error: EnvironmentError,
  }),
  /** Every Workspace, of all Environments, newest first. */
  Rpc.make("listWorkspaces", { success: Schema.Array(WorkspaceRecord) }),
  /**
   * The draft composer's catalog, before there is a Session to ask (`docs/architecture/client-and-protocol.md` → Session list → New session): the
   * Prompt templates and Skills of the directory a Session made with `environment` and `workspace` would work in, as a
   * Session's `catalog` answers them, and no commands. A new Workspace is looked up in the Environment's spare
   * Workspace, the one a new Session takes; with no spare, the catalog is empty. Fails with an `EnvironmentError`
   * when the Environment or the Workspace is not listed, or the Workspace could not be asked.
   */
  Rpc.make("draftCatalog", {
    payload: {
      environment: EnvironmentId,
      workspace: Schema.Union([Schema.Literal(NEW_WORKSPACE), WorkspaceId]),
    },
    success: Catalog,
    error: EnvironmentError,
  }),
  /**
   * The draft composer's `@` menu: the files and folders of the same directory as `draftCatalog`'s that best match
   * `query`, as a Session's `files` answers them; none for a new Workspace of an Environment with no spare.
   */
  Rpc.make("draftFiles", {
    payload: {
      environment: EnvironmentId,
      workspace: Schema.Union([Schema.Literal(NEW_WORKSPACE), WorkspaceId]),
      query: Schema.String.check(Schema.isMaxLength(MAX_FILE_QUERY_LENGTH)),
    },
    success: FileMatches,
    error: EnvironmentError,
  }),
  /**
   * The draft's Start from menu (`docs/architecture/client-and-protocol.md` → Session list → New session): the branches of each of the
   * Environment's Repos on GitHub, asked with a read-only token of the GitHub App and kept for 60 s, in the
   * Environment's order. A Repo that is not on GitHub, or that GitHub would not list, has its reason instead. No
   * Workspace or Container is woken. Fails with an `EnvironmentError` when the Environment is not listed.
   */
  Rpc.make("draftBranches", {
    payload: { environment: EnvironmentId },
    success: Schema.Array(RepoBranches),
    error: EnvironmentError,
  }),
  /**
   * Remove a Workspace (`GLOSSARY.md` → Workspace removal): every Session in it (archived ones too, each as
   * `deleteSession`), then its files and Container, uncommitted changes and unpushed commits included, then its record.
   * What it pushed stays on the remote. A failure partway leaves what is not yet deleted, to try again. A Subagent
   * Workspace is removed as its Session's `subagent_delete` with `discard: true` removes it: its subagent is deleted
   * with everything below it, and their Subagent Workspaces with them.
   */
  Rpc.make("removeWorkspace", {
    payload: { id: WorkspaceId },
    error: EnvironmentError,
  }),
  /**
   * What a Workspace's clones hold that is not on the remote: per Repo, its uncommitted changes and the commits of its
   * branch that no remote branch has; Repos with none are left out. It runs on the Workspace's Container, starting it
   * if it is stopped. For the confirmations that remove a Subagent Workspace, or delete its Session.
   */
  Rpc.make("workspaceWork", {
    payload: { id: WorkspaceId },
    success: Schema.Array(WorkspaceWork),
    error: EnvironmentError,
  }),
  /**
   * Stop a Workspace's Container and forget its saved disk, keeping its files and Sessions: the next command starts a
   * Container from the image and installs the Toolchains again. What only the Container held (dependency directories,
   * build output, caches) is gone, and commands running in it end.
   */
  Rpc.make("restartContainer", {
    payload: { workspace: WorkspaceId },
    error: EnvironmentError,
  }),
  /**
   * The Global Settings in force, the overrides of the defaults they come from, and the Environments that override each
   * field (`overriddenIn`).
   */
  Rpc.make("getSettings", { success: SettingsState }),
  /**
   * Replace the saved Global overrides, a partial of the settings that differs from the defaults. Overrides that do not
   * resolve fail with a `SettingsError` whose message lists each problem, and nothing is saved. A Session reads the
   * new settings when it next admits input, unless its Environment overrides them.
   */
  Rpc.make("updateSettings", {
    payload: { overrides: Schema.Json },
    success: SettingsState,
    error: SettingsError,
  }),
  /**
   * Environment `environment`'s Settings (ADR-0027): its Overrides, Global's settings it inherits, and the two resolved.
   * Fails with a `SettingsError` when no Environment has the id.
   */
  Rpc.make("getSettingsOverrides", {
    payload: { environment: EnvironmentId },
    success: SettingsOverridesState,
    error: SettingsError,
  }),
  /**
   * Change Environment `environment`'s Overrides: `set`, a deep partial of the settings, overrides each field it holds
   * (a Role whole, completed from the Role in force; an extension's option by key, null resetting it, and an extension
   * set to null resetting each of its options), even to the Global value; `reset` names fields (`model`,
   * `roles.small`, `compaction.enabled`, `tools.offered`, `extensions.<extension>.<key>`) whose Override is removed, so they inherit again. Fails with a `SettingsError`,
   * saving nothing, for values the settings do not take, a field that is not one, or an Environment that does not
   * exist. The Environment's Sessions read them when they next admit input.
   */
  Rpc.make("updateSettingsOverrides", {
    payload: {
      environment: EnvironmentId,
      set: Schema.optionalKey(Schema.Json),
      reset: Schema.String.pipe(Schema.Array, Schema.optionalKey),
    },
    success: SettingsOverridesState,
    error: SettingsError,
  }),
  /**
   * Replace Environment `environment`'s own Instructions with `instructions` (empty for none), shown to its Sessions
   * after Global's from each one's next Context Window. Fails with a `SettingsError`, saving nothing, for a text over
   * 64 KiB of UTF-8 or an Environment that does not exist.
   */
  Rpc.make("updateEnvironmentInstructions", {
    payload: { environment: EnvironmentId, instructions: Schema.String },
    success: SettingsOverridesState,
    error: SettingsError,
  }),
  /**
   * The Global Settings' Agent changes (`docs/architecture/agent-changes.md`), newest first: those of the last
   * `MAX_AGENT_CHANGES` the owner has not dismissed, the owner's reverts among them. Each one's `field` names a setting
   * (`model`, `roles.small`, `tools.offered`, `extensions.<extension>.<key>`). An Environment's Settings changes are
   * among its own Agent changes (`listAgentChanges`).
   */
  Rpc.make("listSettingsChanges", { success: Schema.Array(AgentChange) }),
  /**
   * Revert Settings change `change`: write its `before` value back, recorded as the owner's change, which this answers.
   * Refused with a `SettingsError` showing the value now when the field has changed since, and for a change that is the
   * owner's own revert. A Session reads the settings when it next admits input.
   */
  Rpc.make("revertSettingsChange", {
    payload: { change: Schema.Finite },
    success: AgentChange,
    error: SettingsError,
  }),
  /**
   * Dismiss Settings change `change`: `listSettingsChanges` no longer lists it. What it changed stays. Fails with a
   * `SettingsError` when there is no such change.
   */
  Rpc.make("dismissSettingsChange", {
    payload: { change: Schema.Finite },
    error: SettingsError,
  }),
  /**
   * The VAPID public key to subscribe with, and whether the Registry holds the subscription at `endpoint` (a browser
   * whose push service dropped its subscription is told it is not subscribed).
   */
  Rpc.make("getPush", {
    payload: { endpoint: Schema.optionalKey(Schema.String) },
    success: PushState,
  }),
  /** Keep a browser's subscription, so Sessions notify it; one with the same endpoint is replaced. */
  Rpc.make("subscribePush", { payload: { subscription: PushSubscription } }),
  /** Forget the subscription at `endpoint`: that browser stops being notified. */
  Rpc.make("unsubscribePush", { payload: { endpoint: Schema.String } }),
) {}
