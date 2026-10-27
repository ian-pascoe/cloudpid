// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
// The workerd test Durable Object that hosts a `RegistryStore` over its SQLite storage, as the Registry DO does.
import {
  type KeptSecret,
  openKeptVault,
  type SealedValue,
} from "@cloudpid/extensions/secrets/core";
import {
  type AgentChange,
  type EnvironmentRepo,
  type EnvironmentSecretRecord,
  type PushSubscription,
  SETTINGS_SCOPE,
  type SessionOrigin,
} from "@cloudpid/protocol";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { keepSecret, openEnvironmentSecrets, type SecretWrite } from "./environment-secrets.ts";
import type * as Schema from "effect/Schema";
import { type AgentChangeAuthor, type AgentChanges, openAgentChanges } from "./agent-changes.ts";
import { readSettings, type SettingsState, writeSettings } from "./settings.ts";
import {
  changeSettings,
  revertSettingsChange,
  type SettingsChange,
  type SettingsChangeRevert,
  type SettingsFieldChange,
} from "./settings-changes.ts";
import {
  type BuildRecord,
  type Deletion,
  type EnvironmentDeletion,
  type EnvironmentNaming,
  type EnvironmentRecord,
  type LegacyObject,
  openRegistryStore,
  type RegistryStore,
  type RepoChange,
  type SecretPut,
  type StoredEnvironmentSecret,
  type SessionAgent,
  type SessionRecord,
  type SessionRefusal,
  type SessionStatus,
  type SpareUpkeep,
  type StoredWorkspaceChoice,
  type SubagentWorkspaceRefusal,
  type SubagentWorkspaceRequest,
  type WorkspaceRecord,
  type WorkspaceSetup,
} from "./store.ts";

export class TestRegistry extends DurableObject {
  readonly #store: RegistryStore;
  readonly #changes: AgentChanges;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = openRegistryStore(ctx.storage);
    this.#changes = openAgentChanges(ctx.storage);
  }

  createSession(
    input: {
      id: string;
      title: string | null;
      workspace: StoredWorkspaceChoice;
      origin?: SessionOrigin | null;
    },
    now: number,
  ): SessionRecord | SessionRefusal {
    return this.#store.createSession(input, now);
  }

  getSession(id: string): SessionRecord | null {
    return this.#store.getSession(id);
  }

  createSubagentWorkspace(
    input: SubagentWorkspaceRequest,
    now: number,
  ): WorkspaceRecord | SubagentWorkspaceRefusal {
    return this.#store.createSubagentWorkspace(input, now);
  }

  listSubagentWorkspaces(session: string): WorkspaceRecord[] {
    return this.#store.listSubagentWorkspaces(session);
  }

  listSessions(): SessionRecord[] {
    return this.#store.listSessions();
  }

  setSessionStatus(id: string, status: SessionStatus, now: number): void {
    this.#store.setSessionStatus(id, status, now);
  }

  setSessionAgents(id: string, agents: ReadonlyArray<SessionAgent>): void {
    this.#store.setSessionAgents(id, agents);
  }

  renameSession(id: string, title: string): SessionRecord | null {
    return this.#store.renameSession(id, title);
  }

  setGeneratedTitle(id: string, title: string): boolean {
    return this.#store.setGeneratedTitle(id, title);
  }

  archiveSession(id: string, now: number): SessionRecord | null {
    return this.#store.archiveSession(id, now);
  }

  unarchiveSession(id: string): SessionRecord | null {
    return this.#store.unarchiveSession(id);
  }

  deleteSession(id: string): boolean {
    return this.#store.deleteSession(id);
  }

  createEnvironment(id: string, name: string, now: number): EnvironmentNaming {
    return this.#store.createEnvironment(id, name, now);
  }

  getBuild(environment: string): BuildRecord | null {
    return this.#store.getBuild(environment);
  }

  putBuild(environment: string, record: BuildRecord): boolean {
    return this.#store.putBuild(environment, record);
  }

  listBuilds(): Array<BuildRecord & { readonly environment: string }> {
    return this.#store.listBuilds();
  }

  getEnvironment(id: string): EnvironmentRecord | null {
    return this.#store.getEnvironment(id);
  }

  listEnvironments(): EnvironmentRecord[] {
    return this.#store.listEnvironments();
  }

  renameEnvironment(id: string, name: string): EnvironmentNaming {
    return this.#store.renameEnvironment(id, name);
  }

  deleteEnvironment(id: string): EnvironmentDeletion {
    return this.#store.deleteEnvironment(id);
  }

  addRepo(environment: string, repo: EnvironmentRepo): RepoChange {
    return this.#store.addRepo(environment, repo);
  }

  removeRepo(environment: string, name: string): RepoChange {
    return this.#store.removeRepo(environment, name);
  }

  getEnvironmentSettings(environment: string): Schema.Json | null {
    return this.#store.getEnvironmentSettings(environment);
  }

  putEnvironmentSettings(environment: string, overrides: Schema.Json): boolean {
    return this.#store.putEnvironmentSettings(environment, overrides);
  }

  getWorkspace(id: string): WorkspaceRecord | null {
    return this.#store.getWorkspace(id);
  }

  getWorkspaceSetup(id: string): WorkspaceSetup | null {
    return this.#store.getWorkspaceSetup(id);
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.#store.listWorkspaces();
  }

  deleteWorkspace(id: string): Deletion {
    return this.#store.deleteWorkspace(id);
  }

  /** `RegistryStore.upkeepSpares`, drawing fresh ids from `ids` in order (a function cannot cross RPC). */
  upkeepSpares(environments: string[] | undefined, ids: string[], now: number): SpareUpkeep {
    const left = [...ids];

    return this.#store.upkeepSpares(environments, () => left.shift() ?? "ffffffff", now);
  }

  getSpare(environment: string): string | null {
    return this.#store.getSpare(environment);
  }

  forgetSpare(id: string): boolean {
    return this.#store.forgetSpare(id);
  }

  takeLegacy(limit: number, now: number, leaseMs: number): LegacyObject[] {
    return this.#store.takeLegacy(limit, now, leaseMs);
  }

  forgetLegacy(object: LegacyObject): void {
    this.#store.forgetLegacy(object);
  }

  listEnvironmentSecrets(): EnvironmentSecretRecord[] {
    return this.#store.listEnvironmentSecrets();
  }

  getEnvironmentSecrets(environment: string): StoredEnvironmentSecret[] {
    return this.#store.getEnvironmentSecrets(environment);
  }

  putEnvironmentSecret(
    input: { environment: string | null; name: string; sealed: SealedValue; build?: boolean },
    now: number,
  ): SecretPut {
    return this.#store.putEnvironmentSecret(input, now);
  }

  setEnvironmentSecretBuild(
    environment: string | null,
    name: string,
    build: boolean,
    now: number,
  ): EnvironmentSecretRecord | null {
    return this.#store.setEnvironmentSecretBuild(environment, name, build, now);
  }

  deleteEnvironmentSecret(environment: string | null, name: string): boolean {
    return this.#store.deleteEnvironmentSecret(environment, name);
  }

  /** Keep a Secret as the Registry DO does, sealed under `master` (`keepSecret`). */
  keepSecret(
    master: string,
    input: { environment: string | null; name: string; value: string; build?: boolean },
    now: number,
  ): Promise<SecretWrite> {
    return Effect.runPromise(
      Effect.flatMap(openKeptVault(master, "registry"), (vault) =>
        keepSecret(this.#store, vault, input, now),
      ),
    );
  }

  /** What `environment` uses, opened under `master`, as the Registry DO hands it (`openEnvironmentSecrets`). */
  openSecrets(master: string, environment: string): Promise<ReadonlyArray<KeptSecret>> {
    return Effect.runPromise(
      Effect.flatMap(openKeptVault(master, "registry"), (vault) =>
        openEnvironmentSecrets(this.#store, vault, environment),
      ),
    );
  }

  getDocument(name: string): string | null {
    return this.#store.getDocument(name);
  }

  putDocument(name: string, body: string, now: number): void {
    this.#store.putDocument(name, body, now);
  }

  putPushSubscription(subscription: PushSubscription, now: number): void {
    this.#store.putPushSubscription(subscription, now);
  }

  deletePushSubscription(endpoint: string): void {
    this.#store.deletePushSubscription(endpoint);
  }

  hasPushSubscription(endpoint: string): boolean {
    return this.#store.hasPushSubscription(endpoint);
  }

  listPushSubscriptions(): PushSubscription[] {
    return this.#store.listPushSubscriptions();
  }

  getSettings(): SettingsState {
    return readSettings(this.#store);
  }

  /** Save settings overrides, as the Registry DO does; overrides that do not resolve throw. */
  updateSettings(overrides: Schema.Json, now: number): SettingsState {
    const saved = writeSettings(this.#store, overrides, now);

    if (Result.isFailure(saved)) throw new Error(saved.failure.message);

    return saved.success;
  }

  /** An Agent change to the Settings, as the Registry DO makes one. */
  changeSettings(
    changes: ReadonlyArray<SettingsFieldChange>,
    author: AgentChangeAuthor,
    now: number,
  ): SettingsChange {
    return changeSettings(this.ctx.storage, this.#store, this.#changes, { changes, author }, now);
  }

  listSettingsChanges(): ReadonlyArray<AgentChange> {
    return this.#changes.list(SETTINGS_SCOPE);
  }

  revertSettingsChange(change: number, now: number): SettingsChangeRevert {
    return revertSettingsChange(this.ctx.storage, this.#store, this.#changes, { id: change }, now);
  }
}
