// The MCP inventory's bounds, problems and versions (`docs/architecture/mcp-connections.md` → Storage, Discovery and the
// MCP inventory; `mcp-in-a-session.md` → Exposure): what a Session must not register is left out with a problem, a
// schema the engine could not compile keeps its tool, and the versions are content hashes.
import type { McpEngineDiscovered } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_MS,
  inventoryVersions,
  inventoryRows,
  MAX_DESCRIPTION,
  MAX_TOOLS,
  MAX_TTL_MS,
  readInventory,
  type VersionedServer,
} from "./inventory.ts";

const tool = (name: string, extra: Readonly<Record<string, Schema.Json>> = {}) => ({
  name,
  inputSchema: { type: "object" },
  ...extra,
});

const discovered = (extra: Partial<McpEngineDiscovered> = {}): McpEngineDiscovered => ({
  kind: "discovered",
  era: "modern",
  protocolVersion: "2026-07-28",
  capabilities: { tools: {} },
  tools: [tool("a")],
  prompts: [],
  problems: [],
  fetchedAt: 1,
  state: {},
  ...extra,
});

const read = (rows: ReturnType<typeof inventoryRows>) => Option.getOrThrow(readInventory(rows));

const names = (rows: ReturnType<typeof inventoryRows>) =>
  Arr.map(read(rows).tools, (each) => each.name);

describe("inventoryRows", () => {
  it("leaves out a Modern tool with an invalid x-mcp-header, with its problem, and keeps a Legacy one", () => {
    const bad = tool("bad", {
      inputSchema: { type: "object", properties: { r: { type: "object", "x-mcp-header": "R" } } },
    });

    const modern = inventoryRows(discovered({ tools: [tool("a"), bad] }), 0);

    expect(names(modern)).toEqual(["a"]);
    expect(read(modern).meta.problems).toEqual([
      { tool: "bad", problem: expect.stringContaining("not offered: r: x-mcp-header") },
    ]);
    expect(names(inventoryRows(discovered({ era: "legacy", tools: [tool("a"), bad] }), 0))).toEqual(
      ["a", "bad"],
    );
  });

  it("leaves out a Legacy tool that requires the experimental tasks", () => {
    const tasks = tool("tasks", { execution: { taskSupport: "required" } });
    const legacy = inventoryRows(discovered({ era: "legacy", tools: [tasks, tool("a")] }), 0);

    expect(names(legacy)).toEqual(["a"]);
    expect(read(legacy).meta.problems[0]).toMatchObject({ tool: "tasks" });
    expect(names(inventoryRows(discovered({ tools: [tasks] }), 0))).toEqual(["tasks"]);
  });

  it("keeps a tool whose schema the engine could not compile, with its problem", () => {
    const rows = inventoryRows(
      discovered({ problems: [{ tool: "a", problem: "outputSchema: bad $ref" }] }),
      0,
    );

    expect(names(rows)).toEqual(["a"]);
    expect(read(rows).meta.problems).toEqual([{ tool: "a", problem: "outputSchema: bad $ref" }]);
  });

  it("keeps the first 500 tools, cuts descriptions at 4,000 characters, and says what it left out", () => {
    const many = Arr.makeBy(MAX_TOOLS + 2, (index) => tool(`t${index}`));
    const rows = inventoryRows(discovered({ tools: many }), 0);

    expect(read(rows).tools).toHaveLength(MAX_TOOLS);
    expect(read(rows).meta.problems).toEqual([
      { problem: expect.stringContaining("2 tools past the bound") },
    ]);

    const long = inventoryRows(
      discovered({ tools: [tool("a", { description: "x".repeat(MAX_DESCRIPTION + 10) })] }),
      0,
    );

    expect(read(long).tools[0]?.description).toHaveLength(MAX_DESCRIPTION);
  });

  it("keeps 1 MiB of declarations at most, in list order", () => {
    const big = Arr.makeBy(300, (index) => tool(`t${index}`, { description: "x".repeat(3999) }));
    const kept = read(inventoryRows(discovered({ tools: big }), 0)).tools;

    expect(kept.length).toBeLessThan(300);
    expect(kept[0]?.name).toBe("t0");
  });

  it("keeps the TTL from the host's time: a Modern hint capped at 24 h, else 10 min", () => {
    expect(read(inventoryRows(discovered(), 100)).meta.ttlUntil).toBe(100 + DEFAULT_TTL_MS);
    expect(read(inventoryRows(discovered({ ttlMs: 10 * MAX_TTL_MS }), 100)).meta.ttlUntil).toBe(
      100 + MAX_TTL_MS,
    );
  });

  it("stores one text for one content, whatever the order of its keys", () => {
    const one = inventoryRows(
      discovered({ tools: [{ name: "a", inputSchema: { b: 1, a: 2 } }] }),
      0,
    );

    const two = inventoryRows(
      discovered({ tools: [{ inputSchema: { a: 2, b: 1 }, name: "a" }] }),
      0,
    );

    expect(one.tools).toEqual(two.tools);
  });
});

describe("inventoryVersions", () => {
  const server = (
    name: string,
    found: McpEngineDiscovered | undefined,
    state: VersionedServer["state"] = "connected",
  ): VersionedServer => ({
    name,
    entryHash: `hash-${name}`,
    state,
    inventory:
      found === undefined ? Option.none() : readInventory(inventoryRows(found, found.fetchedAt)),
  });

  it("does not move with the time of a discovery, and moves with its tools", () => {
    const first = inventoryVersions([server("a", discovered())]);

    expect(inventoryVersions([server("a", discovered({ fetchedAt: 99 }))])).toEqual(first);

    const grown = inventoryVersions([server("a", discovered({ tools: [tool("a"), tool("b")] }))]);

    expect(grown.version).not.toBe(first.version);
    expect(grown.promptsVersion).toBe(first.promptsVersion);
  });

  it("moves the prompts version alone for a prompts-only change", () => {
    const first = inventoryVersions([server("a", discovered())]);
    const prompted = inventoryVersions([server("a", discovered({ prompts: [{ name: "p" }] }))]);

    expect(prompted.version).toBe(first.version);
    expect(prompted.promptsVersion).not.toBe(first.promptsVersion);
  });

  it("keeps a prompt left out as a prompt problem, which moves the prompts version alone", () => {
    const first = inventoryVersions([server("a", discovered())]);

    const left = inventoryVersions([
      server("a", discovered({ promptProblems: [{ prompt: "prompt #1", problem: "left out" }] })),
    ]);

    expect(left.version).toBe(first.version);
    expect(left.promptsVersion).not.toBe(first.promptsVersion);
    expect(
      read(
        inventoryRows(
          discovered({ promptProblems: [{ prompt: "prompt #1", problem: "left out" }] }),
          0,
        ),
      ).meta.problems,
    ).toEqual([{ prompt: "prompt #1", problem: "left out" }]);
  });

  it("covers a server with no inventory by its coarse state: connecting or sign-in", () => {
    const connecting = inventoryVersions([server("a", undefined, "connecting")]);

    expect(inventoryVersions([server("a", undefined, "failed")])).toEqual(connecting);
    expect(inventoryVersions([server("a", undefined, "sign_in")]).version).not.toBe(
      connecting.version,
    );
  });
});
