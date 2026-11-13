// @effect-diagnostics asyncFunction:off preferEffectArray:off
// What the Registry does with an Environment's MCP server set (`docs/architecture/mcp-configuration.md` → From the
// Registry to the host): the host's pull, the Environments a save pushes to, and the values of a server, over an
// in-memory store with Settings at both Scopes.
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MCP_HANDED_DOCUMENT } from "./mcp-registry.ts";
import { SIGN_INS_REVISION_DOCUMENT } from "./mcp-sign-ins.ts";
import {
  environmentMcpSet,
  mcpHandedUnreadable,
  mcpServerSetAnswer,
  mcpServerValuesAnswer,
  pendingMcpPushes,
  readsSecrets,
  recordMcpDeleted,
  recordMcpDestroyed,
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
  let live = [...ids];
  const overrides = new Map<string, Schema.Json>(Arr.map(ids, (id) => [id, {}] as const));
  const container = new Map<string, Schema.Json>(Arr.map(ids, (id) => [id, {}] as const));
  const workspaces = new Map<string, ReadonlyArray<{ name: string; url: string }>>();

  const fake: McpSetStore & {
    readonly global: (document: Schema.Json) => void;
    readonly overridesOf: (id: string, document: Schema.Json) => void;
    readonly variables: (id: string, variables: Record<string, string>) => void;
    readonly remove: (id: string) => void;
    readonly workspace: (id: string, repos: ReadonlyArray<{ name: string; url: string }>) => void;
  } = {
    getDocument: (name) => documents.get(name) ?? null,
    putDocument: (name, body) => void documents.set(name, body),
    getSettingsOverrides: (id) => (live.includes(id) ? (overrides.get(id) ?? null) : null),
    getEnvironmentSettings: (id) => (live.includes(id) ? (container.get(id) ?? null) : null),
    getEnvironment: (id) => (live.includes(id) ? { id, name: id, repos: [], createdAt: 0 } : null),
    getMcpRepoFiles: () => [],
    listEnvironments: () => Arr.map(live, (id) => ({ id, name: id, repos: [], createdAt: 0 })),
    getWorkspaceSetup: (id) => {
      const repos = workspaces.get(id);

      return repos === undefined
        ? null
        : { id, environment: "a", branch: `cloudpid/${id}`, base: null, repos };
    },
    workspace: (id, repos) => void workspaces.set(id, repos),
    remove: (id) => void (live = live.filter((kept) => kept !== id)),
    global: (document) => void documents.set(SETTINGS_DOCUMENT, JSON.stringify(document)),
    overridesOf: (id, document) => void overrides.set(id, document),
    variables: (id, variables) => void container.set(id, { variables }),
  };

  return fake;
};

/** The Registry's record of what the hosts were handed, as it keeps it. */
// SAFETY: the document is the Registry's own, which this file's pushes wrote.
const handedOf = (registry: McpSetStore) =>
  JSON.parse(registry.getDocument(MCP_HANDED_DOCUMENT) ?? "{}") as {
    readonly handed: Record<string, { readonly hash: string; readonly revision: number }>;
    readonly destroy: ReadonlyArray<string>;
  };

/** The sets pending for `environment`, each noted as pushed under its revision. */
const pushAll = (registry: McpSetStore, environment: string | undefined, now = 1) => {
  const { pushes } = pendingMcpPushes(registry, environment, now);

  for (const { environment: id, set } of pushes) {
    recordMcpPushed(registry, { environment: id, hash: set.hash, revision: set.revision }, now);
  }

  return pushes;
};

describe("the host's pull (mcpServerSet)", () => {
  it("answers the set when the host holds another, and only its hash when it holds this one", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    const first = mcpServerSetAnswer(registry, { environment: "a", heldHash: "old" }, 1);

    expect(first.set?.map(({ name }) => name)).toEqual(["linear"]);
    expect(first.revision).toBe(1);
    expect(first.signInsRevision).toBe(0);
    expect(mcpServerSetAnswer(registry, { environment: "a", heldHash: first.hash }, 2)).toEqual({
      hash: first.hash,
      signInsRevision: 0,
      revision: 2,
    });
  });

  it("answers the revision of the MCP sign-ins the Registry keeps, 0 before any and for an unreadable one", () => {
    const registry = store(["a"]);

    const revisionOf = (environment: string) =>
      mcpServerSetAnswer(registry, { environment }, 1).signInsRevision;

    expect(revisionOf("a")).toBe(0);

    registry.putDocument(SIGN_INS_REVISION_DOCUMENT, "7", 1);
    expect(revisionOf("a")).toBe(7);

    // Global's: an Environment the Registry does not list is told it too.
    expect(revisionOf("gone")).toBe(7);

    registry.putDocument(SIGN_INS_REVISION_DOCUMENT, "not a number", 1);
    expect(revisionOf("a")).toBe(0);
  });

  it("takes a host that holds nothing for one that holds the empty set", () => {
    const registry = store(["a", "b"]);

    registry.overridesOf("b", servers({ local: LOCAL }));

    expect(mcpServerSetAnswer(registry, { environment: "a" }, 1)).toEqual({
      hash: EMPTY_MCP_SET_HASH,
      signInsRevision: 0,
      revision: 1,
    });
    expect(mcpServerSetAnswer(registry, { environment: "b" }, 1).set).toHaveLength(1);
  });

  it("answers an Environment it does not list with no set and no revision, and notes nothing of it", () => {
    const registry = store([]);

    // Neither a set nor a revision: a host answered after its wipe is not filled again.
    expect(mcpServerSetAnswer(registry, { environment: "gone", heldHash: "old" }, 1)).toEqual({
      hash: EMPTY_MCP_SET_HASH,
      signInsRevision: 0,
    });
    expect(environmentMcpSet(registry, "gone")).toBeNull();
    expect(registry.getDocument(MCP_HANDED_DOCUMENT)).toBeNull();
  });

  it("notes the set it answers as handed, so a later change is pushed though no push was ever made", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    const answer = mcpServerSetAnswer(registry, { environment: "a", heldHash: "old" }, 1);

    // The same set: nothing to push.
    expect(pendingMcpPushes(registry, "a", 2).pushes).toEqual([]);

    // A failed push, a pull, and the Environment's last server removed: the host must be told the empty set.
    registry.global({});

    const { pushes } = pendingMcpPushes(registry, "a", 3);

    expect(pushes.map(({ set }) => set.hash)).toEqual([EMPTY_MCP_SET_HASH]);
    expect(pushes[0]?.set.entries).toEqual([]);
    expect(answer.hash).not.toBe(EMPTY_MCP_SET_HASH);
  });

  it("notes the set the host already holds as handed too, so a push applied whose note was lost is not forgotten", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    // The push was applied by the host, but `mcpPushed` never arrived: the Registry notes nothing.
    const [lost] = pendingMcpPushes(registry, "a", 1).pushes;

    // A pull from that host, which holds that very set: only its hash and a revision come back.
    const answer = mcpServerSetAnswer(
      registry,
      { environment: "a", heldHash: lost?.set.hash ?? "" },
      2,
    );

    expect(answer.set).toBeUndefined();
    expect(answer.revision).toBeGreaterThan(lost?.set.revision ?? 0);
    expect(pendingMcpPushes(registry, "a", 3).pushes).toEqual([]);

    // The owner removes the last server: with nothing noted, the empty set would never be pushed.
    registry.global({});

    expect(pendingMcpPushes(registry, "a", 4).pushes.map(({ set }) => set.hash)).toEqual([
      EMPTY_MCP_SET_HASH,
    ]);
  });
});

describe("the Environments to push to", () => {
  it("is none while no Environment has a server, so no host is woken", () => {
    expect(pendingMcpPushes(store(["a", "b"]), undefined, 1)).toEqual({ pushes: [], wipes: [] });
    expect(pendingMcpPushes(store(["a"]), "a", 1)).toEqual({ pushes: [], wipes: [] });
  });

  it("is each Environment whose set differs from what its host was told, once a Global save changed it", () => {
    const registry = store(["a", "b"]);

    registry.global(servers({ linear: LINEAR }));
    registry.overridesOf("b", servers({ linear: { url: "https://b.example/mcp" } }));

    expect(Arr.map(pushAll(registry, undefined), ({ environment }) => environment)).toEqual([
      "a",
      "b",
    ]);
    expect(pendingMcpPushes(registry, undefined, 2).pushes).toEqual([]);

    // A Global edit that Environment b's own entry hides: only a is pushed to.
    registry.global(servers({ linear: { ...LINEAR, description: "issues" } }));

    expect(
      Arr.map(pendingMcpPushes(registry, undefined, 3).pushes, ({ environment }) => environment),
    ).toEqual(["a"]);
  });

  it("pushes a set that went empty once, and then no more", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));
    pushAll(registry, "a");

    registry.global({});

    const [empty] = pushAll(registry, "a", 2);

    expect(empty?.set).toMatchObject({ kind: "set", hash: EMPTY_MCP_SET_HASH, entries: [] });
    expect(pendingMcpPushes(registry, "a", 3).pushes).toEqual([]);
  });

  it("keeps a set pending until its push is recorded, so a push that failed is made again", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    expect(pendingMcpPushes(registry, "a", 1).pushes).toHaveLength(1);
    expect(pendingMcpPushes(registry, "a", 2).pushes).toHaveLength(1);
  });

  it("looks only at the Environment it is asked about", () => {
    const registry = store(["a", "b"]);

    registry.global(servers({ linear: LINEAR }));

    expect(
      Arr.map(pendingMcpPushes(registry, "b", 1).pushes, ({ environment }) => environment),
    ).toEqual(["b"]);
  });

  it("keeps no hash of an Environment that is gone, and no value", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));
    recordMcpPushed(registry, { environment: "gone", hash: "h", revision: 1 }, 1);
    recordMcpPushed(registry, { environment: "a", hash: "i", revision: 2 }, 2);

    expect(Record.keys(handedOf(registry).handed)).toEqual(["a"]);
  });
});

describe("the revisions of the sets handed out", () => {
  it("rise with every set handed out, pushed or answered to a pull", () => {
    const registry = store(["a", "b"]);

    registry.global(servers({ linear: LINEAR }));

    expect(
      Arr.map(pendingMcpPushes(registry, undefined, 1).pushes, ({ set }) => set.revision),
    ).toEqual([1, 2]);
    expect(mcpServerSetAnswer(registry, { environment: "a", heldHash: "old" }, 2).revision).toBe(3);
  });

  it("is never lowered by a push that was answered late: the later pull's set stays recorded", () => {
    const registry = store(["a"]);

    registry.global(servers({ linear: LINEAR }));

    const [slow] = pendingMcpPushes(registry, "a", 1).pushes;

    registry.global(servers({ linear: LINEAR, local: LOCAL }));

    const pulled = mcpServerSetAnswer(registry, { environment: "a", heldHash: "old" }, 2);

    // The slow push's host answer arrives after the pull was answered.
    recordMcpPushed(
      registry,
      { environment: "a", hash: slow?.set.hash ?? "", revision: slow?.set.revision ?? 0 },
      3,
    );

    expect(handedOf(registry).handed["a"]).toEqual({
      hash: pulled.hash,
      revision: pulled.revision,
    });
    expect(pendingMcpPushes(registry, "a", 4).pushes).toEqual([]);
  });
});

describe("the record of what the hosts were handed", () => {
  it("is unreadable only when it exists and cannot be decoded, which the Registry says once", () => {
    const registry = store(["a"]);

    expect(mcpHandedUnreadable(registry)).toBe(false);

    registry.putDocument(MCP_HANDED_DOCUMENT, "{not json", 1);

    expect(mcpHandedUnreadable(registry)).toBe(true);

    // The next set handed out writes it afresh.
    registry.global(servers({ linear: LINEAR }));
    mcpServerSetAnswer(registry, { environment: "a", heldHash: "old" }, 2);

    expect(mcpHandedUnreadable(registry)).toBe(false);
  });
});

describe("the hosts to wipe", () => {
  it("is an Environment deleted after its host was handed a set, with the revision of its deletion, until the wipe is recorded", () => {
    const registry = store(["a", "b"]);

    registry.global(servers({ linear: LINEAR }));
    pushAll(registry, undefined);
    registry.remove("a");
    recordMcpDeleted(registry, "a", 2);

    // Above every set handed out so far (revisions 1 and 2).
    expect(pendingMcpPushes(registry, undefined, 3).wipes).toEqual([
      { environment: "a", revision: 3 },
    ]);
    expect(pendingMcpPushes(registry, "a", 3).pushes).toEqual([]);

    recordMcpDestroyed(registry, "a", 4);

    expect(pendingMcpPushes(registry, undefined, 5).wipes).toEqual([]);
  });

  it("is all of them at every sync, whatever Environment it is for: a lost wipe is retried by any save", () => {
    const registry = store(["a", "b", "c"]);

    registry.global(servers({ linear: LINEAR }));
    pushAll(registry, undefined);
    registry.remove("a");
    recordMcpDeleted(registry, "a", 2);
    registry.remove("b");
    recordMcpDeleted(registry, "b", 3);

    const wiped = (environment: string | undefined) =>
      pendingMcpPushes(registry, environment, 4).wipes.map((wipe) => wipe.environment);

    expect(wiped("c")).toEqual(["a", "b"]);
    expect(wiped("gone")).toEqual(["a", "b"]);
    expect(wiped(undefined)).toEqual(["a", "b"]);
  });

  it("is none for an Environment whose host was never handed a set: it holds nothing and is not woken", () => {
    const registry = store(["a"]);

    registry.remove("a");
    recordMcpDeleted(registry, "a", 1);

    expect(pendingMcpPushes(registry, undefined, 2).wipes).toEqual([]);
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
      redact: ["secret"],
    });
    // A Variable is no Secret: its value is not scrubbed.
    expect(mcpServerValuesAnswer(registry, input, {})).toMatchObject({
      headers: { Authorization: "Bearer variable" },
      redact: [],
    });
  });

  it("lists the Workspace's Repos with a stdio server's values, as Roots for it, when a Workspace is named", () => {
    const registry = store(["a"]);

    registry.global(servers({ local: LOCAL, linear: LINEAR }));
    registry.workspace("1a2b3c4d", [
      { name: "app", url: "https://github.com/ian/app.git" },
      { name: "tools", url: "https://example.com/team/tools" },
    ]);

    const input = (server: string, workspace?: string) => ({
      environment: "a",
      server,
      conn: withConn(registry, server),
      workspace,
    });

    const repos = [
      { directory: "app", slug: "ian/app" },
      { directory: "tools", slug: "tools" },
    ];

    // The Workspace as its object names it, or by its id.
    expect(mcpServerValuesAnswer(registry, input("local", "ws:1a2b3c4d"), {})).toMatchObject({
      status: "values",
      repos,
    });
    expect(mcpServerValuesAnswer(registry, input("local", "1a2b3c4d"), {})).toMatchObject({
      repos,
    });
    // Not named, not known, or not a stdio server's: no Repos.
    expect(mcpServerValuesAnswer(registry, input("local"), {})).not.toHaveProperty("repos");
    expect(mcpServerValuesAnswer(registry, input("local", "ws:ffffffff"), {})).not.toHaveProperty(
      "repos",
    );
    expect(mcpServerValuesAnswer(registry, input("linear", "ws:1a2b3c4d"), {})).not.toHaveProperty(
      "repos",
    );
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
