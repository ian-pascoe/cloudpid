// The Registry operations (`RegistryRpcs`, Effect RPC over HTTP) as promises, for the Session list.
import type { SettingsOverrides } from "@cloudpid/config";
import {
  type PushState,
  type PushSubscription,
  RegistryRpcs,
  RPC_PATH,
  type SessionRecord,
  type SettingsState,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
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
  /** Register a new Session, idle, on a Workspace (the default one when none) and a repo in it (the root when none). */
  readonly createSession: (where?: {
    readonly workspace?: string;
    readonly repo?: string;
  }) => Promise<Answer<SessionRecord>>;
  /** Every Workspace, newest first. */
  readonly listWorkspaces: () => Promise<Answer<readonly WorkspaceRecord[]>>;
  /** Register a Workspace by slug; one already registered keeps its record. */
  readonly createWorkspace: (slug: string) => Promise<Answer<WorkspaceRecord>>;
  /** The repos a Workspace holds, by directory name. */
  readonly listRepos: (workspace: string) => Promise<Answer<readonly string[]>>;
  /** Clone `source` (owner/repo or an https URL) into a Workspace; resolves to the directory it went to. */
  readonly cloneRepo: (workspace: string, source: string) => Promise<Answer<string>>;
  /** The settings in force, and the overrides saved over the defaults. */
  readonly getSettings: () => Promise<Answer<SettingsState>>;
  /** Replace the saved overrides; overrides that do not resolve fail with a readable message, and nothing is saved. */
  readonly updateSettings: (overrides: SettingsOverrides) => Promise<Answer<SettingsState>>;
  /** The VAPID public key to subscribe with, and whether the Registry holds the subscription at `endpoint`. */
  readonly getPush: (endpoint?: string) => Promise<Answer<PushState>>;
  /** Keep this browser's Web Push subscription, so Sessions notify it. */
  readonly subscribePush: (subscription: PushSubscription) => Promise<Answer<void>>;
  /** Forget the subscription at `endpoint`. */
  readonly unsubscribePush: (endpoint: string) => Promise<Answer<void>>;
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
    createSession: (where = {}) =>
      answer(Registry.use((registry) => registry.createSession(where))),
    listWorkspaces: () => answer(Registry.use((registry) => registry.listWorkspaces())),
    createWorkspace: (slug) =>
      answer(Registry.use((registry) => registry.createWorkspace({ slug }))),
    listRepos: (workspace) => answer(Registry.use((registry) => registry.listRepos({ workspace }))),
    cloneRepo: (workspace, source) =>
      answer(Registry.use((registry) => registry.cloneRepo({ workspace, source }))),
    getSettings: () => answer(Registry.use((registry) => registry.getSettings())),
    updateSettings: (overrides) =>
      answer(Registry.use((registry) => registry.updateSettings({ overrides }))),
    getPush: (endpoint) =>
      answer(
        Registry.use((registry) => registry.getPush(endpoint === undefined ? {} : { endpoint })),
      ),
    subscribePush: (subscription) =>
      answer(Registry.use((registry) => registry.subscribePush({ subscription }))),
    unsubscribePush: (endpoint) =>
      answer(Registry.use((registry) => registry.unsubscribePush({ endpoint }))),
  };
};
