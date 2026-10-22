import { SettingsError } from "@cloudpid/config";
import {
  DEFAULT_WORKSPACE,
  parseRepoSource,
  RegistryRpcs,
  SessionActionError,
  SessionNotFound,
  WorkspaceError,
} from "@cloudpid/protocol";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import type { Repos } from "../workspace/repos.ts";
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

/** What the endpoint reaches besides the Registry: the objects behind the Workspaces and the Sessions. */
export type RegistryRpcObjects = {
  /** Lists the repos of a Workspace, clones into one and removes one. */
  readonly repos: Repos;
  /** Reads and saves a Workspace's Container size and idle time. */
  readonly workspaceSettings: WorkspaceSettingsRemote;
  /** Wipes a Workspace's object when it is deleted or reset, and restarts its Container. */
  readonly workspaces: WorkspaceObjects;
  /** Stops a Session when it is archived, and wipes it when it is deleted. */
  readonly sessions: SessionObjects;
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
export const serveRegistryRpc = (
  registries: Cloudflare.DurableObject<Registry>,
  { repos, workspaceSettings, workspaces, sessions }: RegistryRpcObjects,
) =>
  Effect.gen(function* () {
    const registry = registries.getByName(REGISTRY_NAME);

    const failed = (message: string) => WorkspaceError.make({ message });

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

    /** Fails unless the Registry lists the Workspace: a setting must not wake, or leave state in, an object nobody made. */
    const registered = (slug: string) =>
      Effect.gen(function* () {
        const known = yield* registry.listWorkspaces();

        if (!Arr.some(known, (workspace) => workspace.slug === slug)) {
          return yield* failed(`Workspace "${slug}" does not exist: create it first`);
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
      wipe: Effect.Effect<void, WorkspaceError>,
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

    const handlers = RegistryRpcs.toLayer({
      listSessions: () => registry.listSessions(),
      createSession: ({ title, workspace, repo }) =>
        Effect.gen(function* () {
          // The Session works in this directory: it must be a repo the Workspace holds, not a name that merely parses.
          if (repo !== undefined) {
            const slug = workspace ?? DEFAULT_WORKSPACE;

            const held = yield* inWorkspace("Could not list the Workspace's repos", () =>
              repos.list(slug),
            );

            if (!held.includes(repo)) {
              return yield* failed(`Workspace "${slug}" has no repo "${repo}"`);
            }
          }

          return yield* registry.createSession({ title, workspace, repo });
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
      deleteSession: ({ id }) => known(id).pipe(Effect.flatMap(deleteSession)),
      listWorkspaces: () => registry.listWorkspaces(),
      createWorkspace: ({ slug }) => registry.createWorkspace({ slug }),
      renameWorkspace: ({ workspace, name }) =>
        registry.renameWorkspace({ slug: workspace, name }).pipe(
          Effect.flatMap((renamed) => {
            switch (renamed.status) {
              case "renamed":
                return Effect.succeed(renamed.workspace);
              case "taken":
                return failed(`Another workspace is already named "${name}"`);
              case "missing":
                return failed(`Workspace "${workspace}" does not exist`);
            }
          }),
        ),
      deleteWorkspace: ({ workspace }) =>
        Effect.gen(function* () {
          // `New session` always has a Workspace to start in.
          if (workspace === DEFAULT_WORKSPACE) {
            return yield* failed("The default workspace cannot be deleted");
          }

          yield* registered(workspace);

          // The record goes only once none is bound, so no Session is left on a Workspace that is gone.
          yield* sweep(
            (session) => session.workspace === workspace,
            inWorkspace("Could not delete the workspace's files", () =>
              workspaces.destroy(workspace),
            ),
            registry
              .deleteWorkspace({ slug: workspace })
              .pipe(Effect.map((deleted) => deleted !== "in-use")),
            {
              kept: "The workspace and its remaining sessions are kept.",
              busy: "Sessions kept starting in the workspace while it was deleted: try again",
            },
          );
        }),
      resetWorkspace: ({ workspace }) =>
        Effect.gen(function* () {
          yield* registered(workspace);

          const bound = (session: SessionRecord) => session.workspace === workspace;

          // The record, name and Container settings stay; a Session bound to it would work on files that are gone.
          yield* sweep(
            bound,
            inWorkspace("Could not reset the workspace's files", () => workspaces.clear(workspace)),
            noneBound(bound),
            {
              kept: "The workspace's files and its remaining sessions are kept.",
              busy: "Sessions kept starting in the workspace while it was reset: try again",
            },
          );
        }),
      restartContainer: ({ workspace }) =>
        Effect.gen(function* () {
          yield* registered(workspace);
          yield* inWorkspace("Could not restart the Container", () =>
            workspaces.restartContainer(workspace),
          );
        }),
      listRepos: ({ workspace }) =>
        inWorkspace("Could not list the Workspace's repos", () => repos.list(workspace)),
      cloneRepo: ({ workspace, source, name }) =>
        Effect.gen(function* () {
          const found = yield* Effect.fromResult(parseRepoSource(source)).pipe(
            Effect.mapError(failed),
          );

          // The owner's own name for the directory, if any, over the repo's.
          const repo = { url: found.url, name: name ?? found.name };

          // A new slug is registered, as when a Session is created in it.
          yield* registry.createWorkspace({ slug: workspace });
          yield* inWorkspace("Clone failed", () => repos.clone(workspace, repo));

          return repo.name;
        }),
      removeRepo: ({ workspace, repo }) =>
        Effect.gen(function* () {
          yield* registered(workspace);

          const bound = (session: SessionRecord) =>
            session.workspace === workspace && session.repo === repo;

          const held = yield* inWorkspace("Could not list the Workspace's repos", () =>
            repos.list(workspace),
          );

          // A repo that is gone with Sessions still bound to it can be removed, which deletes them.
          if (!held.includes(repo) && (yield* noneBound(bound))) {
            return yield* failed(`Workspace "${workspace}" has no repo "${repo}"`);
          }

          yield* sweep(
            bound,
            inWorkspace("Could not remove the repo", () => repos.remove(workspace, repo)),
            noneBound(bound),
            {
              kept: "The repo and its remaining sessions are kept.",
              busy: "Sessions kept starting in the repo while it was removed: try again",
            },
          );
        }),
      getWorkspaceSettings: ({ workspace }) =>
        Effect.gen(function* () {
          yield* registered(workspace);

          return yield* inWorkspace("Could not read the Workspace's settings", () =>
            workspaceSettings.read(workspace),
          );
        }),
      updateWorkspaceSettings: ({ workspace, overrides }) =>
        Effect.gen(function* () {
          yield* registered(workspace);

          const answer = yield* inWorkspace("Could not save the Workspace's settings", () =>
            workspaceSettings.write(workspace, overrides),
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
