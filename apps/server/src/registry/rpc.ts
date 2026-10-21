import { SettingsError } from "@cloudpid/config";
import {
  DEFAULT_WORKSPACE,
  parseRepoSource,
  RegistryRpcs,
  SessionNotFound,
  WorkspaceError,
} from "@cloudpid/protocol";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type { Repos } from "../workspace/repos.ts";
import type { WorkspaceSettingsRemote } from "../workspace/settings.ts";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";
import { SettingsUpdate } from "./settings.ts";

/**
 * The main Worker's `RegistryRpcs` endpoint (`docs/spec.md` → Client and protocol): Effect RPC over HTTP with JSON
 * serialization, answered by the Registry DO, except for what needs a Workspace's own object: `repos` lists the repos
 * of a Workspace and clones into one, and `workspaceSettings` reads and saves its Container size and idle time. It is reachable only through the Access gate in front of the Worker.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const serveRegistryRpc = (
  registries: Cloudflare.DurableObject<Registry>,
  repos: Repos,
  workspaceSettings: WorkspaceSettingsRemote,
) =>
  Effect.gen(function* () {
    const registry = registries.getByName(REGISTRY_NAME);

    const failed = (message: string) => WorkspaceError.make({ message });

    /** A Workspace call that rejects, as the typed failure a client shows. */
    const inWorkspace = <A>(what: string, call: () => Promise<A>) =>
      Effect.tryPromise({
        try: call,
        catch: (cause) =>
          failed(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`),
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
          .pipe(
            Effect.filterOrFail(Predicate.isNotNull, () =>
              SessionNotFound.make({ message: `No session "${id}"` }),
            ),
          ),
      listWorkspaces: () => registry.listWorkspaces(),
      createWorkspace: ({ slug }) => registry.createWorkspace({ slug }),
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
