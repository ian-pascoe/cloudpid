import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { type McpRepoLayer, resolveMcpServerSet } from "./mcp-server-set.ts";
import { type McpServerValue, normalizeMcpServer } from "./mcp-servers.ts";
import { resolveOverridesLeniently } from "./settings-overrides.ts";
import { resolveLeniently } from "./settings.ts";

const LINEAR = { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TOKEN}" } };
const LOCAL = { command: "node", args: ["server.js"] };

const owner = (servers: Schema.Json): Schema.Json => ({ mcp: { servers } });

/** A Repo's file in directory `directory`, whose slug is `acme/<directory>`. */
const repo = (directory: string, servers: Schema.Json): McpRepoLayer => ({
  directory,
  slug: `acme/${directory}`,
  path: ".pi/mcp.json",
  text: JSON.stringify({ mcpServers: servers }),
});

const REPO_SOURCE = (directory: string) => ({
  kind: "repo",
  directory,
  slug: `acme/${directory}`,
  path: ".pi/mcp.json",
});

const resolve = (global: Schema.Json, environment: Schema.Json, ...repos: Array<McpRepoLayer>) =>
  resolveMcpServerSet(global, environment, repos);

/** The names of the set, with where each comes from. */
const sources = (set: ReturnType<typeof resolve>) =>
  Arr.map(set.servers, ({ name, source }) => `${name}:${source.kind}`);

const server = (set: ReturnType<typeof resolve>, name: string) => {
  const found = Arr.findFirst(set.servers, (held) => held.name === name);

  if (Option.isNone(found)) throw new Error(`No server ${name}`);

  return found.value;
};

describe("the MCP server set", () => {
  it("is empty for an Environment with no server anywhere", () => {
    expect(resolve({}, {})).toEqual({ servers: [], problems: [], orphans: [], hints: [] });
  });

  it("holds Global's servers, read in force with their defaults, and no problem", () => {
    const set = resolve(owner({ linear: LINEAR, local: LOCAL }), {});

    expect(set.problems).toEqual([]);
    expect(sources(set)).toEqual(["linear:global", "local:global"]);
    expect(server(set, "linear")).toEqual({
      name: "linear",
      source: { kind: "global" },
      server: {
        type: "http",
        url: LINEAR.url,
        headers: LINEAR.headers,
        enabled: true,
        exposure: "codemode",
        toolExposure: {},
        timeout: 60,
        sampling: "ask",
      },
      replacesGlobal: false,
      shadowed: [],
      resolvesSecrets: true,
    });
  });

  it("hints at an ignored `callbackPort` or `callbackUrl`, which is no problem, for every layer", () => {
    const oauth = (fields: Schema.Json): Schema.Json => ({ url: "https://x.test", oauth: fields });

    const set = resolve(
      owner({ g: oauth({ clientId: "a", callbackPort: 8080 }), plain: oauth({ clientId: "a" }) }),
      owner({ e: oauth({ callbackUrl: "http://localhost/cb", callbackPort: 1 }) }),
      repo("web", { r: oauth({ callbackPort: 9 }) }),
    );

    expect(set.problems).toEqual([]);
    expect(
      Arr.map(set.hints, ({ source, name, kind, keys }) => ({
        source: source.kind,
        name,
        kind,
        keys,
      })),
    ).toEqual([
      { source: "global", name: "g", kind: "oauth-callback-ignored", keys: ["callbackPort"] },
      {
        source: "environment",
        name: "e",
        kind: "oauth-callback-ignored",
        keys: ["callbackPort", "callbackUrl"],
      },
      { source: "repo", name: "r", kind: "oauth-callback-ignored", keys: ["callbackPort"] },
    ]);
    expect(set.hints[0]?.message).toContain("redirect URI");
  });

  describe("Environment over Global", () => {
    it("takes an Environment's full entry over Global's of that name, whole", () => {
      const set = resolve(
        owner({ linear: { ...LINEAR, timeout: 5, description: "Global's", exposure: "direct" } }),
        owner({ linear: { url: "https://other.example/mcp" } }),
      );

      expect(set.problems).toEqual([]);
      expect(sources(set)).toEqual(["linear:environment"]);
      expect(server(set, "linear")).toMatchObject({
        replacesGlobal: true,
        server: {
          url: "https://other.example/mcp",
          timeout: 60,
          exposure: "codemode",
          headers: {},
        },
      });
      expect(server(set, "linear").server.description).toBeUndefined();
    });

    it("adds an Environment's own servers to Global's, and keeps the order: Global's, then the Environment's", () => {
      const set = resolve(owner({ a: LOCAL, b: LOCAL }), owner({ z: LOCAL, b: LINEAR, c: LOCAL }));

      expect(sources(set)).toEqual(["a:global", "b:environment", "z:environment", "c:environment"]);
    });

    it("lets the Environment's own entry win over a Global name that differs in case or in `-`/`_`, with a problem", () => {
      const set = resolve(owner({ "my-linear": LINEAR }), owner({ My_Linear: LOCAL }));

      expect(sources(set)).toEqual(["My_Linear:environment"]);
      expect(server(set, "My_Linear").replacesGlobal).toBe(false);
      expect(set.problems).toEqual([
        {
          source: { kind: "global" },
          name: "my-linear",
          message: expect.stringContaining('this Environment\'s own "My_Linear"'),
        },
      ]);
    });

    it("skips the stale entries a document holds that the Settings would refuse, with their problems", () => {
      const set = resolve(
        owner({
          ok: LOCAL,
          "bad name": LOCAL,
          bad: { command: "x", auth: "y" },
          twin: LOCAL,
          Twin: LOCAL,
          adjust: { enabled: false },
          text: "not an entry",
        }),
        owner({ own: LOCAL, nope: { type: "http" } }),
      );

      expect(sources(set)).toEqual(["ok:global", "twin:global", "own:environment"]);
      expect(Arr.map(set.problems, ({ source, name }) => `${source.kind}:${name}`)).toEqual([
        "global:bad name",
        "global:bad",
        "global:Twin",
        "global:adjust",
        "global:text",
        "environment:nope",
      ]);
    });

    it("stops at 50 servers a layer, and an Environment's adjustments are not among them", () => {
      const many = (count: number, prefix: string) =>
        Record.fromEntries(
          Arr.makeBy(count, (i): [string, Schema.Json] => [`${prefix}${i}`, LOCAL]),
        );

      const set = resolve(
        owner(many(51, "g")),
        owner(Record.union(many(50, "e"), { g0: { enabled: false } }, (left) => left)),
      );

      expect(set.servers).toHaveLength(50 + 50);
      expect(set.problems).toEqual([
        {
          source: { kind: "global" },
          name: "g50",
          message: expect.stringContaining("over the 50"),
        },
      ]);
      expect(server(set, "g0").server.enabled).toBe(false);
    });
  });

  describe("an Environment's adjustment", () => {
    it("applies over the server it adjusts: `enabled`, `exposure`, and `toolExposure` whole", () => {
      const set = resolve(
        owner({
          linear: { ...LINEAR, exposure: "direct", toolExposure: { a: "direct", b: "hidden" } },
        }),
        owner({ linear: { enabled: false, toolExposure: { c: "deferred" } } }),
      );

      expect(set.problems).toEqual([]);
      expect(server(set, "linear")).toMatchObject({
        source: { kind: "global" },
        server: {
          type: "http",
          url: LINEAR.url,
          enabled: false,
          exposure: "direct",
          toolExposure: { c: "deferred" },
        },
      });
    });

    it("switches a Global server on that Global switched off", () => {
      const set = resolve(
        owner({ linear: { ...LINEAR, enabled: false } }),
        owner({ linear: { enabled: true } }),
      );

      expect(server(set, "linear").server.enabled).toBe(true);
    });

    it("never changes the definition: only a full entry of its own does", () => {
      const set = resolve(
        owner({ linear: { ...LINEAR, timeout: 5, sampling: "off" } }),
        owner({ linear: { exposure: "hidden" } }),
      );

      expect(server(set, "linear").server).toMatchObject({ timeout: 5, sampling: "off" });
    });

    it("adjusts a Repo's server, which stays the Repo's", () => {
      const set = resolve({}, owner({ api: { exposure: "direct" } }), repo("web", { api: LINEAR }));

      expect(set.problems).toEqual([]);
      expect(server(set, "api")).toMatchObject({
        source: REPO_SOURCE("web"),
        server: { exposure: "direct" },
      });
    });

    it("is an orphan when no layer defines its server, a problem with the fields to reset", () => {
      const set = resolve(
        {},
        owner({
          gone: { enabled: false, toolExposure: { a: "hidden" } },
          only: { exposure: "direct" },
        }),
      );

      expect(set.servers).toEqual([]);
      expect(set.orphans).toEqual([
        { source: { kind: "environment" }, name: "gone", keys: ["enabled", "toolExposure"] },
        { source: { kind: "environment" }, name: "only", keys: ["exposure"] },
      ]);
      expect(set.problems).toEqual([
        {
          source: { kind: "environment" },
          name: "gone",
          message: expect.stringContaining("no layer defines"),
          reset: ["mcp.servers.gone.enabled", "mcp.servers.gone.toolExposure"],
        },
        {
          source: { kind: "environment" },
          name: "only",
          message: expect.stringContaining("no layer defines"),
          reset: ["mcp.servers.only.exposure"],
        },
      ]);
    });

    it("becomes an orphan when its base disappears later", () => {
      const environment = owner({ linear: { enabled: false } });

      expect(resolve(owner({ linear: LINEAR }), environment).orphans).toEqual([]);
      expect(resolve({}, environment).orphans).toHaveLength(1);
      expect(resolve({}, environment, repo("web", { linear: LINEAR })).orphans).toEqual([]);
      expect(resolve({}, environment, repo("web", {})).orphans).toHaveLength(1);
    });

    it("finds its server by its exact name, and says when only a twin of it exists", () => {
      const set = resolve(owner({ linear: LINEAR }), owner({ Linear: { enabled: false } }));

      expect(server(set, "linear").server.enabled).toBe(true);
      expect(set.orphans).toHaveLength(1);
      expect(set.problems[0]?.message).toContain('clashes with "linear"');
    });

    it("is read with the Settings' rules: a stale one that does not decode is skipped", () => {
      const set = resolve(
        owner({ linear: LINEAR }),
        owner({ linear: { exposure: "visible" }, other: { timeout: 3 } }),
      );

      expect(set.servers).toHaveLength(1);
      expect(Arr.map(set.problems, ({ name }) => name)).toEqual(["linear", "other"]);
      expect(set.orphans).toEqual([]);
    });
  });

  describe("a Repo's servers", () => {
    it("only add servers: after the owner's, in the Environment's Repo order", () => {
      const set = resolve(
        owner({ g: LOCAL }),
        owner({ e: LOCAL }),
        repo("web", { w: LINEAR }),
        repo("api", { a: LINEAR, b: LOCAL }),
      );

      expect(set.problems).toEqual([]);
      expect(sources(set)).toEqual(["g:global", "e:environment", "w:repo", "a:repo", "b:repo"]);
      expect(server(set, "a").source).toEqual(REPO_SOURCE("api"));
    });

    it("run in the Repo's directory, and read Variables only", () => {
      const set = resolve(
        {},
        {},
        repo("api", { local: LOCAL, sub: { command: "x", cwd: "tools" } }),
      );

      expect(server(set, "local")).toMatchObject({
        resolvesSecrets: false,
        server: { cwd: "/workspace/api" },
      });
      expect(server(set, "sub").server).toMatchObject({ cwd: "/workspace/api/tools" });
    });

    it("hold the Repo's file problems, with its source", () => {
      const set = resolve(
        {},
        {},
        repo("api", { ok: LOCAL, sse: { url: "https://x.test", type: "sse" } }),
      );

      expect(sources(set)).toEqual(["ok:repo"]);
      expect(set.problems).toEqual([
        {
          source: REPO_SOURCE("api"),
          name: "sse",
          message: expect.stringContaining("Streamable HTTP"),
        },
      ]);
    });

    it("read a file that is not valid as a problem of the file, with no server", () => {
      const set = resolve(
        {},
        {},
        {
          directory: "api",
          slug: "acme/api",
          path: ".pi/mcp.json",
          text: "{",
        },
      );

      expect(set.servers).toEqual([]);
      expect(set.problems).toEqual([
        { source: REPO_SOURCE("api"), name: null, message: expect.any(String) },
      ]);
    });

    it("are shadowed by an owner's server of the same name: an info mark, no problem", () => {
      const set = resolve(
        owner({ linear: LINEAR }),
        {},
        repo("web", { linear: LINEAR }),
        repo("api", { linear: { url: "https://other.example/mcp" } }),
      );

      expect(set.problems).toEqual([]);
      expect(sources(set)).toEqual(["linear:global"]);
      expect(server(set, "linear").shadowed).toEqual([
        { source: REPO_SOURCE("web"), name: "linear", differs: false },
        { source: REPO_SOURCE("api"), name: "linear", differs: true },
      ]);
    });

    it("are shadowed by an owner's twin of the name, and by the Environment's over Global's", () => {
      const set = resolve(
        owner({ "my-linear": LINEAR }),
        owner({ Other: LOCAL }),
        repo("web", { My_Linear: LINEAR, other: LOCAL }),
      );

      expect(set.problems).toEqual([]);
      expect(server(set, "my-linear").shadowed).toEqual([
        { source: REPO_SOURCE("web"), name: "My_Linear", differs: false },
      ]);
      expect(server(set, "Other").shadowed).toEqual([
        { source: REPO_SOURCE("web"), name: "other", differs: true },
      ]);
    });

    it("compares what is shadowed once normalized: defaults, the alias and `streamable-http`", () => {
      const set = resolve(
        owner({ linear: LINEAR }),
        {},
        repo("web", {
          linear: {
            ...LINEAR,
            type: "streamable-http",
            exposure: "codemode-deferred",
            timeout: 60,
          },
        }),
      );

      expect(server(set, "linear").shadowed).toEqual([
        { source: REPO_SOURCE("web"), name: "linear", differs: false },
      ]);
    });

    it("define one name in two Repos: a problem, and the first Repo wins", () => {
      const set = resolve({}, {}, repo("web", { linear: LINEAR }), repo("api", { Linear: LOCAL }));

      expect(sources(set)).toEqual(["linear:repo"]);
      expect(server(set, "linear").source).toEqual(REPO_SOURCE("web"));
      expect(set.problems).toEqual([
        {
          source: REPO_SOURCE("api"),
          name: "Linear",
          message: expect.stringContaining("first Repo wins"),
        },
      ]);
    });

    it("read `sampling: allow` as `ask`", () => {
      const set = resolve({}, {}, repo("api", { a: { ...LINEAR, sampling: "allow" } }));

      expect(server(set, "a").server.sampling).toBe("ask");
      expect(set.problems).toEqual([
        {
          source: REPO_SOURCE("api"),
          name: "a",
          message: expect.stringContaining("copy it into the Settings"),
        },
      ]);
    });
  });

  describe("a Repo's adjustment", () => {
    it("switches a server off, whichever layer defined it", () => {
      const set = resolve(
        owner({ g: LOCAL }),
        owner({ e: LOCAL }),
        repo("web", {
          g: { enabled: false },
          e: { exposure: "hidden" },
          own: LOCAL,
          ow: { enabled: false },
        }),
      );

      expect(set.problems).toEqual([
        {
          source: REPO_SOURCE("web"),
          name: "ow",
          message: "adjusts a server that is not in this Environment's set",
        },
      ]);
      expect(server(set, "g").server.enabled).toBe(false);
      expect(server(set, "e").server.exposure).toBe("hidden");
      expect(server(set, "own").server.enabled).toBe(true);
    });

    it("hides tools, ahead of the server's own keys, whose other keys stay", () => {
      const set = resolve(
        owner({
          g: {
            ...LOCAL,
            toolExposure: { "delete_*": "hidden", search: "direct", "a*": "deferred" },
          },
        }),
        {},
        repo("web", { g: { toolExposure: { "a*": "hidden", other: "hidden" } } }),
      );

      expect(Record.toEntries(server(set, "g").server.toolExposure)).toEqual([
        ["a*", "hidden"],
        ["other", "hidden"],
        ["delete_*", "hidden"],
        ["search", "direct"],
      ]);
    });

    it("can never switch on, loosen or change anything else: it is skipped with a problem", () => {
      const set = resolve(
        owner({ g: { ...LOCAL, enabled: false, exposure: "hidden" } }),
        {},
        repo("web", {
          g: { enabled: true },
          h: { exposure: "direct" },
        }),
      );

      expect(server(set, "g").server).toMatchObject({ enabled: false, exposure: "hidden" });
      expect(Arr.map(set.problems, ({ source, name }) => `${source.kind}:${name}`)).toEqual([
        "repo:g",
        "repo:h",
      ]);
      expect(set.problems[0]?.message).toContain("only switch off");
    });

    it("is applied before the Environment's, which has the last word", () => {
      const set = resolve(
        owner({ g: LOCAL }),
        owner({ g: { enabled: true, exposure: "direct" } }),
        repo("web", { g: { enabled: false, exposure: "hidden" } }),
      );

      expect(server(set, "g").server).toMatchObject({ enabled: true, exposure: "direct" });
    });

    it("applies the Repos' adjustments in their order, all of them only switching off", () => {
      const set = resolve(
        owner({ g: { ...LOCAL, toolExposure: { z: "direct" } } }),
        {},
        repo("web", { g: { toolExposure: { a: "hidden" } } }),
        repo("api", { g: { toolExposure: { b: "hidden" }, enabled: false } }),
      );

      expect(server(set, "g").server).toMatchObject({
        enabled: false,
        toolExposure: { b: "hidden", a: "hidden", z: "direct" },
      });
    });

    it("is an orphan, with no Reset, when the server is not in the set", () => {
      const set = resolve({}, {}, repo("web", { gone: { enabled: false } }));

      expect(set.orphans).toEqual([
        { source: REPO_SOURCE("web"), name: "gone", keys: ["enabled"] },
      ]);
      expect(set.problems[0]?.reset).toBeUndefined();
    });
  });
});

describe("the set and the Settings read the same servers", () => {
  const many = (count: number, prefix: string, value: Schema.Json): Schema.JsonObject =>
    Record.fromEntries(
      count === 0 ? [] : Arr.makeBy(count, (i): [string, Schema.Json] => [`${prefix}${i}`, value]),
    );

  const BROKEN = { command: "x", auth: "nope" };

  /** 51 entries, the third of them broken. */
  const third = Record.union(
    Record.union(many(2, "a", LOCAL), { a2: BROKEN }, (left) => left),
    many(49, "b", LOCAL),
    (left) => left,
  );

  /** The full entries of `servers`, in force, by name. */
  const inForce = (servers: Readonly<Record<string, McpServerValue>>) =>
    Record.fromEntries(
      Arr.filterMap(Record.toEntries(servers), ([name, value]) => {
        const server = normalizeMcpServer(value);

        return server === undefined ? Result.failVoid : Result.succeed([name, server] as const);
      }),
    );

  /** An entry of about 12 KB, and 150 patterns that together grow it past 16 KiB. */
  const BIG = { command: "x", args: Arr.makeBy(120, (i) => `${"a".repeat(96)}${i}`) };

  const PATTERNS = Record.fromEntries(
    Arr.makeBy(150, (i): [string, "hidden"] => [`${"p".repeat(20)}_${i}_*`, "hidden"]),
  );

  /** Stale documents, as `[Global's, the Environment's]`: each is something the strict reads would refuse. */
  const stale: ReadonlyArray<readonly [string, Schema.Json, Schema.Json]> = [
    [
      "a stale adjustment: one key stands",
      {},
      owner({ foo: { enabled: false, exposure: "bogus" } }),
    ],
    [
      "a stale adjustment of a Global server",
      owner({ foo: LOCAL }),
      owner({ foo: { enabled: false, exposure: "bogus", timeout: 3 } }),
    ],
    ["an entry that does not decode, then its twin", owner({ Foo: BROKEN, foo: LOCAL }), {}],
    ["a twin, then the entry that does not decode", owner({ foo: LOCAL, Foo: BROKEN }), {}],
    ["51 entries with the third broken", owner(third), {}],
    ["an adjustment at Global", owner({ a: LOCAL, b: { enabled: false } }), {}],
    [
      "names that are not names",
      owner({ "bad name": LOCAL, ok: LOCAL, [`n`.repeat(65)]: LOCAL }),
      {},
    ],
    [
      "Global's twin of an Environment's entry",
      owner({ "my-linear": LINEAR, other: LOCAL }),
      owner({ My_Linear: LOCAL }),
    ],
    [
      "an Environment entry that does not decode over Global's",
      owner({ linear: LINEAR }),
      owner({ linear: BROKEN, extra: LOCAL }),
    ],
    [
      "51 Environment entries, the first broken",
      owner({ g: LOCAL }),
      owner(Record.union({ e0: BROKEN }, many(50, "e", LOCAL), (left) => left)),
    ],
    [
      "an adjustment of a name Global lacks",
      owner({ g: LOCAL }),
      owner({ nobody: { enabled: false } }),
    ],
    [
      "an adjustment that over-fills a Global entry: its other keys stand",
      owner({ a: BIG }),
      owner({ a: { enabled: false, toolExposure: PATTERNS } }),
    ],
    [
      "an adjustment of keys that fit",
      owner({ a: BIG }),
      owner({ a: { enabled: false, exposure: "hidden", toolExposure: { x: "hidden" } } }),
    ],
    [
      "a Global entry that grew after the adjustment was saved",
      owner({
        a: { ...BIG, args: [...BIG.args, ...Arr.makeBy(30, (i) => `${"b".repeat(96)}${i}`)] },
      }),
      owner({ a: { enabled: false, toolExposure: PATTERNS } }),
    ],
    [
      "a twin-named adjustment of a Global server",
      owner({ linear: LINEAR }),
      owner({ Linear: { enabled: false } }),
    ],
    [
      "entries that are not objects",
      owner({ a: "text", b: 3, c: null, d: LOCAL }),
      owner({ e: [] }),
    ],
  ];

  for (const [label, global, environment] of stale) {
    it(label, () => {
      const settings = resolveOverridesLeniently(global, environment).settings.mcp.servers;
      const set = resolveMcpServerSet(global, environment, []);

      // The servers the Settings keep, in force, are the set's, with the same state.
      const kept = inForce(settings);

      expect(
        Record.fromEntries(Arr.map(set.servers, ({ name, server }) => [name, server] as const)),
      ).toEqual(kept);
    });
  }

  it("holds for Global's own document too, in name and in state", () => {
    for (const [, global] of stale) {
      const kept = inForce(resolveLeniently(global).settings.mcp.servers);
      const set = resolveMcpServerSet(global, {}, []);

      expect(
        Record.fromEntries(Arr.map(set.servers, ({ name, server }) => [name, server] as const)),
      ).toEqual(kept);
    }
  });

  it("leaves a stale adjustment's valid keys in force, and skips the rest of it", () => {
    const set = resolveMcpServerSet(
      owner({ foo: LOCAL }),
      owner({ foo: { enabled: false, exposure: "bogus" } }),
      [],
    );

    expect(set.servers[0]?.server).toMatchObject({ enabled: false, exposure: "codemode" });
    expect(set.problems).toEqual([
      {
        source: { kind: "environment" },
        name: "foo",
        message: expect.stringMatching(/^exposure: /),
      },
    ]);
  });

  it("counts only the entries that stand, and makes no twin of one that does not", () => {
    const counted = resolveMcpServerSet(owner(third), {}, []);
    const twins = resolveMcpServerSet(owner({ Foo: BROKEN, foo: LOCAL }), {}, []);

    expect(counted.servers).toHaveLength(50);
    expect(Arr.map(twins.servers, ({ name }) => name)).toEqual(["foo"]);
  });
});

describe("an adjustment over an entry that would grow past 16 KiB", () => {
  const BIG = { command: "x", args: Arr.makeBy(120, (i) => `${"a".repeat(96)}${i}`) };

  const PATTERNS = Record.fromEntries(
    Arr.makeBy(150, (i): [string, "hidden"] => [`${"p".repeat(20)}_${i}_*`, "hidden"]),
  );

  const adjusted = { a: { enabled: false, toolExposure: PATTERNS } };

  it("keeps the keys that fit and refuses the one that does not, as an Override field of its own", () => {
    const set = resolveMcpServerSet(owner({ a: BIG }), owner(adjusted), []);

    expect(set.servers[0]?.server).toMatchObject({ enabled: false, toolExposure: {} });
    expect(set.problems).toEqual([
      {
        source: { kind: "environment" },
        name: "a",
        message: expect.stringMatching(/^toolExposure: makes the entry over 16 KiB/),
        reset: ["mcp.servers.a.toolExposure"],
      },
    ]);

    const read = resolveOverridesLeniently(owner({ a: BIG }), owner(adjusted));

    expect(read.overrides).toEqual({ mcp: { servers: { a: { enabled: false } } } });
    expect(read.dropped).toEqual([
      expect.stringMatching(/^mcp\.servers\.a\.toolExposure: makes the entry over 16 KiB/),
    ]);
    // The same, structured, for the page's row of the server: with the Override field its Reset clears.
    expect(read.mcpProblems).toEqual([
      {
        source: "environment",
        name: "a",
        keys: ["toolExposure"],
        message: expect.stringMatching(/^makes the entry over 16 KiB/),
        reset: ["mcp.servers.a.toolExposure"],
      },
    ]);
  });
});

describe("switching a server off next to the entry bound", () => {
  /** An entry of exactly 16 KiB as written: any key added to it is over the bound. */
  const FULL = (() => {
    const bare = { command: "x", args: [""] };
    const room = 16 * 1024 - new TextEncoder().encode(JSON.stringify(bare)).length;

    return { ...bare, args: ["a".repeat(room)] };
  })();

  const HIDDEN = { x: "hidden" } as const;

  it("fills the bound exactly", () => {
    expect(new TextEncoder().encode(JSON.stringify(FULL)).length).toBe(16 * 1024);
  });

  it("lets an Environment switch a Global server off, in the Settings and in the set", () => {
    const environment = owner({ a: { enabled: false, exposure: "hidden" } });
    const set = resolveMcpServerSet(owner({ a: FULL }), environment, []);
    const read = resolveOverridesLeniently(owner({ a: FULL }), environment);

    expect(set.problems).toEqual([]);
    expect(set.servers[0]?.server).toMatchObject({ enabled: false, exposure: "hidden" });
    expect(read.dropped).toEqual([]);
    expect(read.overrides).toEqual({
      mcp: { servers: { a: { enabled: false, exposure: "hidden" } } },
    });
    expect(read.settings.mcp.servers.a).toMatchObject({ enabled: false, exposure: "hidden" });
  });

  it("lets a Repo switch a Global server off", () => {
    const set = resolveMcpServerSet(owner({ a: FULL }), {}, [
      repo("web", { a: { enabled: false, exposure: "hidden" } }),
    ]);

    expect(set.problems).toEqual([]);
    expect(set.servers[0]?.server).toMatchObject({ enabled: false, exposure: "hidden" });
  });

  it("lets an Environment switch a Repo's server off", () => {
    const set = resolveMcpServerSet({}, owner({ a: { enabled: false, exposure: "hidden" } }), [
      repo("web", { a: FULL }),
    ]);

    expect(set.problems).toEqual([]);
    expect(set.servers[0]?.server).toMatchObject({ enabled: false, exposure: "hidden" });
  });

  it("still refuses the toolExposure that does not fit beside it, and keeps the switch-off", () => {
    const environment = owner({ a: { enabled: false, toolExposure: HIDDEN } });
    const set = resolveMcpServerSet(owner({ a: FULL }), environment, []);
    const read = resolveOverridesLeniently(owner({ a: FULL }), environment);

    expect(set.servers[0]?.server).toMatchObject({ enabled: false, toolExposure: {} });
    expect(set.problems).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^toolExposure: /) }),
    ]);
    expect(read.overrides).toEqual({ mcp: { servers: { a: { enabled: false } } } });

    const repoSet = resolveMcpServerSet(owner({ a: FULL }), {}, [
      repo("web", { a: { enabled: false, toolExposure: HIDDEN } }),
    ]);

    expect(repoSet.servers[0]?.server).toMatchObject({ enabled: false, toolExposure: {} });
    expect(repoSet.problems).toHaveLength(1);
  });

  it("refuses the toolExposure that grows a Repo's entry past the bound, keeping the switch-off", () => {
    const set = resolveMcpServerSet({}, owner({ a: { enabled: false, toolExposure: HIDDEN } }), [
      repo("web", { a: FULL }),
    ]);

    expect(set.servers[0]?.server).toMatchObject({ enabled: false, toolExposure: {} });
    expect(set.problems).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^toolExposure: /) }),
    ]);
  });

  it("does not count the switch-off against the toolExposure that follows it", () => {
    const base = { ...FULL, args: ["a".repeat(16 * 1024 - 120)] };
    const environment = owner({ a: { enabled: false, exposure: "hidden", toolExposure: HIDDEN } });
    const set = resolveMcpServerSet(owner({ a: base }), environment, []);

    expect(set.problems).toEqual([]);
    expect(set.servers[0]?.server).toMatchObject({ toolExposure: HIDDEN, enabled: false });
  });
});
