import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { checkMcpWidening, type McpReach, resolveExposure } from "./mcp-exposure.ts";
import { resolveMcpServerSet } from "./mcp-server-set.ts";
import type { McpExposure } from "./mcp-servers.ts";

const keys = (exposure: McpExposure, toolExposure: Record<string, McpExposure> = {}) => ({
  exposure,
  toolExposure,
});

describe("resolveExposure", () => {
  const decide = (
    server: ReturnType<typeof keys>,
    tool: string,
    extra: { modelName?: string; offered?: ReadonlyArray<string> } = {},
  ) => resolveExposure({ server, tool, ...extra });

  it("uses the server's exposure when no key matches", () => {
    expect(decide(keys("codemode"), "get_user")).toEqual({
      exposure: "codemode",
      reason: { kind: "server" },
    });
    expect(decide(keys("direct", { other: "hidden", "x*": "hidden" }), "get_user")).toEqual({
      exposure: "direct",
      reason: { kind: "server" },
    });
  });

  it("lets an exact tool name beat the server's exposure, whatever it is", () => {
    for (const server of MCP_EXPOSURE_LIST) {
      expect(decide(keys(server, { get_user: "direct" }), "get_user")).toEqual({
        exposure: "direct",
        reason: { kind: "tool", key: "get_user" },
      });
    }
  });

  it("lets a pattern beat the server's exposure", () => {
    expect(decide(keys("direct", { "get_*": "hidden" }), "get_user")).toEqual({
      exposure: "hidden",
      reason: { kind: "pattern", key: "get_*" },
    });
  });

  it("lets an exact name beat a pattern written before it", () => {
    expect(decide(keys("codemode", { "*": "hidden", get_user: "deferred" }), "get_user")).toEqual({
      exposure: "deferred",
      reason: { kind: "tool", key: "get_user" },
    });
  });

  it("lets the first matching pattern win", () => {
    const server = keys("codemode", { "get_*": "deferred", "*_user": "hidden", "*": "direct" });

    expect(decide(server, "get_user")).toEqual({
      exposure: "deferred",
      reason: { kind: "pattern", key: "get_*" },
    });
    expect(decide(server, "set_user")).toEqual({
      exposure: "hidden",
      reason: { kind: "pattern", key: "*_user" },
    });
    expect(decide(server, "list")).toEqual({
      exposure: "direct",
      reason: { kind: "pattern", key: "*" },
    });
    expect(
      decide(keys("codemode", { "*": "direct", "get_*": "deferred" }), "get_user").reason,
    ).toEqual({ kind: "pattern", key: "*" });
  });

  it("keys on the server's own tool names, not cloudpid's snake_case ones", () => {
    const server = keys("codemode", { getUser: "hidden", "list*": "direct" });

    expect(decide(server, "getUser", { modelName: "mcp__s__get_user" }).exposure).toBe("hidden");
    expect(decide(server, "get_user", { modelName: "mcp__s__get_user" }).exposure).toBe("codemode");
    expect(decide(server, "listItems").exposure).toBe("direct");
    expect(decide(server, "list_items").exposure).toBe("direct");
  });

  it("is case-sensitive and never reads an inherited property", () => {
    const server = keys("codemode", { GetUser: "hidden" });

    expect(decide(server, "getuser").exposure).toBe("codemode");
    expect(decide(keys("hidden"), "constructor").exposure).toBe("hidden");
    expect(decide(keys("hidden"), "__proto__").exposure).toBe("hidden");
    expect(decide(keys("hidden"), "toString").reason).toEqual({ kind: "server" });
  });

  describe("tools.offered", () => {
    const offered = ["mcp__github__get_*", "read"];

    it.each(["codemode", "deferred"] as const)("lifts a %s tool that it names", (exposure) => {
      expect(
        decide(keys(exposure), "getUser", { modelName: "mcp__github__get_user", offered }),
      ).toEqual({
        exposure: "direct",
        reason: { kind: "offered", pattern: "mcp__github__get_*", from: exposure },
      });
    });

    it("lifts what a toolExposure key made codemode or deferred", () => {
      const server = keys("hidden", { getUser: "codemode", "get*": "deferred" });

      expect(
        decide(server, "getUser", { modelName: "mcp__github__get_user", offered }).reason,
      ).toEqual({ kind: "offered", pattern: "mcp__github__get_*", from: "codemode" });
      expect(
        decide(server, "getTeam", { modelName: "mcp__github__get_team", offered }).reason,
      ).toEqual({ kind: "offered", pattern: "mcp__github__get_*", from: "deferred" });
    });

    it("never lifts a hidden tool, by its server or by a key", () => {
      expect(
        decide(keys("hidden"), "getUser", { modelName: "mcp__github__get_user", offered }),
      ).toEqual({ exposure: "hidden", reason: { kind: "server" } });
      expect(
        decide(keys("direct", { getUser: "hidden" }), "getUser", {
          modelName: "mcp__github__get_user",
          offered,
        }),
      ).toEqual({ exposure: "hidden", reason: { kind: "tool", key: "getUser" } });
    });

    it("leaves a direct tool as it is, with the reason that made it direct", () => {
      expect(
        decide(keys("direct"), "getUser", { modelName: "mcp__github__get_user", offered }),
      ).toEqual({ exposure: "direct", reason: { kind: "server" } });
    });

    it("lifts nothing that it does not name, or when no model name is given", () => {
      expect(
        decide(keys("codemode"), "listRepos", { modelName: "mcp__github__list_repos", offered })
          .exposure,
      ).toBe("codemode");
      expect(decide(keys("codemode"), "getUser", { offered }).exposure).toBe("codemode");
      expect(
        decide(keys("codemode"), "getUser", { modelName: "mcp__github__get_user" }).exposure,
      ).toBe("codemode");
    });

    it("matches the model-facing name, not the server's tool name", () => {
      expect(
        decide(keys("codemode"), "getUser", {
          modelName: "mcp__github__get_user",
          offered: ["getUser"],
        }).exposure,
      ).toBe("codemode");
      expect(
        decide(keys("codemode"), "getUser", {
          modelName: "mcp__github__get_user",
          offered: ["mcp__*"],
        }).exposure,
      ).toBe("direct");
    });
  });

  it("reads an entry of the resolved set, `codemode-deferred` as codemode", () => {
    const set = resolveMcpServerSet(
      {
        mcp: {
          servers: {
            linear: {
              url: "https://mcp.linear.app/mcp",
              exposure: "codemode-deferred",
              toolExposure: { "get*": "codemode-deferred", delete_issue: "hidden" },
            },
          },
        },
      },
      {},
      [],
    );

    const linear = Option.getOrThrow(Arr.head(set.servers)).server;

    expect(decide(linear, "other").exposure).toBe("codemode");
    expect(decide(linear, "getIssue").exposure).toBe("codemode");
    expect(decide(linear, "delete_issue").exposure).toBe("hidden");
  });
});

const MCP_EXPOSURE_LIST: ReadonlyArray<McpExposure> = ["codemode", "deferred", "direct", "hidden"];

type Entry = {
  enabled?: boolean;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
};

const reach = (entry: Entry, kind: "global" | "environment" | "repo" = "global"): McpReach => ({
  source:
    kind === "repo" ? { kind, directory: "api", slug: "acme/api", path: ".pi/mcp.json" } : { kind },
  server: {
    enabled: entry.enabled ?? true,
    exposure: entry.exposure ?? "codemode",
    toolExposure: entry.toolExposure ?? {},
  },
});

const kinds = (before: McpReach | undefined, after: McpReach | undefined) =>
  Arr.map(checkMcpWidening(before, after), ({ kind }) => kind);

describe("checkMcpWidening", () => {
  describe("what widens", () => {
    it.each<[string, Entry, Entry, ReadonlyArray<string>]>([
      ["switching a server on", { enabled: false }, { enabled: true }, ["switched_on"]],
      [
        "a server's exposure leaving hidden",
        { exposure: "hidden" },
        { exposure: "codemode" },
        ["exposure_unhidden"],
      ],
      [
        "removing a hidden exact key",
        { toolExposure: { delete_issue: "hidden" } },
        {},
        ["key_removed"],
      ],
      [
        "loosening a hidden key to codemode",
        { toolExposure: { delete_issue: "hidden" } },
        { toolExposure: { delete_issue: "codemode" } },
        ["key_loosened"],
      ],
      [
        "adding a non-hidden key on a hidden server",
        { exposure: "hidden" },
        { exposure: "hidden", toolExposure: { get_issue: "direct" } },
        ["key_ahead"],
      ],
      [
        "adding a non-hidden pattern ahead of a hidden pattern",
        { toolExposure: { "delete_*": "hidden" } },
        { toolExposure: { "*": "direct", "delete_*": "hidden" } },
        ["key_ahead"],
      ],
      [
        "adding a non-hidden exact key the hidden pattern matches",
        { toolExposure: { "delete_*": "hidden" } },
        { toolExposure: { "delete_*": "hidden", delete_comment: "direct" } },
        ["key_ahead"],
      ],
      [
        "moving a non-hidden pattern ahead of a hidden one",
        { toolExposure: { "delete_*": "hidden", "*": "direct" } },
        { toolExposure: { "*": "direct", "delete_*": "hidden" } },
        ["key_ahead"],
      ],
      [
        "moving a hidden pattern behind a non-hidden one, so it matches fewer tools",
        { toolExposure: { "delete_*": "hidden", "d*": "direct" } },
        { toolExposure: { "d*": "direct", "delete_*": "hidden" } },
        ["key_ahead"],
      ],
      [
        "moving a non-hidden pattern ahead of a hidden one, on a hidden server",
        { exposure: "hidden", toolExposure: { "a*": "hidden", "b*": "direct" } },
        { exposure: "hidden", toolExposure: { "b*": "direct", "a*": "hidden" } },
        ["key_ahead"],
      ],
      [
        "a switch-on that also loosens a key",
        { enabled: false, toolExposure: { delete_issue: "hidden" } },
        { enabled: true, toolExposure: { delete_issue: "direct" } },
        ["switched_on", "key_loosened"],
      ],
      [
        "changing a non-hidden key to a hidden one while loosening another",
        { toolExposure: { a: "hidden", b: "direct" } },
        { toolExposure: { a: "direct", b: "hidden" } },
        ["key_loosened"],
      ],
    ])("%s", (_, before, after, expected) => {
      expect(kinds(reach(before), reach(after))).toEqual(expected);
    });

    it("says which key widens, and what it widens over", () => {
      expect(
        checkMcpWidening(
          reach({ exposure: "hidden", toolExposure: { "x*": "hidden" } }),
          reach({ exposure: "hidden", toolExposure: { "x*": "hidden", get_issue: "direct" } }),
        ),
      ).toEqual([{ kind: "key_ahead", key: "get_issue", over: null }]);
      expect(
        checkMcpWidening(
          reach({ toolExposure: { "delete_*": "hidden" } }),
          reach({ toolExposure: { "*": "direct", "d*": "deferred", "delete_*": "hidden" } }),
        ),
      ).toEqual([
        { kind: "key_ahead", key: "*", over: "delete_*" },
        { kind: "key_ahead", key: "d*", over: "delete_*" },
      ]);
      expect(
        checkMcpWidening(
          reach({ toolExposure: { b: "hidden" } }),
          reach({ toolExposure: { b: "direct" } }),
        ),
      ).toEqual([{ kind: "key_loosened", key: "b", exposure: "direct" }]);
    });

    it("widens for a server that had no entry, unless it is off and hidden", () => {
      expect(kinds(undefined, reach({}))).toEqual(["switched_on", "exposure_unhidden"]);
      expect(kinds(undefined, reach({ enabled: false }))).toEqual(["exposure_unhidden"]);
      expect(kinds(undefined, reach({ enabled: false, exposure: "hidden" }))).toEqual([]);
      expect(kinds(undefined, reach({ exposure: "hidden" }))).toEqual(["switched_on"]);
    });

    it("widens when a removal falls back to an entry that is on or un-hidden", () => {
      // The Environment's switched-off entry replaced by Global's, which is on.
      expect(kinds(reach({ enabled: false }, "environment"), reach({}, "global"))).toEqual([
        "switched_on",
      ]);
      // A hidden Environment adjustment reset to Global's un-hidden exposure.
      expect(kinds(reach({ exposure: "hidden" }), reach({ exposure: "direct" }))).toEqual([
        "exposure_unhidden",
      ]);
    });
  });

  describe("what does not widen", () => {
    it.each<[string, Entry, Entry]>([
      ["switching off", { enabled: true }, { enabled: false }],
      [
        "no change",
        { toolExposure: { a: "hidden", "b*": "direct" } },
        { toolExposure: { a: "hidden", "b*": "direct" } },
      ],
      ["hiding the server", { exposure: "direct" }, { exposure: "hidden" }],
      [
        "moving among codemode, deferred and direct",
        { exposure: "codemode" },
        { exposure: "direct" },
      ],
      [
        "adding a hidden key",
        { exposure: "direct" },
        { exposure: "direct", toolExposure: { a: "hidden", "b*": "hidden" } },
      ],
      [
        "adding a non-hidden exact key a hidden pattern does not match",
        { toolExposure: { "delete_*": "hidden" } },
        { toolExposure: { "delete_*": "hidden", get_issue: "direct" } },
      ],
      [
        "adding a non-hidden key behind a hidden pattern",
        { toolExposure: { "delete_*": "hidden" } },
        { toolExposure: { "delete_*": "hidden", "*": "direct" } },
      ],
      [
        "moving a hidden pattern ahead of a non-hidden one, so it matches more tools",
        { toolExposure: { "d*": "direct", "delete_*": "hidden" } },
        { toolExposure: { "delete_*": "hidden", "d*": "direct" } },
      ],
      [
        "adding a hidden pattern ahead of a hidden one",
        { toolExposure: { "delete_*": "hidden" } },
        { toolExposure: { "*": "hidden", "delete_*": "hidden" } },
      ],
      [
        "a key that was already ahead of the hidden pattern",
        { toolExposure: { "a*": "direct", "delete_*": "hidden" } },
        { toolExposure: { "a*": "codemode", "delete_*": "hidden" } },
      ],
      [
        "a key that was ahead of the hidden server's exposure",
        { exposure: "hidden", toolExposure: { a: "direct" } },
        { exposure: "hidden", toolExposure: { a: "deferred" } },
      ],
    ])("%s", (_, before, after) => {
      expect(kinds(reach(before), reach(after))).toEqual([]);
    });

    it("does not widen a removal of the server", () => {
      expect(kinds(reach({ enabled: false, exposure: "hidden" }), undefined)).toEqual([]);
      expect(kinds(reach({}), undefined)).toEqual([]);
      expect(kinds(undefined, undefined)).toEqual([]);
    });

    it("does not widen un-shadowing a Repo's switched-on entry", () => {
      expect(
        kinds(reach({ enabled: false, exposure: "hidden" }, "environment"), reach({}, "repo")),
      ).toEqual([]);
      expect(kinds(reach({ exposure: "hidden" }, "global"), reach({}, "repo"))).toEqual([]);
    });

    it("widens a change of a Repo's own entry like any other", () => {
      expect(kinds(reach({ enabled: false }, "repo"), reach({ enabled: true }, "repo"))).toEqual([
        "switched_on",
      ]);
      expect(kinds(reach({}, "repo"), reach({}, "global"))).toEqual([]);
      expect(kinds(reach({ enabled: false }, "repo"), reach({}, "environment"))).toEqual([
        "switched_on",
      ]);
    });
  });

  it("reads the entries a resolved set holds", () => {
    const written = (servers: Schema.Json) =>
      resolveMcpServerSet({ mcp: { servers } }, {}, []).servers[0];

    const before = written({
      linear: {
        url: "https://mcp.linear.app/mcp",
        enabled: false,
        toolExposure: { "delete_*": "hidden" },
      },
    });

    const after = written({
      linear: {
        url: "https://mcp.linear.app/mcp",
        enabled: true,
        toolExposure: { "delete_*": "codemode-deferred" },
      },
    });

    expect(kinds(before, after)).toEqual(["switched_on", "key_loosened"]);
    expect(kinds(after, before)).toEqual([]);
  });
});
