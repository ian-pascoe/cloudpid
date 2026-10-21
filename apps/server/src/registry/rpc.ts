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
  /** Lists the repos of a Workspace and clones into one. */
  readonly repos: Repos;
  /** Reads and saves a Workspace's Container size and idle time. */
  readonly workspaceSettings: WorkspaceSettingsRemote;
  /** Wipes a Workspace's object when it is deleted. */
  readonly workspaces: WorkspaceObjects;
  /** Stops a Session when it is archived, and wipes it when it is deleted. */
  readonly sessions: SessionObjects;
};

/** How many times a Workspace's deletion sweeps its Sessions before it gives up on ones that keep starting. */
const DELETE_WORKSPACE_ROUNDS = 3;

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

          // A Session started in it while it is deleted is deleted too: the record goes only once none is bound, so
          // no Session is left on a Workspace that is gone. A few rounds, then the owner is asked to try again.
          for (let round = 1; ; round++) {
            const bound = Arr.filter(
              yield* registry.listSessions(),
              (session) => session.workspace === workspace,
            );

            // One at a time, so a failure stops the delete with what is left still listed.
            for (const session of bound) {
              yield* deleteSession(session).pipe(
                Effect.mapError((error) =>
                  failed(`${error.message}. The workspace and its remaining sessions are kept.`),
                ),
              );
            }

            yield* inWorkspace("Could not delete the workspace's files", () =>
              workspaces.destroy(workspace),
            );

            if ((yield* registry.deleteWorkspace({ slug: workspace })) !== "in-use") return;

            if (round === DELETE_WORKSPACE_ROUNDS) {
              return yield* failed(
                "Sessions kept starting in the workspace while it was deleted: try again",
              );
            }
          }
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
