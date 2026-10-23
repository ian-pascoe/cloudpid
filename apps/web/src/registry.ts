// The Registry operations (`RegistryRpcs`, Effect RPC over HTTP) as an atom client: queries cache their answers, and a
// mutation invalidates the keys of the queries it changes (ADR-0011).
import { RegistryRpcs, RPC_PATH } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

/**
 * What a query listens to and a mutation invalidates: the Session list, the Environment list (with each one's Repos),
 * the Workspaces, an Environment's own Container settings by id, the Environments' Builds, the settings, and this
 * browser's push subscription.
 */
export type RegistryKey =
  | "sessions"
  | "environments"
  | "workspaces"
  | `environment-settings:${string}`
  | "builds"
  | "settings"
  | "push";

/** The main Worker's Registry, at `RPC_PATH` of the page's origin. */
export class RegistryClient extends AtomRpc.Service<RegistryClient>()(
  "@cloudpid/web/RegistryClient",
  {
    group: RegistryRpcs,
    // Unwrapped, so the page's origin is read only when the client is built (never in a test, which replaces it).
    protocol: Layer.unwrap(
      Effect.sync(() =>
        RpcClient.layerProtocolHttp({ url: new URL(RPC_PATH, window.location.origin).href }),
      ),
    ).pipe(Layer.provide([RpcSerialization.layerJson, FetchHttpClient.layer])),
  },
) {}

/** Run `effect` as a mutation of `keys`: the queries of those keys ask again once it ends, whether or not it worked. */
export const changing =
  (keys: ReadonlyArray<RegistryKey>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Reactivity.Reactivity> =>
    effect.pipe(Effect.ensuring(Reactivity.invalidate(keys)));

/** The text a failure shows the owner: the error's own message, or the defect's. */
export const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);

  return Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
    ? error.message
    : String(error);
};

/** Why an atom's last answer is a failure, or null. */
export const failureOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): string | null =>
  AsyncResult.isFailure(result) ? messageOf(result.cause) : null;

/**
 * Why an atom's last answer is a failure, or null; null too while it asks again, so that starting again (a clone, a
 * retry) clears the message.
 */
export const settledFailureOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): string | null =>
  AsyncResult.isFailure(result) && !result.waiting ? messageOf(result.cause) : null;

/** Why a mutation that ended as `exit` failed, or null when it worked. */
export const exitFailure = <A, E>(exit: Exit.Exit<A, E>): string | null =>
  Exit.isFailure(exit) ? messageOf(exit.cause) : null;
