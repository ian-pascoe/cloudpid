// The Registry operations (`docs/spec.md` → Client and protocol): listing and creating Sessions and Workspaces. They
// hold no stream, so they are an Effect `RpcGroup` over HTTP, served by the main Worker at `RPC_PATH`.
import { Settings, SettingsError } from "@cloudpid/config";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

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

/** A Workspace slug, which is also its directory and its Workspace DO's name. */
export const WorkspaceSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));

/** The Workspace a Session is bound to when it is created without one. */
export const DEFAULT_WORKSPACE = "default";

/** A Session as the Registry lists it. Times are epoch milliseconds. */
export const SessionRecord = Schema.Struct({
  /** The Session DO's name: a UUIDv7. Its socket is at `sessionSocketPath(id)`. */
  id: Schema.String,
  /** Null until the user or the title task gives it one. */
  title: Schema.NullOr(Schema.String),
  /** The slug of the Workspace the Session works on; it never changes. */
  workspace: Schema.String,
  status: SessionStatus,
  createdAt: Schema.Finite,
  /** When the Session was created or its status last changed. */
  updatedAt: Schema.Finite,
});

export type SessionRecord = typeof SessionRecord.Type;

/** A Workspace as the Registry lists it. */
export const WorkspaceRecord = Schema.Struct({ slug: Schema.String, createdAt: Schema.Finite });

export type WorkspaceRecord = typeof WorkspaceRecord.Type;

/** The settings in force, and the overrides saved over the defaults (`docs/spec.md` → Settings). */
export const SettingsState = Schema.Struct({
  settings: Settings,
  overrides: Schema.Json,
  /** Why the saved overrides were not used, when they no longer resolve: the settings are then the defaults. */
  problem: Schema.optionalKey(Schema.String),
});

export type SettingsState = typeof SettingsState.Type;

/** The path of Session `sessionId`'s socket on the main Worker. */
export const sessionSocketPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}/socket`;

export class RegistryRpcs extends RpcGroup.make(
  /** Every Session, newest first. */
  Rpc.make("listSessions", { success: Schema.Array(SessionRecord) }),
  /** Register a new Session, idle, under a fresh UUIDv7, bound to a Workspace (registered when new). */
  Rpc.make("createSession", {
    payload: {
      title: Schema.optionalKey(SessionTitle),
      /** Defaults to `DEFAULT_WORKSPACE`. */
      workspace: Schema.optionalKey(WorkspaceSlug),
    },
    success: SessionRecord,
  }),
  Rpc.make("listWorkspaces", { success: Schema.Array(WorkspaceRecord) }),
  /** Register a Workspace by slug; one already registered keeps its record. */
  Rpc.make("createWorkspace", { payload: { slug: WorkspaceSlug }, success: WorkspaceRecord }),
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
) {}
