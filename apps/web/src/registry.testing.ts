// A Registry for tests: the real RPC client over an in-memory server whose handlers a test supplies. A handler the test
// does not supply dies, so a test notices a call it did not expect.

import { RegistryRpcs } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Layer from "effect/Layer";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { RegistryClient } from "./registry.ts";

type Rpcs = RpcGroup.Rpcs<typeof RegistryRpcs>;

/** A test's handlers: each answers with an Effect that needs nothing. */
type Handlers = { readonly [Current in Rpcs as Current["_tag"]]: Rpc.ToHandlerFn<Current, never> };

const unexpected = (tag: string) => () => Effect.die(`unexpected Registry call: ${tag}`);

/** Every handler dies until a test gives its own. */
const UNEXPECTED: Handlers = {
  listSessions: unexpected("listSessions"),
  createSession: unexpected("createSession"),
  renameSession: unexpected("renameSession"),
  archiveSession: unexpected("archiveSession"),
  unarchiveSession: unexpected("unarchiveSession"),
  deleteSession: unexpected("deleteSession"),
  listEnvironments: unexpected("listEnvironments"),
  createEnvironment: unexpected("createEnvironment"),
  renameEnvironment: unexpected("renameEnvironment"),
  deleteEnvironment: unexpected("deleteEnvironment"),
  addRepo: unexpected("addRepo"),
  removeRepo: unexpected("removeRepo"),
  getEnvironmentSettings: unexpected("getEnvironmentSettings"),
  updateEnvironmentSettings: unexpected("updateEnvironmentSettings"),
  listBuilds: unexpected("listBuilds"),
  rebuildEnvironment: unexpected("rebuildEnvironment"),
  listWorkspaces: unexpected("listWorkspaces"),
  removeWorkspace: unexpected("removeWorkspace"),
  restartContainer: unexpected("restartContainer"),
  getSettings: unexpected("getSettings"),
  updateSettings: unexpected("updateSettings"),
  getPush: unexpected("getPush"),
  subscribePush: unexpected("subscribePush"),
  unsubscribePush: unexpected("unsubscribePush"),
};

/** A `RegistryClient` answering with `handlers`. */
export const fakeRegistryLayer = (handlers: Partial<Handlers>): Layer.Layer<RegistryClient> =>
  Layer.effect(RegistryClient, RpcTest.makeClient(RegistryRpcs, { flatten: true })).pipe(
    Layer.provide(RegistryRpcs.toLayer({ ...UNEXPECTED, ...handlers })),
  );

/** An atom registry whose Registry client answers with `handlers`. */
export const registryWith = (handlers: Partial<Handlers>): AtomRegistry.AtomRegistry =>
  AtomRegistry.make({
    initialValues: [Atom.initialValue(RegistryClient.runtime.layer, fakeRegistryLayer(handlers))],
  });

/** The atom's value once it is neither initial nor waiting. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Effect.Effect<AsyncResult.AsyncResult<A, E>> =>
  Effect.callback((resume) => {
    const done = (result: AsyncResult.AsyncResult<A, E>) =>
      !AsyncResult.isInitial(result) && !result.waiting;

    const now = registry.get(atom);

    if (done(now)) return resume(Effect.succeed(now));

    const cancel = registry.subscribe(atom, (result) => {
      if (!done(result)) return;

      cancel();
      resume(Effect.succeed(result));
    });

    return Effect.sync(cancel);
  });

export type { Handlers as RegistryHandlers };
