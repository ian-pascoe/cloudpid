import { describe, expect, it } from "vitest";
import { sha256Hex } from "./mcp-connection.ts";
import {
  isMcpExtensionToolName,
  isMcpResourceToolName,
  mcpToolHash,
  mcpToolName,
  mcpToolNameFromPi,
  mcpToolNames,
  mcpToolPart,
} from "./mcp-tool-names.ts";

const isMcpToolName = (name: string): boolean =>
  /^mcp__[a-z0-9_]+__[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name);

const hash = (server: string, tool: string): string => sha256Hex(`${server}\0${tool}`).slice(0, 8);

describe("mcpToolPart", () => {
  it.each([
    ["getUser", "get_user"],
    ["get_user", "get_user"],
    ["get-user", "get_user"],
    ["get.user", "get_user"],
    ["GetUser", "get_user"],
    ["getUserID", "get_user_id"],
    ["getHTTPResponse", "get_httpresponse"],
    ["list__items", "list_items"],
    ["_private", "private"],
    ["trailing-", "trailing"],
    ["search2Files", "search2_files"],
    ["a b/c", "a_b_c"],
    ["résumé", "r_sum"],
    ["---", "tool"],
    ["_", "tool"],
  ])("spells %s as %s", (tool, part) => {
    expect(mcpToolPart(tool)).toBe(part);
  });

  it("is idempotent", () => {
    for (const tool of ["getUser", "a.B-c", "HTTPServer", "x1Y2"]) {
      expect(mcpToolPart(mcpToolPart(tool))).toBe(mcpToolPart(tool));
    }
  });
});

describe("mcpToolName", () => {
  it.each([
    ["github", "getUser", "mcp__github__get_user"],
    ["GitHub", "get-user", "mcp__github__get_user"],
    ["my-server", "list.items", "mcp__my_server__list_items"],
    ["My_Server", "ListItems", "mcp__my_server__list_items"],
    ["a--b", "x", "mcp__a__b__x"],
  ])("names %s's %s as %s", (server, tool, name) => {
    expect(mcpToolName(server, tool)).toBe(name);
  });

  it("adds the hash of the normalized server and the server's own tool name for a collision", () => {
    expect(mcpToolName("My-Server", "getUser", { collides: true })).toBe(
      `mcp__my_server__get_user_${hash("my_server", "getUser")}`,
    );
    expect(mcpToolHash("My-Server", "getUser")).toBe(hash("my_server", "getUser"));
    expect(mcpToolHash("my_server", "getUser")).toBe(mcpToolHash("MY-SERVER", "getUser"));
    expect(mcpToolHash("a", "getUser")).not.toBe(mcpToolHash("a", "get_user"));
  });

  describe("the 64-character limit", () => {
    const server = "s";
    const prefix = "mcp__s__";

    it("keeps a name of exactly 64 characters", () => {
      const tool = "t".repeat(64 - prefix.length);
      const name = mcpToolName(server, tool);

      expect(name).toBe(`${prefix}${tool}`);
      expect(name).toHaveLength(64);
    });

    it("cuts a name over 64 to 55, then `_` and the hash", () => {
      const tool = "t".repeat(64 - prefix.length + 1);
      const name = mcpToolName(server, tool);

      expect(name).toHaveLength(64);
      expect(name).toBe(`${`${prefix}${tool}`.slice(0, 55)}_${hash("s", tool)}`);
    });

    it("trims the `_` a cut leaves, so the hash is not preceded by two", () => {
      // `mcp__s__` is 8 characters, so the 55th is the 47th of the tool part: an `_` here.
      const tool = `${"a".repeat(46)}_${"b".repeat(10)}`;
      const name = mcpToolName(server, tool);

      expect(`${prefix}${tool}`[54]).toBe("_");
      expect(name).toBe(`mcp__s__${"a".repeat(46)}_${hash("s", tool)}`);
      expect(name.slice(prefix.length)).not.toMatch(/__/);
    });

    it("cuts a collision's name when the hash would not fit", () => {
      const tool = "t".repeat(64 - prefix.length);
      const name = mcpToolName(server, tool, { collides: true });

      expect(name).toHaveLength(64);
      expect(name).toBe(`${`${prefix}${tool}`.slice(0, 55)}_${hash("s", tool)}`);
    });

    it("appends the hash whole when the name and the hash fit in 64", () => {
      const tool = "t".repeat(55 - prefix.length);
      const name = mcpToolName(server, tool, { collides: true });

      expect(name).toBe(`${prefix}${tool}_${hash("s", tool)}`);
      expect(name).toHaveLength(64);
    });

    // `mcp__` and `__` take 7 characters, so a server of 48 leaves no room for a tool part under the cut of 55.
    it.each([
      [47, false],
      [47, true],
      [48, false],
      [48, true],
      [49, false],
      [49, true],
    ])("treats a server of %i characters, collision %s", (length, collides) => {
      const long = "x".repeat(length);
      const name = mcpToolName(long, "a".repeat(30), { collides });

      expect(name).toHaveLength(length === 47 ? 64 : 5 + 44 + 2 + 8);
      expect(name).toBe(
        length === 47
          ? `${`mcp__${long}__${"a".repeat(30)}`.slice(0, 55)}_${hash(long, "a".repeat(30))}`
          : `mcp__${"x".repeat(44)}__${hash(long, "a".repeat(30))}`,
      );
      expect(isMcpToolName(name)).toBe(true);
    });

    it("keeps the shape of a name whose server leaves no room for a tool part", () => {
      const long = "x".repeat(64);
      const name = mcpToolName(long, "getUser");

      expect(name).toBe(`mcp__${"x".repeat(44)}__${hash(long, "getUser")}`);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(mcpToolName(long, "getUsers")).not.toBe(name);
    });
  });
});

describe("mcpToolNames", () => {
  it("names tools that do not collide plainly", () => {
    expect([...mcpToolNames("github", ["getUser", "list_repos"])]).toEqual([
      ["getUser", "mcp__github__get_user"],
      ["list_repos", "mcp__github__list_repos"],
    ]);
  });

  it("hashes every member of a collision, never one only", () => {
    const names = mcpToolNames("github", ["getUser", "get_user", "get-user", "other"]);

    expect(names.get("getUser")).toBe(`mcp__github__get_user_${hash("github", "getUser")}`);
    expect(names.get("get_user")).toBe(`mcp__github__get_user_${hash("github", "get_user")}`);
    expect(names.get("get-user")).toBe(`mcp__github__get_user_${hash("github", "get-user")}`);
    expect(names.get("other")).toBe("mcp__github__other");
    expect(new Set(names.values()).size).toBe(4);
  });

  it("gives a name that does not depend on the order the server lists its tools in", () => {
    const tools = ["getUser", "get_user", "GetUser", "x", "y".repeat(80), "y".repeat(81)];
    const forward = mcpToolNames("github", tools);
    const backward = mcpToolNames("github", [...tools].reverse());

    for (const tool of tools) expect(backward.get(tool)).toBe(forward.get(tool));
  });

  it("hashes a tool whose name another's hashed name would equal", () => {
    // `a_b` collides with `a-b`, so both are hashed; a tool that is called exactly like the hashed one is hashed too.
    const hashed = `a_b_${hash("s", "a-b")}`;
    const names = mcpToolNames("s", ["a_b", "a-b", hashed]);

    expect(new Set(names.values()).size).toBe(3);
    expect(names.get(hashed)).toBe(`mcp__s__${hashed}_${hash("s", hashed)}`);
  });

  it("hashes every long tool that is cut to the same prefix, each by its own tool name", () => {
    const one = `${"t".repeat(60)}1`;
    const two = `${"t".repeat(60)}2`;
    const names = mcpToolNames("s", [one, two]);

    expect(names.get(one)).toMatch(/^mcp__s__t+_[0-9a-f]{8}$/);
    expect(names.get(one)).not.toBe(names.get(two));
    expect(names.get(one)).toHaveLength(64);
  });

  it("counts a tool listed twice once", () => {
    expect([...mcpToolNames("s", ["a", "a"])]).toEqual([["a", "mcp__s__a"]]);
  });

  it("tells tools apart that normalize to nothing", () => {
    const names = mcpToolNames("s", ["-", "_", "tool"]);

    expect(new Set(names.values()).size).toBe(3);
  });
});

describe("mcpToolNameFromPi", () => {
  it.each([
    ["mcp__github__getUser", "mcp__github__get_user"],
    ["mcp__github__get_user", "mcp__github__get_user"],
    ["mcp__My_Server__listItems", "mcp__my_server__list_items"],
    ["mcp__docs__search.v2", "mcp__docs__search_v2"],
    ["mcp__docs__searchV2", "mcp__docs__search_v2"],
  ])("maps pi's %s to %s", (name, mapped) => {
    expect(mcpToolNameFromPi(name)).toBe(mapped);
  });

  it.each(["read", "bash", "mcp__github", "mcp__github__", "mcp____x", "other__github__getUser"])(
    "leaves %s as it is",
    (name) => {
      expect(mcpToolNameFromPi(name)).toBe(name);
    },
  );

  it("reads a server that holds `__` by the configured names, the longest first", () => {
    expect(mcpToolNameFromPi("mcp__a__b__getUser")).toBe("mcp__a__b_get_user");
    expect(mcpToolNameFromPi("mcp__a__b__getUser", ["a__b"])).toBe("mcp__a__b__get_user");
    expect(mcpToolNameFromPi("mcp__a__b__getUser", ["a", "a__b"])).toBe("mcp__a__b__get_user");
    expect(mcpToolNameFromPi("mcp__a__b__getUser", ["a"])).toBe("mcp__a__b_get_user");
  });

  it("reads a configured name as pi spells it", () => {
    expect(mcpToolNameFromPi("mcp__my_server__getUser", ["my-server"])).toBe(
      "mcp__my_server__get_user",
    );
  });

  it("cuts a name that normalizing lengthens past 64", () => {
    const name = mcpToolNameFromPi(`mcp__s__${"aB".repeat(30)}`);

    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^mcp__s__a_ba_b.*[a-z0-9]_[0-9a-f]{8}$/);
  });
});

describe("the resource tools' names", () => {
  it("are the extension's with the mcp__ tools, and no other tool is", () => {
    expect(isMcpExtensionToolName("mcp__github__get_user")).toBe(true);
    expect(isMcpResourceToolName("mcp__github__get_user")).toBe(false);

    for (const name of ["read", "mcp_servers", "read_mcp_resources", "list_resources"]) {
      expect(isMcpExtensionToolName(name)).toBe(false);
    }
  });
});
