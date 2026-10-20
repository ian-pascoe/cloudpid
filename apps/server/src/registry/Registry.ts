import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { newSessionId } from "./ids.ts";
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
  /** Register a new Session, idle, under a fresh UUIDv7. */
  readonly createSession: (input: {
    readonly title?: string | undefined;
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
        const store = openRegistryStore(state.raw.storage.sql);

        return {
          createSession: ({ title }) =>
            Effect.gen(function* () {
              const id = yield* newSessionId;
              const now = yield* Clock.currentTimeMillis;

              return store.createSession({ id, title: title ?? null }, now);
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
        } satisfies RegistryMethods;
      }),
    ),
  ),
);
