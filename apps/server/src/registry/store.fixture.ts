// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
// The workerd test Durable Object that hosts a `RegistryStore` over its SQLite storage, as the Registry DO does.
import { DurableObject } from "cloudflare:workers";
import {
  openRegistryStore,
  type RegistryStore,
  type SessionRecord,
  type SessionStatus,
  type WorkspaceRecord,
} from "./store.ts";

export class TestRegistry extends DurableObject {
  readonly #store: RegistryStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = openRegistryStore(ctx.storage);
  }

  createSession(
    input: { id: string; title: string | null; workspace?: string },
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

  createWorkspace(slug: string, now: number): WorkspaceRecord {
    return this.#store.createWorkspace(slug, now);
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.#store.listWorkspaces();
  }
}
