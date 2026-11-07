// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
// The workerd test Durable Object that hosts a `RegistryStore` over its SQLite storage, as the Registry DO does.
import {
  type KeptSecret,
  openKeptVault,
  type SealedValue,
} from "@cloudpid/extensions/secrets/core";
import * as Arr from "effect/Array";
import {
  type AgentChange,
  type EnvironmentRepo,
  type EnvironmentSecretRecord,
  holdsEditedFields,
  type PushSubscription,
  SETTINGS_SCOPE,
  type MarkedOrigin,
  type SessionOrigin,
  type SettingsOverridesState,
  type TriggerChanged,
  type TriggerChangeValue,
  type TriggerDefinition,
  type TriggerInput,
  type TriggerPatch,
} from "@cloudpid/protocol";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { keepSecret, openEnvironmentSecrets, type SecretWrite } from "./environment-secrets.ts";
import type * as Schema from "effect/Schema";
import {
  type AgentChangeAuthor,
  type AgentChangeRevert,
  type AgentChanges,
  openAgentChanges,
  revertAgentChange,
} from "./agent-changes.ts";
import { globalSettingsOf } from "./global.ts";
import {
  putEnvironmentInstructions,
  readSettings,
  readSettingsOverrides,
  type SessionSettingsSource,
  sessionSettingsSource,
  type SettingsAnswer,
  settingsOverriddenIn,
  type SettingsState,
  updateSettingsOverrides,
  writeSettings,
} from "./settings.ts";
import { openSkills, type Skills } from "./skills.ts";
import {
  changeSettings,
  changeSettingsOverrides,
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
  type CreatedSession,
  type SessionRefusal,
  type SessionStatus,
  type SpareUpkeep,
  type StoredWorkspaceChoice,
  type SubagentWorkspaceRefusal,
  type SubagentWorkspaceRequest,
  type WorkspaceRecord,
  type WorkspaceSetup,
  STARTING_MS,
} from "./store.ts";
import { openTriggerChanges, type TriggerChanges } from "./trigger-changes.ts";
import {
  type EnvironmentRemoval,
  type WorkspaceRemoval,
  type FireAdmission,
  type FireAdmitted,
  openTriggers,
  type Triggers,
  type TriggerWrite,
} from "./triggers.ts";

/**
 * The Skills `revertAgentChange` takes, for a test whose changes are not a Skill's: the storage's (none kept).
 */
export const noSkills = (storage: DurableObjectStorage): Skills => openSkills(storage);

export class TestRegistry extends DurableObject {
  readonly #store: RegistryStore;
  readonly #changes: AgentChanges;
  readonly #triggers: Triggers;
  readonly #triggerChanges: TriggerChanges;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = openRegistryStore(ctx.storage);
    this.#changes = openAgentChanges(ctx.storage);
    this.#triggers = openTriggers(ctx.storage, this.#store);
    this.#triggerChanges = openTriggerChanges(
      ctx.storage,
      this.#store,
      this.#triggers,
      this.#changes,
    );
  }

  createSession(
    input: {
      id: string;
      title: string | null;
      workspace: StoredWorkspaceChoice;
      origin?: SessionOrigin | null;
      marks?: MarkedOrigin | null;
      requestId?: string | undefined;
      maxRunning?: number;
      maxOpenImports?: { limit: number; auth: string };
    },
    now: number,
  ): CreatedSession | SessionRefusal {
    return this.#store.createSession(input, now);
  }

  endSessionImport(id: string): void {
    this.#store.endSessionImport(id);
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

  setSessionMcpTasks(id: string, count: number): void {
    this.#store.setSessionMcpTasks(id, count);
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

  deleteEnvironmentWithTriggers(id: string): EnvironmentRemoval {
    return this.#triggers.deleteEnvironment(id);
  }

  agentCreateTrigger(
    id: string,
    input: TriggerInput,
    author: AgentChangeAuthor,
    now: number,
  ): TriggerChanged {
    return this.#triggerChanges.create(id, input, author, now);
  }

  agentUpdateTrigger(
    id: string,
    patch: TriggerPatch,
    expected: TriggerChangeValue | undefined,
    author: AgentChangeAuthor,
    now: number,
  ): TriggerChanged {
    return this.#triggerChanges.update(id, patch, expected, author, now);
  }

  agentSetTriggerPaused(
    id: string,
    paused: boolean,
    expected: TriggerChangeValue | undefined,
    author: AgentChangeAuthor,
    now: number,
  ): TriggerChanged {
    return this.#triggerChanges.setPaused(id, paused, expected, author, now);
  }

  agentRemoveTrigger(id: string, author: AgentChangeAuthor, now: number): TriggerChanged {
    return this.#triggerChanges.remove(id, author, now);
  }

  /** The ids of every Trigger row kept, removed ones too, in order. */
  storedTriggerIds(): Array<string> {
    return Arr.map(
      this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM triggers ORDER BY id").toArray(),
      ({ id }) => id,
    );
  }

  createTrigger(id: string, input: TriggerInput, now: number): TriggerWrite {
    return this.#triggers.create(id, input, now);
  }

  triggerDefinition(id: string): TriggerDefinition | null {
    return this.#triggers.get(id);
  }

  listTriggers(environment?: string): Array<TriggerDefinition> {
    return this.#triggers.list(environment);
  }

  updateTrigger(
    id: string,
    patch: TriggerPatch,
    now: number,
    expected?: TriggerChangeValue,
  ): TriggerWrite {
    return this.#triggers.update(
      id,
      patch,
      now,
      expected === undefined ? undefined : (current) => holdsEditedFields(current, expected),
    );
  }

  setTriggerPaused(id: string, paused: boolean, now: number): TriggerWrite {
    return this.#triggers.setPaused(id, paused, now);
  }

  removeTrigger(id: string): boolean {
    return this.#triggers.remove(id);
  }

  /** `admitFire` at `now`, registering a Fire's Session under `ids`. */
  admitFire(
    fire: FireAdmission,
    ids: { session: string; workspace: string },
    now: number,
  ): FireAdmitted {
    return this.#triggers.admit(fire, ids, now, STARTING_MS);
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

  workspaceKept(id: string): boolean {
    return this.#store.workspaceKept(id);
  }

  deleteWorkspace(id: string): Deletion {
    return this.#store.deleteWorkspace(id);
  }

  deleteWorkspaceTriggers(id: string): ReadonlyArray<string> {
    return this.#triggers.deleteWorkspaceTriggers(id);
  }

  deleteWorkspaceWithTriggers(id: string): WorkspaceRemoval {
    return this.#triggers.deleteWorkspace(id);
  }

  /**
   * `RegistryStore.upkeepSpares` with the Container settings at Global, as the Registry runs it, drawing fresh ids from
   * `ids` in order (a function cannot cross RPC).
   */
  upkeepSpares(environments: string[] | undefined, ids: string[], now: number): SpareUpkeep {
    const left = [...ids];

    return this.#store.upkeepSpares(
      environments,
      () => left.shift() ?? "ffffffff",
      now,
      globalSettingsOf(this.#store),
    );
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

  getSettings(): SettingsAnswer {
    return { ...readSettings(this.#store), overriddenIn: settingsOverriddenIn(this.#store) };
  }

  getSettingsOverrides(environment: string): SettingsOverridesState | null {
    return readSettingsOverrides(this.#store, environment);
  }

  /** Change an Environment's Overrides, as the Registry DO does; Overrides that do not resolve throw. */
  updateSettingsOverrides(
    environment: string,
    change: { set?: Schema.Json; reset?: ReadonlyArray<string> },
  ): SettingsOverridesState {
    const saved = updateSettingsOverrides(this.ctx.storage, this.#store, environment, change);

    if (saved === null) throw new Error(`No Environment ${environment}`);

    if (Result.isFailure(saved)) throw new Error(saved.failure.message);

    return saved.success;
  }

  /** Replace an Environment's own Instructions, as the Registry DO does; a text it refuses throws. */
  updateEnvironmentInstructions(environment: string, text: string): SettingsOverridesState {
    const saved = putEnvironmentInstructions(this.#store, environment, text);

    if (saved === null) throw new Error(`No Environment ${environment}`);

    if (Result.isFailure(saved)) throw new Error(saved.failure.message);

    return saved.success;
  }

  /** What Session `session` resolves its Settings from, as the Registry DO answers it. */
  sessionSettings(session: string): SessionSettingsSource {
    return sessionSettingsSource(this.#store, session);
  }

  /** Save settings overrides, as the Registry DO does; overrides that do not resolve throw. */
  updateSettings(overrides: Schema.Json, now: number): SettingsState {
    const saved = writeSettings(this.#store, overrides, now);

    if (Result.isFailure(saved)) throw new Error(saved.failure.message);

    return saved.success;
  }

  /** An Agent change to the Settings, Global's or `environment`'s Overrides, as the Registry DO makes one. */
  changeSettings(
    changes: ReadonlyArray<SettingsFieldChange>,
    author: AgentChangeAuthor,
    now: number,
    environment?: string,
  ): SettingsChange {
    return environment === undefined
      ? changeSettings(this.ctx.storage, this.#store, this.#changes, { changes, author }, now)
      : changeSettingsOverrides(
          this.ctx.storage,
          this.#store,
          this.#changes,
          { environment, changes, author },
          now,
        );
  }

  listAgentChanges(scope: string): ReadonlyArray<AgentChange> {
    return this.#changes.list(scope);
  }

  /** The owner's revert of an Agent change of `environment`, as the Registry DO makes it. */
  revertAgentChange(environment: string, change: number, now: number): AgentChangeRevert {
    return revertAgentChange(
      this.ctx.storage,
      this.#store,
      this.#changes,
      { environment, id: change },
      now,
      noSkills(this.ctx.storage),
    );
  }

  listSettingsChanges(): ReadonlyArray<AgentChange> {
    return this.#changes.list(SETTINGS_SCOPE);
  }

  revertSettingsChange(change: number, now: number): SettingsChangeRevert {
    return revertSettingsChange(this.ctx.storage, this.#store, this.#changes, { id: change }, now);
  }
}
