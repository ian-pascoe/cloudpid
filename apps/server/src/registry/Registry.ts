import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { newSessionId } from "./ids.ts";
import { readSettings, type SettingsState, SettingsUpdate, writeSettings } from "./settings.ts";
import {
  openRegistryStore,
  type SessionRecord,
  type SessionStatus,
  type WorkspaceRecord,
} from "./store.ts";

/** The Registry is a singleton: every caller addresses the object with this name. */
export const REGISTRY_NAME = "registry";

/** What the Registry DO answers over RPC. */
export type RegistryMethods = {
  /** Register a new Session, idle, under a fresh UUIDv7, bound to `workspace` (default `DEFAULT_WORKSPACE`). */
  readonly createSession: (input: {
    readonly title?: string | undefined;
    readonly workspace?: string | undefined;
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
  /** Register a Workspace by slug; one already registered keeps its record. */
  readonly createWorkspace: (input: { readonly slug: string }) => Effect.Effect<WorkspaceRecord>;
  readonly listWorkspaces: () => Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
  /** The settings in force and the overrides saved over the defaults. */
  readonly getSettings: () => Effect.Effect<SettingsState>;
  /** Save `overrides` in place of the saved ones if they resolve; otherwise say why not, and save nothing. */
  readonly updateSettings: (input: {
    readonly overrides: Schema.Json;
  }) => Effect.Effect<SettingsUpdate>;
};

/**
 * The index of Sessions and Workspaces (`docs/spec.md` → Durable Objects), over this object's SQLite storage.
 * The class name is the Durable Object class name in every stage's migrations, so it cannot be renamed once deployed.
 */
export class Registry extends Cloudflare.DurableObject<Registry, RegistryMethods>()("Registry") {}

export const RegistryLive = Registry.make(
  Cloudflare.DurableObjectState.pipe(
    Effect.map((state) =>
      Effect.sync(() => {
        const store = openRegistryStore(state.raw.storage);

        return {
          createSession: ({ title, workspace }) =>
            Effect.gen(function* () {
              const id = yield* newSessionId;
              const now = yield* Clock.currentTimeMillis;

              return store.createSession({ id, title: title ?? null, workspace }, now);
            }),
          getSession: ({ id }) => Effect.sync(() => store.getSession(id)),
          listSessions: () => Effect.sync(() => store.listSessions()),
          setSessionStatus: ({ id, status }) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => store.setSessionStatus(id, status, now)),
            ),
          createWorkspace: ({ slug }) =>
            Clock.currentTimeMillis.pipe(Effect.map((now) => store.createWorkspace(slug, now))),
          listWorkspaces: () => Effect.sync(() => store.listWorkspaces()),
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
        } satisfies RegistryMethods;
      }),
    ),
  ),
);
