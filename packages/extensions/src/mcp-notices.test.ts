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
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vite-plus/test";
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

  /** The Session's reinstall: the conversations are told of the listing, and then the build is installed. */
  const install = async (mcp: McpToolsService) => {
    const built = mcp.reinstall([]);

    if (Option.isNone(built)) return;

    await Effect.runPromise(built.value.announce);
    session.registry.install(built.value.mcp);
    session.registry.install(
      createCodemodeExtension({ sandbox, models: false, namespaces: built.value.namespaces }),
    );
  };

  /** What the Session does at a conversation's request start: the host calls, the reinstall, the notice check. */
  const start = async (
    mcp: McpToolsService,
    conversation: ConversationId = ROOT_CONVERSATION_ID,
    options: { readonly notify?: boolean } = {},
  ) => {
    await Effect.runPromise(mcp.requestStart(startOf(conversation)));

    // As the Session host: the conversations are told, then the build is installed.
    await install(mcp);

    if (options.notify !== false) await Effect.runPromise(mcp.notify(conversation));
  };

  /** The notices of conversation `id`, oldest first. */
  const notices = async (id: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> =>
    (await session.entries(id)).filter((entry) => entry.kind === MCP_SERVERS_KIND);

  return { ...session, tools, start, install, notices };
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

  it("is told of every listing the Session installs, a flip back to the section's own included", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");

    // Each install tells the conversations first, whichever conversation's start made it: the flip back is told too,
    // since the model reads the first notice before it.
    host.set([DOCS, LINEAR]);
    await session.start(mcp, ROOT_CONVERSATION_ID, { notify: false });
    host.set([DOCS]);
    await session.start(mcp, ROOT_CONVERSATION_ID, { notify: false });
    await session.start(mcp);
    await session.prompt("two");

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

    await session.prompt("two");
    expect(session.requests[1]?.system).toContain("- mcp__files (codemode): Files · resources");
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

describe("a busy conversation when an install lands", () => {
  it("carries the notice in every request that is offered the new server's tool", async () => {
    // A server that lists a tool as direct beside one that scripts call: the request's tools show when it is installed.
    const lifted: FakeMcpServer = {
      name: "linear",
      exposure: "codemode",
      toolExposure: { issues: "direct" },
      tools: [{ name: "issues" }, { name: "triage" }],
    };

    const host = fakeMcpHost([DOCS]);
    const slow = gate();
    let requests = 0;
    let finished = false;
    let running = false;

    const session = await open(async (request) => {
      if (request.text === "Work") running = true;

      if (!running) return answer("ok");

      requests += 1;
      // Each request follows a tool call, so the Run crosses a boundary every few milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 5));

      if (!finished) return call(["read", {}]);

      running = false;

      return answer("Done.");
    });

    const mcp = session.tools(host);
    const sink = mcpNotices(session.harness);
    let armed = false;

    // The notices take a while to write once armed: the Run goes on meanwhile.
    mcp.bindNotices({
      check: async (input) => {
        if (armed) await slow.promise;

        return sink.check(input);
      },
      conversations: sink.conversations,
    });

    await session.start(mcp);
    await session.prompt("one");

    const work = await session.root.submit({ type: "input", content: "Work" }, context);

    await session.until(async () => requests > 2, "the Run to be busy");
    host.set([DOCS, lifted]);
    armed = true;
    await Effect.runPromise(mcp.requestStart(startOf()));

    // A settings read installs the build: no request start of the owner's, and the Run is busy. Its notice is written
    // before the build is installed, so a request that is offered the tool has it, here where the Run's boundaries are
    // far apart. (Not a guarantee to the microsecond: pi-durable places a Run's inbox at a boundary and fixes its tools
    // later, in `prepare`, so a request in that gap has the new tools and its notice one boundary later.)
    const installed = session.install(mcp);

    await new Promise((resolve) => setTimeout(resolve, 60));
    slow.resolve();
    await installed;
    await session.until(async () => requests > 8, "the Run to see the install");

    finished = true;
    await work.wait(context);

    const run = session.requests.filter(
      (request) => request.text !== "one" && request.text !== "ok",
    );

    const offered = session.requests.filter((request) =>
      request.tools.includes("mcp__linear__issues"),
    );

    const told = (request: (typeof session.requests)[number]) =>
      request.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("mcp__linear"),
      );

    expect(run.length).toBeGreaterThan(1);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every(told)).toBe(true);
    expect(await session.notices()).toHaveLength(1);
  });
});

describe("an object that starts again", () => {
  /** A runtime over `store` whose notices count each conversation they are asked about. */
  const counting = (
    session: Awaited<ReturnType<typeof open>>,
    host: ReturnType<typeof fakeMcpHost>,
    store: McpToolsStore,
  ) => {
    const mcp = makeMcpTools(host.client, store);
    const sink = mcpNotices(session.harness);
    const asked: ConversationId[] = [];

    mcp.bindNotices({
      check: (input) => {
        asked.push(...input.conversations);

        return sink.check(input);
      },
      conversations: sink.conversations,
    });

    return { mcp, asked };
  };

  it("reads no conversation when the kept listing is the one its last broadcast told", async () => {
    const host = fakeMcpHost([DOCS]);
    const store = memoryMcpToolsStore();
    const session = await open(() => answer("ok"));

    const other = await session.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
      context,
    );

    await session.start(session.tools(host, store));
    await session.prompt("one");
    await (await other.submit({ type: "input", content: "hello" }, context)).wait(context);

    // A wake, an alarm's included: the kept build is installed and its listing was told, so nothing is read.
    host.fail(true);

    const { mcp, asked } = counting(session, host, store);

    await session.install(mcp);

    expect(asked).toEqual([]);
    expect(await session.notices(other.id)).toEqual([]);
  });

  it("finishes a broadcast that a crash cut off, though the notices it had written are not written twice", async () => {
    const host = fakeMcpHost([DOCS]);
    const store = memoryMcpToolsStore();
    const session = await open(() => answer("ok"));
    const before = session.tools(host, store);

    const other = await session.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
      context,
    );

    await session.start(before);
    await session.prompt("one");
    await (await other.submit({ type: "input", content: "hello" }, context)).wait(context);

    // The change is kept and the owner's conversation told; the object goes before the others are.
    const sink = mcpNotices(session.harness);

    before.bindNotices({
      check: sink.check,
      conversations: async () => {
        throw new Error("The object was evicted");
      },
    });
    host.set([DOCS, LINEAR]);
    await session.start(before);
    expect(await session.notices()).toHaveLength(1);
    expect(await session.notices(other.id)).toEqual([]);

    host.fail(true);

    const { mcp, asked } = counting(session, host, store);

    await session.install(mcp);

    expect(asked).toContain(other.id);
    expect(await session.notices(other.id)).toHaveLength(1);
    expect(await session.notices()).toHaveLength(1);

    // It is told now: the next wake reads nothing.
    const again = counting(session, host, store);

    await session.install(again.mcp);
    expect(again.asked).toEqual([]);
  });
});

describe("a Stop that interrupts the broadcast", () => {
  it("leaves every conversation still told, exactly once", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);
    const sink = mcpNotices(session.harness);
    const entered = gate();
    const opened = gate();
    let waiting: ConversationId | undefined;
    let checks = 0;

    mcp.bindNotices({
      check: async (input) => {
        checks += 1;

        // The first conversation of the broadcast waits in its check while the Stop arrives.
        const first = input.conversations.find((each) => each === waiting);

        if (first !== undefined) {
          waiting = undefined;
          entered.resolve();
          await opened.promise;
        }

        return sink.check(input);
      },
      conversations: sink.conversations,
    });

    const others = await Promise.all(
      Array.from({ length: 3 }, () =>
        session.harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: { model: { provider: "faux", modelId: "faux-1" } },
          },
          context,
        ),
      ),
    );

    await session.start(mcp);
    await session.prompt("one");

    for (const other of others) {
      await (await other.submit({ type: "input", content: "hello" }, context)).wait(context);
    }

    host.set([DOCS, LINEAR]);
    await Effect.runPromise(mcp.requestStart(startOf()));
    // The build is installed without its announcement: the owner's request start is what broadcasts.
    Option.map(mcp.reinstall([]), ({ mcp: extension }) => session.registry.install(extension));
    waiting = others[0]!.id;

    const start = Effect.runFork(mcp.notify(ROOT_CONVERSATION_ID));

    await entered.promise;

    const stopped = Effect.runPromise(start.pipe(Fiber.interrupt));

    opened.resolve();
    await stopped;

    expect(await session.notices()).toHaveLength(1);

    for (const other of others) expect(await session.notices(other.id)).toHaveLength(1);

    // The broadcast ran to its end: the next request finds nothing due, and asks no conversation again.
    const asked = checks;

    await Effect.runPromise(mcp.notify(ROOT_CONVERSATION_ID));
    expect(checks).toBe(asked);

    for (const other of others) expect(await session.notices(other.id)).toHaveLength(1);
  });
});

describe("the section's intro", () => {
  it("names only tools the build registers: a host without `resources` has no resource tools, and none has mcp_sign_in_ask", async () => {
    const host = fakeMcpHost([DOCS, { ...DOCS, name: "files", resources: true }]);

    host.features(["inventory", "call"]);

    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");

    const [first] = session.requests;

    expect(first?.system).toContain("- mcp__files (codemode): The product docs · resources");
    expect(first?.system).toContain("tools.mcp__<server>__<tool>(args)");
    expect(first?.system).not.toContain("list_mcp_resources");
    expect(first?.system).not.toContain("read_mcp_resource");
    expect(first?.system).not.toContain("mcp_sign_in_ask");
  });

  it("names the resource tools when the host lists `resources` and a server has resources", async () => {
    const host = fakeMcpHost([DOCS, { ...DOCS, name: "files", resources: true }]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");

    const [first] = session.requests;

    expect(first?.system).toContain(
      "list_mcp_resources, list_mcp_resource_templates and read_mcp_resource take its name",
    );
    expect(first?.system).not.toContain("mcp_sign_in_ask");
  });
});

describe("what a conversation was last shown", () => {
  /** Holds the root's request that carries `text` until the gate opens. */
  const heldOn = (text: string, held: ReturnType<typeof gate>) =>
    open(async (request) => {
      if (request.text === text) await held.promise;

      return answer("ok");
    });

  it("is told at once when it is idle, though the owner's start is the only one", async () => {
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
    // Only the owner's conversation starts a request: the idle one is told by the same start, and starts no Run.
    await session.start(mcp);

    expect(await session.notices(other.id)).toHaveLength(1);
    expect(noticeText((await session.notices(other.id))[0])).toContain("mcp__linear");
    expect(await session.notices()).toHaveLength(1);
    expect((await session.harness.inspect(context)).tasks).toEqual([]);
    expect(session.requests).toHaveLength(2);
  });

  it("counts a notice still queued behind a busy Run, so a flip back before it is placed is told too", async () => {
    const host = fakeMcpHost([DOCS]);
    const held = gate();
    const session = await heldOn("slow", held);
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");

    const slow = await session.root.submit({ type: "input", content: "slow" }, context);

    await session.until(async () => session.requests.length === 2, "the held request");
    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    // The first notice is queued behind the Run. The listing flips back to what the section showed: the model, which
    // will read the first notice at the Run's next boundary, is told this one too.
    host.set([DOCS]);
    await session.start(mcp);
    // The same listing again, and a new runtime that remembers nothing: nothing more is queued.
    await session.start(session.tools(host));

    held.resolve();
    await slow.wait(context);
    await session.settle();

    const notices = await session.notices();

    expect(notices).toHaveLength(2);
    expect(noticeText(notices[0])).toContain("mcp__linear");
    expect(noticeText(notices[1])).not.toContain("mcp__linear");
    expect(noticeText(notices[1])).toContain("mcp__docs");
  });

  it("tells a change once when a new runtime asks while the notice is still queued, and tells the next change", async () => {
    const host = fakeMcpHost([DOCS]);
    const held = gate();
    const session = await heldOn("slow", held);

    await session.start(session.tools(host));
    await session.prompt("one");

    const slow = await session.root.submit({ type: "input", content: "slow" }, context);

    await session.until(async () => session.requests.length === 2, "the held request");
    host.set([DOCS, LINEAR]);
    await session.start(session.tools(host));
    // The object was evicted before the notice was placed: its memory is gone, the queued notice is not.
    await session.start(session.tools(host));
    host.set([LINEAR]);
    await session.start(session.tools(host));

    held.resolve();
    await slow.wait(context);
    await session.settle();

    const notices = await session.notices();

    expect(notices).toHaveLength(2);
    expect(noticeText(notices[0])).toContain("mcp__docs");
    expect(noticeText(notices[1])).not.toContain("mcp__docs");
    expect(noticeText(notices[1])).toContain("mcp__linear");
  });

  it("is what a fork inherits: a fork from before a notice is told of the change, one from after it is told what is new", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);

    await session.start(mcp);
    await session.prompt("one");

    const before = (await session.entries()).at(-1)!;

    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    await session.prompt("two");

    const after = (await session.entries()).at(-1)!;
    const early = await session.root.fork(before.id, { ownership: { kind: "ownerless" } }, context);
    const late = await session.root.fork(after.id, { ownership: { kind: "ownerless" } }, context);

    // The listing goes back to the one the section showed: the root and the late fork (shown the other) are told, the
    // early fork never was shown the change.
    host.set([DOCS]);
    await session.start(mcp);

    expect(await session.notices(early.id)).toEqual([]);
    expect(await session.notices(late.id)).toHaveLength(2);
    expect(noticeText((await session.notices(late.id))[1])).not.toContain("mcp__linear");
    expect(await session.notices()).toHaveLength(2);
  });

  it("is not told before the listing is known: a runtime that has not read the host yet says nothing", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));

    await session.start(session.tools(host));
    await session.prompt("one");
    host.set([DOCS, LINEAR]);

    // Another runtime over the same Session, before its first reinstall (an object restarted without a kept build).
    await Effect.runPromise(session.tools(host).notify(ROOT_CONVERSATION_ID));

    expect(await session.notices()).toEqual([]);
  });
});

describe("telling every conversation of a listing", () => {
  const ownerless = (session: Awaited<ReturnType<typeof open>>) =>
    session.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
      context,
    );

  it("is done by a reinstall that no request start of the owner made", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);
    const other = await ownerless(session);

    await session.start(mcp);
    await session.prompt("one");
    await (await other.submit({ type: "input", content: "hello" }, context)).wait(context);

    // A settings read installs again: the owner's conversation starts nothing, and everyone is told as the build installs.
    host.set([DOCS, LINEAR]);
    await Effect.runPromise(mcp.requestStart(startOf()));
    await session.install(mcp);

    expect(await session.notices(other.id)).toHaveLength(1);
    expect(await session.notices()).toHaveLength(1);
  });

  it("is tried again by the next request when the Session's conversations could not be listed", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);
    const sink = mcpNotices(session.harness);
    let failures = 0;

    mcp.bindNotices({
      check: sink.check,
      conversations: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("The Harness is busy");
        }

        return sink.conversations();
      },
    });

    const other = await ownerless(session);

    await session.start(mcp);
    await session.prompt("one");
    await (await other.submit({ type: "input", content: "hello" }, context)).wait(context);

    host.set([DOCS, LINEAR]);
    failures = 2;
    // The install's broadcast and the start's both fail: the owner's own conversation is told, the rest is not yet.
    await session.start(mcp);
    expect(await session.notices()).toHaveLength(1);
    expect(await session.notices(other.id)).toEqual([]);

    // The next request finds the broadcast still due, and finishes it; the owner is not told twice.
    await session.start(mcp);
    expect(await session.notices(other.id)).toHaveLength(1);
    expect(await session.notices()).toHaveLength(1);
  });

  it("does not read again a conversation whose context shows no section yet, until it shows one", async () => {
    const host = fakeMcpHost([DOCS]);
    const session = await open(() => answer("ok"));
    const mcp = session.tools(host);
    const sink = mcpNotices(session.harness);
    const asked: ConversationId[][] = [];

    mcp.bindNotices({
      check: (input) => {
        asked.push([...input.conversations]);

        return sink.check(input);
      },
      conversations: sink.conversations,
    });

    const fresh = await ownerless(session);

    await session.start(mcp);
    await session.prompt("one");
    host.set([DOCS, LINEAR]);
    await session.start(mcp);
    expect(asked.flat()).toContain(fresh.id);

    asked.length = 0;
    host.set([LINEAR]);
    await session.start(mcp);
    expect(asked.flat()).not.toContain(fresh.id);

    // Its first request shows it the section as it is, and it is read again from then on.
    await (await fresh.submit({ type: "input", content: "hello" }, context)).wait(context);
    asked.length = 0;
    host.set([DOCS]);
    await session.start(mcp);
    expect(asked.flat()).toContain(fresh.id);
  });
});
