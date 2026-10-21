// Deferred tools through real runs: a scripted model on a Harness whose tools are deferred by the offered set, which
// `tool_search` loads from and a child's grants add to.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { answer, call, context, openSubagentHarness } from "./subagents/harness.fixture.ts";
import { COORDINATOR_TOOLS } from "./subagents.ts";
import { fixedToolSearchSettings, isOffered, reloadToolSearch, ToolSearch } from "./tool-search.ts";

/** The deferred tools the latest request's prompt names (the system sections it carried are joined, oldest first). */
const deferredIn = (system: string | undefined) =>
  system?.split("<deferred_tools>").at(-1)?.split("</deferred_tools>")[0] ?? "";

const CODING = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/** Stand-ins for tools that are deferred by default, each with a description a search can tell apart. */
const Extras = defineExtension({
  name: "extras",
  tools: Object.entries({
    web_fetch: "Fetch a page from a URL",
    web_search: "Search the internet for pages",
    todo: "Keep a checklist of tasks",
  }).map(([name, description]) =>
    defineTool({
      name,
      description,
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }),
    }),
  ),
});

const NAMES = [...CODING, "web_fetch", "web_search", "todo", ...COORDINATOR_TOOLS];

/**
 * A Harness whose tools are deferred unless `offered` names them, and `setOffered`, which the Session does when the
 * settings it reads change: it installs the extension again over the earlier one.
 */
const open = async (
  script: Parameters<typeof openSubagentHarness>[0],
  offered: ReadonlyArray<string>,
) => {
  const toolSearch = await Effect.runPromise(
    ToolSearch(NAMES).pipe(Effect.provide(fixedToolSearchSettings(offered))),
  );

  const session = await openSubagentHarness(script, {}, [Extras, toolSearch]);

  const setOffered = (next: ReadonlyArray<string>) =>
    session.registry.install(
      reloadToolSearch(session.registry.snapshot().installed(), { offered: next }),
    );

  return { ...session, setOffered };
};

describe("which tools are offered", () => {
  it("matches names and patterns, and always offers tool_search and context_rollover", () => {
    const options = { offered: ["read", "context_*"] };

    expect(isOffered(options, "read")).toBe(true);
    expect(isOffered(options, "context_notes")).toBe(true);
    expect(isOffered(options, "reader")).toBe(false);
    expect(isOffered(options, "web_fetch")).toBe(false);
    expect(isOffered({ offered: [] }, "tool_search")).toBe(true);
    expect(isOffered({ offered: [] }, "context_rollover")).toBe(true);
  });
});

describe("deferred tools", () => {
  it("are absent from the model's tool list, which names them in the prompt, until tool_search loads them", async () => {
    const session = await open((request) => answer(`seen ${request.tools.length}`), CODING);

    await session.prompt("hello");

    const [first] = session.requests;

    expect(first?.tools).toEqual([...CODING, "tool_search"]);
    expect(first?.system).toContain("tool_search");
    expect(first?.system).toContain("web_fetch");
    expect(first?.system).toContain("todo");
    expect(deferredIn(first?.system)).not.toMatch(/\bread\b/);
  });

  it("are loaded by tool_search, and stay offered on the branch", async () => {
    const session = await open((request) => {
      if (request.text === "go") return call(["tool_search", { query: "fetch" }]);

      return answer("done");
    }, CODING);

    await session.prompt("go");
    await session.prompt("once more");

    const [before, after, later] = session.requests;

    expect(before?.tools).not.toContain("web_fetch");
    expect(after?.tools).toContain("web_fetch");
    expect(later?.tools).toContain("web_fetch");

    // The prompt names the tools the settings defer, loaded or not, so a load does not change it.
    expect(deferredIn(later?.system)).toBe(deferredIn(before?.system));
    expect(deferredIn(later?.system)).toContain("web_fetch");
    expect(deferredIn(later?.system)).toContain("web_search");
    expect((await session.texts("toolResult"))[0]).toContain("Loaded");
  });

  it("stay callable by tools and scripts without being loaded", async () => {
    const session = await open(() => answer("hi"), CODING);

    const agent = await session.root.agent(context);
    const offered = agent.tools.map((tool) => tool.name);
    const deferred = agent.deferred.map((tool) => tool.name);
    const callable = agent.callable.map((tool) => tool.name);

    expect(offered).not.toContain("web_fetch");
    expect(deferred).toEqual(
      expect.arrayContaining(["web_fetch", "web_search", "todo", "subagent"]),
    );
    expect(callable).toEqual(
      expect.arrayContaining(["web_fetch", "web_search", "todo", ...CODING]),
    );
  });

  it("follow the offered set as it is installed again, and keep what was loaded", async () => {
    const session = await open((request) => {
      if (request.text === "load") return call(["tool_search", { query: "checklist" }]);

      return answer("ok");
    }, CODING);

    await session.prompt("first");
    session.setOffered([...CODING, "web_search"]);
    await session.prompt("second");
    await session.prompt("load");
    session.setOffered(["read"]);
    await session.prompt("fourth");

    const tools = session.requests.map((request) => request.tools);

    expect(tools[0]).not.toContain("web_search");
    expect(tools[1]).toContain("web_search");
    expect(tools.at(-1)).toEqual(expect.arrayContaining(["read", "todo", "tool_search"]));
    expect(tools.at(-1)).not.toContain("bash");
    expect(tools.at(-1)).not.toContain("web_search");
  });

  it("can all be deferred, leaving the model tool_search", async () => {
    const session = await open(() => answer("ok"), []);

    await session.prompt("hello");
    expect(session.requests[0]?.tools).toEqual(["tool_search"]);
  });

  it("are all deferred by an empty set, and offered by a pattern that matches everything", async () => {
    const session = await Effect.runPromise(
      ToolSearch(NAMES).pipe(Effect.provide(fixedToolSearchSettings(["*"]))),
    ).then((toolSearch) => openSubagentHarness(() => answer("ok"), {}, [Extras, toolSearch]));

    await session.prompt("hello");
    expect(session.requests[0]?.tools).toEqual(
      expect.arrayContaining([...CODING, "web_fetch", "todo", "tool_search"]),
    );
  });
});

describe("a subagent's offered tools", () => {
  /** The first request an agent made. */
  const firstOf = (
    requests: ReadonlyArray<{ agent: string; tools: ReadonlyArray<string> }>,
    agent: string,
  ) => requests.find((request) => request.agent === agent)?.tools ?? [];

  it("are the grant's tools the settings offer, plus the tools it named and its coordinator tools", async () => {
    const session = await open(
      (request) => {
        if (
          request.agent === "agent-1" ||
          request.agent === "agent-2" ||
          request.agent === "agent-3"
        )
          return answer("ok");

        if (request.text === "go") {
          return call(
            ["subagent", { task: "read only", tools: "read" }],
            ["subagent", { task: "named", tools: ["web_fetch", "bash"] }],
            ["subagent", { task: "inherit" }],
          );
        }

        if (request.text.startsWith("Spawned")) return answer("delegated");

        return answer("noted");
      },
      [...CODING, "subagent"],
    );

    // The root loads nothing: `subagent` is offered by the set.
    await session.prompt("go");
    await session.settle();

    // The preset's tools are all offered, the base toolset's `todo` (deferred for the root) among them.
    expect(firstOf(session.requests, "agent-1")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "todo",
      "agent_message",
    ]);

    // An exact list is offered whole, deferred tools included, and nothing else is.
    expect([...firstOf(session.requests, "agent-2")].sort()).toEqual([
      "agent_message",
      "bash",
      "todo",
      "web_fetch",
    ]);

    // A child that inherits is offered what every conversation is, not the tools the settings defer: it has tool_search
    // for those.
    const inherited = firstOf(session.requests, "agent-3");

    expect(inherited).toEqual(expect.arrayContaining([...CODING, "tool_search", "agent_message"]));
    expect(inherited).not.toContain("web_fetch");
    expect(inherited).not.toContain("todo");
  });

  it("can load a deferred tool of its grant with tool_search when it inherits", async () => {
    const session = await open(
      (request) => {
        if (request.agent === "agent-1") {
          return request.tools.includes("todo")
            ? answer("loaded")
            : call(["tool_search", { query: "checklist" }]);
        }

        if (request.text === "go") return call(["subagent", { task: "inherit" }]);

        return answer("noted");
      },
      [...CODING, "subagent"],
    );

    await session.prompt("go");
    await session.settle();

    const child = session.requests.filter((request) => request.agent === "agent-1");

    expect(child[0]?.tools).not.toContain("todo");
    expect(child.at(-1)?.tools).toContain("todo");
  });

  it("offers a grandchild the whole grant it inherits from a child that has no tool_search, and does not tell it to search", async () => {
    const session = await open(
      (request) => {
        if (request.agent === "agent-1.agent-1") return answer("ok");

        if (request.agent === "agent-1") {
          return request.text === "child"
            ? call(["subagent", { task: "grandchild" }])
            : answer("child done");
        }

        if (request.text === "go") {
          return call([
            "subagent",
            { task: "child", tools: ["web_fetch", "bash"], delegation: "fanout" },
          ]);
        }

        return answer("noted");
      },
      [...CODING, "subagent"],
    );

    await session.prompt("go");
    await session.settle();

    const grandchild = session.requests.find((request) => request.agent === "agent-1.agent-1");

    // Its grant is web_fetch, bash and the base toolset's todo, and tool_search is not in it: all are offered, since no
    // search could load them.
    expect([...(grandchild?.tools ?? [])].sort()).toEqual([
      "agent_message",
      "bash",
      "todo",
      "web_fetch",
    ]);
    expect(grandchild?.system).not.toContain("Tools the settings defer");
  });
});
