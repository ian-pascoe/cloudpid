// @effect-diagnostics preferEffectArray:off preferEffectRecord:off nodeBuiltinImport:off asyncFunction:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; runs on node, on the owner's machine; plain Promises, as node's fs gives them.
/**
 * Where the sign-in is kept (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → The connection):
 * `cloudpid-auth.json` in pi's agent directory, mode 0600, written atomically, one entry per endpoint URL.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_FILE, type AuthEntry, fileAuthStore } from "./auth-store.ts";
import { Refusal } from "./errors.ts";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-cloudpid-store-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const entry = (label: string): AuthEntry => ({
  client: { client_id: `client-${label}`, redirect_uris: ["http://127.0.0.1:1/callback"] },
  tokens: {
    access_token: `access-${label}`,
    token_type: "Bearer",
    expires_in: 300,
    refresh_token: `refresh-${label}`,
  },
  obtainedAt: 1_700_000_000_000,
  discovery: { authorizationServerUrl: "https://auth.example.test" },
});

const file = () => join(directory, AUTH_FILE);

describe("the sign-in file", () => {
  it("reads nothing before anything is written", async () => {
    expect(await fileAuthStore(directory).read("https://a.example.test/mcp")).toBeUndefined();
  });

  it("round-trips an entry: the client, the tokens, when they were obtained, and discovery", async () => {
    const store = fileAuthStore(directory);

    await store.write("https://a.example.test/mcp", entry("a"));

    expect(await store.read("https://a.example.test/mcp")).toEqual(entry("a"));
  });

  it("is a file only its owner can read or write, and stays so when it is rewritten", async () => {
    const store = fileAuthStore(directory);

    await store.write("https://a.example.test/mcp", entry("a"));
    expect(statSync(file()).mode & 0o777).toBe(0o600);

    await store.write("https://a.example.test/mcp", entry("b"));
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("is written atomically: nothing but the file is left behind", async () => {
    const store = fileAuthStore(directory);

    await Promise.all([
      store.write("https://a.example.test/mcp", entry("a")),
      store.write("https://b.example.test/mcp", entry("b")),
      store.write("https://c.example.test/mcp", entry("c")),
    ]);

    expect(readdirSync(directory)).toEqual([AUTH_FILE]);
    // Whole JSON, every write kept (they ran one after the other).
    expect(Object.keys(JSON.parse(readFileSync(file(), "utf8")).endpoints).sort()).toEqual([
      "https://a.example.test/mcp",
      "https://b.example.test/mcp",
      "https://c.example.test/mcp",
    ]);
  });

  it("keeps one entry per endpoint URL, so a project on a preview stage keeps its own", async () => {
    const store = fileAuthStore(directory);

    await store.write("https://prod.example.test/mcp", entry("prod"));
    await store.write("https://preview.example.test/mcp", entry("preview"));
    await store.write("https://prod.example.test/mcp", entry("prod-2"));

    expect((await store.read("https://prod.example.test/mcp"))?.tokens?.access_token).toBe(
      "access-prod-2",
    );
    expect((await store.read("https://preview.example.test/mcp"))?.tokens?.access_token).toBe(
      "access-preview",
    );
    expect(await store.read("https://other.example.test/mcp")).toBeUndefined();
  });

  it("removes one endpoint's entry and leaves the others", async () => {
    const store = fileAuthStore(directory);

    await store.write("https://prod.example.test/mcp", entry("prod"));
    await store.write("https://preview.example.test/mcp", entry("preview"));

    expect(await store.remove("https://preview.example.test/mcp")).toBe(true);
    expect(await store.remove("https://preview.example.test/mcp")).toBe(false);
    expect(await store.read("https://preview.example.test/mcp")).toBeUndefined();
    expect((await store.read("https://prod.example.test/mcp"))?.tokens?.access_token).toBe(
      "access-prod",
    );
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("creates the agent directory when it is not there", async () => {
    const nested = join(directory, "not", "yet");

    await fileAuthStore(nested).write("https://a.example.test/mcp", entry("a"));

    expect(readdirSync(nested)).toEqual([AUTH_FILE]);
  });

  it("refuses a file it cannot read, and never overwrites it", async () => {
    writeFileSync(file(), "{ not json");

    const store = fileAuthStore(directory);

    await expect(store.read("https://a.example.test/mcp")).rejects.toBeInstanceOf(Refusal);
    await expect(store.write("https://a.example.test/mcp", entry("a"))).rejects.toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(file(), "utf8")).toBe("{ not json");

    writeFileSync(file(), JSON.stringify({ somethingElse: true }));

    await expect(store.remove("https://a.example.test/mcp")).rejects.toThrow(
      /not a cloudpid sign-in file/,
    );
  });

  it("drops a part of an entry that has not the fields the flow reads", async () => {
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        endpoints: {
          "https://a.example.test/mcp": { client: { no: "id" }, tokens: { access_token: "x" } },
        },
      }),
    );

    const read = await fileAuthStore(directory).read("https://a.example.test/mcp");

    expect(read?.client).toBeUndefined();
    expect(read?.tokens?.access_token).toBe("x");
  });
});
