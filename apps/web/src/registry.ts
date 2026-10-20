// The Registry operations (`RegistryRpcs`, Effect RPC over HTTP) as promises, for the Session list.
import type { SettingsOverrides } from "@cloudpid/config";
import { RegistryRpcs, RPC_PATH, type SessionRecord, type SettingsState } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

class Registry extends Context.Service<
  Registry,
  RpcClient.FromGroup<typeof RegistryRpcs, RpcClientError>
>()("@cloudpid/web/registry") {}

/** An answer, or why there is none. */
export type Answer<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export interface RegistryApi {
  /** Every Session, newest first. */
  readonly listSessions: () => Promise<Answer<readonly SessionRecord[]>>;
  /** Register a new Session, idle. */
  readonly createSession: () => Promise<Answer<SessionRecord>>;
  /** The settings in force, and the overrides saved over the defaults. */
  readonly getSettings: () => Promise<Answer<SettingsState>>;
  /** Replace the saved overrides; overrides that do not resolve fail with a readable message, and nothing is saved. */
  readonly updateSettings: (overrides: SettingsOverrides) => Promise<Answer<SettingsState>>;
}

/** A client of the main Worker at `origin`. */
export const connectRegistry = (origin: string): RegistryApi => {
  const client = Layer.effect(Registry, RpcClient.make(RegistryRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: new URL(RPC_PATH, origin).href })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );

  const runtime = ManagedRuntime.make(client);

  const answer = <A, E extends { readonly message: string }>(
    call: Effect.Effect<A, E, Registry>,
  ): Promise<Answer<A>> =>
    runtime.runPromise(
      call.pipe(
        Effect.match({
          onFailure: (error): Answer<A> => ({ ok: false, message: error.message }),
          onSuccess: (value): Answer<A> => ({ ok: true, value }),
        }),
      ),
    );

  return {
    listSessions: () => answer(Registry.use((registry) => registry.listSessions())),
    createSession: () => answer(Registry.use((registry) => registry.createSession({}))),
    getSettings: () => answer(Registry.use((registry) => registry.getSettings())),
    updateSettings: (overrides) =>
      answer(Registry.use((registry) => registry.updateSettings({ overrides }))),
  };
};
