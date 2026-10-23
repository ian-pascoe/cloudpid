// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
// The workerd test Durable Object that hosts a `RegistryStore` over its SQLite storage, as the Registry DO does.
import type { PushSubscription } from "@cloudpid/protocol";
import { DurableObject } from "cloudflare:workers";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { readSettings, type SettingsState, writeSettings } from "./settings.ts";
import {
  type Deletion,
  type EnvironmentNaming,
  type EnvironmentRecord,
  type LegacyObject,
  openRegistryStore,
  type RegistryStore,
  type RepoChange,
  type SessionRecord,
  type SessionRefusal,
  type SessionStatus,
  type StoredWorkspaceChoice,
  type WorkspaceRecord,
  type WorkspaceSetup,
} from "./store.ts";
import type { EnvironmentRepo } from "@cloudpid/protocol";

export class TestRegistry extends DurableObject {
  readonly #store: RegistryStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = openRegistryStore(ctx.storage);
  }

  createSession(
    input: { id: string; title: string | null; workspace: StoredWorkspaceChoice },
    now: number,
  ): SessionRecord | SessionRefusal {
    return this.#store.createSession(input, now);
  }

  getSession(id: string): SessionRecord | null {
    return this.#store.getSession(id);
  }

  listSessions(): SessionRecord[] {
    return this.#store.listSessions();
  }

  setSessionStatus(id: string, status: SessionStatus, now: number): void {
    this.#store.setSessionStatus(id, status, now);
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

  getEnvironment(id: string): EnvironmentRecord | null {
    return this.#store.getEnvironment(id);
  }

  listEnvironments(): EnvironmentRecord[] {
    return this.#store.listEnvironments();
  }

  renameEnvironment(id: string, name: string): EnvironmentNaming {
    return this.#store.renameEnvironment(id, name);
  }

  deleteEnvironment(id: string): Deletion {
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

  takeLegacy(limit: number, now: number, leaseMs: number): LegacyObject[] {
    return this.#store.takeLegacy(limit, now, leaseMs);
  }

  forgetLegacy(object: LegacyObject): void {
    this.#store.forgetLegacy(object);
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
}
