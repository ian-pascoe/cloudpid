// The Registry operations (`docs/spec.md` → Client and protocol): listing and creating Sessions, Environments and
// Workspaces. They hold no stream, so they are an Effect `RpcGroup` over HTTP, served by the main Worker at `RPC_PATH`.
import {
  Settings,
  SettingsError,
  ContainerSettings,
  EveryEnvironmentSettings,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { EnvironmentSecretRecord, SecretName } from "./environment-secrets.ts";
import { BranchName, EnvironmentError, RepoName, WorkspaceId } from "./repo.ts";
import { Catalog, FileMatches, MAX_FILE_QUERY_LENGTH, TreePoint } from "./session.ts";

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

/** Where a Secret is kept (`docs/spec.md` → Secrets): an Environment's id, or null for every Environment. */
export const SecretScope = Schema.NullOr(EnvironmentId);

/**
 * The scope of the Agent changes of the Secrets and variables kept for every Environment (`docs/spec.md` → Agent
 * changes), where an Environment's are kept under its id. No Environment id can be it.
 */
export const EVERY_ENVIRONMENT_SCOPE = "*";

/** Whose Agent changes `listAgentChanges` lists and `revertAgentChange` reverts: an Environment's, or those of every Environment. */
export const AgentChangeScope = Schema.Union([
  EnvironmentId,
  Schema.Literal(EVERY_ENVIRONMENT_SCOPE),
]);

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

/** A Session as the Registry lists it. Times are epoch milliseconds. */
export const SessionRecord = Schema.Struct({
  /** The Session DO's name: a UUIDv7. Its socket is at `sessionSocketPath(id)`. */
  id: Schema.String,
  /** Null until the user or the title task gives it one. */
  title: Schema.NullOr(Schema.String),
  /**
   * Who set the title; null while there is none. A generated title is set at most once, and never replaces an owner's
   * (`docs/spec.md` → Client and protocol → Titles).
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

/**
 * Where an Environment's Build stands (`docs/spec.md` → Builds): none made yet, one being made (with when the last good
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

/** The settings in force, and the overrides saved over the defaults (`docs/spec.md` → Settings). */
export const SettingsState = Schema.Struct({
  settings: Settings,
  overrides: Schema.Json,
  /** Why the saved overrides were not used, when they no longer resolve: the settings are then the defaults. */
  problem: Schema.optionalKey(Schema.String),
});

export type SettingsState = typeof SettingsState.Type;

/**
 * An Environment's Container settings in force (`docs/spec.md` → Container and Toolchains → Container settings), and the
 * overrides they come from. Each of its Workspaces applies them at its next Container launch.
 */
export const ContainerSettingsState = Schema.Struct({
  settings: ContainerSettings,
  overrides: Schema.Json,
  /** Why the saved overrides were only partly used, when some no longer resolve: the rest still apply. */
  problem: Schema.optionalKey(Schema.String),
});

export type ContainerSettingsState = typeof ContainerSettingsState.Type;

/**
 * The settings kept for every Environment in force (`docs/spec.md` → Container and Toolchains → Container settings),
 * and the overrides they come from. Each Workspace of every Environment applies them at its next Container launch.
 */
export const EveryEnvironmentSettingsState = Schema.Struct({
  settings: EveryEnvironmentSettings,
  overrides: Schema.Json,
  /** Why the saved overrides were only partly used, when some no longer resolve: the rest still apply. */
  problem: Schema.optionalKey(Schema.String),
});

export type EveryEnvironmentSettingsState = typeof EveryEnvironmentSettingsState.Type;

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
 * One Agent change (GLOSSARY.md → Agent change; `docs/spec.md` → Agent changes): a change the agent made to an
 * Environment or to the Settings, or the owner's revert of one. `field` names what changed (`variableField` for a variable), and `before`
 * and `after` are its values then, null where it had none (a variable not set).
 */
export const AgentChange = Schema.Struct({
  /** Its number, which grows with each change in the Registry. */
  id: Schema.Finite,
  /** The Environment's id, or `EVERY_ENVIRONMENT_SCOPE` for a Secret or variable kept for every Environment. */
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
  /** Every Environment, the default one included, newest first. */
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
   * Scripts, Toolchains), and their overrides.
   */
  Rpc.make("getEnvironmentSettings", {
    payload: { environment: EnvironmentId },
    success: ContainerSettingsState,
    error: EnvironmentError,
  }),
  /**
   * Replace an Environment's saved Container overrides, a partial of its settings that differs from the defaults.
   * Overrides that do not resolve fail with an `EnvironmentError` whose message lists each problem, and nothing is
   * saved. Each Workspace applies them at its next Container launch: a running Container keeps the settings it
   * started with.
   */
  Rpc.make("updateEnvironmentSettings", {
    payload: { environment: EnvironmentId, overrides: Schema.Json },
    success: ContainerSettingsState,
    error: EnvironmentError,
  }),
  /** The settings kept for every Environment in force (the variables), and their overrides. */
  Rpc.make("getEveryEnvironmentSettings", { success: EveryEnvironmentSettingsState }),
  /**
   * Replace the saved overrides of the settings kept for every Environment. Overrides that do not resolve, or that
   * would give any Environment more than 50 variables with its own, fail with an `EnvironmentError` whose message lists
   * each problem, and nothing is saved. Each Workspace applies them at its next Container start.
   */
  Rpc.make("updateEveryEnvironmentSettings", {
    payload: { overrides: Schema.Json },
    success: EveryEnvironmentSettingsState,
    error: EnvironmentError,
  }),
  /**
   * Every Secret kept for an Environment or for every Environment (`docs/spec.md` → Secrets): names, scopes, build
   * flags and times, never a value.
   */
  Rpc.make("listEnvironmentSecrets", { success: Schema.Array(EnvironmentSecretRecord) }),
  /**
   * An Environment's Agent changes (`docs/spec.md` → Agent changes), newest first: the last `MAX_AGENT_CHANGES`, the
   * owner's reverts among them.
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
   * Keep a Secret for `environment` (null: every Environment), or replace the value of the one kept under `name`. The
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
  /** Say whether a kept Secret reaches the Environment's Build (each Environment's, for one kept for every Environment). */
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
  /** Where each Environment's Build stands (`docs/spec.md` → Builds). */
  Rpc.make("listBuilds", { success: Schema.Array(EnvironmentBuildState) }),
  /**
   * Make the Environment's Build again now, whatever the last one was made from; one already being made is left to
   * finish. Fails with an `EnvironmentError` when the Environment does not exist or its Build could not be asked for.
   */
  Rpc.make("rebuildEnvironment", {
    payload: { environment: EnvironmentId },
    error: EnvironmentError,
  }),
  /** Every Workspace, of every Environment, newest first. */
  Rpc.make("listWorkspaces", { success: Schema.Array(WorkspaceRecord) }),
  /**
   * The draft composer's catalog, before there is a Session to ask (`docs/spec.md` → Session list → New session): the
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
  /** The settings in force and the overrides they come from. */
  Rpc.make("getSettings", { success: SettingsState }),
  /**
   * Replace the saved overrides, a partial of the settings that differs from the defaults. Overrides that do not
   * resolve fail with a `SettingsError` whose message lists each problem, and nothing is saved. A Session reads the
   * new settings when it next admits input.
   */
  Rpc.make("updateSettings", {
    payload: { overrides: Schema.Json },
    success: SettingsState,
    error: SettingsError,
  }),
  /**
   * The Settings' Agent changes (`docs/spec.md` → Agent changes), newest first: the last `MAX_AGENT_CHANGES`, the
   * owner's reverts among them. Each one's `field` names a setting (`model`, `roles.small.model`, `tools.offered`,
   * `extensions.<extension>.<key>`).
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
