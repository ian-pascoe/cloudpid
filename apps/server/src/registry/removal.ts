// Deleting Sessions, Workspaces and Environments with what they hold (`docs/architecture/workspace.md` → Environments): the Registry's
// records and the objects behind them, in the order that leaves nothing behind a record. The main Worker's endpoint
// runs it for the owner (`rpc.ts`), and a Session runs the Environment's delete for the agent's `environment_delete`
// once the owner approved it (`docs/architecture/agent-changes.md` → Approval), so the two delete the same way.
// @effect-diagnostics missingPipeableSignature:off
import { DEFAULT_ENVIRONMENT, EnvironmentError, SessionActionError } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { buildObjectName, testBuildObjectName, workspaceObjectName } from "../workspace/binding.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import { noEnvironment, reason, thenSaying } from "./messages.ts";
import type { RegistryMethods } from "./Registry.ts";
import type { SessionObjects } from "./rpc.ts";
import type { SessionRecord, WorkspaceRecord } from "./store.ts";
import type { TriggerObjects } from "../trigger/objects.ts";

/** What the deletes read and change in the Registry. */
export type RemovalRegistry = Pick<
  RegistryMethods,
  | "getEnvironment"
  | "getSession"
  | "listSessions"
  | "deleteSession"
  | "listWorkspaces"
  | "deleteWorkspace"
  | "deleteWorkspaceWithTriggers"
  | "deleteWorkspaceTriggers"
  | "workspaceKept"
  | "listSubagentWorkspaces"
  | "getSpare"
  | "forgetSpare"
  | "deleteEnvironmentWithTriggers"
>;

/**
 * What the deletes wipe besides the records: the Workspaces' objects (and Build objects), the Sessions', and the
 * objects of the Triggers that went with a Workspace or an Environment.
 */
export type RemovalObjects = {
  readonly workspaces: Pick<WorkspaceObjects, "destroy">;
  readonly sessions: Pick<SessionObjects, "destroy">;
  readonly triggers: Pick<TriggerObjects, "remove">;
};

/** Why the default Environment is not deleted. */
export const DEFAULT_KEPT = "The default environment cannot be deleted";

/** How many times a deletion sweeps the Sessions it takes before it gives up on ones that keep starting. */
const SWEEP_ROUNDS = 3;

/** What a sweep says when it stops: after what is kept when a Session cannot be deleted, and when Sessions keep starting. */
type SweepWords = { readonly kept: string; readonly busy: string };

/** The deletes over `registry` and `objects`. */
export const removals = (
  registry: RemovalRegistry,
  { workspaces, sessions, triggers }: RemovalObjects,
) => {
  const failed = (message: string) => EnvironmentError.make({ message });

  /** A failure partway through deleting an Environment, saying what is left. */
  const environmentKept = (error: EnvironmentError) =>
    failed(thenSaying(error.message, "The environment and its remaining workspaces are kept."));

  /** A call to a Session's object, failing with a `SessionActionError` that says what could not be done and why. */
  const onSession = <A>(what: string, call: Effect.Effect<A>) =>
    call.pipe(
      Effect.catchCause((cause) =>
        Effect.fail(SessionActionError.make({ message: `${what}: ${reason(cause)}` })),
      ),
    );

  /** A Workspace call that rejects, as the typed failure a client shows. */
  const inWorkspace = <A>(what: string, call: () => Promise<A>) =>
    Effect.tryPromise({
      try: call,
      catch: (cause) => failed(`${what}: ${reason(Cause.fail(cause))}`),
    });

  /**
   * Remove a Subagent Workspace: its object (files, Container, settings), then its record. No Session is bound to one,
   * so nothing else goes with it.
   */
  const removeSubagentWorkspace = (workspace: WorkspaceRecord) =>
    inWorkspace("Could not delete the subagent workspace's files", () =>
      workspaces.destroy(workspaceObjectName(workspace.id)),
    ).pipe(Effect.andThen(registry.deleteWorkspace({ id: workspace.id })), Effect.asVoid);

  /** Remove Session `id`'s Subagent Workspaces, then forget it: its object is wiped already. */
  const forgetSession = (id: string) =>
    Effect.gen(function* () {
      for (const workspace of yield* registry.listSubagentWorkspaces({ session: id })) {
        yield* removeSubagentWorkspace(workspace).pipe(
          Effect.mapError((error) =>
            SessionActionError.make({
              message: thenSaying(error.message, "The session is kept."),
            }),
          ),
        );
      }

      yield* registry.deleteSession({ id });
    });

  /**
   * Wipe a Session's object, then its Subagent Workspaces, then forget it: a wipe that fails leaves it listed (with the
   * Subagent Workspaces left), to try again. The object goes first, so no subagent spawned meanwhile makes another.
   */
  const deleteSession = (session: SessionRecord) =>
    onSession("Could not delete the session", sessions.destroy(session.id)).pipe(
      Effect.andThen(forgetSession(session.id)),
    );

  /**
   * Remove Workspace `id` with the Session that left it, when no Session is left in it and no Workspace trigger keeps
   * it (`docs/architecture/triggers.md` → Kinds and what a Fire delivers to). The Session is gone whatever happens here,
   * so a failure is logged and leaves the Workspace listed, for the owner to remove. A Session started in it meanwhile,
   * or a Workspace trigger made for it, keeps the record (`deleteWorkspace` answers `in-use` once the object is wiped),
   * and the object is made again as a Session first works there.
   */
  const removeIfEmpty = (id: string) =>
    Effect.gen(function* () {
      const left = yield* registry.listSessions();

      if (Arr.some(left, (session) => session.workspace === id)) return;

      // Kept with its files: the Trigger's next Fire works on them.
      if (yield* registry.workspaceKept({ id })) return;

      yield* inWorkspace("Could not delete the workspace's files", () =>
        workspaces.destroy(workspaceObjectName(id)),
      );

      if ((yield* registry.deleteWorkspace({ id })) === "in-use") {
        yield* Effect.logWarning(
          `Workspace ${id} got a Session or a Workspace trigger while it was removed, and is kept: its files are made again as a Session first works there`,
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Could not remove workspace ${id} with its last session`, error),
      ),
    );

  /**
   * Delete Session `id` as the owner's delete does: its object, then its record, then its Workspace if it was the last
   * Session in it. A Session the Registry does not list is already gone.
   */
  const removeSession = (id: string) =>
    Effect.gen(function* () {
      const known = yield* registry.getSession({ id });

      if (known === null) return;

      yield* deleteSession(known);
      yield* removeIfEmpty(known.workspace);
    });

  /**
   * A Session deleting itself (an import that expired): its record and Workspace go first, and `wipe`, which empties the
   * Session's own storage, last, so a failure before it leaves the Session to try again, and one after it leaves nothing
   * that points at an object that is gone. A Session the Registry no longer lists is only wiped.
   */
  const removeOwnSession = (id: string, wipe: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const known = yield* registry.getSession({ id });

      if (known !== null) {
        yield* forgetSession(id);
        yield* removeIfEmpty(known.workspace);
      }

      yield* wipe;
    });

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
            Effect.mapError((error) => failed(thenSaying(error.message, words.kept))),
          );
        }

        yield* wipe;

        if (yield* settled) return;

        if (round === SWEEP_ROUNDS) return yield* failed(words.busy);
      }
    });

  /** Wipe the objects of Triggers `ids`, which would wipe themselves at their next alarm. */
  const wipeTriggers = (ids: ReadonlyArray<string>) =>
    Effect.forEach(ids, triggers.remove, { discard: true });

  /**
   * Remove a Workspace: its Triggers first (their records, then their objects), so no waiting Fire starts a Session in a
   * Workspace being torn down; then its Sessions, then its object (files, Container, settings), then its record, which
   * takes a Trigger made meanwhile with it (`docs/architecture/triggers.md` → Cascades). The record goes only once no
   * Session is bound, so none is left in a Workspace that is gone.
   */
  const removeWorkspace = (workspace: WorkspaceRecord) =>
    registry.deleteWorkspaceTriggers({ id: workspace.id }).pipe(
      Effect.flatMap(wipeTriggers),
      Effect.andThen(
        sweep(
          (session) => session.workspace === workspace.id,
          inWorkspace("Could not delete the workspace's files", () =>
            workspaces.destroy(workspaceObjectName(workspace.id)),
          ),
          registry.deleteWorkspaceWithTriggers({ id: workspace.id }).pipe(
            Effect.tap((removal) => wipeTriggers(removal.triggers)),
            Effect.map((removal) => removal.deletion !== "in-use"),
          ),
          {
            kept: "The workspace and its remaining sessions are kept.",
            busy: "Sessions kept starting in the workspace while it was removed: try again",
          },
        ),
      ),
    );

  /** Remove an Environment's spare Workspace, if it has one: its record, then its object. */
  const removeSpare = (environment: string) =>
    Effect.gen(function* () {
      const spare = yield* registry.getSpare({ environment });

      // The record first: a spare a Session took meanwhile is a Workspace of the Environment now, which the sweep
      // removes as one, and a spare upkeep that asks it to prepare after the wipe finds it forgotten.
      if (spare === null || !(yield* registry.forgetSpare({ id: spare }))) return;

      yield* inWorkspace("Could not delete the spare workspace", () =>
        workspaces.destroy(workspaceObjectName(spare)),
      );
    });

  /**
   * Remove an Environment's Build object (`buildObjectName`) and its Test Build object (`testBuildObjectName`): their
   * Containers, their Builds' records.
   */
  const removeBuild = (environment: string) =>
    inWorkspace("Could not delete the environment's Build", () =>
      workspaces.destroy(buildObjectName(environment)),
    ).pipe(
      Effect.andThen(
        inWorkspace("Could not delete the environment's Test Build", () =>
          workspaces.destroy(testBuildObjectName(environment)),
        ),
      ),
    );

  /**
   * Delete Environment `environment` with everything made from it: its Workspaces with their Sessions (archived ones
   * too), its spare Workspace and its Build object, then its record, which takes its kept Secrets, Agent changes and
   * Triggers (`docs/architecture/triggers.md` → Cascades), whose objects are wiped after it. A Workspace made
   * meanwhile is removed the same way, a few rounds; a failure says what is left. The default
   * Environment is never deleted.
   */
  const deleteEnvironment = (environment: string) =>
    Effect.gen(function* () {
      // A new Session always has an Environment to start in.
      if (environment === DEFAULT_ENVIRONMENT) return yield* failed(DEFAULT_KEPT);

      if ((yield* registry.getEnvironment({ id: environment })) === null) {
        return yield* failed(noEnvironment(environment));
      }

      for (let round = 1; ; round++) {
        const made = Arr.filter(
          yield* registry.listWorkspaces(),
          (workspace) => workspace.environment === environment,
        );

        for (const workspace of made) {
          yield* removeWorkspace(workspace).pipe(Effect.mapError(environmentKept));
        }

        yield* removeSpare(environment).pipe(Effect.mapError(environmentKept));
        yield* removeBuild(environment).pipe(Effect.mapError(environmentKept));

        // The record goes only once no Workspace is made from it.
        const removal = yield* registry.deleteEnvironmentWithTriggers({ id: environment });
        const deleted = removal.deletion;

        if (deleted === "refused") return yield* failed(DEFAULT_KEPT);

        if (deleted === "deleted") {
          // Its Triggers went with the record: their objects are wiped, or wipe themselves at their next alarm.
          yield* Effect.forEach(removal.triggers, triggers.remove, { discard: true });

          // A Build upkeep that asked the Build object for a Build after its wipe made it anew; one that asks
          // after this finds the Environment gone (`buildUpkeep`).
          yield* removeBuild(environment).pipe(
            Effect.catch((error) => Effect.logWarning(error.message)),
          );
        }

        if (deleted !== "in-use") return;

        if (round === SWEEP_ROUNDS) {
          return yield* failed(
            "Workspaces kept being made in the environment while it was deleted: try again",
          );
        }
      }
    });

  return {
    deleteSession,
    removeSession,
    removeOwnSession,
    removeWorkspace,
    removeIfEmpty,
    removeSubagentWorkspace,
    deleteEnvironment,
    inWorkspace,
    onSession,
  };
};
