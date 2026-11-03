// The `mcp_servers` section's notices through real runs (`docs/architecture/mcp-in-a-session.md` → The prompt cache and the
// `mcp_servers` section): a scripted model on a Harness whose `mcp` extension `McpTools` builds from an in-memory host,
// as the Session installs it. A set change mid-window gives each conversation, subagents included, exactly one notice and
// leaves the section's bytes as they were.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import {
  makeMcpTools,
  mcpNotices,
  type McpRequestStartInput,
  type McpToolsService,
  type McpToolsStore,
  memoryMcpToolsStore,
} from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { MCP_SERVERS_KIND } from "./mcp/servers.ts";
import { answer, call, context, gate, openSubagentHarness } from "./subagents/harness.fixture.ts";

const DOCS: FakeMcpServer = {
  name: "docs",
  description: "The product docs",
  exposure: "codemode",
  tools: [{ name: "search" }],
};

const LINEAR: FakeMcpServer = {
  name: "linear",
  exposure: "deferred",
  instructions: "Issues and projects.",
  tools: [{ name: "issues" }],
};

const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });

const startOf = (conversation: ConversationId = ROOT_CONVERSATION_ID): McpRequestStartInput => ({
  caller: { session: "s1", conversation: String(conversation), workspace: "ws:w1" },
  window: "start",
  servers: 1,
  offered: [],
  ready: Effect.succeed(true),
});

/** A Harness with `codemode`, whose `mcp` extension (and its section) the test installs as the Session's reinstall does. */
const open = async (script: Parameters<typeof openSubagentHarness>[0]) => {
  const session = await openSubagentHarness(script, {}, [
    createCodemodeExtension({ sandbox, models: false, namespaces: [] }),
  ]);

  /** A fresh `McpTools` over `host`, writing its notices to this Harness. */
  const tools = (
    host: ReturnType<typeof fakeMcpHost>,
    store: McpToolsStore = memoryMcpToolsStore(),
  ) => {
    const mcp = makeMcpTools(host.client, store);

    mcp.bindNotices(mcpNotices(session.harness));

    return mcp;
  };

  /** What the Session does at a conversation's request start: the host calls, the reinstall, the notice check. */
  const start = async (
    mcp: McpToolsService,
    conversation: ConversationId = ROOT_CONVERSATION_ID,
    options: { readonly notify?: boolean } = {},
  ) => {
    await Effect.runPromise(mcp.requestStart(startOf(conversation)));

    Option.map(mcp.reinstall([]), ({ mcp: extension, namespaces }) => {
      session.registry.install(extension);
      session.registry.install(createCodemodeExtension({ sandbox, models: false, namespaces }));
    });

    if (options.notify !== false) await Effect.runPromise(mcp.notify(conversation));
  };

  /** The notices of conversation `id`, oldest first. */
  const notices = async (id: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> =>
    (await session.entries(id)).filter((entry) => entry.kind === MCP_SERVERS_KIND);

  return { ...session, tools, start, notices };
};

/** The model-facing text of a notice entry. */
const noticeText = (entry: EntryRecord | undefined): string => {
  const message = entry?.model?.[0];

  return message?.role === "user" && Predicate.isString(message.content) ? message.content : "";
};

describe("the mcp_servers section", () => {
  it("is shown once, with a line for each server that has a codemode or deferred tool", async () => {
    const host = fakeMcpHost([
      DOCS,
      LINEAR,
      { name: "issues", exposure: "direct", tools: [{ name: "list" }] },
    ]);

    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("hello");

    const [first] = session.requests;

    expect(first?.system).toContain("<mcp_servers>");
    expect(first?.system).toContain("- mcp__docs (codemode): The product docs");
    expect(first?.system).toContain("- mcp__linear (tool_search): Issues and projects.");
    expect(first?.system).not.toContain("mcp__issues (");
    // Codemode is loaded here, so the intro does not say to load it.
    expect(first?.system).not.toContain("Load codemode with tool_search first");
  });
});

describe("a set change under a conversation", () => {
  it("gives it exactly one notice and leaves the section's bytes as they were, however many requests see it", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open((request) => answer(`seen ${request.text.length}`));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");

    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    await session.prompt("two");
    // Nothing changes: more starts and requests tell it nothing more.
    await session.start(mcp);
    await session.prompt("three");

    const notices = await session.notices();
    const [first, second, third] = session.requests;

    expect(notices).toHaveLength(1);
    expect(notices[0]?.data).toMatchObject({ notice: "MCP servers changed" });
    expect(noticeText(notices[0])).toContain("- mcp__linear (tool_search): Issues and projects.");
    expect(noticeText(notices[0])).toContain("- mcp__docs (codemode): The product docs");
    // The notice came before the message of the request that started it, and the request after it carried it too.
    expect(second?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(third?.messages.filter((message) => message.role === "user")).toHaveLength(4);
    // The section the provider got is the one it was first shown, in every request.
    expect(second?.system).toBe(first?.system);
    expect(third?.system).toBe(first?.system);
    expect(first?.system).not.toContain("mcp__linear");
    expect(
      session.requests.map((request) => request.messages.filter((m) => m.role === "system").length),
    ).toEqual([1, 1, 1]);
  });

  it("tells a notice at once to an idle conversation, and never starts a Run", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");
    host.set([DOCS, LINEAR]);
    await session.start(mcp);

    expect(await session.notices()).toHaveLength(1);
    expect(session.requests).toHaveLength(1);
    expect((await session.harness.inspect(context)).tasks).toEqual([]);
  });

  it("is told nothing by a reinstall that changes no line, since the section shows what it did", async () => {
    const host = fakeMcpHost([DOCS, { ...LINEAR, timeout: 30 }]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");
    // The version bumps and the tools are built again, but the lines are the same.
    host.set([DOCS, { ...LINEAR, timeout: 90 }]);
    await session.start(mcp);
    await session.prompt("two");

    expect(await session.notices()).toEqual([]);
    expect(session.requests[1]?.system).toBe(session.requests[0]?.system);
  });

  it("is told the section's own listing again by a flip back, but not of a flip that no request saw", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");

    // Changed and changed back by starts of other conversations: this one was shown this listing, so it is told nothing.
    host.set([DOCS, LINEAR]);
    await session.start(mcp, ROOT_CONVERSATION_ID, { notify: false });
    host.set([DOCS]);
    await session.start(mcp, ROOT_CONVERSATION_ID, { notify: false });
    await session.start(mcp);
    await session.prompt("two");
    expect(await session.notices()).toEqual([]);

    // A change that was told, and then the flip back: one notice for each change, though the first listing is the section's.
    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    await session.prompt("three");
    host.set([DOCS]);
    await session.start(mcp);
    await session.prompt("four");

    const notices = await session.notices();

    expect(notices).toHaveLength(2);
    expect(noticeText(notices[0])).toContain("mcp__linear");
    expect(noticeText(notices[1])).not.toContain("mcp__linear");
    expect(noticeText(notices[1])).toContain("mcp__docs");
    expect(new Set(session.requests.map((request) => request.system)).size).toBe(1);
  });

  it("is told once more by a new runtime over the same conversation only if the listing changed since its last notice", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));

    const before = session.tools(host);

    await session.start(before);
    await session.prompt("one");
    host.set([DOCS, LINEAR]);
    await session.start(before);
    await session.prompt("two");

    // The object starts again: what it remembered of each conversation is gone, the conversation's document is not.
    const after = session.tools(host);

    await session.start(after);
    await session.prompt("three");
    expect(await session.notices()).toHaveLength(1);

    host.set([LINEAR]);
    await session.start(after);
    await session.prompt("four");
    expect(await session.notices()).toHaveLength(2);
  });

  it("tells nothing after a restart that installs the kept build, and still tells of a change made while it was down", async () => {
    const files: FakeMcpServer = { ...DOCS, name: "files", resources: true, description: "Files" };
    const host = fakeMcpHost([DOCS, files]);
    const store = memoryMcpToolsStore();
    const session = await open(() => answer("ok"));
    const before = session.tools(host, store);

    await session.start(before);
    await session.prompt("one");

    // The object starts again: its `McpTools` is made over what the first kept, and installs it without asking the host.
    host.fail(true);

    const after = session.tools(host, store);

    const kept = after.reinstall([]);

    expect(Option.isSome(kept)).toBe(true);
    Option.map(kept, ({ mcp }) => session.registry.install(mcp));
    expect(after.listing()).toEqual(before.listing());
    expect(after.listing().text).toContain("- mcp__files (codemode): Files · resources");

    await session.prompt("two");
    await Effect.runPromise(after.notify(ROOT_CONVERSATION_ID));
    expect(await session.notices()).toEqual([]);
    expect(session.requests[1]?.system).toBe(session.requests[0]?.system);

    // The set changed meanwhile: the next request start reads it, and the conversation is told once.
    host.fail(false);
    host.set([DOCS]);
    await session.start(after);
    await session.prompt("three");
    expect(await session.notices()).toHaveLength(1);
  });

  it("writes one notice when two checks of a conversation run together", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");
    host.set([DOCS, LINEAR]);
    await Effect.runPromise(mcp.requestStart(startOf()));
    Option.map(mcp.reinstall([]), ({ mcp: extension }) => session.registry.install(extension));

    await Promise.all([
      Effect.runPromise(mcp.notify(ROOT_CONVERSATION_ID)),
      Effect.runPromise(mcp.notify(ROOT_CONVERSATION_ID)),
    ]);

    expect(await session.notices()).toHaveLength(1);
  });

  it("is shown the listing as it is, not told of it, in a new Context Window", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");
    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    await session.prompt("two");
    expect(await session.notices()).toHaveLength(1);

    await session.root.reset("Handoff summary", context);
    await session.start(mcp);
    await session.prompt("three");

    const last = session.requests.at(-1);

    expect(last?.system).toContain("- mcp__linear (tool_search)");
    expect(await session.notices()).toHaveLength(1);
  });

  it("gives each conversation of the Session its own single notice", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    const other = await session.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
      context,
    );

    await session.start(mcp);
    await session.prompt("one");
    await (await other.submit({ type: "input", content: "hello" }, context)).wait(context);

    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    await session.start(mcp, other.id);
    await session.prompt("two");
    await (await other.submit({ type: "input", content: "again" }, context)).wait(context);
    await session.start(mcp, other.id);
    await (await other.submit({ type: "input", content: "once more" }, context)).wait(context);

    expect(await session.notices()).toHaveLength(1);
    expect(await session.notices(other.id)).toHaveLength(1);
  });

  it("tells a notice before a conversation's message only when its section has been shown", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    // Nothing was shown to the conversation yet: it gets the section as it is when its first request shows it.
    await session.start(mcp);
    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    expect(await session.notices()).toEqual([]);

    await session.prompt("one");
    expect(session.requests[0]?.system).toContain("mcp__linear");
    expect(await session.notices()).toEqual([]);
  });
});

describe("a set change under a subagent", () => {
  it("gives the child exactly one notice, placed at its next boundary, though it makes no request start of its own", async () => {
    const host = fakeMcpHost([DOCS]);
    const held = gate();
    let childRequests = 0;

    const session = await open(async (request) => {
      if (request.agent === "agent-1") {
        childRequests += 1;

        // Its first request waits while the Session's set changes.
        if (childRequests === 1) await held.promise;

        return childRequests < 3 ? call(["read", {}]) : answer("Done.");
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "Work" }]);

      return answer("Noted.");
    });

    const mcp = session.tools(host);

    await session.start(mcp);
    const delegated = session.prompt("Delegate it");

    await session.until(async () => childRequests === 1, "the child's first request");
    host.set([DOCS, LINEAR]);
    // The owner's next message starts a request: the Session reads the new set and tells the conversations it knows.
    await session.start(mcp);
    held.resolve();
    await delegated;
    await session.settle();

    const child = (await session.state()).agents["agent-1"]!.conversationId;
    const notices = await session.notices(child);
    const requests = session.requests.filter((request) => request.agent === "agent-1");

    expect(notices).toHaveLength(1);
    expect(noticeText(notices[0])).toContain("- mcp__linear (tool_search)");
    // The child's section never changed, and its last request carried the notice.
    expect(new Set(requests.map((request) => request.system)).size).toBe(1);
    expect(
      requests
        .at(-1)
        ?.messages.some(
          (message) =>
            message.role === "user" && JSON.stringify(message.content).includes("mcp__linear"),
        ),
    ).toBe(true);
    // The root was told by the start that read the new set, once.
    expect(await session.notices()).toHaveLength(1);
  });
});
