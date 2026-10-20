import { SettingsError } from "@cloudpid/config";
import {
  DEFAULT_WORKSPACE,
  parseRepoSource,
  RegistryRpcs,
  WorkspaceError,
} from "@cloudpid/protocol";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type { Repos } from "../workspace/repos.ts";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";
import { SettingsUpdate } from "./settings.ts";

/**
 * The main Worker's `RegistryRpcs` endpoint (`docs/spec.md` → Client and protocol): Effect RPC over HTTP with JSON
 * serialization, answered by the Registry DO, except for what needs a Workspace's files: `repos` lists the repos of a
 * Workspace and clones into one. It is reachable only through the Access gate in front of the Worker.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const serveRegistryRpc = (registries: Cloudflare.DurableObject<Registry>, repos: Repos) =>
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
