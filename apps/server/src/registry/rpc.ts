import { SettingsError } from "@cloudpid/config";
import {
  DEFAULT_ENVIRONMENT,
  EnvironmentError,
  NEW_WORKSPACE,
  parseRepoSource,
  RegistryRpcs,
  SessionActionError,
  SessionNotFound,
  SPARE_BRANCH,
} from "@cloudpid/protocol";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { workspaceObjectName } from "../workspace/binding.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";
import type { EnvironmentNaming, SessionRecord, SessionRefusal, WorkspaceRecord } from "./store.ts";
import { SettingsUpdate } from "./settings.ts";

/**
 * The Sessions' own objects, by ID, as the main Worker reaches them to archive or delete one. A call that fails (the
 * object threw, or could not be reached) dies: the endpoint turns any failure into a `SessionActionError`.
 */
export type SessionObjects = {
  /** Stop everything Session `id` runs: its root conversation and every subagent below it. */
  readonly stop: (id: string) => Effect.Effect<void>;
  /** Stop Session `id`, close its browser and its clients' sockets, and wipe its storage. */
  readonly destroy: (id: string) => Effect.Effect<void>;
};

/**
 * What the endpoint reaches besides the Registry: the objects behind the Workspaces and the Sessions, and a way to run
 * work after the answer, which needs `R` of the request.
 */
export type RegistryRpcObjects<R = never> = {
  /** Wipes a Workspace's object when it is removed, and restarts its Container, by object name. */
  readonly workspaces: WorkspaceObjects;
  /** Stops a Session when it is archived, and wipes it when it is deleted. */
  readonly sessions: SessionObjects;
  /** Wipes what is left from before Environments, a few objects at a time (`legacyCleanup`), after the answer. */
  readonly legacy: Effect.Effect<void>;
  /** Keeps each Environment's spare Workspace current (`spareUpkeep`), after the answer. */
  readonly spares: Spares;
  /** Runs `effect` once the answer is sent, keeping the request alive until it is done (`waitUntil`). */
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void, never, R>;
};

/** How many legacy objects one cleanup wipes. */
const LEGACY_BATCH = 10;

/**
 * The wipe of what the Registry kept from before Environments (ADR-0016): the Session DOs and Machine Workspace DOs
 * that migration 11 forgot, a batch per run, until none is left. An object that cannot be wiped is logged and taken
 * again once its lease runs out. Once a run finds nothing it does no more in this isolate, so later runs cost nothing.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const legacyCleanup = (
  registries: Cloudflare.DurableObject<Registry>,
  { sessions, workspaces }: Pick<RegistryRpcObjects, "sessions" | "workspaces">,
): Effect.Effect<void> => {
  let cleared = false;

  return Effect.gen(function* () {
    if (cleared) return;

    const registry = registries.getByName(REGISTRY_NAME);
    const taken = yield* registry.takeLegacy({ limit: LEGACY_BATCH });

    if (taken.length === 0) {
      cleared = true;

      return;
    }

    for (const object of taken) {
      const wipe =
        object.kind === "session"
          ? sessions.destroy(object.id)
          : Effect.promise(() => workspaces.destroy(object.id));

      yield* wipe.pipe(
        Effect.andThen(registry.forgetLegacy(object)),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Could not wipe the legacy ${object.kind} ${object.id}`, cause),
        ),
      );
    }
  });
};

/** The upkeep of the Environments' spare Workspaces (`spareUpkeep`). Neither ever fails: what goes wrong is logged. */
export type Spares = {
  /** Keep every Environment's spare current. Once a run finds nothing to do, this isolate does no more. */
  readonly all: Effect.Effect<void>;
  /** Keep `environment`'s spare current, as after a Session took it or its Repos changed. */
  readonly of: (environment: string) => Effect.Effect<void>;
};

/**
 * The upkeep of the Environments' spare Workspaces (ADR-0016): one Registry call says what to do (`upkeepSpares`), a
 * stale spare's object is wiped and then its record forgotten, and each spare registered is asked to prepare itself
 * (`prepareSpare`), which its object does on its own time: the answer comes at once. A spare removed leaves its
 * Environment without one, so the call is made once more to register the next. What fails is logged and left: a stale
 * spare is tried again at the next upkeep, and a spare not prepared is readied by the Session that takes it.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const spareUpkeep = (
  registries: Cloudflare.DurableObject<Registry>,
  { workspaces }: Pick<RegistryRpcObjects, "workspaces">,
): Spares => {
  /** Keep the spares of `environments` (all when undefined) current; whether there was anything to do. */
  const keep = (environments: ReadonlyArray<string> | undefined) =>
    Effect.gen(function* () {
      const registry = registries.getByName(REGISTRY_NAME);
      let busy = false;

      for (let round = 1; round <= 2; round++) {
        const work = yield* registry.upkeepSpares({ environments });

        if (work.stale.length === 0 && work.made.length === 0) return busy;

        busy = true;

        let removed = 0;

        for (const id of work.stale) {
          yield* Effect.promise(() => workspaces.destroy(workspaceObjectName(id))).pipe(
            Effect.andThen(registry.forgetSpare({ id })),
            Effect.map(() => {
              removed++;
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning(`Could not remove the stale spare workspace ${id}`, cause),
            ),
          );
        }

        for (const setup of work.made) {
          yield* Effect.promise(() =>
            workspaces.prepareSpare(workspaceObjectName(setup.id), setup),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`Could not ask the spare workspace ${setup.id} to prepare`, cause),
            ),
          );
        }

        if (removed === 0) return busy;
      }

      return busy;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The upkeep of the spare workspaces failed", cause).pipe(Effect.as(true)),
      ),
    );

  let settled = false;

  return {
    all: Effect.gen(function* () {
      if (settled) return;

      if (!(yield* keep(undefined))) settled = true;
    }),
    of: (environment) => Effect.asVoid(keep([environment])),
  };
};

/** How many times a deletion sweeps the Sessions it takes before it gives up on ones that keep starting. */
const SWEEP_ROUNDS = 3;

/** What a sweep says when it stops: after what is kept when a Session cannot be deleted, and when Sessions keep starting. */
type SweepWords = { readonly kept: string; readonly busy: string };

/** What went wrong in `cause`, in a line. */
const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);

  return error instanceof Error ? error.message : String(error);
};

/**
 * The main Worker's `RegistryRpcs` endpoint (`docs/spec.md` → Client and protocol): Effect RPC over HTTP with JSON
 * serialization, answered by the Registry DO, except for what needs a Workspace's or a Session's own object
 * (`RegistryRpcObjects`). It is reachable only through the Access gate in front of the Worker.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const serveRegistryRpc = <R = never>(
  registries: Cloudflare.DurableObject<Registry>,
  { workspaces, sessions, legacy, spares, background }: RegistryRpcObjects<R>,
) =>
  Effect.gen(function* () {
    const registry = registries.getByName(REGISTRY_NAME);

    const failed = (message: string) => EnvironmentError.make({ message });

    const notFound = (id: string) => SessionNotFound.make({ message: `No session "${id}"` });

    /** The Session registered under `id`, or a `SessionNotFound`: no object is woken for a Session nobody made. */
    const known = (id: string) =>
      registry
        .getSession({ id })
        .pipe(Effect.filterOrFail(Predicate.isNotNull, () => notFound(id)));

    /** A call to a Session's object, failing with a `SessionActionError` that says what could not be done and why. */
    const onSession = (what: string, call: Effect.Effect<void>) =>
      call.pipe(
        Effect.catchCause((cause) =>
          Effect.fail(SessionActionError.make({ message: `${what}: ${reason(cause)}` })),
        ),
      );

    /** Wipe a Session's object, then forget it: a wipe that fails leaves it listed, to try again. */
    const deleteSession = (session: SessionRecord) =>
      onSession("Could not delete the session", sessions.destroy(session.id)).pipe(
        Effect.andThen(registry.deleteSession({ id: session.id })),
        Effect.asVoid,
      );

    /** A Workspace call that rejects, as the typed failure a client shows. */
    const inWorkspace = <A>(what: string, call: () => Promise<A>) =>
      Effect.tryPromise({
        try: call,
        catch: (cause) => failed(`${what}: ${reason(Cause.fail(cause))}`),
      });

    /** The Environment registered under `id`, or an `EnvironmentError`. */
    const knownEnvironment = (id: string) =>
      registry
        .getEnvironment({ id })
        .pipe(
          Effect.filterOrFail(Predicate.isNotNull, () =>
            failed(`Environment "${id}" does not exist`),
          ),
        );

    /** The Workspace registered under `id`, or an `EnvironmentError`. */
    const knownWorkspace = (id: string) =>
      registry
        .getWorkspace({ id })
        .pipe(Effect.filterOrFail(Predicate.isNotNull, () => failed(`No workspace "${id}"`)));

    /**
     * Delete every Session `bound` picks (archived ones too), then `wipe` what they worked on, until `settled` says no
     * Session is left: one started meanwhile is deleted the same way and the sweep runs again, a few rounds, then the
     * owner is asked to try again. One Session at a time, so a failure stops it with what is left still listed.
     */
    const sweep = (
      bound: (session: SessionRecord) => boolean,
      wipe: Effect.Effect<void, EnvironmentError>,
      settled: Effect.Effect<boolean, EnvironmentError>,
      words: SweepWords,
    ) =>
      Effect.gen(function* () {
        for (let round = 1; ; round++) {
          for (const session of Arr.filter(yield* registry.listSessions(), bound)) {
            yield* deleteSession(session).pipe(
              Effect.mapError((error) => failed(`${error.message}. ${words.kept}`)),
            );
          }

          yield* wipe;

          if (yield* settled) return;

          if (round === SWEEP_ROUNDS) return yield* failed(words.busy);
        }
      });

    /** Remove a Workspace: its Sessions, then its object (files, Container, settings), then its record. */
    const removeWorkspace = (workspace: WorkspaceRecord) =>
      // The record goes only once none is bound, so no Session is left in a Workspace that is gone.
      sweep(
        (session) => session.workspace === workspace.id,
        inWorkspace("Could not delete the workspace's files", () =>
          workspaces.destroy(workspaceObjectName(workspace.id)),
        ),
        registry
          .deleteWorkspace({ id: workspace.id })
          .pipe(Effect.map((deleted) => deleted !== "in-use")),
        {
          kept: "The workspace and its remaining sessions are kept.",
          busy: "Sessions kept starting in the workspace while it was removed: try again",
        },
      );

    /** Remove an Environment's spare Workspace, if it has one: its object, then its record. */
    const removeSpare = (environment: string) =>
      Effect.gen(function* () {
        const spare = yield* registry.getSpare({ environment });

        if (spare === null) return;

        yield* inWorkspace("Could not delete the spare workspace", () =>
          workspaces.destroy(workspaceObjectName(spare)),
        );
        yield* registry.forgetSpare({ id: spare });
      });

    /** The Environment a naming gave, or why there is none. */
    const named = (naming: EnvironmentNaming, name: string, id?: string) => {
      switch (naming.status) {
        case "named":
          return Effect.succeed(naming.environment);
        case "taken":
          return failed(`Another environment is already named "${name}"`);
        case "missing":
          return failed(`Environment "${id ?? name}" does not exist`);
      }
    };

    /** Why the Registry did not create a Session, for the owner. */
    const refused = (refusal: SessionRefusal, environment: string, branch: string | undefined) => {
      switch (refusal.refused) {
        case "no-environment":
          return failed(`Environment "${environment}" does not exist`);
        case "no-workspace":
          return failed("That workspace does not exist any more");
        case "branch-taken":
          return failed(
            `Workspace "${refusal.workspace}" is already on branch ${branch ?? ""}: start a session in it instead`,
          );
      }
    };

    const handlers = RegistryRpcs.toLayer({
      listSessions: () =>
        registry.listSessions().pipe(
          // What is left from before Environments is wiped behind the Session list the web app polls, and the spares
          // are made where there are none (a fresh deploy, an upkeep that failed).
          Effect.tap(() => background(legacy)),
          Effect.tap(() => background(spares.all)),
        ),
      createSession: ({ title, environment, workspace, branch, base }) =>
        Effect.gen(function* () {
          const existing = workspace !== undefined && workspace !== NEW_WORKSPACE;

          if (existing && (branch !== undefined || base !== undefined)) {
            return yield* failed("A branch and a base are only for a new workspace");
          }

          if (existing) {
            // A Workspace that exists brings its Environment; the Session cannot name another.
            const known = yield* knownWorkspace(workspace);

            if (environment !== undefined && environment !== known.environment) {
              return yield* failed(
                `Workspace "${workspace}" is in environment "${known.environment}"`,
              );
            }

            const created = yield* registry.createSession({
              title,
              workspace: { kind: "existing", id: workspace },
            });

            return "refused" in created
              ? yield* refused(created, known.environment, undefined)
              : created;
          }

          if (branch === SPARE_BRANCH) {
            return yield* failed(
              `Branch ${SPARE_BRANCH} is kept for spare workspaces: name another`,
            );
          }

          const made = environment ?? DEFAULT_ENVIRONMENT;

          const created = yield* registry.createSession({
            title,
            workspace: { kind: "new", environment: made, branch, base },
          });

          if ("refused" in created) return yield* refused(created, made, branch);

          // The Session took the Environment's spare or made a Workspace: either way, the next one is made ahead.
          yield* background(spares.of(made));

          return created;
        }),
      renameSession: ({ id, title }) =>
        registry
          .renameSession({ id, title })
          .pipe(Effect.filterOrFail(Predicate.isNotNull, () => notFound(id))),
      archiveSession: ({ id }) =>
        known(id).pipe(
          // Nothing an archived Session started keeps running: its Runs and subagents stop first.
          Effect.andThen(onSession("Could not stop the session", sessions.stop(id))),
          Effect.andThen(registry.archiveSession({ id })),
          Effect.filterOrFail(Predicate.isNotNull, () => notFound(id)),
        ),
      unarchiveSession: ({ id }) =>
        registry
          .unarchiveSession({ id })
          .pipe(Effect.filterOrFail(Predicate.isNotNull, () => notFound(id))),
      // The Workspace stays, with what the Session left in it, until the owner removes it.
      deleteSession: ({ id }) => known(id).pipe(Effect.flatMap(deleteSession)),
      listEnvironments: () => registry.listEnvironments(),
      createEnvironment: ({ name }) =>
        registry.createEnvironment({ name }).pipe(
          Effect.flatMap((naming) => named(naming, name)),
          Effect.tap((environment) => background(spares.of(environment.id))),
        ),
      renameEnvironment: ({ environment, name }) =>
        registry
          .renameEnvironment({ id: environment, name })
          .pipe(Effect.flatMap((naming) => named(naming, name, environment))),
      deleteEnvironment: ({ environment }) =>
        Effect.gen(function* () {
          // A new Session always has an Environment to start in.
          if (environment === DEFAULT_ENVIRONMENT) {
            return yield* failed("The default environment cannot be deleted");
          }

          yield* knownEnvironment(environment);

          for (let round = 1; ; round++) {
            const made = Arr.filter(
              yield* registry.listWorkspaces(),
              (workspace) => workspace.environment === environment,
            );

            for (const workspace of made) {
              yield* removeWorkspace(workspace).pipe(
                Effect.mapError((error) =>
                  failed(`${error.message} The environment and its remaining workspaces are kept.`),
                ),
              );
            }

            yield* removeSpare(environment).pipe(
              Effect.mapError((error) =>
                failed(`${error.message}. The environment and its remaining workspaces are kept.`),
              ),
            );

            // The record goes only once no Workspace is made from it.
            if ((yield* registry.deleteEnvironment({ id: environment })) !== "in-use") return;

            if (round === SWEEP_ROUNDS) {
              return yield* failed(
                "Workspaces kept being made in the environment while it was deleted: try again",
              );
            }
          }
        }),
      addRepo: ({ environment, source, name }) =>
        Effect.gen(function* () {
          const found = yield* Effect.fromResult(parseRepoSource(source)).pipe(
            Effect.mapError(failed),
          );

          // The owner's own name for the directory, if any, over the repo's.
          const repo = name ?? found.name;
          const added = yield* registry.addRepo({ environment, name: repo, url: found.url });

          switch (added) {
            case "changed":
              // The spare holds the Repos it was made with: one made before is stale now.
              yield* background(spares.of(environment));

              return repo;
            case "taken":
              return yield* failed(`The environment already has a repo in ${repo}: name this one`);
            default:
              return yield* failed(`Environment "${environment}" does not exist`);
          }
        }),
      removeRepo: ({ environment, repo }) =>
        registry.removeRepo({ environment, name: repo }).pipe(
          Effect.flatMap((removed) => {
            switch (removed) {
              case "changed":
                return background(spares.of(environment));
              case "absent":
                return failed(`The environment has no repo "${repo}"`);
              default:
                return failed(`Environment "${environment}" does not exist`);
            }
          }),
        ),
      getEnvironmentSettings: ({ environment }) =>
        registry
          .getEnvironmentSettings({ environment })
          .pipe(
            Effect.filterOrFail(Predicate.isNotNull, () =>
              failed(`Environment "${environment}" does not exist`),
            ),
          ),
      updateEnvironmentSettings: ({ environment, overrides }) =>
        registry.updateEnvironmentSettings({ environment, overrides }).pipe(
          Effect.flatMap((update) => {
            switch (update.status) {
              case "saved":
                return Effect.succeed(update.state);
              // Overrides that do not resolve say why, one problem per line, and nothing was saved.
              case "rejected":
                return failed(update.message);
              case "missing":
                return failed(`Environment "${environment}" does not exist`);
            }
          }),
        ),
      listWorkspaces: () => registry.listWorkspaces(),
      removeWorkspace: ({ id }) => knownWorkspace(id).pipe(Effect.flatMap(removeWorkspace)),
      restartContainer: ({ workspace }) =>
        knownWorkspace(workspace).pipe(
          Effect.andThen(
            inWorkspace("Could not restart the Container", () =>
              workspaces.restartContainer(workspaceObjectName(workspace)),
            ),
          ),
        ),
      getSettings: () => registry.getSettings(),
      getPush: ({ endpoint }) => registry.getPush({ endpoint }),
      subscribePush: ({ subscription }) => registry.subscribePush({ subscription }),
      unsubscribePush: ({ endpoint }) => registry.unsubscribePush({ endpoint }),
      updateSettings: ({ overrides }) =>
        registry.updateSettings({ overrides }).pipe(
          Effect.flatMap(
            SettingsUpdate.$match({
              Saved: ({ state }) => Effect.succeed(state),
              Rejected: ({ message }) => Effect.fail(SettingsError.make({ message })),
            }),
          ),
        ),
    });

    const serve = yield* RpcServer.toHttpEffect(RegistryRpcs).pipe(
      // Each request builds its own server, as a Worker request has no longer-lived scope to build it in.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(Layer.merge(handlers, RpcSerialization.layerJson)),
    );

    return yield* serve;
  }).pipe(Effect.scoped);
