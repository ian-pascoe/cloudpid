// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The MCP server set the Registry hands a host, its hashes, the decision to push it, and the `${NAME}` values of a
// server (`docs/architecture/mcp-configuration.md` → From the Registry to the host, `${NAME}` values): all pure.
import { resolveMcpServerSet } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { EMPTY_MCP_SET_HASH, mcpServerSetOf, shouldPushMcpSet } from "./mcp-set.ts";
import { resolveMcpServerValues } from "./mcp-values.ts";

const LINEAR = { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TOKEN}" } };
const LOCAL = { command: "node", args: ["server.js"], env: { KEY: "${KEY}", PLAIN: "x" } };

const owner = (servers: Schema.Json): Schema.Json => ({ mcp: { servers } });

const setOf = (global: Schema.Json, overrides: Schema.Json = {}) =>
  mcpServerSetOf({ global, overrides, repos: [] });

const entry = (set: ReturnType<typeof setOf>, name: string) => {
  const found = Arr.findFirst(set.entries, (held) => held.name === name);

  if (Option.isNone(found)) throw new Error(`No server ${name}`);

  return found.value;
};

describe("the set a host is handed", () => {
  it("is empty, with the empty hash, for an Environment with no server", () => {
    expect(setOf({})).toEqual({ kind: "set", hash: EMPTY_MCP_SET_HASH, entries: [] });
  });

  it("has an entry for every server in force, with its source, defaults and three hashes", () => {
    const set = setOf(
      owner({ linear: LINEAR, local: LOCAL }),
      owner({ local: { enabled: false } }),
    );

    expect(Arr.map(set.entries, ({ name, source }) => `${name}:${source.kind}`)).toEqual([
      "linear:global",
      "local:global",
    ]);
    expect(entry(set, "linear").server).toMatchObject({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      enabled: true,
      exposure: "codemode",
      timeout: 60,
    });
    // The adjustment is in force, and a server switched off is still in the set.
    expect(entry(set, "local").server).toMatchObject({ type: "stdio", enabled: false });

    for (const { hash, conn, identity } of set.entries) {
      expect([hash, conn, identity].map((text) => text.length)).toEqual([64, 64, 64]);
    }
  });

  it("has the keys of a server's entry only when it has them, as JSON", () => {
    expect(entry(setOf(owner({ linear: LINEAR })), "linear").server).not.toHaveProperty("cwd");
    expect(JSON.stringify(entry(setOf(owner({ local: LOCAL })), "local").server)).not.toContain(
      "undefined",
    );
  });

  it("keeps ${NAME} as written: no resolved value is in the set, whatever the Secrets are", () => {
    const text = JSON.stringify(setOf(owner({ linear: LINEAR, local: LOCAL })));

    expect(text).toContain("Bearer ${TOKEN}");
    expect(text).toContain("${KEY}");
  });

  it("has the same hashes for the same layers, whatever the order its JSON keys were written in", () => {
    const left = setOf(owner({ a: { url: "https://a.example/mcp", timeout: 5 }, b: LOCAL }));
    const right = setOf(owner({ b: LOCAL, a: { timeout: 5, url: "https://a.example/mcp" } }));

    expect(left.entries.map(({ hash }) => hash).sort()).toEqual(
      right.entries.map(({ hash }) => hash).sort(),
    );
  });

  it("changes the entry's hash, the whole's and no other entry's with any key of the entry", () => {
    const before = setOf(owner({ linear: LINEAR, local: LOCAL }));

    for (const edit of [
      { description: "issues" },
      { timeout: 5 },
      { sampling: "off" },
      { exposure: "direct" },
      { enabled: false },
      { toolExposure: { "get_*": "hidden" } },
      { url: "https://mcp.linear.app/other" },
      { headers: { Authorization: "Bearer ${OTHER}" } },
    ]) {
      const after = setOf(owner({ linear: { ...LINEAR, ...edit }, local: LOCAL }));

      expect(after.hash).not.toBe(before.hash);
      expect(entry(after, "linear").hash).not.toBe(entry(before, "linear").hash);
      expect(entry(after, "local").hash).toBe(entry(before, "local").hash);
    }
  });

  it("changes the connection key only with what changes the connection", () => {
    const before = entry(setOf(owner({ linear: LINEAR })), "linear");

    for (const edit of [{ description: "issues" }, { timeout: 5 }, { exposure: "hidden" }]) {
      expect(entry(setOf(owner({ linear: { ...LINEAR, ...edit } })), "linear").conn).toBe(
        before.conn,
      );
    }

    expect(
      entry(setOf(owner({ linear: { ...LINEAR, url: "https://mcp.linear.app/other" } })), "linear")
        .conn,
    ).not.toBe(before.conn);
  });

  it("says where an Environment's own entry and each layer's come from", () => {
    const set = setOf(owner({ linear: LINEAR }), owner({ local: LOCAL }));

    expect(Arr.map(set.entries, ({ name, source }) => [name, source.kind])).toEqual([
      ["linear", "global"],
      ["local", "environment"],
    ]);
  });

  it("agrees with the resolver on which servers there are", () => {
    const global = owner({ linear: LINEAR, local: LOCAL });

    expect(Arr.map(setOf(global).entries, ({ name }) => name)).toEqual(
      Arr.map(resolveMcpServerSet(global, {}, []).servers, ({ name }) => name),
    );
  });

  it("changes the whole's hash when the order of the servers does", () => {
    const first = setOf(owner({ linear: LINEAR }), owner({ local: LOCAL }));
    const second = setOf(owner({ local: LOCAL }), owner({ linear: LINEAR }));

    expect(second.hash).not.toBe(first.hash);
  });
});

describe("the decision to push a set", () => {
  const some = setOf(owner({ linear: LINEAR })).hash;
  const other = setOf(owner({ local: LOCAL })).hash;

  it("pushes a set that differs from the one the host was told", () => {
    expect(shouldPushMcpSet(some, other)).toBe(true);
    expect(shouldPushMcpSet(undefined, some)).toBe(true);
    expect(shouldPushMcpSet(EMPTY_MCP_SET_HASH, some)).toBe(true);
  });

  it("does not push a set the host holds", () => {
    expect(shouldPushMcpSet(some, some)).toBe(false);
  });

  it("pushes an empty set only after a non-empty one", () => {
    expect(shouldPushMcpSet(some, EMPTY_MCP_SET_HASH)).toBe(true);
    expect(shouldPushMcpSet(undefined, EMPTY_MCP_SET_HASH)).toBe(false);
    expect(shouldPushMcpSet(EMPTY_MCP_SET_HASH, EMPTY_MCP_SET_HASH)).toBe(false);
  });
});

describe("the values of a server", () => {
  const resolved = (global: Schema.Json, name: string) => {
    const found = Arr.findFirst(
      resolveMcpServerSet(global, {}, []).servers,
      (held) => held.name === name,
    );

    if (Option.isNone(found)) throw new Error(`No server ${name}`);

    return found.value;
  };

  it("resolves a stdio server's env and an HTTP server's headers, Secrets first, then Variables", () => {
    const global = owner({ linear: LINEAR, local: LOCAL });

    expect(
      resolveMcpServerValues(resolved(global, "linear"), {
        secrets: { TOKEN: "s3cret" },
        variables: { TOKEN: "variable" },
      }),
    ).toEqual({
      status: "values",
      env: {},
      headers: { Authorization: "Bearer s3cret" },
      missing: [],
      redact: ["s3cret"],
    });

    expect(
      resolveMcpServerValues(resolved(global, "local"), {
        secrets: {},
        variables: { KEY: "value" },
      }),
    ).toEqual({
      status: "values",
      env: { KEY: "value", PLAIN: "x" },
      headers: {},
      missing: [],
      redact: [],
    });
  });

  it("leaves a name with no value as written, and lists it", () => {
    const global = owner({ local: { command: "node", env: { A: "${B}-${C}", D: "${B}" } } });

    expect(
      resolveMcpServerValues(resolved(global, "local"), { secrets: {}, variables: { C: "c" } }),
    ).toEqual({
      status: "values",
      env: { A: "${B}-c", D: "${B}" },
      headers: {},
      missing: ["B"],
      redact: [],
    });
  });

  it("gives a Repo's entry no Secret", () => {
    const set = resolveMcpServerSet({}, {}, [
      {
        directory: "app",
        slug: "acme/app",
        path: ".pi/mcp.json",
        text: JSON.stringify({
          mcpServers: { local: { command: "node", env: { KEY: "${KEY}" } } },
        }),
      },
    ]);

    const [repo] = set.servers;

    if (repo === undefined) throw new Error("No Repo server");

    expect(
      resolveMcpServerValues(repo, { secrets: { KEY: "secret" }, variables: { OTHER: "v" } }),
    ).toMatchObject({ env: { KEY: "${KEY}" }, missing: ["KEY"] });
    expect(resolveMcpServerValues(repo, { secrets: {}, variables: { KEY: "v" } })).toMatchObject({
      env: { KEY: "v" },
      missing: [],
    });
  });
});
