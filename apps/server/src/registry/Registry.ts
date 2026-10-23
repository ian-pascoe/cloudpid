import * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { type KeptSecret, openKeptVault } from "@cloudpid/extensions/secrets/core";
import type {
  EnvironmentBuildState,
  EnvironmentSecretRecord,
  PushState,
  PushSubscription,
} from "@cloudpid/protocol";
import { SecretsConfig } from "../session/secrets.ts";
import {
  buildSecretsOf,
  keepSecret,
  type SecretsHandover,
  secretsHandover,
  type SecretWrite,
  usedSecrets,
} from "./environment-secrets.ts";
import type { BuildProgress, EnvironmentBuild } from "../workspace/build-record.ts";
import { type BuildWork, buildView } from "./builds.ts";
import { PushConfig } from "../push/config.ts";
import { pushNotifier } from "../push/notify.ts";
import type { PushEvent } from "../push/notification.ts";
import { newEnvironmentId, newSessionId, newWorkspaceId, shortId } from "./ids.ts";
import { readSettings, type SettingsState, SettingsUpdate, writeSettings } from "./settings.ts";
import {
  readEnvironmentSettings,
  type EnvironmentSettingsState,
  writeEnvironmentSettings,
} from "./environment-settings.ts";
import {
  type Deletion,
  type EnvironmentDeletion,
  type EnvironmentNaming,
  type EnvironmentRecord,
  type LegacyObject,
  openRegistryStore,
  type RepoChange,
  type SessionRecord,
  type SessionRefusal,
  type SessionStatus,
  type SpareUpkeep,
  type WorkspaceRecord,
  type WorkspaceSetup,
} from "./store.ts";

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
 * good Build (null for none yet) and kept Secrets, opened (docs/spec.md → Secrets): the Workspace keeps them sealed,
 * to search a snapshot for and to take out of output. When the Registry cannot open them, `secrets` is absent and
 * `secretsUnavailable` says so (`SECRETS_UNAVAILABLE`), and the Workspace refuses the snapshots that would need them.
 */
export type WorkspaceSetupWithSettings = WorkspaceSetup & {
  readonly settings: Schema.Json;
  readonly build: EnvironmentBuild | null;
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
  }) => Effect.Effect<SessionRecord | SessionRefusal>;
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
  /** An Environment's Container settings in force and their overrides, or null when it is not registered. */
  readonly getEnvironmentSettings: (input: {
    readonly environment: string;
  }) => Effect.Effect<EnvironmentSettingsState | null>;
  /** Save an Environment's Container settings overrides if they resolve; otherwise say why not, and save nothing. */
  readonly updateEnvironmentSettings: (input: {
    readonly environment: string;
    readonly overrides: Schema.Json;
  }) => Effect.Effect<EnvironmentSettingsUpdate>;
  /** The Workspace registered under `id`, or null. */
  readonly getWorkspace: (input: { readonly id: string }) => Effect.Effect<WorkspaceRecord | null>;
  /**
   * What a Session's Workspace sets itself up with (its Repos, branch and base) and the Container settings in force
   * for its Environment, or null when the Workspace is not registered.
   */
  readonly getWorkspaceSetup: (input: {
    readonly id: string;
  }) => Effect.Effect<WorkspaceSetupWithSettings | null>;
  /** Every Workspace, newest first. */
  readonly listWorkspaces: () => Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
  /** Forget a Workspace once its Sessions are deleted and its object wiped; kept while a Session is bound to it. */
  readonly deleteWorkspace: (input: { readonly id: string }) => Effect.Effect<Deletion>;
  /**
   * What keeps the spare Workspace of each of `environments` (every Environment when undefined) current, in one call:
   * the stale spares to remove (`forgetSpare`, then their objects), and the spares registered now, each with what its
   * object prepares itself with. Nothing to do is two empty lists.
   */
  readonly upkeepSpares: (input: {
    readonly environments?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<SpareWork>;
  /**
   * What keeping the Builds of `environments` (every Environment when undefined) current needs: each Environment's
   * Repos and Container settings overrides, and what is recorded of its Build.
   */
  readonly buildWork: (input: {
    readonly environments?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ReadonlyArray<BuildWork>>;
  /** Record what an Environment's Build object answered: its last good Build, and the one in progress or the last failure. */
  readonly recordBuild: (input: {
    readonly environment: string;
    readonly build: EnvironmentBuild | null;
    readonly status: BuildProgress | null;
  }) => Effect.Effect<void>;
  /** Where each Environment's Build stands, for the owner. */
  readonly listBuilds: () => Effect.Effect<ReadonlyArray<EnvironmentBuildState>>;
  /** Every kept Secret: names, scopes, build flags and times, never a value. */
  readonly listEnvironmentSecrets: () => Effect.Effect<ReadonlyArray<EnvironmentSecretRecord>>;
  /**
   * Keep `value` under `name` for `environment` (null: every Environment), sealed here; replaces a value kept there.
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
   * The Secrets `environment` uses, with their values, opened here: its own over those of the same name kept for every
   * Environment. For the main Worker's Builds and spares only: never answered to a client.
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

/** How long a legacy object taken to be wiped is left to its taker before another may take it. */
export const LEGACY_LEASE_MS = 5 * 60_000;

/**
 * The index of Sessions, Environments and Workspaces (`docs/spec.md` → Durable Objects), over this object's SQLite storage.
 * The class name is the Durable Object class name in every stage's migrations, so it cannot be renamed once deployed.
 */
export class Registry extends Cloudflare.DurableObject<Registry, RegistryMethods>()("Registry") {}

export const RegistryLive = Registry.make(
  Effect.all({
    state: Cloudflare.DurableObjectState,
    push: PushConfig,
    secrets: SecretsConfig,
  }).pipe(
    Effect.map(({ state, push, secrets }) =>
      Effect.gen(function* () {
        const store = openRegistryStore(state.raw.storage);
        const notify = pushNotifier({ store, vapid: push.vapid });

        // The kept Secrets' key, derived once, on first use: a malformed master key fails the calls that need it, not
        // the object. An Environment no Secret reaches never needs it.
        const vault = yield* Effect.cached(
          openKeptVault(Redacted.value(secrets.encryptionKey), "registry"),
        );

        /** The Secrets `environment` uses, opened, for the Session DOs and the Builds: a vault that fails says why. */
        const opened = (environment: string) =>
          usedSecrets(store, vault, environment).pipe(
            Effect.mapError(
              (error) => new Error(`The kept Secrets cannot be opened: ${error.message}`),
            ),
            Effect.orDie,
          );

        /**
         * A Workspace's set-up with its Environment's Container settings overrides, last good Build (`build`, the one
         * a spare was registered with, else the Environment's now) and Secrets, or why it gets none.
         */
        const withSettings = (
          setup: WorkspaceSetup & { readonly build?: EnvironmentBuild | null },
        ): Effect.Effect<WorkspaceSetupWithSettings> =>
          Effect.map(secretsHandover(store, vault, setup.environment), (handover) => {
            // Only the overrides that still resolve reach the Workspace, which checks them again.
            const overrides = store.getEnvironmentSettings(setup.environment) ?? {};

            return {
              ...setup,
              settings: readEnvironmentSettings(overrides).overrides,
              build:
                setup.build === undefined
                  ? (store.getBuild(setup.environment)?.build ?? null)
                  : setup.build,
              ...handover,
            };
          });

        return {
          createSession: ({ title, workspace }) =>
            Effect.gen(function* () {
              const id = yield* newSessionId;
              const now = yield* Clock.currentTimeMillis;

              if (workspace.kind === "existing") {
                return store.createSession({ id, title: title ?? null, workspace }, now);
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
          deleteEnvironment: ({ id }) => Effect.sync(() => store.deleteEnvironment(id)),
          addRepo: ({ environment, name, url }) =>
            Effect.sync(() => store.addRepo(environment, { name, url })),
          removeRepo: ({ environment, name }) =>
            Effect.sync(() => store.removeRepo(environment, name)),
          getEnvironmentSettings: ({ environment }) =>
            Effect.sync(() => {
              const overrides = store.getEnvironmentSettings(environment);

              return overrides === null ? null : readEnvironmentSettings(overrides);
            }),
          updateEnvironmentSettings: ({ environment, overrides }) =>
            Effect.sync((): EnvironmentSettingsUpdate => {
              if (store.getEnvironment(environment) === null) return { status: "missing" };

              const saved = writeEnvironmentSettings(overrides);

              if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure };

              store.putEnvironmentSettings(environment, saved.success.overrides);

              return { status: "saved", state: saved.success };
            }),
          getWorkspace: ({ id }) => Effect.sync(() => store.getWorkspace(id)),
          getWorkspaceSetup: ({ id }) =>
            Effect.suspend(() => {
              const setup = store.getWorkspaceSetup(id);

              return setup === null ? Effect.succeed(null) : withSettings(setup);
            }),
          listWorkspaces: () => Effect.sync(() => store.listWorkspaces()),
          deleteWorkspace: ({ id }) => Effect.sync(() => store.deleteWorkspace(id)),
          upkeepSpares: ({ environments }) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const { stale, made } = store.upkeepSpares(environments, shortId, now);

              return { stale, made: yield* Effect.forEach(made, withSettings) } satisfies SpareWork;
            }),
          buildWork: ({ environments }) =>
            Effect.gen(function* () {
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
                    settings: readEnvironmentSettings(
                      store.getEnvironmentSettings(environment.id) ?? {},
                    ).overrides,
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
            Effect.sync(() => {
              store.putBuild(environment, { build, status });
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
