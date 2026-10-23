// @effect-diagnostics asyncFunction:off
import { type KeptSecret, openKeptVault } from "@cloudpid/extensions/secrets/core";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { workspaceSecretsStore } from "./environment-secrets.ts";
import type { SettingsStorage } from "./settings.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const VALUE = "sk-live-0123456789abcdef";

const secret = (name: string, value: string, build = false): KeptSecret => ({
  name,
  value,
  scope: "environment",
  build,
});

/** A Durable Object's storage, in memory, that outlives the stores opened over it (an eviction). */
const memory = () => {
  const map = new Map<string, unknown>();

  const storage: SettingsStorage = {
    // SAFETY: the store reads back only what it wrote under each key.
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => {
      map.set(key, structuredClone(value));
    },
  };

  return { storage, dump: () => JSON.stringify([...map]) };
};

const open = (storage: SettingsStorage, master: string | null = MASTER, owner = "ws-1") =>
  workspaceSecretsStore({
    storage,
    vault: () =>
      master === null
        ? Promise.reject(new Error("no SECRETS_ENCRYPTION_KEY"))
        : Effect.runPromise(openKeptVault(master, "workspace")),
    owner,
  });

describe("a Workspace's copy of its Environment's Secrets", () => {
  it("holds none until it is handed some", async () => {
    expect(await open(memory().storage).read()).toEqual({ ok: true, secrets: [] });
  });

  it("keeps what it is handed sealed, and opens it again after an eviction", async () => {
    const { storage, dump } = memory();
    const handed = [secret("API_KEY", VALUE), secret("NPM_TOKEN", "npm_0123456789", true)];

    await open(storage).replace(handed);

    expect(dump()).not.toContain(VALUE);
    expect(dump()).not.toContain("npm_0123456789");
    expect(await open(storage).read()).toEqual({ ok: true, secrets: handed });
  });

  it("says it cannot show what it holds when its copy does not open: another key, or another object's copy", async () => {
    const { storage } = memory();

    await open(storage).replace([secret("API_KEY", VALUE)]);

    for (const other of [open(storage, `${MASTER}-rotated`), open(storage, MASTER, "ws-2")]) {
      const read = await other.read();

      expect(read.ok).toBe(false);
      expect(JSON.stringify(read)).toContain("API_KEY");
      expect(JSON.stringify(read)).not.toContain(VALUE);
    }
  });

  it("without the key, holds what it is handed until an eviction, then knows it has Secrets it cannot open", async () => {
    const { storage, dump } = memory();
    const unkeyed = open(storage, null);

    await unkeyed.replace([secret("API_KEY", VALUE)]);

    expect(await unkeyed.read()).toEqual({ ok: true, secrets: [secret("API_KEY", VALUE)] });
    expect(dump()).not.toContain(VALUE);
    expect((await open(storage, null).read()).ok).toBe(false);
  });

  it("says it cannot show its Secrets once told the Registry could not open them, until it is handed some", async () => {
    const { storage } = memory();
    const store = open(storage);

    await store.replace([secret("API_KEY", VALUE)]);
    await store.markUnavailable("the Registry could not open them");

    expect(await store.read()).toEqual({ ok: false, reason: "the Registry could not open them" });
    // Still taken out of output: the values may be on the Container.
    expect(store.known()).toEqual([secret("API_KEY", VALUE)]);
    // After an eviction too.
    expect(await open(storage).read()).toEqual({
      ok: false,
      reason: "the Registry could not open them",
    });

    // The same set handed again replaces the mark.
    await store.replace([secret("API_KEY", VALUE)]);
    expect(await open(storage).read()).toEqual({ ok: true, secrets: [secret("API_KEY", VALUE)] });
  });

  it("holds none again once handed none, and gives what it holds in memory without waiting", async () => {
    const { storage } = memory();
    const store = open(storage);

    expect(store.known()).toEqual([]);
    await store.replace([secret("API_KEY", VALUE)]);
    expect(store.known()).toEqual([secret("API_KEY", VALUE)]);
    await store.replace([]);
    expect(await open(storage).read()).toEqual({ ok: true, secrets: [] });
  });
});
