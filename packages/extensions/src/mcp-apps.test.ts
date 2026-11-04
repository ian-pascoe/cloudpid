// MCP Apps in the `mcp` extension (`docs/architecture/mcp-apps.md` → Declaring and reading Apps, App records): an
// `["app"]`-only tool is never declared to the model, whatever its Exposure or `tools.offered` says; a completed call of an
// App tool, direct or nested in `codemode`, hands the recorder its draft; the inventory's App tools; and the page of a
// record through the host's `ui/html`. pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off missingPipeableSignature:off
import {
  HostUnsupported,
  type JsonObject,
  McpHostAppHtml,
  McpHostCallFailed,
  McpHostCompleted,
  NoAppHtml,
  TimedOut,
} from "@cloudpid/mcp/types";
import { MAX_MCP_APP_SCHEMA_BYTES, type McpAppDraft, type McpAppTool } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { build, DOCS, open, results, startOf } from "./mcp.fixture.ts";
import { makeMcpTools, type McpAppRecorder } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { answer, call } from "./subagents/harness.fixture.ts";

const PAGE = "ui://docs/page";

/** A server with a model-visible App tool, an App tool only the App sees, a plain tool, and an App tool for both. */
const appServer = (more: Partial<FakeMcpServer> = {}): FakeMcpServer => ({
  ...DOCS,
  exposure: "direct",
  toolExposure: {},
  tools: [
    { name: "page", description: "Show a page", _meta: { ui: { resourceUri: PAGE } } },
    {
      name: "refresh",
      description: "The page's own refresh",
      _meta: { ui: { resourceUri: PAGE, visibility: ["app"] } },
    },
    {
      name: "both",
      description: "Both see it",
      _meta: { ui: { resourceUri: PAGE, visibility: ["model", "app"] } },
    },
    { name: "plain", description: "No App" },
  ],
  ...more,
});

/** A recorder that keeps what it is given. */
const recorder = (options: { readonly fails?: boolean } = {}) => {
  const drafts: McpAppDraft[] = [];
  const told: Array<ReadonlyArray<McpAppTool>> = [];

  const apps: McpAppRecorder = {
    put: (draft) =>
      options.fails === true
        ? Effect.die(new Error("storage is full"))
        : Effect.sync(() => {
            drafts.push(draft);
          }),
    setTools: (tools) => {
      told.push(tools);
    },
  };

  return { apps, drafts, told };
};

const completed = (value: JsonObject, htmlHash?: string, viewHash?: string) =>
  htmlHash === undefined
    ? McpHostCompleted.make({ result: { kind: "inline", value } })
    : McpHostCompleted.make({
        result: { kind: "inline", value },
        app: viewHash === undefined ? { htmlHash } : { htmlHash, viewHash },
      });

describe("an app-only tool", () => {
  it("is never declared to the model, in any Exposure, and tools.offered cannot lift it", async () => {
    for (const exposure of ["direct", "deferred", "codemode", "codemode-deferred"]) {
      for (const offered of [[], ["mcp__*"], ["mcp__docs_site__refresh"], ["mcp__docs_site__*"]]) {
        const host = fakeMcpHost([
          appServer({ exposure, toolExposure: { refresh: "direct", both: "codemode" } }),
        ]);

        const built = Option.getOrThrow(
          await build(makeMcpTools(host.client), startOf(1, { offered })),
        );

        const names = (built.tools ?? []).map((tool) => tool.name);

        expect(names, `${exposure} ${offered.join()}`).not.toContain("mcp__docs_site__refresh");
        // The tools the model may see are declared as before.
        expect(names).toContain("mcp__docs_site__page");
        expect(names).toContain("mcp__docs_site__both");
      }
    }
  });

  it("is not declared to a conversation's request either", async () => {
    const host = fakeMcpHost([appServer()]);
    const session = await open(() => answer("ok"));

    await session.start(makeMcpTools(host.client));
    await session.prompt("hello");

    const [first] = session.requests;

    expect(first?.tools).toContain("mcp__docs_site__page");
    expect(first?.tools).not.toContain("mcp__docs_site__refresh");
  });

  it("tells the page each App tool's input schema for the View's toolInfo, within its bounds", async () => {
    const schema = { type: "object", properties: { slug: { type: "string" } } };
    const huge = { type: "object", description: "x".repeat(MAX_MCP_APP_SCHEMA_BYTES) };

    const host = fakeMcpHost([
      appServer({
        tools: [
          { name: "page", _meta: { ui: { resourceUri: PAGE } }, inputSchema: schema },
          { name: "big", _meta: { ui: { resourceUri: PAGE } }, inputSchema: huge },
          { name: "none", _meta: { ui: { resourceUri: PAGE } } },
        ],
      }),
    ]);

    const { apps, told } = recorder();

    await build(makeMcpTools(host.client, undefined, { apps }));

    const schemas = told.at(-1)?.map((tool) => tool.inputSchema);

    // The one that fits, not the one over the cap, and the host's own default for the one that declares none.
    expect(schemas).toEqual([schema, undefined, { type: "object" }]);
  });

  it("is still an App tool the page is told of, with its visibility", async () => {
    const host = fakeMcpHost([appServer(), { ...appServer(), name: "off", state: "disabled" }]);
    const { apps, told } = recorder();
    const tools = makeMcpTools(host.client, undefined, { apps });

    await build(tools);

    expect(told.at(-1)).toEqual([
      {
        name: "mcp__docs_site__page",
        server: "Docs-Site",
        tool: "page",
        uri: PAGE,
        inputSchema: { type: "object" },
        visibility: ["model", "app"],
      },
      {
        name: "mcp__docs_site__refresh",
        server: "Docs-Site",
        tool: "refresh",
        uri: PAGE,
        inputSchema: { type: "object" },
        visibility: ["app"],
      },
      {
        name: "mcp__docs_site__both",
        server: "Docs-Site",
        tool: "both",
        uri: PAGE,
        inputSchema: { type: "object" },
        visibility: ["model", "app"],
      },
    ]);
  });

  it("makes no App tools of a Session without servers", async () => {
    const host = fakeMcpHost([]);
    const { apps, told } = recorder();
    const tools = makeMcpTools(host.client, undefined, { apps });

    await build(tools, startOf(0));

    expect(told).toEqual([]);
  });
});

describe("the record of an App call", () => {
  const callPage = async (
    reply: Parameters<ReturnType<typeof fakeMcpHost>["answer"]>[0],
    options: { readonly features?: ReadonlyArray<string>; readonly fails?: boolean } = {},
    tool = "mcp__docs_site__page",
  ) => {
    const host = fakeMcpHost([appServer()]);
    const kept = recorder(options);
    const tools = makeMcpTools(host.client, undefined, { apps: kept.apps });

    if (options.features !== undefined) host.features(options.features);

    host.answer(reply);

    const session = await open((request) =>
      request.text === "go" ? call([tool, { slug: "intro" }]) : answer("ok"),
    );

    await session.start(tools);
    await session.prompt("go");

    return { ...kept, host, session };
  };

  it("holds the whole result, the arguments, the page's hash and who called", async () => {
    const result = {
      content: [{ type: "text", text: "A page" }],
      structuredContent: { title: "Intro" },
      _meta: { view: "wide" },
    };

    const { drafts, session } = await callPage(async () => completed(result, "hash-1"));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      callId: expect.any(String),
      server: "Docs-Site",
      tool: "page",
      conversation: "1",
      arguments: { slug: "intro" },
      htmlHash: "hash-1",
      result,
    });
    // The model's own result is as it was.
    expect(await session.texts("toolResult")).toEqual(["A page"]);
  });

  it("pins what named its server's origin, when the host said, so a shadowed server is not mistaken for it", async () => {
    const { drafts } = await callPage(async () => completed({ content: [] }, "hash-1", "view-1"));

    expect(drafts[0]).toMatchObject({ htmlHash: "hash-1", viewHash: "view-1" });
  });

  it("records an isError result too, and no call that did not complete", async () => {
    const error = { content: [{ type: "text", text: "no page" }], isError: true };
    const bad = await callPage(async () => completed(error));

    expect(bad.drafts.map((draft) => draft.result)).toEqual([error]);

    const failed = await callPage(async () =>
      McpHostCallFailed.make({ error: TimedOut.make({ message: "too slow" }) }),
    );

    expect(failed.drafts).toEqual([]);
  });

  it("records no call of a tool without an App", async () => {
    const { drafts } = await callPage(
      async () => completed({ content: [{ type: "text", text: "x" }] }, "hash-1"),
      {},
      "mcp__docs_site__plain",
    );

    expect(drafts).toEqual([]);
  });

  it("keeps the page's hash only when the host lists app_html", async () => {
    const { drafts } = await callPage(async () => completed({ content: [] }, "hash-1"), {
      features: ["inventory", "call"],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).not.toHaveProperty("htmlHash");
  });

  it("never fails the call for a record that could not be kept", async () => {
    const { session, drafts } = await callPage(
      async () => completed({ content: [{ type: "text", text: "A page" }] }, "hash-1"),
      { fails: true },
    );

    expect(drafts).toEqual([]);
    expect(await results(session)).toEqual([[false, [{ type: "text", text: "A page" }]]]);
  });

  it("records a call nested in a codemode script with the script's call as its parent", async () => {
    const host = fakeMcpHost([appServer()]);
    const kept = recorder();
    const tools = makeMcpTools(host.client, undefined, { apps: kept.apps });

    host.answer(async () => completed({ content: [{ type: "text", text: "A page" }] }, "hash-2"));

    const session = await open((request) =>
      request.text === "go"
        ? call([
            "codemode",
            { code: `await tools.mcp__docs_site__page({ slug: "a" }); text("done");` },
          ])
        : answer("ok"),
    );

    await session.start(tools, startOf(1, { offered: ["codemode"] }));
    await session.prompt("go");

    expect(kept.drafts).toHaveLength(1);

    const [draft] = kept.drafts;

    expect(draft?.parentCall).toEqual(expect.any(String));
    expect(draft?.callId.startsWith(`${draft?.parentCall}/`)).toBe(true);
    expect(draft?.conversation).toBe("1");
    expect(draft?.htmlHash).toBe("hash-2");
  });
});

describe("the record of a subagent's App call", () => {
  it("is the child's own: its conversation is the child's, not the root's", async () => {
    const host = fakeMcpHost([appServer()]);
    const kept = recorder();
    const tools = makeMcpTools(host.client, undefined, { apps: kept.apps });
    let childTurns = 0;

    host.answer(async () => completed({ content: [{ type: "text", text: "A page" }] }, "hash-3"));

    const session = await open((request) => {
      if (request.agent === "root") {
        return request.text === "go" ? call(["subagent", { task: "Show the page" }]) : answer("ok");
      }

      childTurns += 1;

      return childTurns === 1 ? call(["mcp__docs_site__page", { slug: "intro" }]) : answer("shown");
    });

    await session.start(tools, startOf(1, { offered: ["subagent*", "mcp__docs_site__page"] }));
    await session.prompt("go");
    await session.settle();

    const child = (await session.state()).agents["agent-1"]!.conversationId;

    expect(kept.drafts).toHaveLength(1);
    expect(kept.drafts[0]).toMatchObject({ tool: "page", conversation: String(child) });
    expect(kept.drafts[0]?.conversation).not.toBe("1");
  });
});

describe("a ui:// resource link in a result", () => {
  it("is a link as any other: the model's line and a chip, and it mounts no App and writes no record", async () => {
    const host = fakeMcpHost([appServer()]);
    const kept = recorder();
    const tools = makeMcpTools(host.client, undefined, { apps: kept.apps });

    host.answer(async () =>
      completed({
        content: [{ type: "resource_link", uri: "ui://docs/other", name: "other" }],
      }),
    );

    const session = await open((request) =>
      request.text === "go" ? call(["mcp__docs_site__plain", {}]) : answer("ok"),
    );

    await session.start(tools);
    await session.prompt("go");

    const content = (await results(session)).flatMap(([, blocks]) => blocks);

    expect(JSON.stringify(content)).toContain('Resource ui://docs/other \\"other\\"');
    expect(kept.drafts).toEqual([]);
  });
});

describe("the page of an App record", () => {
  const html = McpHostAppHtml.make({
    hash: "h1",
    html: "<p>hi</p>",
    meta: { prefersBorder: true },
  });

  const input = { server: "Docs-Site", hash: "h1", callId: "c1", conversation: "1" };

  const started = async (features?: ReadonlyArray<string>) => {
    const host = fakeMcpHost([appServer()]);
    const tools = makeMcpTools(host.client);

    if (features !== undefined) host.features(features);

    await build(tools);

    return { host, tools };
  };

  it("is served through ui/html as the App's own request, with the hash", async () => {
    const { host, tools } = await started();

    host.answer(async () => html);

    expect(await Effect.runPromise(tools.appHtml(input))).toEqual({
      status: "html",
      hash: "h1",
      html: "<p>hi</p>",
      meta: { prefersBorder: true },
    });

    const sent = host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

    expect(sent).toEqual([
      {
        op: "ui/html",
        server: "Docs-Site",
        params: { hash: "h1" },
        ctx: expect.objectContaining({ origin: "app", callId: "c1", conversation: "1" }),
      },
    ]);
  });

  it("carries the host's view hash on, for the Session to build the page's origin", async () => {
    const { host, tools } = await started();

    host.answer(async () =>
      McpHostAppHtml.make({ ...html, viewHash: "abcdefghijklmnopqrstuvwxyz" }),
    );

    expect(await Effect.runPromise(tools.appHtml(input))).toEqual({
      status: "html",
      hash: "h1",
      html: "<p>hi</p>",
      meta: { prefersBorder: true },
      view: "abcdefghijklmnopqrstuvwxyz",
    });
  });

  it("says missing for a page the host no longer keeps, and unsupported for a host that cannot serve it", async () => {
    const { host, tools } = await started();

    host.answer(async () => NoAppHtml.make({ message: "evicted" }));
    expect(await Effect.runPromise(tools.appHtml(input))).toEqual({
      status: "missing",
      message: "evicted",
    });

    // The backstop: a host that lists the feature and still does not know the op.
    host.answer(async () => HostUnsupported.make({ message: "no ui/html", op: "ui/html" }));
    expect(await Effect.runPromise(tools.appHtml(input))).toEqual({
      status: "unsupported",
      message: "no ui/html",
    });
  });

  it("is never asked of a host that does not list app_html", async () => {
    const { host, tools } = await started(["inventory", "call"]);

    host.answer(async () => html);

    expect(await Effect.runPromise(tools.appHtml(input))).toMatchObject({ status: "unsupported" });
    expect(host.calls.filter((each) => each.method === "request")).toEqual([]);
  });
});
