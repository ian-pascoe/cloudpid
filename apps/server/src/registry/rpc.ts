import { RegistryRpcs } from "@cloudpid/protocol";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";

/**
 * The main Worker's `RegistryRpcs` endpoint (`docs/spec.md` → Client and protocol): Effect RPC over HTTP with JSON
 * serialization, answered by the Registry DO. It is reachable only through the Access gate in front of the Worker.
 */
export const serveRegistryRpc = (registries: Cloudflare.DurableObject<Registry>) =>
  Effect.gen(function* () {
    const registry = registries.getByName(REGISTRY_NAME);

    const handlers = RegistryRpcs.toLayer({
      listSessions: () => registry.listSessions(),
      createSession: ({ title, workspace }) => registry.createSession({ title, workspace }),
      listWorkspaces: () => registry.listWorkspaces(),
      createWorkspace: ({ slug }) => registry.createWorkspace({ slug }),
    });

    const serve = yield* RpcServer.toHttpEffect(RegistryRpcs).pipe(
      // Each request builds its own server, as a Worker request has no longer-lived scope to build it in.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(Layer.merge(handlers, RpcSerialization.layerJson)),
    );

    return yield* serve;
  }).pipe(Effect.scoped);
