// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import { openKeptVault, openVault } from "./vault.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const OTHER_MASTER = "another-master-key-0123456789abcdef012345";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("SecretVault", () => {
  it("opens what it sealed", async () => {
    const vault = await run(openVault(MASTER, "session-1"));
    const sealed = await run(vault.seal("API_KEY", "sk-live-abc", 1_000));

    expect(await run(vault.open(sealed))).toBe("sk-live-abc");
  });

  it("never stores the value in the sealed record", async () => {
    const vault = await run(openVault(MASTER, "session-1"));
    const sealed = await run(vault.seal("API_KEY", "sk-live-abcdefgh", 1_000));

    expect(JSON.stringify(sealed)).not.toContain("sk-live-abcdefgh");
  });

  it("cannot open a record under another master key", async () => {
    const sealed = await run(
      Effect.flatMap(openVault(MASTER, "session-1"), (vault) =>
        vault.seal("API_KEY", "sk-live-abc", 1_000),
      ),
    );

    const other = await run(openVault(OTHER_MASTER, "session-1"));

    expect(Exit.isFailure(await Effect.runPromiseExit(other.open(sealed)))).toBe(true);
  });

  it("cannot open a record in another Session", async () => {
    const sealed = await run(
      Effect.flatMap(openVault(MASTER, "session-1"), (vault) =>
        vault.seal("API_KEY", "sk-live-abc", 1_000),
      ),
    );

    const other = await run(openVault(MASTER, "session-2"));

    expect(Exit.isFailure(await Effect.runPromiseExit(other.open(sealed)))).toBe(true);
  });

  it("cannot open a record whose name or expiry was changed", async () => {
    const vault = await run(openVault(MASTER, "session-1"));
    const sealed = await run(vault.seal("API_KEY", "sk-live-abc", 1_000));

    for (const edited of [
      { ...sealed, name: "OTHER_KEY" },
      { ...sealed, expiresAt: 10_000_000 },
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(vault.open(edited)))).toBe(true);
    }
  });

  it("refuses a master key too short to be one", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(openVault("short", "session-1")))).toBe(true);
  });
});

describe("KeptVault", () => {
  const binding = { owner: "env-1", name: "API_KEY" };

  it("opens what it sealed, and never stores the value or the name", async () => {
    const vault = await run(openKeptVault(MASTER, "registry"));
    const sealed = await run(vault.seal(binding, "sk-live-abcdefgh"));

    expect(JSON.stringify(sealed)).not.toContain("sk-live-abcdefgh");
    expect(JSON.stringify(sealed)).not.toContain("API_KEY");
    expect(await run(vault.open(binding, sealed))).toBe("sk-live-abcdefgh");
  });

  it("cannot open a record moved to another owner or name", async () => {
    const vault = await run(openKeptVault(MASTER, "registry"));
    const sealed = await run(vault.seal(binding, "sk-live-abc"));

    for (const moved of [
      { owner: "*", name: "API_KEY" },
      { owner: "env-1", name: "OTHER_KEY" },
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(vault.open(moved, sealed)))).toBe(true);
    }
  });

  it("cannot open a record under another purpose or master key, nor a Session's", async () => {
    const sealed = await run(
      Effect.flatMap(openKeptVault(MASTER, "registry"), (vault) =>
        vault.seal(binding, "sk-live-abc"),
      ),
    );

    for (const other of [
      await run(openKeptVault(MASTER, "workspace:ws-1")),
      await run(openKeptVault(OTHER_MASTER, "registry")),
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(other.open(binding, sealed)))).toBe(true);
    }

    // A Session's vault with the purpose as its id reads no kept record either.
    const session = await run(openVault(MASTER, "registry"));
    const asSession = { ...sealed, name: "API_KEY", expiresAt: 0 };

    expect(Exit.isFailure(await Effect.runPromiseExit(session.open(asSession)))).toBe(true);
  });

  it("digests with the key: the same text gives the same digest, another key another one", async () => {
    const vault = await run(openKeptVault(MASTER, "registry"));
    const digest = await run(vault.digest("API_KEY=sk-live-abc"));

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(vault.digest("API_KEY=sk-live-abc"))).toBe(digest);
    expect(await run(vault.digest("API_KEY=sk-live-abd"))).not.toBe(digest);

    const other = await run(openKeptVault(OTHER_MASTER, "registry"));

    expect(await run(other.digest("API_KEY=sk-live-abc"))).not.toBe(digest);
  });
});
