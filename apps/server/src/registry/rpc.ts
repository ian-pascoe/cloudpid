import { SettingsError } from "@cloudpid/config";
import { unpushedWork, unsettledClone } from "@cloudpid/extensions/subagents/workspaces";
import {
  DEFAULT_ENVIRONMENT,
  EnvironmentError,
  fieldRepo,
  fieldSecret,
  fieldSkill,
  fieldVariable,
  MAX_ENVIRONMENT_SECRETS,
  NEW_WORKSPACE,
  parseRepoSource,
  RegistryRpcs,
  SessionActionError,
  type ForkKind,
  ownBranchProblem,
  SessionNotFound,
  forkTitle,
  workspaceDirectory,
} from "@cloudpid/protocol";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type * as Schema from "effect/Schema";
import {
  type ExportPage,
  type ExportRequest,
  fillSession,
  type ForkPlan,
  type ForkQuiet,
  type ForkSourceRequest,
} from "../session/fork.ts";
import type { LookupPlace, WorkspaceLookups } from "../session/lookups.ts";
import { workspaceObjectName } from "../workspace/binding.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import type { Builds } from "./builds.ts";
import type { DraftBranches } from "./draft-branches.ts";
import type { SkillSearcher } from "./skill-search.ts";
import { noEnvironment, noRepo, nameTaken, repoTaken } from "./messages.ts";
import { removals } from "./removal.ts";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";
import {
  type EnvironmentNaming,
  EVERY_ENVIRONMENT_SCOPE,
  type SessionRecord,
  type SessionRefusal,
  type SubagentOwner,
  type WorkspaceRecord,
} from "./store.ts";
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
  /** What a Fork or Clone of Session `id` carries besides its entries (`SessionMethods.forkSource`). */
  readonly forkSource: (id: string, request: ForkSourceRequest) => Effect.Effect<ForkPlan>;
  /** A page of the entries a Fork or Clone of Session `id` copies (`SessionMethods.exportEntries`). */
  readonly exportEntries: (id: string, request: ExportRequest) => Effect.Effect<ExportPage>;
  /** Start filling new Session `id` as a Fork or Clone (`SessionMethods.importStart`). */
  readonly importStart: (id: string) => Effect.Effect<void>;
  /** Append a page of the source's entries to new Session `id` (`SessionMethods.importEntries`). */
  readonly importEntries: (id: string, entries: ReadonlyArray<EntryRecord>) => Effect.Effect<void>;
  /** Give new Session `id` what `plan` carries, and let it take messages (`SessionMethods.importFinish`). */
  readonly importFinish: (id: string, plan: ForkPlan) => Effect.Effect<void>;
  /** Let Session `id` take messages again once a Fork or Clone carried its files (`SessionMethods.releaseFork`). */
  readonly releaseFork: (id: string) => Effect.Effect<void>;
  /**
   * Delete subagent `agent` of Session `id` with its subtree and their Subagent Workspaces
   * (`SessionMethods.deleteSubagent`); why a Subagent Workspace of theirs is still there, one line each.
   */
  readonly deleteSubagent: (
    id: string,
    agent: string,
    workspace: string,
  ) => Effect.Effect<ReadonlyArray<string>>;
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
  /** Keeps each Environment's Build current (`buildUpkeep`), after the answer, and makes one again when asked. */
  readonly builds: Builds;
  /** The draft composer's catalog and `@` menu, looked up in a Workspace's object. */
  readonly lookups: WorkspaceLookups;
  /** The draft's Start from menu: the branches of an Environment's Repos, asked of GitHub. */
  readonly branches: DraftBranches;
  /** The Environments page's search of skills.sh for Skills to install. */
  readonly skillSearch: SkillSearcher;
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
  /**
   * Keep every Environment's spare current. Once a run finds nothing to do, this isolate does no more, until a run of
   * `of` fails.
   */
  readonly all: Effect.Effect<void>;
  /** Keep `environment`'s spare current, as after a Session took it, its Repos changed or it has a new Build. */
  readonly of: (environment: string) => Effect.Effect<void>;
};

/** What a run of the spares' upkeep found: whether there was anything to do, and whether any of it failed. */
type SpareRun = { readonly busy: boolean; readonly failed: boolean };

/**
 * The upkeep of the Environments' spare Workspaces (ADR-0016): one Registry call says what to do (`upkeepSpares`), a
 * stale spare's record is forgotten and then, if it was still a spare (not taken meanwhile), its object wiped, and
 * each spare registered is asked to prepare itself (`prepareSpare`), which its object does on its own time: the answer
 * comes at once. A spare removed leaves its Environment without one, so the call is made once more to register the
 * next. A spare whose record went while it was asked (its Environment deleted, or it went stale) has its object wiped
 * again, since the request made it anew. What fails is logged and left: a stale spare not forgotten is tried again at
 * the next upkeep, one forgotten whose wipe failed is left to its idle stop, a spare not prepared is readied by the
 * Session that takes it, and the runs behind the Session list look at every spare again.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const spareUpkeep = (
  registries: Cloudflare.DurableObject<Registry>,
  { workspaces }: Pick<RegistryRpcObjects, "workspaces">,
): Spares => {
  /** Keep the spares of `environments` (all when undefined) current. */
  const keep = (environments: ReadonlyArray<string> | undefined) =>
    Effect.gen(function* () {
      const registry = registries.getByName(REGISTRY_NAME);
      let busy = false;
      let failed = false;

      /** Log what went wrong, and note that this run failed. */
      const warn = (message: string) => (cause: Cause.Cause<unknown>) =>
        Effect.logWarning(message, cause).pipe(
          Effect.andThen(
            Effect.sync(() => {
              failed = true;
            }),
          ),
        );

      /** Wipe spare `id`'s object. */
      const wipe = (id: string) =>
        Effect.promise(() => workspaces.destroy(workspaceObjectName(id)));

      for (let round = 1; round <= 2; round++) {
        const work = yield* registry.upkeepSpares({ environments });

        if (work.stale.length === 0 && work.made.length === 0) break;

        busy = true;

        let removed = 0;

        for (const id of work.stale) {
          // The record first: one a Session took meanwhile is its Workspace now, and its object is left alone.
          if (!(yield* registry.forgetSpare({ id }))) continue;

          removed++;
          yield* wipe(id).pipe(
            Effect.catchCause(
              warn(`Could not wipe the stale spare workspace ${id}, now forgotten`),
            ),
          );
        }

        for (const setup of work.made) {
          yield* Effect.promise(() =>
            workspaces.prepareSpare(workspaceObjectName(setup.id), setup),
          ).pipe(
            Effect.catchCause(warn(`Could not ask the spare workspace ${setup.id} to prepare`)),
          );

          // A spare forgotten meanwhile (its Environment deleted, or gone stale) was made anew by the request.
          const spare = yield* registry.getSpare({ environment: setup.environment });

          if (spare === setup.id || (yield* registry.getWorkspace({ id: setup.id })) !== null) {
            continue;
          }

          yield* wipe(setup.id).pipe(
            Effect.catchCause(
              warn(`Could not wipe the spare workspace ${setup.id}, forgotten while it was asked`),
            ),
          );
        }

        if (removed === 0) break;
      }

      return { busy, failed } satisfies SpareRun;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The upkeep of the spare workspaces failed", cause).pipe(
          Effect.as<SpareRun>({ busy: true, failed: true }),
        ),
      ),
    );

  /** Whether a run behind the Session list found nothing to do since the last failure. */
  let settled = false;

  return {
    all: Effect.gen(function* () {
      if (settled) return;

      if (!(yield* keep(undefined)).busy) settled = true;
    }),
    // A failure here is retried by the runs behind the Session list.
    of: (environment) =>
      keep([environment]).pipe(
        Effect.map(({ failed }) => {
          if (failed) settled = false;
        }),
      ),
  };
};

/** A setting's value as a refusal shows it: JSON, or "not set" for none. */
const shownValue = (value: Schema.Json | null): string =>
  value === null ? "not set" : JSON.stringify(value);

/**
 * The main Worker's `RegistryRpcs` endpoint (`docs/spec.md` → Client and protocol): Effect RPC over HTTP with JSON
 * serialization, answered by the Registry DO, except for what needs a Workspace's or a Session's own object
 * (`RegistryRpcObjects`). It is reachable only through the Access gate in front of the Worker.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const serveRegistryRpc = <R = never>(
  registries: Cloudflare.DurableObject<Registry>,
  {
    workspaces,
    sessions,
    legacy,
    spares,
    builds,
    lookups,
    branches,
    skillSearch,
    background,
  }: RegistryRpcObjects<R>,
) =>
  Effect.gen(function* () {
    const registry = registries.getByName(REGISTRY_NAME);

    const failed = (message: string) => EnvironmentError.make({ message });

    // The deletes, shared with a Session's `environment_delete` (`removal.ts`).
    const {
      deleteSession,
      removeWorkspace,
      removeSubagentWorkspace,
      deleteEnvironment,
      inWorkspace,
      onSession,
    } = removals(registry, { workspaces, sessions });

    const notFound = (id: string) => SessionNotFound.make({ message: `No session "${id}"` });

    /**
     * Remove Subagent Workspace `workspace` as its Session's `subagent_delete` does: its subagent is deleted with the
     * subtree below it, and their Subagent Workspaces with them (the owner confirmed losing what was not pushed). One
     * whose Session is gone, or whose subagent is, is removed on its own.
     */
    const removeSubagent = (workspace: WorkspaceRecord, owner: SubagentOwner) =>
      Effect.gen(function* () {
        if ((yield* registry.getSession({ id: owner.session })) !== null) {
          const kept = yield* sessions.deleteSubagent(owner.session, owner.agent, workspace.id);

          if (kept.length > 0) return yield* failed(Arr.join(kept, "\n"));
        }

        // Still listed: the subagent was gone already, so nothing removed it.
        if ((yield* registry.getWorkspace({ id: workspace.id })) !== null) {
          yield* removeSubagentWorkspace(workspace);
        }
      });

    /** The Session registered under `id`, or a `SessionNotFound`: no object is woken for a Session nobody made. */
    const known = (id: string) =>
      registry
        .getSession({ id })
        .pipe(Effect.filterOrFail(Predicate.isNotNull, () => notFound(id)));

    /** The Environment registered under `id`, or an `EnvironmentError`. */
    const knownEnvironment = (id: string) =>
      registry
        .getEnvironment({ id })
        .pipe(Effect.filterOrFail(Predicate.isNotNull, () => failed(noEnvironment(id))));

    /** The Workspace registered under `id`, or an `EnvironmentError`. */
    const knownWorkspace = (id: string) =>
      registry
        .getWorkspace({ id })
        .pipe(Effect.filterOrFail(Predicate.isNotNull, () => failed(`No workspace "${id}"`)));

    /**
     * Remove Workspace `id` once its last Session is deleted: its object (files, Container, settings), then its record.
     * The Session is gone whatever happens here, so a failure is logged and leaves the Workspace listed, for the owner to
     * remove; a Session started in it meanwhile keeps the record, and its object is made again as it first works there.
     */
    const removeIfEmpty = (id: string) =>
      Effect.gen(function* () {
        const left = yield* registry.listSessions();

        if (Arr.some(left, (session) => session.workspace === id)) return;

        yield* inWorkspace("Could not delete the workspace's files", () =>
          workspaces.destroy(workspaceObjectName(id)),
        );

        if ((yield* registry.deleteWorkspace({ id })) === "in-use") {
          yield* Effect.logWarning(
            `Workspace ${id} got a Session while it was removed, and is kept`,
          );
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Could not remove workspace ${id} with its last session`, error),
        ),
      );

    /** The Environment a naming gave, or why there is none. */
    const named = (naming: EnvironmentNaming, name: string, id?: string) => {
      switch (naming.status) {
        case "named":
          return Effect.succeed(naming.environment);
        case "taken":
          return failed(nameTaken(name));
        case "missing":
          return failed(noEnvironment(id ?? name));
      }
    };

    /** Where a Secret is kept, in words. */
    const scopeWords = (environment: string | null) =>
      environment === null ? "every environment" : `environment "${environment}"`;

    /**
     * After a Secret or a variable kept for every Environment changed: every Environment's Build is looked at again
     * (their key covers the Secrets and variables a Build gets).
     */
    const everyEnvironmentChanged = () =>
      registry
        .listEnvironments()
        .pipe(
          Effect.flatMap((all) =>
            Effect.forEach(all, (item) => background(builds.of(item.id)), { discard: true }),
          ),
        );

    /**
     * After a kept Secret changed: the Builds it may reach are looked at again (their key covers the Secrets a Build
     * gets), each Environment's for one kept for every Environment.
     */
    const secretChanged = (environment: string | null) =>
      environment === null ? everyEnvironmentChanged() : background(builds.of(environment));

    /**
     * The Workspace whose files a Fork or Clone carries to a new one (`fresh`), after checking the Git branch asked for;
     * none for one in its source's Workspace, which takes no branch.
     */
    const carriedWorkspace = (origin: SessionRecord, fresh: boolean, branch: string | undefined) =>
      Effect.gen(function* () {
        if (!fresh) {
          return branch === undefined
            ? undefined
            : yield* failed("A branch is only for a new workspace");
        }

        const problem = branch === undefined ? undefined : ownBranchProblem(branch);

        if (problem !== undefined) return yield* failed(problem);

        return yield* knownWorkspace(origin.workspace);
      });

    /** Register Fork or Clone `kind` of `origin`: in its Workspace, or in a new one of `carried`'s Environment on `branch`. */
    const registerFork = (
      origin: SessionRecord,
      kind: ForkKind,
      carried: WorkspaceRecord | undefined,
      branch: string | undefined,
    ) =>
      Effect.gen(function* () {
        const created = yield* registry.createSession({
          title: forkTitle(origin.title, kind),
          workspace:
            carried === undefined
              ? { kind: "existing", id: origin.workspace }
              : { kind: "new", environment: carried.environment, branch },
          origin: { session: origin.id, kind },
        });

        if ("refused" in created) return yield* refused(created, origin.environment, branch);

        if (carried !== undefined) {
          // The Session took the Environment's spare or made a Workspace: either way, the next one is made ahead.
          yield* background(spares.of(carried.environment));
          yield* background(builds.of(carried.environment));
        }

        return created;
      });

    /**
     * Fill Fork or Clone `created` with what `plan` of Session `source` carries, then carry `carried`'s files to its new
     * Workspace. When anything fails, nothing is left of it: its Session, and the Workspace made for it with it.
     */
    const fillFork = (
      source: string,
      created: SessionRecord,
      plan: ForkPlan,
      carried: WorkspaceRecord | undefined,
      kind: ForkKind,
    ) => {
      // The files go last, so a Fork that failed pushed nothing.
      const fill = Effect.gen(function* () {
        yield* onSession(
          `Could not ${kind} the session`,
          fillSession(
            { exportEntries: (request) => sessions.exportEntries(source, request) },
            {
              importStart: sessions.importStart(created.id),
              importEntries: (entries) => sessions.importEntries(created.id, entries),
              importFinish: (finished) => sessions.importFinish(created.id, finished),
            },
            plan,
          ),
        );

        if (carried === undefined) return;

        const made = yield* knownWorkspace(created.workspace);

        yield* inWorkspace("Could not carry the workspace's files", () =>
          workspaces.carry(workspaceObjectName(carried.id), made.branch, carried.repos),
        );
      });

      const undo: Effect.Effect<void, EnvironmentError | SessionActionError> =
        carried === undefined
          ? deleteSession(created)
          : knownWorkspace(created.workspace).pipe(Effect.flatMap(removeWorkspace));

      return fill.pipe(
        Effect.tapError(() =>
          undo.pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Could not remove the failed ${kind} ${created.id}`, error),
            ),
          ),
        ),
      );
    };

    /**
     * Where the draft composer looks for a Session made with `environment` and `workspace`: that Workspace's directory,
     * or for a new one the Environment's spare's, which a new Session takes (with the same Repos). Null when a new
     * Workspace has no spare to look in: no object is woken for a Workspace nobody made.
     */
    const draftPlace = (environment: string, workspace: string) =>
      Effect.gen(function* () {
        const known = yield* knownEnvironment(environment);

        if (workspace === NEW_WORKSPACE) {
          const spare = yield* registry.getSpare({ environment });

          // Where a new Workspace of the Environment's Repos works, as the spare does.
          return spare === null
            ? null
            : ({
                object: workspaceObjectName(spare),
                directory: workspaceDirectory(Arr.map(known.repos, (repo) => repo.name)),
              } satisfies LookupPlace);
        }

        const record = yield* knownWorkspace(workspace);

        if (record.environment !== environment) {
          return yield* failed(
            `Workspace "${workspace}" is in environment "${record.environment}"`,
          );
        }

        return {
          object: workspaceObjectName(record.id),
          directory: record.directory,
        } satisfies LookupPlace;
      });

    /** Why the Registry did not create a Session, for the owner. */
    const refused = (refusal: SessionRefusal, environment: string, branch: string | undefined) => {
      switch (refusal.refused) {
        case "no-environment":
          return failed(noEnvironment(environment));
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
          // What is left from before Environments is wiped behind the Session list the web app polls, the spares are
          // made where there are none (a fresh deploy, an upkeep that failed), and the Builds are kept current.
          Effect.tap(() => background(legacy)),
          Effect.tap(() => background(spares.all)),
          Effect.tap(() => background(builds.all)),
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

          const problem = branch === undefined ? undefined : ownBranchProblem(branch);

          if (problem !== undefined) return yield* failed(problem);

          const made = environment ?? DEFAULT_ENVIRONMENT;

          const created = yield* registry.createSession({
            title,
            workspace: { kind: "new", environment: made, branch, base },
          });

          if ("refused" in created) return yield* refused(created, made, branch);

          // The Session took the Environment's spare or made a Workspace: either way, the next one is made ahead.
          yield* background(spares.of(made));
          yield* background(builds.of(made));

          return created;
        }),
      forkSession: ({ source, point, workspace, branch }) =>
        Effect.gen(function* () {
          const origin = yield* known(source);
          const fresh = workspace === NEW_WORKSPACE;
          const carried = yield* carriedWorkspace(origin, fresh, branch);
          const kind: ForkKind = point === undefined ? "clone" : "fork";

          // A Clone takes the branch as it stands, and a new Workspace the files as they are: what changes them must rest.
          const quiet: ForkQuiet = fresh ? "session" : kind === "clone" ? "branch" : "none";
          const asked: ForkSourceRequest = point === undefined ? { quiet } : { point, quiet };

          const plan = yield* onSession(
            `Could not ${kind} the session`,
            sessions.forkSource(source, asked),
          );

          // A source whose files are carried takes no message until they are.
          const released =
            quiet === "session"
              ? sessions
                  .releaseFork(source)
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        `Could not release session ${source} after a ${kind}`,
                        cause,
                      ),
                    ),
                  )
              : Effect.void;

          const created = yield* Effect.ensuring(
            registerFork(origin, kind, carried, branch).pipe(
              Effect.tap((made) => fillFork(source, made, plan, carried, kind)),
            ),
            released,
          );

          return { session: created, text: plan.text };
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
      // A Workspace is removed with its last Session, archived ones counted; else it stays, with what the Session left.
      deleteSession: ({ id }) =>
        known(id).pipe(
          Effect.tap(deleteSession),
          Effect.flatMap((session) => removeIfEmpty(session.workspace)),
        ),
      listEnvironments: () => registry.listEnvironments(),
      createEnvironment: ({ name }) =>
        registry.createEnvironment({ name }).pipe(
          Effect.flatMap((naming) => named(naming, name)),
          Effect.tap((environment) => background(spares.of(environment.id))),
          Effect.tap((environment) => background(builds.of(environment.id))),
        ),
      renameEnvironment: ({ environment, name }) =>
        registry
          .renameEnvironment({ id: environment, name })
          .pipe(Effect.flatMap((naming) => named(naming, name, environment))),
      deleteEnvironment: ({ environment }) => deleteEnvironment(environment),
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
              // The spare holds the Repos it was made with: one made before is stale now, and so is the Build.
              yield* background(spares.of(environment));
              yield* background(builds.of(environment));

              return repo;
            case "taken":
              return yield* failed(repoTaken(repo));
            default:
              return yield* failed(noEnvironment(environment));
          }
        }),
      removeRepo: ({ environment, repo }) =>
        registry.removeRepo({ environment, name: repo }).pipe(
          Effect.flatMap((removed) => {
            switch (removed) {
              case "changed":
                return background(spares.of(environment)).pipe(
                  Effect.andThen(background(builds.of(environment))),
                );
              case "absent":
                return failed(noRepo(repo));
              default:
                return failed(noEnvironment(environment));
            }
          }),
        ),
      getEnvironmentSettings: ({ environment }) =>
        registry
          .getEnvironmentSettings({ environment })
          .pipe(Effect.filterOrFail(Predicate.isNotNull, () => failed(noEnvironment(environment)))),
      updateEnvironmentSettings: ({ environment, overrides }) =>
        registry.updateEnvironmentSettings({ environment, overrides }).pipe(
          Effect.flatMap((update) => {
            switch (update.status) {
              case "saved":
                // The variables, the Setup Script and the Container-only paths are what a Build is made with.
                return background(builds.of(environment)).pipe(Effect.as(update.state));
              // Overrides that do not resolve say why, one problem per line, and nothing was saved.
              case "rejected":
                return failed(update.message);
              case "missing":
                return failed(noEnvironment(environment));
            }
          }),
        ),
      getEveryEnvironmentSettings: () => registry.getEveryEnvironmentSettings(),
      updateEveryEnvironmentSettings: ({ overrides }) =>
        registry.updateEveryEnvironmentSettings({ overrides }).pipe(
          Effect.flatMap((update) => {
            switch (update.status) {
              case "saved":
                // A Build is made with the variables, so every Environment's is looked at again.
                return everyEnvironmentChanged().pipe(Effect.as(update.state));
              // Overrides that do not resolve say why, one problem per line, and nothing was saved.
              case "rejected":
                return failed(update.message);
            }
          }),
        ),
      listAgentChanges: ({ environment }) =>
        registry
          .listAgentChanges({ environment })
          .pipe(Effect.filterOrFail(Predicate.isNotNull, () => failed(noEnvironment(environment)))),
      revertAgentChange: ({ environment, change }) =>
        registry.revertAgentChange({ environment, change }).pipe(
          Effect.flatMap((revert) => {
            switch (revert.status) {
              case "reverted":
                // A Skill is not part of a Build: its Workspaces take the set at their next readying.
                if (fieldSkill(revert.change.field) !== null) return Effect.succeed(revert.change);

                // A variable put back: as after the owner's save, every Environment's Build is looked at again.
                if (
                  environment === EVERY_ENVIRONMENT_SCOPE &&
                  fieldVariable(revert.change.field) !== null
                ) {
                  return everyEnvironmentChanged().pipe(Effect.as(revert.change));
                }

                // A Build mark put back: as after the owner's switch, the Builds the Secret may reach are looked at
                // again, each Environment's for one kept for every Environment (scope `*`).
                if (fieldSecret(revert.change.field) !== null) {
                  return secretChanged(
                    environment === EVERY_ENVIRONMENT_SCOPE ? null : environment,
                  ).pipe(Effect.as(revert.change));
                }

                // As after the owner's save: the variables are among what a Build is made with. A Repo put back or
                // taken out also makes the spare stale, as the owner's \`addRepo\` and \`removeRepo\` do.
                return (
                  fieldRepo(revert.change.field) === null
                    ? Effect.void
                    : background(spares.of(environment))
                ).pipe(
                  Effect.andThen(background(builds.of(environment))),
                  Effect.as(revert.change),
                );
              case "changed-since":
                return failed(
                  `${revert.field} has changed since: it is ${shownValue(revert.current)} now, so the change is not reverted`,
                );
              case "refused":
                return failed(revert.message);
              case "missing":
                return failed(`Environment "${environment}" has no change ${change}`);
            }
          }),
        ),
      dismissAgentChange: ({ environment, change }) =>
        registry.dismissAgentChange({ environment, change }).pipe(
          Effect.filterOrFail(Predicate.isTruthy, () =>
            failed(`Environment "${environment}" has no change ${change}`),
          ),
          Effect.asVoid,
        ),
      skillChangeFiles: ({ environment, change }) =>
        registry
          .skillChangeFiles({ environment, change })
          .pipe(
            Effect.filterOrFail(Predicate.isNotNull, () =>
              failed(`Environment "${environment}" has no change ${change} of a Skill`),
            ),
          ),
      listEnvironmentSkills: ({ environment }) =>
        registry
          .listSkills({ environment })
          .pipe(Effect.filterOrFail(Predicate.isNotNull, () => failed(noEnvironment(environment)))),
      // Each Workspace of the Environment is handed its Skill set without it at its next readying; Skills are not part
      // of a Build, so no upkeep runs.
      removeEnvironmentSkill: ({ environment, name }) =>
        registry.removeSkill({ environment, name }).pipe(
          Effect.flatMap((removed) => {
            switch (removed.status) {
              case "removed":
                return Effect.void;
              case "absent":
                return failed(`The environment keeps no Skill named ${JSON.stringify(name)}`);
              case "rejected":
                return failed(`Not removed: ${removed.message}`);
              case "missing":
                return failed(noEnvironment(environment));
            }
          }),
        ),
      // Fetched by the Registry as the GitHub App; each Workspace of the Environment (of every Environment, for `*`) is
      // handed its Skill set with the Skills at its next readying. The owner's install is not an Agent change, as the
      // owner's removal is not.
      installEnvironmentSkills: ({ environment, source, skills }) =>
        Effect.gen(function* () {
          const installation = yield* registry.installSkills({ environment, source, skills });

          switch (installation.status) {
            case "missing":
              return yield* failed(noEnvironment(environment));
            case "refused":
              return yield* failed(installation.message);
            case "listed":
              return {
                status: "listed" as const,
                repo: installation.repo,
                ref: installation.ref,
                commit: installation.commit,
                available: installation.available,
              };
            case "installed":
              return {
                status: "installed" as const,
                repo: installation.repo,
                ref: installation.ref,
                commit: installation.commit,
                skills: Arr.map(installation.results, ({ name, outcome, message }) => {
                  const shown = { name, outcome };

                  return message === undefined ? shown : { ...shown, message };
                }),
              };
          }
        }),
      // As the install: fetched by the Registry as the GitHub App, not an Agent change, no Approval even for `*`. Each
      // Workspace of the Environment is handed its Skill set with the Skills at its next readying.
      updateEnvironmentSkills: ({ environment, names, overwrite }) =>
        Effect.gen(function* () {
          const updates = yield* registry.updateSkills({
            environment,
            names,
            overwrite: overwrite === true,
          });

          switch (updates.status) {
            case "missing":
              return yield* failed(noEnvironment(environment));
            case "refused":
              return yield* failed(updates.message);
            case "nothing":
              return { skills: [] };
            case "done":
              return {
                skills: Arr.map(updates.results, (result) => {
                  switch (result.outcome) {
                    case "updated":
                      return { name: result.name, outcome: "updated" as const };
                    case "changed-since":
                      return {
                        name: result.name,
                        outcome: "rejected" as const,
                        message: result.message,
                      };
                    default:
                      return {
                        name: result.name,
                        outcome: result.outcome,
                        message: result.message,
                      };
                  }
                }),
              };
          }
        }),
      searchSkills: ({ query }) =>
        Effect.gen(function* () {
          const found = yield* skillSearch(query);

          return found.ok ? found.results : yield* failed(found.message);
        }),
      listBuilds: () =>
        registry.listBuilds().pipe(
          // The Environments page asks again while a Build is under way, which records it once it ends.
          Effect.tap(() => background(builds.all)),
        ),
      rebuildEnvironment: ({ environment }) =>
        knownEnvironment(environment).pipe(
          Effect.andThen(builds.rebuild(environment).pipe(Effect.asVoid, Effect.mapError(failed))),
        ),
      listEnvironmentSecrets: () => registry.listEnvironmentSecrets(),
      setEnvironmentSecret: ({ environment, name, value, build }) =>
        registry.setEnvironmentSecret({ environment, name, value, build }).pipe(
          Effect.flatMap((written) => {
            switch (written.status) {
              case "saved":
                return secretChanged(environment).pipe(Effect.as(written.record));
              // Says what is wrong with the name or the value, never the value itself.
              case "rejected":
                return failed(written.message);
              case "missing":
                return failed(noEnvironment(environment ?? ""));
              case "full":
                return failed(
                  `At most ${MAX_ENVIRONMENT_SECRETS} Secrets are kept for ${scopeWords(environment)}: delete one first`,
                );
            }
          }),
        ),
      setEnvironmentSecretBuild: ({ environment, name, build }) =>
        registry.setEnvironmentSecretBuild({ environment, name, build }).pipe(
          Effect.filterOrFail(Predicate.isNotNull, () =>
            failed(`No Secret ${name} is kept for ${scopeWords(environment)}`),
          ),
          Effect.tap(() => secretChanged(environment)),
        ),
      deleteEnvironmentSecret: ({ environment, name }) =>
        registry
          .deleteEnvironmentSecret({ environment, name })
          .pipe(
            Effect.flatMap((deleted) =>
              deleted
                ? secretChanged(environment)
                : failed(`No Secret ${name} is kept for ${scopeWords(environment)}`),
            ),
          ),
      listWorkspaces: () => registry.listWorkspaces(),
      draftCatalog: ({ environment, workspace }) =>
        draftPlace(environment, workspace).pipe(
          Effect.flatMap((place) =>
            place === null
              ? Effect.succeed({ commands: [], templates: [], skills: [] })
              : lookups.catalog(place),
          ),
        ),
      draftFiles: ({ environment, workspace, query }) =>
        draftPlace(environment, workspace).pipe(
          Effect.flatMap((place) =>
            place === null ? Effect.succeed({ paths: [] }) : lookups.files(place, query),
          ),
        ),
      draftBranches: ({ environment }) =>
        knownEnvironment(environment).pipe(Effect.flatMap((known) => branches(known.repos))),
      removeWorkspace: ({ id }) =>
        knownWorkspace(id).pipe(
          Effect.flatMap((workspace) =>
            workspace.subagent === undefined
              ? removeWorkspace(workspace)
              : removeSubagent(workspace, workspace.subagent),
          ),
        ),
      // A clone missing or on another branch than the Workspace's is listed as not set up: its work is not known to be
      // pushed, so the confirmation does not call it clean.
      workspaceWork: ({ id }) =>
        knownWorkspace(id).pipe(
          Effect.flatMap((workspace) =>
            inWorkspace("Could not read what the workspace has not pushed", () =>
              workspaces.workState(workspaceObjectName(id), workspace.branch, workspace.repos),
            ).pipe(
              Effect.map((states) =>
                Arr.map(unpushedWork(states, workspace.branch), (state) => {
                  const unsettled = unsettledClone(state, workspace.branch);
                  const { repo, uncommitted, unpushed } = state;

                  return unsettled === undefined
                    ? { repo, uncommitted, unpushed }
                    : { repo, uncommitted, unpushed, unsettled };
                }),
              ),
            ),
          ),
        ),
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
      listSettingsChanges: () => registry.listSettingsChanges(),
      revertSettingsChange: ({ change }) =>
        registry.revertSettingsChange({ change }).pipe(
          Effect.flatMap((revert) => {
            switch (revert.status) {
              case "reverted":
                return Effect.succeed(revert.change);
              case "changed-since":
                return Effect.fail(
                  SettingsError.make({
                    message: `${revert.field} has changed since: it is ${shownValue(revert.current)} now, so the change is not reverted`,
                  }),
                );
              case "refused":
                return Effect.fail(SettingsError.make({ message: revert.message }));
              case "missing":
                return Effect.fail(
                  SettingsError.make({ message: `The Settings have no change ${change}` }),
                );
            }
          }),
        ),
      dismissSettingsChange: ({ change }) =>
        registry.dismissSettingsChange({ change }).pipe(
          Effect.filterOrFail(Predicate.isTruthy, () =>
            SettingsError.make({ message: `The Settings have no change ${change}` }),
          ),
          Effect.asVoid,
        ),
    });

    const serve = yield* RpcServer.toHttpEffect(RegistryRpcs).pipe(
      // Each request builds its own server, as a Worker request has no longer-lived scope to build it in.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(Layer.merge(handlers, RpcSerialization.layerJson)),
    );

    return yield* serve;
  }).pipe(Effect.scoped);
