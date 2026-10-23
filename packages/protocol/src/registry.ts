// The Registry operations (`docs/spec.md` → Client and protocol): listing and creating Sessions and Machines. They
// hold no stream, so they are an Effect `RpcGroup` over HTTP, served by the main Worker at `RPC_PATH`.
import { Settings, SettingsError, ContainerSettings } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import { BranchName, MachineError, RepoName, WorkspaceId } from "./repo.ts";

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

/** Who gave a Session its title: the owner by naming it, or the `small` role's model after the first answer. */
export const TitleSource = Schema.Literals(["generated", "owner"]);

export type TitleSource = typeof TitleSource.Type;

/** A Machine slug, which is also its directory and its Workspace DO's name. */
export const MachineSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));

/** The Machine a Session is bound to when it is created without one. */
export const DEFAULT_MACHINE = "default";

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
  /** The slug of the Machine the Session works on; it never changes. */
  machine: Schema.String,
  /** The repo the Session works in, or null for the Machine's root; it never changes. */
  repo: Schema.NullOr(Schema.String),
  /**
   * The id of the Workspace of its own the Session works in (a worktree of `repo`: `WorkspaceRecord`), or null for the
   * repo's main checkout, or the Machine's root without a repo; it never changes.
   */
  workspace: Schema.NullOr(Schema.String),
  status: SessionStatus,
  createdAt: Schema.Finite,
  /** When the Session was created or its status last changed. */
  updatedAt: Schema.Finite,
  /** When the owner archived the Session (out of the Session list, read-only until unarchived), or null. */
  archivedAt: Schema.NullOr(Schema.Finite),
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
 * A Workspace of its own (ADR-0015): a git worktree of a repo on one branch, at `worktreeDirectory(repo, id)`, made
 * when a Session first works in it. A repo's main checkout and a Machine's root are Workspaces too, without a record:
 * a Session names them by its Machine and repo alone.
 */
export const WorkspaceRecord = Schema.Struct({
  /** Eight lowercase hex digits (`WorkspaceId`), also its worktree's directory name. */
  id: Schema.String,
  /** The slug of the Machine it is on. */
  machine: Schema.String,
  /** The repo it is a worktree of. */
  repo: Schema.String,
  /** The branch it works on: `cloudpid/<id>` unless the owner named one. It outlives the worktree. */
  branch: Schema.String,
  /** Its worktree: `/workspace/.worktrees/<repo>/<id>`. */
  directory: Schema.String,
  createdAt: Schema.Finite,
});

export type WorkspaceRecord = typeof WorkspaceRecord.Type;

/** What `createSession` is told to make the Session's Workspace a new one of the repo's own. */
export const NEW_WORKSPACE = "new";

/** The longest Machine name. */
export const MAX_MACHINE_NAME_LENGTH = 80;

/** A Machine name: trimmed, then neither empty nor longer than `MAX_MACHINE_NAME_LENGTH`. */
export const MachineName = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_MACHINE_NAME_LENGTH),
);

/** A Machine as the Registry lists it. */
export const MachineRecord = Schema.Struct({
  /** Its fixed identifier: the Workspace DO's name, and what its Sessions are bound to. */
  slug: Schema.String,
  /** The owner's label for it, unique among Machines whatever the case. It starts as the slug. */
  name: Schema.String,
  createdAt: Schema.Finite,
});

export type MachineRecord = typeof MachineRecord.Type;

/** The settings in force, and the overrides saved over the defaults (`docs/spec.md` → Settings). */
export const SettingsState = Schema.Struct({
  settings: Settings,
  overrides: Schema.Json,
  /** Why the saved overrides were not used, when they no longer resolve: the settings are then the defaults. */
  problem: Schema.optionalKey(Schema.String),
});

export type SettingsState = typeof SettingsState.Type;

/**
 * A Machine's own settings in force (`docs/spec.md` → Container and Toolchains → Size and idle), and the overrides
 * they come from. They apply at the Machine's next Container launch.
 */
export const MachineSettingsState = Schema.Struct({
  settings: ContainerSettings,
  overrides: Schema.Json,
  /** Why the saved overrides were only partly used, when some no longer resolve: the rest still apply. */
  problem: Schema.optionalKey(Schema.String),
});

export type MachineSettingsState = typeof MachineSettingsState.Type;

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
  /** Register a new Session, idle, under a fresh UUIDv7, bound to a Machine (registered when new). */
  Rpc.make("createSession", {
    payload: {
      title: Schema.optionalKey(SessionTitle),
      /** Defaults to `DEFAULT_MACHINE`. */
      machine: Schema.optionalKey(MachineSlug),
      /**
       * A repo already in the Machine (`listRepos`) that the Session works in. Without one the `cwd` is `/workspace`.
       * A repo the Machine does not hold fails with a `MachineError`.
       */
      repo: Schema.optionalKey(RepoName),
      /**
       * The Session's Workspace in `repo`: `NEW_WORKSPACE` makes one of its own (a worktree on its own branch, made when
       * the Session first works in it), and a `WorkspaceId` names one that exists (its Machine and repo are then the
       * Session's, and `machine` and `repo`, if given, must be them). Without it the Session works in the repo's main
       * checkout.
       */
      workspace: Schema.optionalKey(Schema.Union([Schema.Literal(NEW_WORKSPACE), WorkspaceId])),
      /**
       * The branch of a new Workspace: one the repo or its `origin` has is checked out, any other is made from the
       * remote's default branch. Defaults to `cloudpid/<id>`. Only with `workspace: NEW_WORKSPACE`; a branch another
       * Workspace of the repo is on fails, since git checks a branch out in one worktree at a time (one the main
       * checkout is on fails too, when the worktree is made: the Session's first use reports git's message).
       */
      branch: Schema.optionalKey(BranchName),
    },
    success: SessionRecord,
    error: MachineError,
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
   * then forget it. The files it wrote in its Machine stay. A `SessionActionError` leaves it listed, to try again.
   */
  Rpc.make("deleteSession", {
    payload: { id: Schema.String },
    error: Schema.Union([SessionNotFound, SessionActionError]),
  }),
  Rpc.make("listMachines", { success: Schema.Array(MachineRecord) }),
  /** Register a Machine by slug; one already registered keeps its record. */
  Rpc.make("createMachine", { payload: { slug: MachineSlug }, success: MachineRecord }),
  /**
   * Name a Machine. Its slug never changes. Fails with a `MachineError` when the Registry does not list it or another
   * Machine has the name, whatever the case.
   */
  Rpc.make("renameMachine", {
    payload: { machine: MachineSlug, name: MachineName },
    success: MachineRecord,
    error: MachineError,
  }),
  /**
   * Delete a Machine for good: every Session bound to it (archived ones too, each as `deleteSession`), then its files,
   * Container and settings, then its record. The default Machine cannot be deleted. A failure partway leaves what is
   * not yet deleted listed, to try again.
   */
  Rpc.make("deleteMachine", {
    payload: { machine: MachineSlug },
    error: MachineError,
  }),
  /**
   * Reset a Machine to a fresh start, keeping its slug, name and Container settings: every Session bound to it
   * (archived ones too, each as `deleteSession`), then its files, Container and saved disk. The next command starts a
   * Container from the image. The default Machine can be reset. A failure partway leaves what is not yet deleted, to
   * try again.
   */
  Rpc.make("resetMachine", {
    payload: { machine: MachineSlug },
    error: MachineError,
  }),
  /**
   * Stop a Machine's Container and forget its saved disk, keeping its files and Sessions: the next command starts a
   * Container from the image and installs the Toolchains again. What only the Container held (dependency directories,
   * build output, caches) is gone, and commands running in it end.
   */
  Rpc.make("restartContainer", {
    payload: { machine: MachineSlug },
    error: MachineError,
  }),
  /** The repos a Machine holds: the directories below `/workspace` that are git repositories, by name. */
  Rpc.make("listRepos", {
    payload: { machine: MachineSlug },
    success: Schema.Array(Schema.String),
    error: MachineError,
  }),
  /**
   * Clone a repo into `/workspace/<name>` of a Machine (registered when new), on the Container where the network and
   * the GitHub token are. `source` is `owner/repo` or an `https` URL (`parseRepoSource`); `name` defaults to the repo's
   * own. Fails with a `MachineError` carrying git's message when the address is not valid, the directory is taken or
   * the clone does not finish. Answers the directory name.
   */
  Rpc.make("cloneRepo", {
    payload: {
      machine: MachineSlug,
      source: Schema.String,
      name: Schema.optionalKey(RepoName),
    },
    success: RepoName,
    error: MachineError,
  }),
  /**
   * Remove a repo from a Machine: every Session bound to it (archived ones too, each as `deleteSession`), then its
   * directory, on the Container, so what only the Container held under it goes too. Work that was not pushed is lost.
   * Fails with a `MachineError` when the Machine is not listed, or neither holds the repo nor has a Session bound to
   * it. A failure partway leaves what is not yet deleted, to try again.
   */
  Rpc.make("removeRepo", {
    payload: { machine: MachineSlug, repo: RepoName },
    error: MachineError,
  }),
  /** Every Workspace of its own (a worktree), on every Machine, newest first. */
  Rpc.make("listWorkspaces", { success: Schema.Array(WorkspaceRecord) }),
  /**
   * Remove a Workspace of its own: every Session bound to it (archived ones too, each as `deleteSession`), then its
   * worktree, on the Container, uncommitted changes and what only the Container held there included, then its record.
   * Its branch and the commits on it stay in the repo. A failure partway leaves what is not yet deleted, to try again.
   */
  Rpc.make("removeWorkspace", {
    payload: { id: WorkspaceId },
    error: MachineError,
  }),
  /** A Machine's own settings (Container size, idle time, Container-only paths) in force, and their overrides. */
  Rpc.make("getMachineSettings", {
    payload: { machine: MachineSlug },
    success: MachineSettingsState,
    error: MachineError,
  }),
  /**
   * Replace a Machine's saved overrides, a partial of its settings that differs from the defaults. Overrides that do
   * not resolve fail with a `MachineError` whose message lists each problem, and nothing is saved. The Machine
   * applies them at its next Container launch: a running Container keeps the settings it started with.
   */
  Rpc.make("updateMachineSettings", {
    payload: { machine: MachineSlug, overrides: Schema.Json },
    success: MachineSettingsState,
    error: MachineError,
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
