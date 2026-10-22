import { SettingsError } from "@cloudpid/config";
import {
  DEFAULT_MACHINE,
  NEW_WORKSPACE,
  parseRepoSource,
  RegistryRpcs,
  SessionActionError,
  SessionNotFound,
  MachineError,
} from "@cloudpid/protocol";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import type { Repos } from "../workspace/repos.ts";
import type { Worktrees } from "../workspace/worktrees.ts";
import type { WorkspaceSettingsRemote } from "../workspace/settings.ts";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";
import type { SessionRecord } from "./store.ts";
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

/** What the endpoint reaches besides the Registry: the objects behind the Machines and the Sessions. */
export type RegistryRpcObjects = {
  /** Lists the repos of a Machine, clones into one and removes one. */
  readonly repos: Repos;
  /** Reads and saves a Machine's Container settings (size, idle time, Container-only paths). */
  readonly machineSettings: WorkspaceSettingsRemote;
  /** Wipes a Machine's object when it is deleted or reset, and restarts its Container. */
  readonly machines: WorkspaceObjects;
  /** Stops a Session when it is archived, and wipes it when it is deleted. */
  readonly sessions: SessionObjects;
  /** Removes a Workspace's worktree, and releases it with the Workspace's last Session. */
  readonly worktrees: Worktrees;
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
 * serialization, answered by the Registry DO, except for what needs a Machine's or a Session's own object
 * (`RegistryRpcObjects`). It is reachable only through the Access gate in front of the Worker.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const serveRegistryRpc = (
  registries: Cloudflare.DurableObject<Registry>,
  { repos, machineSettings, machines, sessions, worktrees }: RegistryRpcObjects,
) =>
  Effect.gen(function* () {
    const registry = registries.getByName(REGISTRY_NAME);

    const failed = (message: string) => MachineError.make({ message });

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

    /** A Machine call that rejects, as the typed failure a client shows. */
    const inMachine = <A>(what: string, call: () => Promise<A>) =>
      Effect.tryPromise({
        try: call,
        catch: (cause) => failed(`${what}: ${reason(Cause.fail(cause))}`),
      });

    /** Fails unless the Registry lists the Machine: a setting must not wake, or leave state in, an object nobody made. */
    const registered = (slug: string) =>
      Effect.gen(function* () {
        const known = yield* registry.listMachines();

        if (!Arr.some(known, (machine) => machine.slug === slug)) {
          return yield* failed(`Machine "${slug}" does not exist: create it first`);
        }
      });

    /** Whether no Session is bound where `bound` says, once the Registry is asked again. */
    const noneBound = (bound: (session: SessionRecord) => boolean) =>
      registry.listSessions().pipe(Effect.map((listed) => !Arr.some(listed, bound)));

    /**
     * Delete every Session `bound` picks (archived ones too), then `wipe` what they worked on, until `settled` says no
     * Session is left: one started meanwhile is deleted the same way and the sweep runs again, a few rounds, then the
     * owner is asked to try again. One Session at a time, so a failure stops it with what is left still listed.
     */
    const sweep = (
      bound: (session: SessionRecord) => boolean,
      wipe: Effect.Effect<void, MachineError>,
      settled: Effect.Effect<boolean>,
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

    /** The Workspace registered under `id`, or a `MachineError`. */
    const knownWorkspace = (id: string) =>
      registry
        .getWorkspace({ id })
        .pipe(Effect.filterOrFail(Predicate.isNotNull, () => failed(`No workspace "${id}"`)));

    /**
     * Once Session `session` is deleted, release its Workspace of its own if no other Session (archived ones included)
     * is bound to it: the worktree goes, with its record, unless it holds uncommitted changes, which keep both for the
     * owner to look at or remove. Its branch stays. Never fails: the deletion is done, and a Workspace kept is listed.
     */
    const releaseWorkspaceOf = (session: SessionRecord) =>
      Effect.gen(function* () {
        const id = session.workspace;

        if (id === null || !(yield* noneBound((other) => other.workspace === id))) return;

        const workspace = yield* registry.getWorkspace({ id });

        if (workspace === null) return;

        const released = yield* Effect.tryPromise(() =>
          worktrees.on(workspace.machine).release(workspace),
        );

        if (released) yield* registry.deleteWorkspace({ id });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Could not release the workspace of session ${session.id}`, cause),
        ),
      );

    const handlers = RegistryRpcs.toLayer({
      listSessions: () => registry.listSessions(),
      createSession: ({ title, machine, repo, workspace, branch }) =>
        Effect.gen(function* () {
          if (branch !== undefined && workspace !== NEW_WORKSPACE) {
            return yield* failed("A branch is only for a new workspace");
          }

          // A Workspace that exists brings its Machine and repo; the Session cannot name others.
          if (workspace !== undefined && workspace !== NEW_WORKSPACE) {
            const known = yield* knownWorkspace(workspace);

            if (
              (machine !== undefined && machine !== known.machine) ||
              (repo !== undefined && repo !== known.repo)
            ) {
              return yield* failed(
                `Workspace "${workspace}" is in ${known.repo} on machine "${known.machine}"`,
              );
            }

            return yield* registry.createSession({
              title,
              machine: known.machine,
              repo: known.repo,
              workspace: { kind: "existing", id: workspace },
            });
          }

          const slug = machine ?? DEFAULT_MACHINE;

          if (workspace === NEW_WORKSPACE && repo === undefined) {
            return yield* failed("A new workspace needs a repo");
          }

          // The Session works in this directory: it must be a repo the Machine holds, not a name that merely parses.
          if (repo !== undefined) {
            const held = yield* inMachine("Could not list the Machine's repos", () =>
              repos.list(slug),
            );

            if (!held.includes(repo)) {
              return yield* failed(`Machine "${slug}" has no repo "${repo}"`);
            }
          }

          if (workspace !== NEW_WORKSPACE) {
            return yield* registry.createSession({ title, machine, repo });
          }

          // git checks a branch out in one worktree at a time.
          if (branch !== undefined) {
            const taken = Arr.findFirst(
              yield* registry.listWorkspaces(),
              (other) => other.machine === slug && other.repo === repo && other.branch === branch,
            );

            if (Option.isSome(taken)) {
              return yield* failed(
                `Workspace "${taken.value.id}" is already on branch ${branch}: start a session in it instead`,
              );
            }
          }

          return yield* registry.createSession({
            title,
            machine,
            repo,
            workspace: { kind: "new", branch },
          });
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
      deleteSession: ({ id }) =>
        known(id).pipe(
          Effect.flatMap((session) =>
            deleteSession(session).pipe(Effect.andThen(releaseWorkspaceOf(session))),
          ),
        ),
      listMachines: () => registry.listMachines(),
      createMachine: ({ slug }) => registry.createMachine({ slug }),
      renameMachine: ({ machine, name }) =>
        registry.renameMachine({ slug: machine, name }).pipe(
          Effect.flatMap((renamed) => {
            switch (renamed.status) {
              case "renamed":
                return Effect.succeed(renamed.machine);
              case "taken":
                return failed(`Another machine is already named "${name}"`);
              case "missing":
                return failed(`Machine "${machine}" does not exist`);
            }
          }),
        ),
      deleteMachine: ({ machine }) =>
        Effect.gen(function* () {
          // `New session` always has a Machine to start in.
          if (machine === DEFAULT_MACHINE) {
            return yield* failed("The default machine cannot be deleted");
          }

          yield* registered(machine);

          // The record goes only once none is bound, so no Session is left on a Machine that is gone.
          yield* sweep(
            (session) => session.machine === machine,
            inMachine("Could not delete the machine's files", () => machines.destroy(machine)),
            registry
              .deleteMachine({ slug: machine })
              .pipe(Effect.map((deleted) => deleted !== "in-use")),
            {
              kept: "The machine and its remaining sessions are kept.",
              busy: "Sessions kept starting in the machine while it was deleted: try again",
            },
          );
        }),
      resetMachine: ({ machine }) =>
        Effect.gen(function* () {
          yield* registered(machine);

          const bound = (session: SessionRecord) => session.machine === machine;

          // The record, name and Container settings stay; a Session bound to it would work on files that are gone.
          yield* sweep(
            bound,
            inMachine("Could not reset the machine's files", () => machines.clear(machine)),
            noneBound(bound),
            {
              kept: "The machine's files and its remaining sessions are kept.",
              busy: "Sessions kept starting in the machine while it was reset: try again",
            },
          );
          // Their worktrees went with the files.
          yield* registry.deleteWorkspacesOf({ machine });
        }),
      restartContainer: ({ machine }) =>
        Effect.gen(function* () {
          yield* registered(machine);
          yield* inMachine("Could not restart the Container", () =>
            machines.restartContainer(machine),
          );
        }),
      listRepos: ({ machine }) =>
        inMachine("Could not list the Machine's repos", () => repos.list(machine)),
      cloneRepo: ({ machine, source, name }) =>
        Effect.gen(function* () {
          const found = yield* Effect.fromResult(parseRepoSource(source)).pipe(
            Effect.mapError(failed),
          );

          // The owner's own name for the directory, if any, over the repo's.
          const repo = { url: found.url, name: name ?? found.name };

          // A new slug is registered, as when a Session is created in it.
          yield* registry.createMachine({ slug: machine });
          yield* inMachine("Clone failed", () => repos.clone(machine, repo));

          return repo.name;
        }),
      removeRepo: ({ machine, repo }) =>
        Effect.gen(function* () {
          yield* registered(machine);

          const bound = (session: SessionRecord) =>
            session.machine === machine && session.repo === repo;

          const held = yield* inMachine("Could not list the Machine's repos", () =>
            repos.list(machine),
          );

          // A repo that is gone with Sessions still bound to it can be removed, which deletes them.
          if (!held.includes(repo) && (yield* noneBound(bound))) {
            return yield* failed(`Machine "${machine}" has no repo "${repo}"`);
          }

          yield* sweep(
            bound,
            inMachine("Could not remove the repo", () => repos.remove(machine, repo)),
            noneBound(bound),
            {
              kept: "The repo and its remaining sessions are kept.",
              busy: "Sessions kept starting in the repo while it was removed: try again",
            },
          );
          // Their worktrees went with the repo.
          yield* registry.deleteWorkspacesOf({ machine, repo });
        }),
      listWorkspaces: () => registry.listWorkspaces(),
      removeWorkspace: ({ id }) =>
        Effect.gen(function* () {
          const workspace = yield* knownWorkspace(id);

          yield* registered(workspace.machine);

          // The record goes only once none is bound, so no Session is left on a worktree that is gone.
          yield* sweep(
            (session) => session.workspace === id,
            inMachine("Could not remove the workspace's worktree", () =>
              worktrees.on(workspace.machine).remove(workspace),
            ),
            registry.deleteWorkspace({ id }).pipe(Effect.map((deleted) => deleted !== "in-use")),
            {
              kept: "The workspace and its remaining sessions are kept.",
              busy: "Sessions kept starting in the workspace while it was removed: try again",
            },
          );
        }),
      getMachineSettings: ({ machine }) =>
        Effect.gen(function* () {
          yield* registered(machine);

          return yield* inMachine("Could not read the Machine's settings", () =>
            machineSettings.read(machine),
          );
        }),
      updateMachineSettings: ({ machine, overrides }) =>
        Effect.gen(function* () {
          yield* registered(machine);

          const answer = yield* inMachine("Could not save the Machine's settings", () =>
            machineSettings.write(machine, overrides),
          );

          // Overrides that do not resolve say why, one problem per line, and nothing was saved.
          return answer.ok ? answer.state : yield* failed(answer.message);
        }),
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
