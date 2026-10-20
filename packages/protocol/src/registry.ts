// The Registry operations (`docs/spec.md` → Client and protocol): listing and creating Sessions and Workspaces. They
// hold no stream, so they are an Effect `RpcGroup` over HTTP, served by the main Worker at `RPC_PATH`.
import { Settings, SettingsError } from "@cloudpid/config";
import * as Arr from "effect/Array";
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
