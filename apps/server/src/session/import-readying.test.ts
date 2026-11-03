// @effect-diagnostics asyncFunction:off -- the readying is a Promise.
import { describe, expect, it } from "vitest";
import type { ImportRecord } from "./import-staging.ts";
import { IMPORT_NOT_READIED, importReadying } from "./import-readying.ts";
import type { SettingsKv } from "./settings.ts";

const SESSION = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

const kv = (importing: boolean): SettingsKv => {
  const rows = new Map<string, unknown>(
    importing ? [["fork-copy", { ids: {}, import: true }]] : [],
  );

  return {
    // SAFETY: the test reads back what it put.
    get: <T>(key: string) => rows.get(key) as T | undefined,
    put: (key, value) => {
      rows.set(key, value);
    },
  };
};

// SAFETY: the readying only asks whether a record exists, never what is in it.
const record = {} as ImportRecord;

const options = (
  overrides: Partial<Parameters<typeof importReadying>[0]> = {},
): Parameters<typeof importReadying>[0] => ({
  kv: kv(false),
  staging: { record: () => record },
  session: SESSION,
  workspace: "ws-1",
  placed: () => Promise.resolve("ws-1"),
  ...overrides,
});

describe("readying the Workspace of a Session that may be an import", () => {
  it("refuses while the import is under way, so its Changes are not applied before the pushes are done", async () => {
    await expect(importReadying(options({ kv: kv(true) }))).rejects.toThrow(IMPORT_NOT_READIED);
  });

  it("takes an import's Changes from a ref of its own, in its own Workspace", async () => {
    expect(await importReadying(options())).toEqual({ carry: `refs/cloudpid/import/${SESSION}` });
  });

  it("leaves another Workspace of the Session, and a Session that is no import, on the branch's ref", async () => {
    expect(await importReadying(options({ workspace: "subagent-ws" }))).toEqual({});
    expect(await importReadying(options({ staging: { record: () => undefined } }))).toEqual({});
    expect(await importReadying(options({ session: undefined }))).toEqual({});
  });
});
