// The Registry DO's side of kept Secrets: checking what the owner sets, sealing it bound to its scope and name, and
// opening what an Environment uses, its own over those kept for every Environment. The store is an in-memory stand-in
// for the SQLite table (`store.workerd.test.ts` covers that one).
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { openKeptVault } from "@cloudpid/extensions/secrets/core";
import { MAX_ENVIRONMENT_SECRET_BYTES } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  buildSecretsDigest,
  keepSecret,
  openEnvironmentSecrets,
  type SecretsTable,
} from "./environment-secrets.ts";
import type { StoredEnvironmentSecret } from "./store.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const VALUE = "sk-live-0123456789abcdef";

/** The table in memory, keyed by scope and name, with the Environments that exist. */
const table = (environments: ReadonlyArray<string> = ["env-1", "env-2"]) => {
  const rows = new Map<string, StoredEnvironmentSecret>();
  const key = (environment: string | null, name: string) => `${environment ?? "*"}/${name}`;

  const store: SecretsTable = {
    getEnvironmentSecrets: (environment) =>
      [...rows.values()]
        .filter((row) => row.environment === null || row.environment === environment)
        .toSorted((a, b) => Number(a.environment !== null) - Number(b.environment !== null)),
    putEnvironmentSecret: ({ environment, name, sealed, build }, now) => {
      if (environment !== null && !environments.includes(environment)) return "missing";

      const known = rows.get(key(environment, name));
      const record = { environment, name, build: build ?? known?.build ?? false, updatedAt: now };

      rows.set(key(environment, name), { ...record, sealed });

      return record;
    },
  };

  return { store, rows, key };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const vault = () => run(openKeptVault(MASTER, "registry"));

describe("keeping a Secret", () => {
  it("seals the value, which the table never holds, and opens it for the Environment", async () => {
    const { store, rows } = table();
    const keys = await vault();

    expect(
      await run(
        keepSecret(store, keys, { environment: "env-1", name: "API_KEY", value: VALUE }, 5),
      ),
    ).toEqual({
      status: "saved",
      record: { environment: "env-1", name: "API_KEY", build: false, updatedAt: 5 },
    });
    expect(JSON.stringify([...rows.values()])).not.toContain(VALUE);
    expect(await run(openEnvironmentSecrets(store, keys, "env-1"))).toEqual([
      { name: "API_KEY", value: VALUE, scope: "environment", build: false },
    ]);
    expect(await run(openEnvironmentSecrets(store, keys, "env-2"))).toEqual([]);
  });

  it("refuses a malformed name or value, or an Environment that does not exist, saying why without the value", async () => {
    const { store, rows } = table();
    const keys = await vault();

    const refusals = await run(
      Effect.forEach(
        [
          { environment: "env-1", name: "api_key", value: VALUE },
          { environment: "env-1", name: "API_KEY", value: "" },
          {
            environment: "env-1",
            name: "API_KEY",
            value: "x".repeat(MAX_ENVIRONMENT_SECRET_BYTES + 1),
          },
          { environment: "env-9", name: "API_KEY", value: VALUE },
        ],
        (input) => keepSecret(store, keys, input, 5),
      ),
    );

    expect(refusals.map((refusal) => refusal.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "missing",
    ]);
    expect(JSON.stringify(refusals)).not.toContain(VALUE);
    expect(rows.size).toBe(0);
  });

  it("uses an Environment's own Secret over one of the same name kept for every Environment", async () => {
    const { store } = table();
    const keys = await vault();

    await run(
      keepSecret(store, keys, { environment: null, name: "API_KEY", value: "every-0123456789" }, 1),
    );
    await run(
      keepSecret(store, keys, { environment: null, name: "SHARED", value: "shared-0123456789" }, 1),
    );
    await run(
      keepSecret(
        store,
        keys,
        { environment: "env-1", name: "API_KEY", value: VALUE, build: true },
        2,
      ),
    );

    expect(await run(openEnvironmentSecrets(store, keys, "env-1"))).toEqual([
      { name: "API_KEY", value: VALUE, scope: "environment", build: true },
      { name: "SHARED", value: "shared-0123456789", scope: "every", build: false },
    ]);
    expect(await run(openEnvironmentSecrets(store, keys, "env-2"))).toEqual([
      { name: "API_KEY", value: "every-0123456789", scope: "every", build: false },
      { name: "SHARED", value: "shared-0123456789", scope: "every", build: false },
    ]);
  });

  it("opens no record moved to another scope or name, nor one sealed under another key", async () => {
    const { store, rows, key } = table();
    const keys = await vault();

    await run(keepSecret(store, keys, { environment: "env-1", name: "API_KEY", value: VALUE }, 1));

    const sealed = rows.get(key("env-1", "API_KEY"));

    if (sealed === undefined) throw new Error("not kept");

    // Moved to every Environment, and renamed in env-2.
    rows.set(key(null, "API_KEY"), { ...sealed, environment: null });
    rows.set(key("env-2", "OTHER"), { ...sealed, environment: "env-2", name: "OTHER" });

    expect(await run(openEnvironmentSecrets(store, keys, "env-2"))).toEqual([]);

    const rotated = await run(openKeptVault(`${MASTER}-rotated`, "registry"));

    expect(await run(openEnvironmentSecrets(store, rotated, "env-1"))).toEqual([]);
  });
});

describe("the digest of the Secrets a Build gets", () => {
  const secret = (name: string, value: string, build: boolean) => ({
    name,
    value,
    scope: "environment" as const,
    build,
  });

  it("is none without a Secret for the Build, whatever the others", async () => {
    const keys = await vault();

    expect(await run(buildSecretsDigest(keys, [secret("API_KEY", VALUE, false)]))).toBeNull();
  });

  it("changes with a Build Secret's value or name, not with the order or another Secret, and holds no value", async () => {
    const keys = await vault();
    const npm = secret("NPM_TOKEN", "npm_0123456789abcdef", true);
    const digest = await run(buildSecretsDigest(keys, [npm, secret("API_KEY", VALUE, false)]));

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await run(buildSecretsDigest(keys, [secret("API_KEY", "other-value-123", false), npm])),
    ).toBe(digest);
    expect(
      await run(buildSecretsDigest(keys, [secret("NPM_TOKEN", "npm_rotated_0123456", true)])),
    ).not.toBe(digest);
    expect(
      await run(buildSecretsDigest(keys, [secret("NPM_TOKEN2", "npm_0123456789abcdef", true)])),
    ).not.toBe(digest);
    expect(digest).not.toContain("npm_0123456789abcdef");
  });
});
