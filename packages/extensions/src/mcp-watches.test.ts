// The Session's end of the Resource watches (`docs/architecture/mcp-in-a-session.md` → Resource watches): the `watch`
// parameter only on a host that lists `watches`, what a read says and records of its watch, the notice a request start
// writes of what changed and ended (URIs only, with its caps), and the request start that still calls the host for a
// conversation whose watches outlived its servers. An in-memory host and a recording `McpWatchRecorder`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import { McpHostCompleted, type McpWatchChange } from "@cloudpid/mcp/types";
import {
  type ConversationId,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type { Mutable } from "effect/Types";
import { describe, expect, it, vi } from "vitest";
import { startOf } from "./mcp.fixture.ts";
import {
  makeMcpTools,
  mcpExtension,
  mcpNotices,
  memoryMcpToolsStore,
  type McpWatched,
} from "./mcp.ts";
import type { McpToolOptions } from "./mcp/tools.ts";
import { fakeMcpHost, type FakeMcpServer } from "./mcp.testing.ts";
import type { McpHostClientService } from "./mcp/client.ts";
import { answer, call, context, openSubagentHarness } from "./subagents/harness.fixture.ts";
import {
  MAX_NOTICE_ENTRIES,
  MCP_WATCHES_KIND,
  MAX_NOTICE_SUB_URIS,
  type McpWatchRecorder,
  watchesNotice,
} from "./mcp/watches.ts";

const FILES: FakeMcpServer = {
  name: "File-Store",
  exposure: "direct",
  resources: true,
  tools: [],
};

/** A recorder that keeps what it is told, and what it holds is `held`. */
const recorder = () => {
  const started: McpWatched[] = [];
  const ended: Array<readonly [string, ReadonlyArray<{ server: string; uri: string }>]> = [];
  const held = new Set<string>();

  const watches: McpWatchRecorder = {
    started: (watch) =>
      Effect.sync(() => {
        started.push(watch);
        held.add(watch.conversation);
      }),
    ended: (conversation, each) =>
      Effect.sync(() => {
        ended.push([conversation, each]);
      }),
    has: (conversation) => held.has(conversation),
  };

  return {
    watches,
    started,
    ended,
    /** Make `conversation` hold a watch, as one started through a read does. */
    hold: (conversation: string) => {
      held.add(conversation);
    },
    /** Make `conversation` hold no watch, as its last one ending does. */
    release: (conversation: string) => {
      held.delete(conversation);
    },
  };
};

/** The `read_mcp_resource` tool of a build that lists `features`, and an api to run it with. */
const reader = (features: ReadonlyArray<string>, watches?: McpWatchRecorder) => {
  const host = fakeMcpHost([FILES]);

  host.answer(async (input) => {
    const result = {
      kind: "inline",
      value: { contents: [{ uri: "file:///a.txt", text: "read" }] },
    } as const;

    return input.op === "resources/read" && input.params.watch === true
      ? McpHostCompleted.make({ result, sha256: "00", watch: { started: true } })
      : McpHostCompleted.make({ result, sha256: "00" });
  });

  const options: Mutable<McpToolOptions> = { environment: "env-1" };

  if (watches !== undefined) options.watches = watches;

  const extension = mcpExtension(
    {
      servers: [
        {
          name: "File-Store",
          state: "connected",
          discoveredAt: 1,
          server: { exposure: "direct" },
          resources: true,
        },
      ],
      offered: [],
      features: ["inventory", "call", "resources", ...features],
    },
    host.client,
    {},
    options,
  );

  const tool = Option.getOrThrow(
    Arr.findFirst(extension.tools ?? [], (each) => each.name === "read_mcp_resource"),
  );

  const parts: Partial<ToolExecutionApi> = {
    callId: "call-1",
    // SAFETY: a conversation ID for the test, which the tool reads as text.
    conversationId: 3 as ConversationId,
    env: undefined,
    getTask: async () => undefined,
    details: async () => undefined,
    memo: async () => undefined,
  };

  // SAFETY: only what the resource tools read of the api is given: the call's ids, its memo, task, details and environment.
  const api = parts as ToolExecutionApi;

  return {
    host,
    tool,
    run: (args: { server: string; uri: string; watch?: boolean }) =>
      tool.execute(args, api, context),
    // SAFETY: the tool's parameters are an object schema.
    properties: () => Record.keys((tool.parameters as { properties: object }).properties),
  };
};

const readParams = (host: ReturnType<typeof fakeMcpHost>) =>
  Arr.flatMap(host.calls, (each) =>
    each.method === "request" && each.input.op === "resources/read" ? [each.input.params] : [],
  );

describe("the watch parameter of read_mcp_resource", () => {
  it("is declared only when the host lists `watches`", () => {
    expect(reader(["watches"]).properties()).toEqual(["server", "uri", "watch"]);
    expect(reader([]).properties()).toEqual(["server", "uri"]);
  });

  it("is sent to the host, and left out of a request that did not ask or a host that cannot", async () => {
    const watching = reader(["watches"]);

    await watching.run({ server: "file_store", uri: "file:///a.txt", watch: true });
    await watching.run({ server: "file_store", uri: "file:///a.txt" });
    expect(readParams(watching.host)).toEqual([
      { uri: "file:///a.txt", watch: true },
      { uri: "file:///a.txt" },
    ]);

    const plain = reader([]);

    await plain.run({ server: "file_store", uri: "file:///a.txt", watch: true });
    expect(readParams(plain.host)).toEqual([{ uri: "file:///a.txt" }]);
  });

  it("records a watch the host started, tells the model, and ends the conversation's with watch: false", async () => {
    const kept = recorder();
    const watching = reader(["watches"], kept.watches);

    const result = await watching.run({ server: "file_store", uri: "file:///a.txt", watch: true });

    expect(kept.started).toEqual([
      { environment: "env-1", conversation: "3", server: "File-Store", uri: "file:///a.txt" },
    ]);
    expect(JSON.stringify(result.output)).toContain("Watching this resource");

    await watching.run({ server: "file_store", uri: "file:///a.txt", watch: false });
    expect(kept.ended).toEqual([["3", [{ server: "File-Store", uri: "file:///a.txt" }]]]);
  });

  it("records nothing for a read that did not ask to watch", async () => {
    const kept = recorder();
    const watching = reader(["watches"], kept.watches);

    await watching.run({ server: "file_store", uri: "file:///a.txt" });
    expect(kept.started).toEqual([]);
    expect(kept.ended).toEqual([]);
  });
});

describe("the notice of what the watches found", () => {
  const change = (uri: string, more: Partial<McpWatchChange> = {}): McpWatchChange => ({
    server: "docs",
    uri,
    subUris: [],
    unchecked: false,
    ...more,
  });

  it("is empty with no news", () => {
    expect(watchesNotice({ changes: [], ends: [] })).toBe("");
  });

  it("names URIs only, changed ones first, and why each ended", () => {
    const text = watchesNotice({
      changes: [change("file:///a.md", { subUris: ["file:///a/1"], unchecked: true })],
      ends: [{ server: "docs", uri: "file:///b.md", reason: "server changed" }],
    });

    expect(text).toContain("docs: file:///a.md (could not be checked; may have changed)");
    expect(text).toContain("under it: file:///a/1");
    expect(text).toContain("docs: file:///b.md (server changed)");
    expect(text.indexOf("Changed")).toBeLessThan(text.indexOf("Ended"));
  });

  it("names at most 20 entries and 3 sub-resources of each, and counts the rest", () => {
    const changes = Arr.makeBy(25, (index) =>
      change(`file:///${index}`, { subUris: ["s1", "s2", "s3", "s4", "s5"] }),
    );

    const text = watchesNotice({
      changes,
      ends: [{ server: "docs", uri: "file:///gone", reason: "server changed" }],
    });

    expect(text.match(/^- /gm)).toHaveLength(MAX_NOTICE_ENTRIES);
    expect(text.match(/under it/g)).toHaveLength(MAX_NOTICE_ENTRIES * MAX_NOTICE_SUB_URIS);
    expect(text).toContain("6 more not listed.");
    expect(text).not.toContain("file:///gone");
  });
});

describe("a request start's news of the watches", () => {
  const news = {
    changed: ["file:///a.md"],
    ended: ["file:///b.md"],
    changes: [{ server: "docs", uri: "file:///a.md", subUris: [], unchecked: false }],
    ends: [{ server: "docs", uri: "file:///b.md", reason: "signed out" }],
  };

  const started = (kept: McpWatchRecorder, host = fakeMcpHost([FILES])) => {
    const written: Array<{ conversation: number; text: string }> = [];
    const tools = makeMcpTools(host.client, undefined, { watches: kept });

    tools.bindNotices({
      check: async () => [],
      conversations: async () => [],
      watches: async (input) => {
        written.push({ conversation: Number(input.conversation), text: input.text });
      },
    });

    return { host, tools, written };
  };

  it("writes one notice to the conversation and drops the ended watches from the Session's list", async () => {
    const kept = recorder();
    const { host, tools, written } = started(kept.watches);

    host.watches(news);
    await Effect.runPromise(
      tools.requestStart(
        startOf(1, { caller: { session: "s1", conversation: "4", workspace: "ws:w1" } }),
      ),
    );

    expect(kept.ended).toEqual([["4", news.ends]]);
    expect(written).toHaveLength(1);
    expect(written[0]?.conversation).toBe(4);
    expect(written[0]?.text).toContain("file:///a.md");
    expect(written[0]?.text).toContain("file:///b.md");
  });

  it("writes nothing when the host has no news", async () => {
    const kept = recorder();
    const { tools, written } = started(kept.watches);

    await Effect.runPromise(tools.requestStart(startOf(1)));
    expect(written).toEqual([]);
    expect(kept.ended).toEqual([]);
  });

  it("calls the host for a conversation that still watches though the set has no server", async () => {
    const { host, tools } = started(recorder().watches);

    await Effect.runPromise(tools.requestStart(startOf(0)));
    expect(host.calls).toEqual([]);

    await Effect.runPromise(tools.requestStart(startOf(0, { watching: true })));
    expect(host.calls.map((each) => each.method)).toContain("requestStart");
  });
});

describe("the watches of a conversation during a Run", () => {
  const news = {
    changed: ["file:///a.md"],
    ended: [],
    changes: [{ server: "Docs-Site", uri: "file:///a.md", subUris: [], unchecked: false }],
    ends: [],
  };

  const quiet = { changed: [], ended: [] };
  const DOCS: FakeMcpServer = { name: "Docs-Site", exposure: "direct", resources: true, tools: [] };

  const root = String(ROOT_CONVERSATION_ID);

  /** The host calls a conversation's model request made, not a request start's: no Workspace. */
  const touches = (host: ReturnType<typeof fakeMcpHost>) =>
    Arr.flatMap(host.calls, (each) =>
      each.method === "requestStart" && each.input.caller.workspace === "" ? [each.input] : [],
    );

  /**
   * A Harness whose `mcp` extension is installed as the Session's request start does, the root having made its start; with
   * `restarted`, as a Session that restarted does: the tools are built again from what the first kept, and no request
   * start has been made since.
   */
  const opened = async (
    host: ReturnType<typeof fakeMcpHost>,
    kept: ReturnType<typeof recorder>,
    watchTouchMs: number,
    script: Parameters<typeof openSubagentHarness>[0],
    restarted = false,
    /** The client the tools touch the host with after the first request start. */
    touching: McpHostClientService = host.client,
    more: Partial<McpToolOptions> = {},
  ) => {
    const session = await openSubagentHarness(script);
    const store = memoryMcpToolsStore();
    const options = { watches: kept.watches, watchTouchMs, session: "s1", ...more };
    const first = makeMcpTools(host.client, store, options);

    await Effect.runPromise(
      first.requestStart(
        startOf(1, { caller: { session: "s1", conversation: root, workspace: "ws:w1" } }),
      ),
    );

    // What a Session's install keeps, which the restarted tools are built from.
    if (restarted) first.reinstall([]);

    const mcp = restarted ? makeMcpTools(touching, store, options) : first;

    mcp.bindNotices(mcpNotices(session.harness));
    Option.map(mcp.reinstall([]), ({ mcp: built }) => session.registry.install(built));
    // Each build's request starts are counted from here: the hook's are what the tests look at.
    host.calls.length = 0;

    return session;
  };

  const watchNotices = async (
    session: { entries: (id: ConversationId) => Promise<EntryRecord[]> },
    id: ConversationId,
  ) =>
    Arr.filter(await session.entries(id), (entry: EntryRecord) => entry.kind === MCP_WATCHES_KIND);

  const text = (entry: EntryRecord | undefined) => JSON.stringify(entry?.model ?? []);

  it("holds the watches and tells their news before a model request, though the Run makes no request start", async () => {
    const host = fakeMcpHost([DOCS]);
    const kept = recorder();
    let requests = 0;

    kept.hold(root);

    const session = await opened(host, kept, 0, async () => {
      requests += 1;

      if (requests === 1) host.watches(news);

      if (requests === 2) host.watches(quiet);

      return requests < 3 ? call(["read", { path: "a.txt" }]) : answer("Done.");
    });

    await session.prompt("Go");

    // Each model request after the first touched the host for the conversation, with the Session, and no Workspace.
    expect(touches(host).length).toBeGreaterThanOrEqual(2);
    expect(touches(host)[0]?.caller).toEqual({ session: "s1", conversation: root, workspace: "" });

    // The news came as one notice, which the Run's last request carried.
    const notices = await watchNotices(session, ROOT_CONVERSATION_ID);

    expect(notices).toHaveLength(1);
    expect(text(notices[0])).toContain("file:///a.md");
    expect(JSON.stringify(session.requests.at(-1)?.messages)).toContain("file:///a.md");
  });

  it("leaves a conversation with no watch alone", async () => {
    const host = fakeMcpHost([DOCS]);
    const kept = recorder();

    const session = await opened(host, kept, 0, async () => answer("ok"));

    await session.prompt("Go");

    expect(touches(host)).toEqual([]);
  });

  it("touches at most once in the throttle, so a Run of many requests does not call the host for each", async () => {
    const host = fakeMcpHost([DOCS]);
    const kept = recorder();
    let requests = 0;

    kept.hold(root);

    const session = await opened(host, kept, 60_000, async () => {
      requests += 1;

      return requests < 5 ? call(["read", { path: "a.txt" }]) : answer("Done.");
    });

    await session.prompt("Go");

    expect(requests).toBe(5);
    expect(touches(host)).toEqual([]);
  });

  it("touches in a Session that restarted and made no request start yet", async () => {
    const host = fakeMcpHost([DOCS]);
    const kept = recorder();
    let requests = 0;

    kept.hold(root);

    const session = await opened(
      host,
      kept,
      0,
      async () => {
        requests += 1;

        if (requests === 1) host.watches(news);

        if (requests === 2) host.watches(quiet);

        return requests < 3 ? call(["read", { path: "a.txt" }]) : answer("Done.");
      },
      true,
    );

    await session.prompt("Go");

    expect(touches(host)[0]?.caller).toEqual({ session: "s1", conversation: root, workspace: "" });
    expect(await watchNotices(session, ROOT_CONVERSATION_ID)).toHaveLength(1);
  });

  it("does not make a model request wait long on a host that does not answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const host = fakeMcpHost([DOCS]);
      const kept = recorder();

      kept.hold(root);

      // The host never answers a touch.
      const hung: McpHostClientService = {
        ...host.client,
        requestStart: () => Effect.never,
      };

      const session = await opened(host, kept, 0, async () => answer("ok"), true, hung);

      const run = session.prompt("Go");

      await vi.advanceTimersByTimeAsync(6000);
      await run;
      expect(session.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the hook's Effect through the `run` it is given", async () => {
    const host = fakeMcpHost([DOCS]);
    const kept = recorder();
    let runs = 0;

    kept.hold(root);

    const session = await opened(host, kept, 0, async () => answer("ok"), false, host.client, {
      run: (effect) => {
        runs += 1;

        return Effect.runPromise(effect);
      },
    });

    await session.prompt("Go");

    expect(runs).toBe(1);
    expect(touches(host)).toHaveLength(1);
  });

  it("forgets a conversation's last touch once it holds no watch, so a watch it starts later is touched at once", async () => {
    const host = fakeMcpHost([DOCS]);
    const kept = recorder();
    let requests = 0;

    kept.hold(root);

    // The request start made the first touch, a minute ago at most: the throttle is far longer.
    const session = await opened(host, kept, 60_000, async () => {
      requests += 1;

      // The watch ends in the first request, and one is started again in the second.
      if (requests === 1) kept.release(root);

      if (requests === 2) kept.hold(root);

      return requests < 3 ? call(["read", { path: "a.txt" }]) : answer("Done.");
    });

    await session.prompt("Go");

    // Request 1 was throttled, 2 had no watch (and dropped the touch), 3 touched at once for the new watch.
    expect(requests).toBe(3);
    expect(touches(host)).toHaveLength(1);
  });

  it("is built only with a recorder: a Session that records no watch has no hook", () => {
    const host = fakeMcpHost([DOCS]);

    expect(mcpExtension({ servers: [], offered: [] }, host.client, {}, {}).hooks).toEqual([]);
  });

  it("holds and tells a subagent's watches, which makes no request start of its own", async () => {
    const host = fakeMcpHost([DOCS]);
    const kept = recorder();
    let childRequests = 0;
    let held: Awaited<ReturnType<typeof opened>> | undefined;

    const session = await opened(host, kept, 0, async (request) => {
      if (request.agent === "agent-1") {
        childRequests += 1;

        if (childRequests === 1) {
          // The child started a watch with its first read: it holds it, and the host has news of it.
          const id = (await held?.state())?.agents["agent-1"]?.conversationId;

          kept.hold(String(id));
          host.watches(news);
        }

        if (childRequests === 2) host.watches(quiet);

        return childRequests < 3 ? call(["read", { path: "a.txt" }]) : answer("Done.");
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "Work" }]);

      return answer("Noted.");
    });

    held = session;
    await session.prompt("Delegate it");
    await session.settle();

    const child = (await session.state()).agents["agent-1"]!.conversationId;

    // Only the child held a watch: its model requests touched the host for it, and the root's did not.
    expect(touches(host).length).toBeGreaterThanOrEqual(1);
    expect(Arr.every(touches(host), (each) => each.caller.conversation === String(child))).toBe(
      true,
    );

    const notices = await watchNotices(session, child);

    expect(notices).toHaveLength(1);
    expect(text(notices[0])).toContain("file:///a.md");
    expect(await watchNotices(session, ROOT_CONVERSATION_ID)).toEqual([]);
  });
});
