import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { PushState, PushSubscription } from "@cloudpid/protocol";
import { PushConfig } from "../push/config.ts";
import { pushNotifier } from "../push/notify.ts";
import type { PushEvent } from "../push/notification.ts";
import { newSessionId, newWorkspaceId } from "./ids.ts";
import { readSettings, type SettingsState, SettingsUpdate, writeSettings } from "./settings.ts";
import {
  openRegistryStore,
  type SessionRecord,
  type SessionStatus,
  type MachineRecord,
  type MachineDeletion,
  type MachineRename,
  type WorkspaceDeletion,
  type WorkspaceRecord,
} from "./store.ts";

/** The Registry is a singleton: every caller addresses the object with this name. */
export const REGISTRY_NAME = "registry";

/** A new Session's Workspace of its own: one that exists, or a new one, on `branch` if given. */
export type WorkspaceChoice =
  | { readonly kind: "existing"; readonly id: string }
  | { readonly kind: "new"; readonly branch?: string | undefined };

/** What the Registry DO answers over RPC. */
export type RegistryMethods = {
  /**
   * Register a new Session, idle, under a fresh UUIDv7, bound to `machine` (default `DEFAULT_MACHINE`). `workspace` is
   * a Workspace of `repo` it works in, or a new one to register with it, under a fresh id, on `branch` (default
   * `cloudpid/<id>`).
   */
  readonly createSession: (input: {
    readonly title?: string | undefined;
    readonly machine?: string | undefined;
    readonly repo?: string | undefined;
    readonly workspace?: WorkspaceChoice | undefined;
  }) => Effect.Effect<SessionRecord>;
  /** The Session registered under `id`, or null. */
  readonly getSession: (input: { readonly id: string }) => Effect.Effect<SessionRecord | null>;
  /** Every Session, newest first. */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<SessionRecord>>;
  /** The Session DO reports that a Run started or ended. A Session that is not registered is ignored. */
  readonly setSessionStatus: (input: {
    readonly id: string;
    readonly status: SessionStatus;
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
  /** Register a Machine by slug, named after it; one already registered keeps its record. */
  readonly createMachine: (input: { readonly slug: string }) => Effect.Effect<MachineRecord>;
  readonly listMachines: () => Effect.Effect<ReadonlyArray<MachineRecord>>;
  /** Give a Machine a new name, which no other Machine may have in any case. */
  readonly renameMachine: (input: {
    readonly slug: string;
    readonly name: string;
  }) => Effect.Effect<MachineRename>;
  /** Forget a Machine once its Sessions are deleted and its object wiped; kept while a Session is bound to it. */
  readonly deleteMachine: (input: { readonly slug: string }) => Effect.Effect<MachineDeletion>;
  /** The Workspace registered under `id`, or null. */
  readonly getWorkspace: (input: { readonly id: string }) => Effect.Effect<WorkspaceRecord | null>;
  /** Every Workspace of its own, newest first. */
  readonly listWorkspaces: () => Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
  /** Forget a Workspace once its Sessions are deleted and its worktree removed; kept while a Session is bound to it. */
  readonly deleteWorkspace: (input: { readonly id: string }) => Effect.Effect<WorkspaceDeletion>;
  /** Forget the Workspaces of a Machine (or of one of its repos) no Session is bound to, once their files are gone. */
  readonly deleteWorkspacesOf: (input: {
    readonly machine: string;
    readonly repo?: string | undefined;
  }) => Effect.Effect<void>;
  /** The settings in force and the overrides saved over the defaults. */
  readonly getSettings: () => Effect.Effect<SettingsState>;
  /** Save `overrides` in place of the saved ones if they resolve; otherwise say why not, and save nothing. */
  readonly updateSettings: (input: {
    readonly overrides: Schema.Json;
  }) => Effect.Effect<SettingsUpdate>;
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

/**
 * The index of Sessions and Machines (`docs/spec.md` → Durable Objects), over this object's SQLite storage.
 * The class name is the Durable Object class name in every stage's migrations, so it cannot be renamed once deployed.
 */
export class Registry extends Cloudflare.DurableObject<Registry, RegistryMethods>()("Registry") {}

export const RegistryLive = Registry.make(
  Effect.all({ state: Cloudflare.DurableObjectState, push: PushConfig }).pipe(
    Effect.map(({ state, push }) =>
      Effect.sync(() => {
        const store = openRegistryStore(state.raw.storage);
        const notify = pushNotifier({ store, vapid: push.vapid });

        return {
          createSession: ({ title, machine, repo, workspace }) =>
            Effect.gen(function* () {
              const id = yield* newSessionId;
              const now = yield* Clock.currentTimeMillis;

              if (workspace?.kind !== "new") {
                return store.createSession(
                  { id, title: title ?? null, machine, repo, workspace },
                  now,
                );
              }

              // Eight hex digits rarely collide; one that does is drawn again.
              let workspaceId = yield* newWorkspaceId;

              while (store.getWorkspace(workspaceId) !== null) workspaceId = yield* newWorkspaceId;

              return store.createSession(
                {
                  id,
                  title: title ?? null,
                  machine,
                  repo,
                  workspace: {
                    kind: "new",
                    id: workspaceId,
                    branch: workspace.branch ?? `cloudpid/${workspaceId}`,
                  },
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
          renameSession: ({ id, title }) => Effect.sync(() => store.renameSession(id, title)),
          setGeneratedTitle: ({ id, title }) =>
            Effect.sync(() => store.setGeneratedTitle(id, title)),
          archiveSession: ({ id }) =>
            Clock.currentTimeMillis.pipe(Effect.map((now) => store.archiveSession(id, now))),
          unarchiveSession: ({ id }) => Effect.sync(() => store.unarchiveSession(id)),
          deleteSession: ({ id }) => Effect.sync(() => store.deleteSession(id)),
          createMachine: ({ slug }) =>
            Clock.currentTimeMillis.pipe(Effect.map((now) => store.createMachine(slug, now))),
          listMachines: () => Effect.sync(() => store.listMachines()),
          renameMachine: ({ slug, name }) => Effect.sync(() => store.renameMachine(slug, name)),
          deleteMachine: ({ slug }) => Effect.sync(() => store.deleteMachine(slug)),
          getWorkspace: ({ id }) => Effect.sync(() => store.getWorkspace(id)),
          listWorkspaces: () => Effect.sync(() => store.listWorkspaces()),
          deleteWorkspace: ({ id }) => Effect.sync(() => store.deleteWorkspace(id)),
          deleteWorkspacesOf: ({ machine, repo }) =>
            Effect.sync(() => store.deleteWorkspacesOf(machine, repo)),
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
