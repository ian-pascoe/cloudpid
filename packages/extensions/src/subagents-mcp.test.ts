// MCP tools in a subagent's hands (`docs/architecture/mcp-in-a-session.md` → Exposure, Subagents): an inheriting child
// has them as its caller does, a preset or an exact list only by pattern or name, a `codemode` tool is never offered and a
// `hidden` one never granted, the child's enabled list is fixed at spawn, and a child in a Subagent Workspace calls a stdio
// server for its own Container. Real runs: a scripted model on a Harness with the subagents, `tool_search` and `codemode`
// extensions and the `mcp` extension `McpTools` builds from an in-memory host, installed as the Session's reinstall does.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import * as Record from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import { makeMcpTools, memoryMcpToolsStore } from "./mcp.ts";
import { DOCS, ISSUES, open, startOf } from "./mcp.fixture.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { answer, call, fakeSubagentWorkspaces, gate } from "./subagents/harness.fixture.ts";

/** What a Session offers every conversation: `codemode`, the subagent tools and `read`. */
const OFFERED = ["codemode", "subagent*", "agent_message", "read"];

/** The tools the first request of `agent` offered. */
const offeredTo = (session: Awaited<ReturnType<typeof open>>, agent: string) =>
  session.requests.find((request) => request.agent === agent)?.tools ?? [];

/** The text of each tool result of conversation `agent`, oldest first. */
const resultsOf = async (session: Awaited<ReturnType<typeof open>>, agent: string) =>
  session.texts("toolResult", (await session.state()).agents[agent]!.conversationId);

/** A script that calls `tool` of the docs server and prints what it answers. */
const callOf = (tool: string) =>
  `console.log(JSON.stringify(await tools.mcp__docs_site__${tool}({ query: "q" })))`;

describe("a child that inherits its caller's tools", () => {
  it("has the MCP tools as its caller has them: direct offered, deferred found with tool_search, codemode in scripts, hidden none", async () => {
    const host = fakeMcpHost([DOCS, ISSUES]);
    const tools = makeMcpTools(host.client);
    let child = 0;

    const session = await open((request) => {
      if (request.agent === "root") {
        return request.text === "go" ? call(["subagent", { task: "Work" }]) : answer("ok");
      }

      child += 1;

      switch (child) {
        case 1:
          return call(["tool_search", { query: "fetch page" }]);
        case 2:
          return call(["codemode", { code: callOf("summarize") }]);
        default:
          return answer("done");
      }
    });

    await session.start(tools, startOf(2, { offered: OFFERED }));
    await session.prompt("go");
    await session.settle();

    const first = offeredTo(session, "agent-1");

    // What the root is offered, the direct tools of both servers: the deferred and the `codemode` one are not.
    expect(first).toContain("mcp__docs_site__search");
    expect(first).toContain("mcp__issues__list");
    expect(first).toContain("tool_search");
    expect(first).toContain("codemode");
    expect(first).not.toContain("mcp__docs_site__fetch_page");
    expect(first).not.toContain("mcp__docs_site__summarize");
    expect(first).not.toContain("mcp__docs_site__secret");
    expect(first).not.toContain("mcp__docs_site__widget");

    // `tool_search` finds the deferred tool for the child, and offers it from its next request; the `codemode` one never.
    const second = session.requests.filter((request) => request.agent === "agent-1")[1]?.tools;

    expect(second).toContain("mcp__docs_site__fetch_page");
    expect(second).not.toContain("mcp__docs_site__summarize");

    // The script reaches the `codemode` tool, as the caller's would, and the call is the child's.
    expect((await resultsOf(session, "agent-1"))[1]).toContain("summarize");

    const { contract } = (await session.state()).agents["agent-1"]!;

    expect(contract.toolSelection).toBe("inherit");
    expect(contract.tools).toEqual(
      expect.arrayContaining([
        "mcp__docs_site__search",
        "mcp__docs_site__fetch_page",
        "mcp__docs_site__summarize",
        "mcp__issues__list",
      ]),
    );
    expect(contract.tools).not.toContain("mcp__docs_site__secret");
    expect(contract.tools).not.toContain("mcp__docs_site__widget");
    expect(contract.ceiling).not.toContain("mcp__docs_site__secret");
  });

  it("is told no more than its caller: a child of a preset child has what the preset child was granted", async () => {
    const host = fakeMcpHost([DOCS, ISSUES]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) => {
      if (request.agent === "root") {
        return request.text === "go"
          ? call([
              "subagent",
              { task: "Explore", tools: ["mcp__docs_site__search"], delegation: "fanout" },
            ])
          : answer("ok");
      }

      if (request.agent === "agent-1" && request.text === "Explore") {
        return call(["subagent", { task: "Dig" }]);
      }

      return answer("done");
    }, undefined);

    await session.start(tools, startOf(2, { offered: OFFERED }));
    await session.prompt("go");
    await session.settle();

    const { agents } = await session.state();

    expect(agents["agent-1"]?.contract.tools).toEqual(["mcp__docs_site__search"]);
    expect(agents["agent-1.agent-1"]?.contract.tools).toEqual(["mcp__docs_site__search"]);
    expect(offeredTo(session, "agent-1.agent-1")).toEqual([
      "mcp__docs_site__search",
      "agent_message",
    ]);
  });
});

describe("a child given a preset or an exact list", () => {
  it("has MCP tools only by the pattern its preset's toolset names, offered whether deferred or not, and never a codemode one", async () => {
    const host = fakeMcpHost([DOCS, ISSUES]);
    const tools = makeMcpTools(host.client);

    const session = await open(
      (request) => {
        if (request.agent === "root") {
          return request.text === "go"
            ? call(
                ["subagent", { task: "Plain", tools: "read" }],
                ["subagent", { task: "Docs", tools: "read" }],
              )
            : answer("ok");
        }

        return answer("done");
      },
      undefined,
      {
        options: {
          toolsets: {
            baseToolset: [],
            readToolset: ["read", "grep", "mcp__docs_site__*"],
            modifyToolset: ["bash"],
          },
        },
      },
    );

    await session.start(tools, startOf(2, { offered: OFFERED }));
    await session.prompt("go");
    await session.settle();

    const { agents } = await session.state();

    // The pattern matches every tool of the docs server the caller has, the `codemode` one too (a script may call it) but
    // not the `hidden` one and not the issues server's.
    expect(agents["agent-1"]?.contract.tools).toEqual([
      "read",
      "grep",
      "mcp__docs_site__search",
      "mcp__docs_site__fetch_page",
      "mcp__docs_site__summarize",
    ]);

    // Named by the owner's toolset, the deferred one is offered at once; the `codemode` one never is.
    expect(offeredTo(session, "agent-1").toSorted()).toEqual(
      [
        "read",
        "grep",
        "mcp__docs_site__search",
        "mcp__docs_site__fetch_page",
        "agent_message",
      ].toSorted(),
    );
  });

  it("has no MCP tool from a preset whose toolsets name none, nor from none", async () => {
    const host = fakeMcpHost([DOCS, ISSUES]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) => {
      if (request.agent === "root") {
        return request.text === "go"
          ? call(
              ["subagent", { task: "Read it", tools: "read" }],
              ["subagent", { task: "Nothing", tools: "none" }],
              ["subagent", { task: "Modify it", tools: "modify" }],
            )
          : answer("ok");
      }

      return answer("done");
    });

    await session.start(tools, startOf(2, { offered: OFFERED }));
    await session.prompt("go");
    await session.settle();

    const { agents } = await session.state();

    for (const id of ["agent-1", "agent-2", "agent-3"]) {
      expect(agents[id]?.contract.tools.filter((name) => name.startsWith("mcp__"))).toEqual([]);
      expect(offeredTo(session, id).filter((name) => name.startsWith("mcp__"))).toEqual([]);
    }
  });

  it("has the MCP tools an exact list names, and refuses a hidden tool, one the server lacks, and one its caller lacks", async () => {
    const host = fakeMcpHost([DOCS, ISSUES]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) => {
      if (request.agent === "root") {
        return request.text === "go"
          ? call(
              ["subagent", { task: "One", tools: ["mcp__docs_site__search", "mcp__issues__list"] }],
              ["subagent", { task: "Two", tools: ["mcp__docs_site__secret"] }],
              ["subagent", { task: "Three", tools: ["mcp__docs_site__nothing"] }],
              ["subagent", { task: "Four", tools: ["mcp__docs_site__widget"] }],
            )
          : answer("ok");
      }

      return answer("done");
    });

    await session.start(tools, startOf(2, { offered: OFFERED }));
    await session.prompt("go");
    await session.settle();

    const { agents } = await session.state();

    expect(agents["agent-1"]?.contract.tools).toEqual([
      "mcp__docs_site__search",
      "mcp__issues__list",
    ]);
    expect(offeredTo(session, "agent-1")).toEqual([
      "mcp__docs_site__search",
      "mcp__issues__list",
      "agent_message",
    ]);

    const refusals = (await session.texts("toolResult")).slice(1);

    expect(refusals).toHaveLength(3);

    for (const [index, name] of ["secret", "nothing", "widget"].entries()) {
      expect(refusals[index]).toContain(
        `mcp__docs_site__${name} is unknown or outside your capability ceiling`,
      );
      expect(refusals[index]).not.toContain("mcp__docs_site__secret,");
    }

    expect(Record.keys(agents)).toEqual(["agent-1"]);
  });

  it("offers a codemode tool granted by name to no one, and reaches it from the child's own script", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    let child = 0;

    const session = await open((request) => {
      if (request.agent === "root") {
        return request.text === "go"
          ? call(["subagent", { task: "Work", tools: ["codemode", "mcp__docs_site__summarize"] }])
          : answer("ok");
      }

      child += 1;

      return child === 1 ? call(["codemode", { code: callOf("summarize") }]) : answer("done");
    });

    await session.start(tools, startOf(1, { offered: OFFERED }));
    await session.prompt("go");
    await session.settle();

    expect(offeredTo(session, "agent-1")).toEqual(["codemode", "agent_message"]);
    expect((await resultsOf(session, "agent-1"))[0]).toContain("summarize");
  });
});

describe("a child's enabled list", () => {
  it("is fixed at spawn: a tool the server adds later reaches the caller and not the child, and a tool that turns hidden leaves it", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    const held = gate();
    let child = 0;

    const session = await open(async (request) => {
      if (request.agent === "root") {
        return request.text === "go" ? call(["subagent", { task: "Work" }]) : answer("ok");
      }

      child += 1;

      if (child === 1) {
        await held.promise;

        return call(["read", {}]);
      }

      return answer("done");
    });

    await session.start(tools, startOf(1, { offered: OFFERED }));
    await session.prompt("go");
    await session.until(async () => child === 1, "the child's first request");

    // The server adds `index`, and `search` turns hidden: a reinstall while the child is between requests.
    host.set([
      {
        ...DOCS,
        toolExposure: { ...DOCS.toolExposure, search: "hidden", index: "direct" },
        tools: [...DOCS.tools, { name: "index", description: "Index the docs" }],
      },
    ]);
    await session.start(tools, startOf(1, { offered: OFFERED }));
    held.resolve();
    await session.settle();
    await session.prompt("again");

    const [before, after] = session.requests.filter((request) => request.agent === "agent-1");

    expect(before?.tools).toContain("mcp__docs_site__search");
    expect(after?.tools).not.toContain("mcp__docs_site__search");
    expect(after?.tools).not.toContain("mcp__docs_site__index");

    // The caller's own request has the new tool.
    expect(session.requests.at(-1)?.agent).toBe("root");
    expect(session.requests.at(-1)?.tools).toContain("mcp__docs_site__index");
  });
});

describe("a child's tools follow the Exposure in force", () => {
  it("offers a codemode tool the child holds once tools.offered lifts it, as it does its caller", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    const held = gate();
    let child = 0;

    const session = await open(async (request) => {
      if (request.agent === "root") {
        return request.text === "go" ? call(["subagent", { task: "Work" }]) : answer("ok");
      }

      child += 1;

      if (child === 1) {
        await held.promise;

        return call(["read", {}]);
      }

      return answer("done");
    });

    await session.start(tools, startOf(1, { offered: OFFERED }));
    await session.prompt("go");
    await session.until(async () => child === 1, "the child's first request");

    const lifted = [...OFFERED, "mcp__docs_site__summarize"];

    host.set([{ ...DOCS, tools: [...DOCS.tools] }]);
    await session.start(tools, startOf(1, { offered: lifted }));
    held.resolve();
    await session.settle();

    const [before, after] = session.requests.filter((request) => request.agent === "agent-1");

    expect(before?.tools).not.toContain("mcp__docs_site__summarize");
    expect(after?.tools).toContain("mcp__docs_site__summarize");
  });
});

describe("a child and the mcp_servers section", () => {
  it("has the section its own Context Window shows, the same listing as its caller's, from the inventory the Environment shares", async () => {
    const host = fakeMcpHost([DOCS, ISSUES]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) => {
      if (request.agent === "root") {
        return request.text === "go" ? call(["subagent", { task: "Work" }]) : answer("ok");
      }

      return answer("done");
    });

    await session.start(tools, startOf(2, { offered: OFFERED }));

    const starts = host.calls.filter((each) => each.method === "requestStart").length;

    await session.prompt("go");
    await session.settle();

    const section = (system: string) => /<mcp_servers>[\s\S]*<\/mcp_servers>/.exec(system)?.[0];
    const root = session.requests.find((request) => request.agent === "root")!;
    const child = session.requests.find((request) => request.agent === "agent-1")!;

    expect(section(child.system)).toContain("- mcp__docs_site (codemode): The product docs");
    expect(section(child.system)).toBeDefined();
    expect(section(child.system)).toEqual(section(root.system));

    // The child made no request start of its own: the inventory is the Environment's, which the Session's reads share.
    expect(host.calls.filter((each) => each.method === "requestStart")).toHaveLength(starts);
  });
});

describe("a child in a Subagent Workspace", () => {
  it("calls a stdio server for its own Workspace, from a direct call and from a script, and the Session's calls for the Session's", async () => {
    const host = fakeMcpHost([{ ...DOCS, entry: { type: "stdio", command: "npx" } }]);
    const readied: string[] = [];

    const tools = makeMcpTools(host.client, memoryMcpToolsStore(), {
      ready: async (workspace) => {
        readied.push(workspace);

        return true;
      },
    });

    const workspaces = fakeSubagentWorkspaces();
    let child = 0;

    const session = await open(
      (request) => {
        if (request.agent === "root") {
          if (request.text === "go") {
            return call(["subagent", { task: "Work", workspace: "new" }]);
          }

          return request.text === "root"
            ? call(["mcp__docs_site__search", { query: "root" }])
            : answer("ok");
        }

        child += 1;

        switch (child) {
          case 1:
            return call(["mcp__docs_site__search", { query: "direct" }]);
          case 2:
            return call(["codemode", { code: callOf("search") }]);
          default:
            return answer("done");
        }
      },
      undefined,
      { workspaces: workspaces.host },
    );

    await session.start(tools, startOf(1, { offered: OFFERED }));
    await session.prompt("go");
    await session.settle();
    await session.prompt("root");

    const named = host.calls.flatMap((each) =>
      each.method === "request" && each.input.op === "tools/call" ? [each.input.ctx.workspace] : [],
    );

    // The child's two calls name its Workspace, and the root's the Session's; each Workspace was marked used first.
    expect(named).toEqual(["ws:00000001", "ws:00000001", "ws:w1"]);
    expect(readied).toEqual(["ws:00000001", "ws:00000001", "ws:w1"]);
  });
});
