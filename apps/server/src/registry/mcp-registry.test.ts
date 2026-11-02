// @effect-diagnostics asyncFunction:off preferEffectArray:off
// What the Registry does with an Environment's MCP server set (`docs/architecture/mcp-configuration.md` → From the
// Registry to the host): the host's pull, the Environments a save pushes to, and the values of a server, over an
// in-memory store with Settings at both Scopes.
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MCP_HANDED_DOCUMENT } from "./mcp-registry.ts";
import {
  environmentMcpSet,
  mcpServerSetAnswer,
  mcpServerValuesAnswer,
  pendingMcpPushes,
  readsSecrets,
  recordMcpPushed,
  type McpSetStore,
} from "./mcp-registry.ts";
import { EMPTY_MCP_SET_HASH } from "./mcp-set.ts";
import { SETTINGS_DOCUMENT } from "./settings.ts";

const LINEAR = { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TOKEN}" } };
const LOCAL = { command: "node", args: ["server.js"] };

const servers = (value: Schema.Json): Schema.Json => ({ mcp: { servers: value } });

/** A store with Environments `ids`, each with the Settings Overrides and Container settings Overrides given. */
const store = (ids: ReadonlyArray<string>) => {
  const documents = new Map<string, string>();
  const overrides = new Map<string, Schema.Json>(Arr.map(ids, (id) => [id, {}] as const));
  const container = new Map<string, Schema.Json>(Arr.map(ids, (id) => [id, {}] as const));

  const fake: McpSetStore & {
    readonly global: (document: Schema.Json) => void;
    readonly overridesOf: (id: string, document: Schema.Json) => void;
    readonly variables: (id: string, variables: Record<string, string>) => void;
  } = {
    getDocument: (name) => documents.get(name) ?? null,
    putDocument: (name, body) => void documents.set(name, body),
    getSettingsOverrides: (id) => overrides.get(id) ?? null,
    getEnvironmentSettings: (id) => container.get(id) ?? null,
    listEnvironments: () => Arr.map(ids, (id) => ({ id, name: id, repos: [], createdAt: 0 })),
    global: (document) => void documents.set(SETTINGS_DOCUMENT, JSON.stringify(document)),
    overridesOf: (id, document) => void overrides.set(id, document),
    variables: (id, variables) => void container.set(id, { variables }),
  };

  return fake;
};

describe("the host's pull (mcpServerSet)", () => {
  it("answers the set when the host holds another, and only its hash when it holds this one", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    const first = mcpServerSetAnswer(registry, { environment: "a", heldHash: "old" });

    expect(first.set?.map(({ name }) => name)).toEqual(["linear"]);
    expect(first.signInsRevision).toBe(0);
    expect(mcpServerSetAnswer(registry, { environment: "a", heldHash: first.hash })).toEqual({
      hash: first.hash,
      signInsRevision: 0,
    });
  });

  it("takes a host that holds nothing for one that holds the empty set", () => {
    const registry = store(["a", "b"]);

    registry.overridesOf("b", servers({ local: LOCAL }));

    expect(mcpServerSetAnswer(registry, { environment: "a" })).toEqual({
      hash: EMPTY_MCP_SET_HASH,
      signInsRevision: 0,
    });
    expect(mcpServerSetAnswer(registry, { environment: "b" }).set).toHaveLength(1);
  });

  it("answers an Environment it does not list as one with no servers", () => {
    expect(mcpServerSetAnswer(store([]), { environment: "gone", heldHash: "old" })).toEqual({
      hash: EMPTY_MCP_SET_HASH,
      signInsRevision: 0,
      set: [],
    });
    expect(environmentMcpSet(store([]), "gone")).toBeNull();
  });
});

describe("the Environments to push to", () => {
  it("is none while no Environment has a server, so no host is woken", () => {
    expect(pendingMcpPushes(store(["a", "b"]), undefined)).toEqual([]);
    expect(pendingMcpPushes(store(["a"]), "a")).toEqual([]);
  });

  it("is each Environment whose set differs from what its host was told, once a Global save changed it", () => {
    const registry = store(["a", "b"]);

    registry.global(servers({ linear: LINEAR }));
    registry.overridesOf("b", servers({ linear: { url: "https://b.example/mcp" } }));

    const pending = pendingMcpPushes(registry, undefined);

    expect(Arr.map(pending, ({ environment }) => environment)).toEqual(["a", "b"]);

    for (const { environment, set } of pending) recordMcpPushed(registry, environment, set.hash, 1);

    expect(pendingMcpPushes(registry, undefined)).toEqual([]);

    // A Global edit that Environment b's own entry hides: only a is pushed to.
    registry.global(servers({ linear: { ...LINEAR, description: "issues" } }));

    expect(
      Arr.map(pendingMcpPushes(registry, undefined), ({ environment }) => environment),
    ).toEqual(["a"]);
  });

  it("pushes a set that went empty once, and then no more", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));
    pendingMcpPushes(registry, "a").forEach(({ environment, set }) =>
      recordMcpPushed(registry, environment, set.hash, 1),
    );

    registry.global({});

    const [empty] = pendingMcpPushes(registry, "a");

    expect(empty?.set).toEqual({ kind: "set", hash: EMPTY_MCP_SET_HASH, entries: [] });

    recordMcpPushed(registry, "a", EMPTY_MCP_SET_HASH, 2);

    expect(pendingMcpPushes(registry, "a")).toEqual([]);
  });

  it("keeps a set pending until its push is recorded, so a push that failed is made again", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    expect(pendingMcpPushes(registry, "a")).toHaveLength(1);
    expect(pendingMcpPushes(registry, "a")).toHaveLength(1);
  });

  it("looks only at the Environment it is asked about", () => {
    const registry = store(["a", "b"]);

    registry.global(servers({ linear: LINEAR }));

    expect(Arr.map(pendingMcpPushes(registry, "b"), ({ environment }) => environment)).toEqual([
      "b",
    ]);
  });

  it("keeps no hash of an Environment that is gone, and no value", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));
    recordMcpPushed(registry, "gone", "h", 1);
    recordMcpPushed(registry, "a", "i", 2);

    expect(Record.keys(JSON.parse(registry.getDocument(MCP_HANDED_DOCUMENT) ?? "{}"))).toEqual([
      "a",
    ]);
  });
});

describe("the values of a server (mcpServerValues)", () => {
  const withConn = (registry: ReturnType<typeof store>, server: string) => {
    const [set] = [environmentMcpSet(registry, "a")];
    const found = set?.entries.find(({ name }) => name === server);

    if (found === undefined) throw new Error(`No server ${server}`);

    return found.conn;
  };

  it("resolves against the Secrets, then the Variables, for the connection the host holds", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));
    registry.variables("a", { TOKEN: "variable" });

    const input = { environment: "a", server: "linear", conn: withConn(registry, "linear") };

    expect(readsSecrets(registry, "a", "linear")).toBe(true);
    expect(mcpServerValuesAnswer(registry, input, { TOKEN: "secret" })).toEqual({
      status: "values",
      env: {},
      headers: { Authorization: "Bearer secret" },
      missing: [],
    });
    expect(mcpServerValuesAnswer(registry, input, {})).toMatchObject({
      headers: { Authorization: "Bearer variable" },
    });
  });

  it("says a server is unknown, or changed with its current connection, and reads no Secret then", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    expect(
      mcpServerValuesAnswer(registry, { environment: "a", server: "nope", conn: "x" }, {}),
    ).toEqual({ status: "unknown_server" });
    expect(readsSecrets(registry, "a", "nope")).toBe(false);
    expect(
      mcpServerValuesAnswer(registry, { environment: "a", server: "linear", conn: "stale" }, {}),
    ).toEqual({ status: "server_changed", conn: withConn(registry, "linear") });
  });
});
