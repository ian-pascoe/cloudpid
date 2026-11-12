// What the model and scripts get for an MCP tool's call, and how a call ends (`docs/architecture/mcp-in-a-session.md` →
// Calls and results): text, images and Result Spills, `details`, the value a script gets and the rules for an invalid
// `structuredContent`, cuts, results over 1 MiB read from a stream, `replay: "safe"` with the `mcp.sent` marker.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off preferEffectRecord:off nodeBuiltinImport:off -- real files in a temporary directory.
import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Cut,
  HostFailed,
  type JsonObject,
  McpHostCallFailed,
  McpHostCompleted,
  type McpStructuredOutput,
  TimedOut,
  TooLarge,
} from "@cloudpid/mcp/types";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { ImageContent, JsonValue as DetailsValue, TextContent } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DOCS, detailsOf, open, results, startOf } from "./mcp.fixture.ts";
import { makeMcpTools, mcpExtension } from "./mcp.ts";
import type { McpToolOptions } from "./mcp/tools.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

/** The one item of `items`. */
const only = <A>(items: ReadonlyArray<A>): A => {
  expect(items).toHaveLength(1);

  return Option.getOrThrow(Arr.head(items));
};

/** The lines of text in a result's content. */
const linesOf = (content: ReadonlyArray<ImageContent | TextContent>): ReadonlyArray<string> =>
  Arr.flatMap(content, (block) => (block.type === "text" ? [block.text] : []));

const SpillDetails = Schema.Struct({ full_output_path: Schema.String });

/** The Result Spill a call's `details` name. */
const spillOf = (details: DetailsValue | undefined): string =>
  Option.getOrThrow(Schema.decodeUnknownOption(SpillDetails)(details)).full_output_path;

/** The `details` of the one tool result. */
const detailOf = async (session: Awaited<ReturnType<typeof open>>) =>
  only(await detailsOf(session));

/** A tool of the fake server, with what the test sets of it. */
type Tool = FakeMcpServer["tools"][number];

/** A server with one tool, `search`, that `tool` adds to. */
const server = (tool: Partial<Tool> = {}): FakeMcpServer => ({
  ...DOCS,
  tools: [{ name: "search", description: "Search the docs", ...tool }],
});

type Reply = Parameters<ReturnType<typeof fakeMcpHost>["answer"]>[0];

/** A completed call with `value` inline, and the engine's check of its `structuredContent`. */
const completed = (value: JsonObject, structuredOutput?: McpStructuredOutput) =>
  structuredOutput === undefined
    ? McpHostCompleted.make({ result: { kind: "inline", value } })
    : McpHostCompleted.make({ result: { kind: "inline", value }, structuredOutput });

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The Node environment, whose temporary directories (its Result Spills') are removed after the test too. */
class SweptEnv extends NodeExecutionEnv {
  override async createTempDir(...args: Parameters<NodeExecutionEnv["createTempDir"]>) {
    const made = await super.createTempDir(...args);

    if (made.ok) roots.push(made.value);

    return made;
  }
}

/** The model calls `search` `count` times; the host answers with `reply`, and the Session has a file system. */
const calling = async (
  reply: Reply,
  tool: Partial<Tool> = {},
  count = 1,
  options: McpToolOptions = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-results-"));
  roots.push(directory);
  const host = fakeMcpHost([server(tool)]);
  const tools = makeMcpTools(host.client, undefined, options);

  host.answer(reply);

  const session = await open(
    (request) =>
      request.text === "go"
        ? call(...Arr.makeBy(count, () => ["mcp__docs_site__search", {}] as const))
        : answer("ok"),
    () => new SweptEnv({ cwd: directory }),
  );

  await session.start(tools);
  await session.prompt("go");

  return { host, session, directory };
};

describe("the text and images the model gets", () => {
  it("maps text, images, placeholder lines, a link and an embedded resource's text", async () => {
    const { session } = await calling(async () =>
      completed({
        content: [
          { type: "text", text: "found 2" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
          { type: "video", data: "AAAA" },
          {
            type: "resource_link",
            uri: "file:///a.md",
            name: "a",
            title: "Notes",
            mimeType: "text/markdown",
            size: 2048,
            description: "The notes",
          },
          { type: "resource", resource: { uri: "file:///b.txt", text: "inline text" } },
          {
            type: "resource",
            resource: { uri: "file:///c.png", blob: "aGk=", mimeType: "image/png" },
          },
        ],
      }),
    );

    expect(await results(session)).toEqual([
      [
        false,
        [
          { type: "text", text: "found 2" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "text", text: "[audio content (audio/mpeg) omitted]" },
          { type: "text", text: "[video content omitted]" },
          {
            type: "text",
            text: '[Resource file:///a.md "Notes" (text/markdown, 2.0KB): The notes]',
          },
          { type: "text", text: "inline text" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      ],
    ]);
  });

  it("saves an image no provider takes and a binary resource to a Result Spill, and says where", async () => {
    const { session } = await calling(async () =>
      completed({
        content: [
          { type: "image", data: "PHN2Zy8+", mimeType: "image/svg+xml" },
          {
            type: "resource",
            resource: { uri: "file:///report.pdf", blob: "JVBERi0x", mimeType: "application/pdf" },
          },
        ],
      }),
    );

    const [, content] = only(await results(session));
    const [image = "", report = ""] = linesOf(content);
    const pathIn = (line: string) => /saved to (.+)\]$/.exec(line)?.[1] ?? "";

    expect(image).toMatch(/^\[Image \(image\/svg\+xml, 6B\) saved to /);
    expect(report).toMatch(
      /^\[Binary resource file:\/\/\/report\.pdf \(application\/pdf, 6B\) saved to .+\.pdf\]$/,
    );
    expect(await readFile(pathIn(image), "utf8")).toBe("<svg/>");
    expect(await readFile(pathIn(report), "utf8")).toBe("%PDF-1");
  });

  it("keeps the head of text over the limits and writes the whole to a Result Spill named in details", async () => {
    const text = Arr.makeBy(5000, (line) => `line ${line}`).join("\n");

    const { session } = await calling(async () => completed({ content: [{ type: "text", text }] }));

    const [isError, content] = only(await results(session));
    const [shown = ""] = linesOf(content);

    expect(isError).toBe(false);
    expect(shown.startsWith("line 0\nline 1\n")).toBe(true);
    expect(shown.length).toBeLessThan(text.length);
    // The model is told what was cut, in pi-durable's words for any tool's output.
    expect(linesOf(content).join("\n")).toContain(
      `Output truncated to its beginning: 3000 lines, ${String(text.length - shown.length)} bytes dropped`,
    );
    expect(await readFile(spillOf(await detailOf(session)), "utf8")).toBe(text);
  });

  it("tells the model that nothing was saved when the Session has no file system", async () => {
    const host = fakeMcpHost([server()]);
    const tools = makeMcpTools(host.client);

    host.answer(async () =>
      completed({ content: [{ type: "resource", resource: { uri: "u.bin", blob: "AAAA" } }] }),
    );

    const session = await open((request) =>
      request.text === "go" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
    );

    await session.start(tools);
    await session.prompt("go");

    const [, content] = only(await results(session));

    expect(content).toEqual([
      {
        type: "text",
        text: "[Binary resource u.bin (unknown type, 3B) could not be saved: this Session has no file system]",
      },
    ]);
  });

  it("gives structuredContent as JSON when there is no content, and an error with no text pi's message", async () => {
    const { session } = await calling(async () =>
      completed({ content: [], structuredContent: { count: 2 } }),
    );

    expect(await results(session)).toEqual([[false, [{ type: "text", text: '{"count":2}' }]]]);

    const failing = await calling(async () => completed({ content: [], isError: true }));

    expect(await results(failing.session)).toEqual([
      [true, [{ type: "text", text: "MCP tool Docs-Site/search returned an error" }]],
    ]);
  });
});

describe("details", () => {
  it("carries the tool, its title, its four hints as badges and its _meta", async () => {
    const { session } = await calling(
      async () => completed({ content: [{ type: "text", text: "ok" }] }),
      {
        annotations: {
          title: "Search the docs",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          audience: "x",
        },
        _meta: { ui: { resourceUri: "ui://docs/search" } },
      },
    );

    expect(await detailsOf(session)).toEqual([
      {
        server: "Docs-Site",
        tool: "search",
        title: "Search the docs",
        hints: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        meta: { ui: { resourceUri: "ui://docs/search" } },
      },
    ]);
  });
});

/** What a `codemode` script printed with `text()`, after the lines codemode puts before it, for each result. */
const printed = async (session: Awaited<ReturnType<typeof open>>) =>
  Arr.map(
    await results(session),
    ([isError, content]) =>
      [
        isError,
        Arr.join(linesOf(content), "").split("Output:\n").slice(1).join("Output:\n"),
      ] as const,
  );

/** Opens a Session whose model runs `code` in `codemode` against the one tool, answered by `reply`. */
const scripted = async (code: string, reply: Reply, tool: Partial<Tool> = {}) => {
  const host = fakeMcpHost([server(tool)]);
  const tools = makeMcpTools(host.client);

  host.answer(reply);

  const session = await open((request) =>
    request.text === "go" ? call(["codemode", { code }]) : answer("ok"),
  );

  await session.start(tools, startOf(1, { offered: ["codemode"] }));
  await session.prompt("go");

  return { host, session };
};

const Printed = Schema.fromJsonString(
  Schema.Struct({
    value: Schema.optionalKey(Schema.Json),
    truncated: Schema.optionalKey(Schema.Boolean),
    small: Schema.optionalKey(Schema.String),
    big: Schema.optionalKey(Schema.Finite),
  }),
);

const decodePrinted = (text: string) => Option.getOrThrow(Schema.decodeOption(Printed)(text));

describe("the value a script gets", () => {
  it("is { content, structuredContent, isError } without _meta, and an isError result resolves", async () => {
    let next = 0;

    const { session } = await scripted(
      `const ok = await tools.mcp__docs_site__search({});
       const bad = await tools.mcp__docs_site__search({});
       text(JSON.stringify({ value: [ok, bad] }));`,
      async () =>
        completed(
          next++ === 0
            ? {
                content: [{ type: "text", text: "two" }],
                structuredContent: { count: 2 },
                _meta: { secret: "x" },
              }
            : { content: [{ type: "text", text: "no page" }], isError: true },
        ),
      { outputSchema: { type: "object", properties: { count: { type: "number" } } } },
    );

    const [isError, out] = only(await printed(session));

    expect(isError).toBe(false);
    expect(decodePrinted(out).value).toEqual([
      { content: [{ type: "text", text: "two" }], structuredContent: { count: 2 } },
      { content: [{ type: "text", text: "no page" }], isError: true },
    ]);
  });

  it("cuts the text largest-first to fit a nested call's value, and says so with truncated: true", async () => {
    const { session } = await scripted(
      `const r = await tools.mcp__docs_site__search({});
       text(JSON.stringify({ truncated: r.truncated, small: r.content[0].text, big: r.content[1].text.length }));`,
      async () =>
        completed({
          content: [
            { type: "text", text: "small" },
            { type: "text", text: "x".repeat(2 * 1024 * 1024) },
          ],
        }),
    );

    const [isError, out] = only(await printed(session));
    const seen = decodePrinted(out);

    expect(isError).toBe(false);
    expect(seen.truncated).toBe(true);
    expect(seen.small).toBe("small");
    expect(seen.big).toBeLessThan(1536 * 1024);
    expect(seen.big).toBeGreaterThan(1024 * 1024);
  });

  it("fails a nested call whose structuredContent the engine found invalid, and keeps a model call's text", async () => {
    const invalid: McpStructuredOutput = { valid: false, errors: ["/count must be number"] };

    const reply = async () =>
      completed(
        { content: [{ type: "text", text: "count: two" }], structuredContent: { count: "two" } },
        invalid,
      );

    const nested = await scripted(
      `try { await tools.mcp__docs_site__search({}); text("resolved"); } catch (error) { text(String(error.message)); }`,
      reply,
    );

    const failed = only(await printed(nested.session))[1];

    expect(failed).toContain("does not match the tool's outputSchema");
    // pi-durable adds nothing of its own to what the call says.
    expect(failed).not.toContain("returned no structuredOutput");

    const model = await calling(reply);

    // The model keeps its text and is told nothing else: the value is dropped and logged, and details say why.
    expect(await results(model.session)).toEqual([[false, [{ type: "text", text: "count: two" }]]]);
    expect(await detailsOf(model.session)).toEqual([
      expect.objectContaining({ error: "invalid_structured_output" }),
    ]);
  });
});

describe("a call that ends without a result", () => {
  it("says a cut between the host and the engine was lost there, and that the call may have run", async () => {
    const { session } = await calling(async () =>
      McpHostCallFailed.make({
        error: Cut.make({
          message: "The host's connection to the MCP engine was lost",
          mayHaveRun: true,
          lost: "engine",
        }),
      }),
    );

    expect(await results(session)).toEqual([
      [
        true,
        [
          {
            type: "text",
            text: "The call was cut before its answer arrived; it may or may not have run. The host's connection to the MCP engine was lost",
          },
        ],
      ],
    ]);
    expect(await detailsOf(session)).toEqual([expect.objectContaining({ cut: "engine_lost" })]);
  });

  it("reads a cut that did not run, a timeout, a result over 16 MiB and a host that failed", async () => {
    const answers = [
      McpHostCallFailed.make({
        error: Cut.make({ message: "Waited for a slot", mayHaveRun: false }),
      }),
      McpHostCallFailed.make({
        error: TimedOut.make({ message: "The server did not answer in time" }),
      }),
      McpHostCallFailed.make({ error: TooLarge.make({ message: "big", limit: 16 * 1024 * 1024 }) }),
      HostFailed.make({ message: "The MCP host could not read its storage" }),
    ];

    let next = 0;

    const { session } = await calling(
      async () => answers[next++] ?? HostFailed.make({ message: "" }),
      {},
      4,
    );

    expect(Arr.map(await results(session), ([, content]) => content)).toEqual([
      [{ type: "text", text: "Waited for a slot" }],
      [
        {
          type: "text",
          text: "The call timed out: The server did not answer in time. It may or may not have run.",
        },
      ],
      [
        {
          type: "text",
          text: "The tool's result was over 16 MiB and was dropped; the tool may have run.",
        },
      ],
      [{ type: "text", text: "The MCP host could not read its storage" }],
    ]);
    expect(await detailsOf(session)).toEqual([
      expect.not.objectContaining({ cut: expect.anything() }),
      expect.not.objectContaining({ cut: expect.anything() }),
      expect.objectContaining({ error: "too_large" }),
      expect.not.objectContaining({ cut: expect.anything() }),
    ]);
  });
});

/** `json` as the engine's byte stream of a result's JSON: 64 KiB at a time, pulled by the reader. */
const streamOf = (json: string) => {
  const bytes = new TextEncoder().encode(json);
  let offset = 0;

  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        if (offset >= bytes.byteLength) return controller.close();

        controller.enqueue(bytes.slice(offset, offset + 65_536));
        offset += 65_536;
      },
    },
    { highWaterMark: 0 },
  );

  return { body, bytes: bytes.byteLength };
};

describe("a result over 1 MiB", () => {
  it("is read from the engine's stream, its text spilled whole, and a 16 MiB one passes", async () => {
    const text = "0123456789abcdef".repeat(1024 * 1024 - 1024);
    const stream = streamOf(JSON.stringify({ content: [{ type: "text", text }] }));

    expect(stream.bytes).toBeGreaterThan(15 * 1024 * 1024);

    const { session } = await calling(async () =>
      McpHostCompleted.make({ result: { kind: "stream", ...stream } }),
    );

    const [isError, content] = only(await results(session));
    const [shown = ""] = linesOf(content);

    expect(isError).toBe(false);
    expect(shown.startsWith("0123456789abcdef")).toBe(true);
    expect((await readFile(spillOf(await detailOf(session)), "utf8")).length).toBe(text.length);
  });

  it("is a result like any other for a script, cut to fit its value", async () => {
    const stream = streamOf(
      JSON.stringify({ content: [{ type: "text", text: "y".repeat(3 * 1024 * 1024) }] }),
    );

    const { session } = await scripted(
      `const r = await tools.mcp__docs_site__search({}); text(JSON.stringify({ truncated: r.truncated, big: r.content[0].text.length }));`,
      async () => McpHostCompleted.make({ result: { kind: "stream", ...stream } }),
    );

    const [isError, out] = only(await printed(session));
    const seen = decodePrinted(out);

    expect(isError).toBe(false);
    expect(seen.truncated).toBe(true);
    expect(seen.big).toBeLessThan(1536 * 1024);
  });

  it("is lost, as the engine's end of the call, when its stream goes quiet past the idle deadline", async () => {
    const quiet = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });

    const { session } = await calling(
      async () =>
        McpHostCompleted.make({ result: { kind: "stream", body: quiet, bytes: 2_000_000 } }),
      {},
      1,
      { streamIdleMs: 50 },
    );

    expect(only(await results(session))).toEqual([
      true,
      [
        {
          type: "text",
          text: "The tool's result was lost on its way from the MCP engine; the tool may have run.",
        },
      ],
    ]);
    expect(await detailsOf(session)).toEqual([expect.objectContaining({ cut: "engine_lost" })]);
    expect(quiet.locked).toBe(true);
  });

  it("is dropped, as a cut the tool ran in, when it waits for the slot past the deadline that is under the engine's", async () => {
    const { session } = await calling(
      async () => {
        // The first holds the slot, quiet; the second waits for it.
        const quiet = new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
        });

        return McpHostCompleted.make({
          result: { kind: "stream", body: quiet, bytes: 5 * 1024 * 1024 },
        });
      },
      {},
      2,
      { streamIdleMs: 400, streamWaitMs: 40 },
    );

    const texts = (await results(session)).map(([isError, content]) => [
      isError,
      linesOf(content)[0],
    ]);

    expect(texts).toHaveLength(2);
    expect(texts).toContainEqual([
      true,
      expect.stringMatching(
        /dropped unread: the Session was reading other large results.* The tool ran\.$/,
      ),
    ]);
    expect(texts).toContainEqual([
      true,
      expect.stringMatching(/was lost on its way from the MCP engine/),
    ]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({ cut: "engine_lost" }),
      expect.objectContaining({ cut: "engine_lost" }),
    ]);
  });

  it("is lost, as the engine's end of the call, when its stream breaks, and unreadable when it is not JSON", async () => {
    let next = 0;

    const { session } = await calling(
      async () => {
        const broken = new ReadableStream<Uint8Array>({
          pull: (controller) => controller.error(new Error("The result was not read in time")),
        });

        return McpHostCompleted.make({
          result:
            next++ === 0
              ? { kind: "stream", body: broken, bytes: 2_000_000 }
              : { kind: "stream", ...streamOf("not json at all") },
        });
      },
      {},
      2,
    );

    expect(await results(session)).toEqual([
      [
        true,
        [
          {
            type: "text",
            text: "The tool's result was lost on its way from the MCP engine; the tool may have run.",
          },
        ],
      ],
      [true, [{ type: "text", text: "The server answered with a result this build cannot read" }]],
    ]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({ cut: "engine_lost" }),
      expect.not.objectContaining({ cut: expect.anything() }),
    ]);
  });
});

/** pi-durable's `memo` over a map: a read, or a write whose first value wins. */
const memoryMemo = (memos: Map<string, JsonValue>) => {
  async function memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  async function memo<T extends JsonValue>(
    name: string,
    candidate: T,
    context: Context,
  ): Promise<T>;
  async function memo(
    name: string,
    ...rest: ReadonlyArray<JsonValue | Context>
  ): Promise<JsonValue | undefined> {
    if (rest.length === 1) return memos.get(name);

    // SAFETY: a write's candidate is a `JsonValue`, as the overloads take it.
    const candidate = rest[0] as JsonValue;

    if (!memos.has(name)) memos.set(name, candidate);

    return memos.get(name);
  }

  return memo;
};

/** The parts of a tool's api that `execute` reads, as the api. */
const apiWith = (parts: Partial<ToolExecutionApi>): ToolExecutionApi =>
  // SAFETY: only what the `mcp` tools read of the api is given: the call's ids, its memos, task, details and environment.
  parts as ToolExecutionApi;

describe("replay", () => {
  it("is safe, writes mcp.sent before the request leaves, and never sends a call again that a rerun finds sent", async () => {
    const memos = new Map<string, JsonValue>();
    const host = fakeMcpHost([server()]);
    let markedWhenSent: boolean | undefined;

    host.answer(async () => {
      markedWhenSent = memos.get("mcp.sent") === true;

      return completed({ content: [{ type: "text", text: "done" }] });
    });

    const extension = mcpExtension(
      {
        servers: [
          {
            name: "Docs-Site",
            state: "connected",
            discoveredAt: 1,
            server: { exposure: "direct" },
            tools: [{ name: "search", inputSchema: { type: "object" } }],
          },
        ],
        offered: [],
      },
      host.client,
    );

    const tool = Option.getOrThrow(Arr.head(extension.tools ?? []));

    const api = apiWith({
      callId: "call-1",
      env: undefined,
      getTask: async () => undefined,
      details: async () => undefined,
      memo: memoryMemo(memos),
    });

    const run = () => tool.execute({}, api, context);
    const sent = () => Arr.filter(host.calls, (each) => each.method === "request").length;

    expect(tool.replay).toBe("safe");

    expect((await run()).output).toEqual([{ type: "text", text: "done" }]);
    expect(markedWhenSent).toBe(true);
    expect(sent()).toBe(1);

    // After a restart the same call runs again: it finds the marker, settles, and sends nothing.
    const rerun = await run();

    expect(rerun.isError).toBe(true);
    expect(rerun.output).toEqual([
      {
        type: "text",
        text: "Tool mcp__docs_site__search was interrupted and may have partially run; it was not sent again.",
      },
    ]);
    expect(sent()).toBe(1);
  });

  it("readies a stdio call's Workspace once: a rerun that finds the call sent does not ready it again", async () => {
    const memos = new Map<string, JsonValue>();
    const host = fakeMcpHost([server()]);
    const readied: Array<string> = [];

    host.answer(async () => completed({ content: [{ type: "text", text: "done" }] }));

    const extension = mcpExtension(
      {
        servers: [
          {
            name: "Docs-Site",
            state: "connected",
            discoveredAt: 1,
            server: { type: "stdio", exposure: "direct" },
            tools: [{ name: "search", inputSchema: { type: "object" } }],
          },
        ],
        offered: [],
      },
      host.client,
      { workspace: "ws:w1" },
      {
        ready: async (workspace) => {
          readied.push(workspace);

          return true;
        },
      },
    );

    const tool = Option.getOrThrow(Arr.head(extension.tools ?? []));

    const api = apiWith({
      callId: "call-1",
      env: undefined,
      getTask: async () => undefined,
      details: async () => undefined,
      memo: memoryMemo(memos),
    });

    await tool.execute({}, api, context);
    await tool.execute({}, api, context);

    expect(readied).toEqual(["ws:w1"]);
    expect(Arr.filter(host.calls, (each) => each.method === "request")).toHaveLength(1);
  });
});
