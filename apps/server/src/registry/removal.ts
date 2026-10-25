// Deleting Sessions, Workspaces and Environments with what they hold (`docs/spec.md` → Environments): the Registry's
// records and the objects behind them, in the order that leaves nothing behind a record. The main Worker's endpoint
// runs it for the owner (`rpc.ts`), and a Session runs the Environment's delete for the agent's `environment_delete`
// once the owner approved it (`docs/spec.md` → Approval), so the two delete the same way.
// @effect-diagnostics missingPipeableSignature:off
import { DEFAULT_ENVIRONMENT, EnvironmentError, SessionActionError } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import {
  buildObjectName,
  testBuildObjectName,
  workspaceObjectName,
} from "../workspace/binding.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import { noEnvironment, reason, thenSaying } from "./messages.ts";
import type { RegistryMethods } from "./Registry.ts";
import type { SessionObjects } from "./rpc.ts";
import type { SessionRecord, WorkspaceRecord } from "./store.ts";

/** What the deletes read and change in the Registry. */
export type RemovalRegistry = Pick<
  RegistryMethods,
  | "getEnvironment"
  | "listSessions"
  | "deleteSession"
  | "listWorkspaces"
  | "deleteWorkspace"
  | "getSpare"
  | "forgetSpare"
  | "deleteEnvironment"
>;

/** What the deletes wipe besides the records: the Workspaces' objects (and Build objects), and the Sessions'. */
export type RemovalObjects = {
  readonly workspaces: Pick<WorkspaceObjects, "destroy">;
  readonly sessions: Pick<SessionObjects, "destroy">;
};

/** Why the default Environment is not deleted. */
export const DEFAULT_KEPT = "The default environment cannot be deleted";

/** How many times a deletion sweeps the Sessions it takes before it gives up on ones that keep starting. */
const SWEEP_ROUNDS = 3;

/** What a sweep says when it stops: after what is kept when a Session cannot be deleted, and when Sessions keep starting. */
type SweepWords = { readonly kept: string; readonly busy: string };

/** The deletes over `registry` and `objects`. */
export const removals = (registry: RemovalRegistry, { workspaces, sessions }: RemovalObjects) => {
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
   * too), its spare Workspace and its Build object, then its record, which takes its kept Secrets and Agent changes. A
   * Workspace made meanwhile is removed the same way, a few rounds; a failure says what is left. The default
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
        const deleted = yield* registry.deleteEnvironment({ id: environment });

        if (deleted === "refused") return yield* failed(DEFAULT_KEPT);

        if (deleted === "deleted") {
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

  return { deleteSession, removeWorkspace, deleteEnvironment, inWorkspace, onSession };
};
