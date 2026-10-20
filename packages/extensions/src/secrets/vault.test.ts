// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import { openVault } from "./vault.ts";

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

  it("gives equal digests for equal text and different ones across Sessions", async () => {
    const one = await run(openVault(MASTER, "session-1"));
    const two = await run(openVault(MASTER, "session-2"));

    expect(await run(one.digest("hello"))).toBe(await run(one.digest("hello")));
    expect(await run(one.digest("hello"))).not.toBe(await run(one.digest("world")));
    expect(await run(one.digest("hello"))).not.toBe(await run(two.digest("hello")));
  });
});
