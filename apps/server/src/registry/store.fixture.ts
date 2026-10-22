// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
// The workerd test Durable Object that hosts a `RegistryStore` over its SQLite storage, as the Registry DO does.
import type { PushSubscription } from "@cloudpid/protocol";
import { DurableObject } from "cloudflare:workers";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { readSettings, type SettingsState, writeSettings } from "./settings.ts";
import {
  openRegistryStore,
  type RegistryStore,
  type SessionRecord,
  type SessionStatus,
  type MachineDeletion,
  type MachineRecord,
  type MachineRename,
} from "./store.ts";

export class TestRegistry extends DurableObject {
  readonly #store: RegistryStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = openRegistryStore(ctx.storage);
  }

  createSession(
    input: { id: string; title: string | null; machine?: string; repo?: string },
    now: number,
  ): SessionRecord {
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

  createMachine(slug: string, now: number): MachineRecord {
    return this.#store.createMachine(slug, now);
  }

  getMachine(slug: string): MachineRecord | null {
    return this.#store.getMachine(slug);
  }

  listMachines(): MachineRecord[] {
    return this.#store.listMachines();
  }

  renameMachine(slug: string, name: string): MachineRename {
    return this.#store.renameMachine(slug, name);
  }

  deleteMachine(slug: string): MachineDeletion {
    return this.#store.deleteMachine(slug);
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
