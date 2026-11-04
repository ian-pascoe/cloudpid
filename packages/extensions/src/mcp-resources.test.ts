// The resource tools of the `mcp` extension (`docs/architecture/mcp-in-a-session.md` → Resource tools, Resource links and
// embedded resources): which servers and Exposure register them, what a listing holds and where it stops, what a read
// gives the model and a script, the blob that goes to a Result Spill without the Container being woken, and the
// references `details` keeps. A scripted model on a Harness, and an in-memory host.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off preferEffectRecord:off nodeBuiltinImport:off preferSchemaOverJson:off
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostUnsupported,
  type JsonObject,
  McpHostCallFailed,
  McpHostCompleted,
  TimedOut,
} from "@cloudpid/mcp/types";
import type { ImageContent, JsonValue as DetailsValue, TextContent } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { describe, expect, it } from "vitest";
import { build, deferredIn, detailsOf, open, results, startOf } from "./mcp.fixture.ts";
import { makeMcpTools, mcpExtension } from "./mcp.ts";
import { type FakeMcpAnswer, type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { MAX_LISTED_BYTES, MAX_LISTED_ITEMS } from "./mcp/resources.ts";
import type { McpToolOptions } from "./mcp/tools.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

/** A server with resources and no tools, its own Exposure `exposure`. */
const store = (
  name: string,
  exposure: string,
  more: Partial<FakeMcpServer> = {},
): FakeMcpServer => ({
  name,
  exposure,
  resources: true,
  tools: [],
  ...more,
});

const NAMES = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** The resource tools of the `mcp` extension a request start over `servers` installs, as [name, deferred, callers]. */
const registered = async (
  servers: ReadonlyArray<FakeMcpServer>,
  options: {
    readonly features?: ReadonlyArray<string>;
    readonly offered?: ReadonlyArray<string>;
  } = {},
) => {
  const host = fakeMcpHost(servers);

  if (options.features !== undefined) host.features(options.features);

  const extension = Option.getOrThrow(
    await build(
      makeMcpTools(host.client),
      startOf(servers.length, { offered: options.offered ?? [] }),
    ),
  );

  return Arr.flatMap(extension.tools ?? [], (tool) =>
    NAMES.includes(tool.name)
      ? [[tool.name, tool.deferred ?? false, tool.callers ?? "all"] as const]
      : [],
  );
};

describe("which Exposure the resource tools get", () => {
  const same = (deferred: boolean, callers: "all" | readonly ["tools"]) =>
    NAMES.map((name) => [name, deferred, callers]);

  it("is the widest of the servers' own, direct over deferred over codemode", async () => {
    expect(await registered([store("a", "codemode")])).toEqual(same(true, ["tools"]));
    expect(await registered([store("a", "codemode"), store("b", "deferred")])).toEqual(
      same(true, "all"),
    );
    expect(
      await registered([store("a", "deferred"), store("b", "direct"), store("c", "codemode")]),
    ).toEqual(same(false, "all"));
  });

  it("counts only enabled servers that are not hidden and have resources", async () => {
    expect(
      await registered([
        store("a", "hidden"),
        store("b", "direct", { state: "disabled" }),
        store("c", "direct", { resources: false }),
        store("d", "codemode"),
      ]),
    ).toEqual(same(true, ["tools"]));
    expect(
      await registered([store("a", "hidden"), store("b", "direct", { state: "disabled" })]),
    ).toEqual([]);
  });

  it("registers nothing when no server has resources, or when the host does not list `resources`", async () => {
    expect(await registered([store("a", "direct", { resources: false })])).toEqual([]);
    expect(await registered([store("a", "direct")], { features: ["inventory", "call"] })).toEqual(
      [],
    );
  });

  it("ignores a server's toolExposure, and lets tools.offered lift each tool on its own", async () => {
    expect(
      await registered([store("a", "codemode", { toolExposure: { read_mcp_resource: "direct" } })]),
    ).toEqual(same(true, ["tools"]));

    expect(await registered([store("a", "codemode")], { offered: ["read_mcp_resource"] })).toEqual([
      ["list_mcp_resources", true, ["tools"]],
      ["list_mcp_resource_templates", true, ["tools"]],
      ["read_mcp_resource", false, "all"],
    ]);
  });

  it("builds the same declarations from the same inventory", async () => {
    const servers = [store("a", "direct")];
    const first = await registered(servers);

    expect(await registered(servers)).toEqual(first);
  });

  it("leaves the tools out of deferred_tools and out of tool_search's deferral", async () => {
    const host = fakeMcpHost([store("a", "deferred")]);
    const session = await open(() => answer("ok"));

    await session.start(makeMcpTools(host.client));
    await session.prompt("hello");

    const [first] = session.requests;

    // A deferred tool is not offered until loaded, and its name is not in the section that lists the settings' deferrals.
    expect(first?.tools).not.toContain("read_mcp_resource");
    expect(deferredIn(first?.system)).not.toContain("mcp_resource");
    expect(first?.system).toContain("· resources");
    expect(first?.system).toContain(
      "list_mcp_resources, list_mcp_resource_templates and read_mcp_resource",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** `count` resources of server `tag`, each with a description of `weight` characters. */
const resourcesOf = (tag: string, count: number, weight = 0): ReadonlyArray<JsonObject> =>
  Arr.makeBy(count, (index) => {
    const resource: Mutable<JsonObject> = {
      uri: `file:///${tag}/${index}`,
      name: `${tag}-${index}`,
    };

    if (weight > 0) resource["description"] = "d".repeat(weight);

    return resource;
  });

/** A host that lists `pages` of each server by its configured name, `p1`, `p2`, ... being the cursors after the first. */
const lister =
  (
    byServer: Readonly<Record<string, ReadonlyArray<ReadonlyArray<JsonObject>>>>,
    key: "resources" | "resourceTemplates" = "resources",
  ): FakeMcpAnswer =>
  async (input) => {
    if (input.op !== "resources/list" && input.op !== "resources/templates/list") {
      return HostUnsupported.make({ message: "lists only", op: input.op });
    }

    const pages = byServer[input.server] ?? [];
    const index = input.params.cursor === undefined ? 0 : Number(input.params.cursor.slice(1));
    const value: JsonObject = { [key]: pages[index] ?? [] };

    return McpHostCompleted.make({
      result: {
        kind: "inline",
        value: index + 1 < pages.length ? { ...value, nextCursor: `p${index + 1}` } : value,
      },
    });
  };

type Calls = ReadonlyArray<readonly [string, JsonObject]>;

/** A Session whose model makes `calls`, over `servers` answered by `reply`, with a file system for Result Spills. */
const calling = async (
  servers: ReadonlyArray<FakeMcpServer>,
  reply: FakeMcpAnswer,
  calls: Calls,
  options: McpToolOptions = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-resources-"));
  const host = fakeMcpHost(servers);
  const tools = makeMcpTools(host.client, undefined, options);

  host.answer(reply);

  const session = await open(
    (request) => (request.text === "go" ? call(...calls) : answer("ok")),
    () => new NodeExecutionEnv({ cwd: directory }),
  );

  await session.start(tools, startOf(servers.length));
  await session.prompt("go");

  return { host, session, directory };
};

/** The text of every block of the content. */
const textsOf = (content: ReadonlyArray<ImageContent | TextContent>) =>
  Arr.flatMap(content, (block) => (block.type === "text" ? [block.text] : []));

const Spilled = Schema.Struct({ full_output_path: Schema.String });

/** The Result Spill a result's `details` name. */
const spillOf = (details: DetailsValue | undefined): string =>
  Option.getOrThrow(Schema.decodeUnknownOption(Spilled)(details)).full_output_path;

const Referring = Schema.Struct({ resources: Schema.Array(Schema.Json) });

/** The references a result's `details` keep. */
const refsIn = (details: DetailsValue | undefined) =>
  Option.getOrThrow(Schema.decodeUnknownOption(Referring)(details)).resources;

/** The JSON a list result is, from the text of its one block. */
const jsonOf = async (session: Awaited<ReturnType<typeof open>>, index = 0): Promise<any> => {
  const [, content] = (await results(session))[index] ?? [false, []];

  return JSON.parse(textsOf(content).join(""));
};

/** The requests the host got, in order, as [op, server, cursor]. */
const requestsOf = (host: ReturnType<typeof fakeMcpHost>) =>
  Arr.flatMap(host.calls, (each) =>
    each.method === "request"
      ? [
          [
            each.input.op,
            each.input.server,
            "cursor" in each.input.params ? each.input.params.cursor : undefined,
          ] as const,
        ]
      : [],
  );

const FILES = store("File-Store", "direct");
const DOCS = store("docs", "direct");

describe("list_mcp_resources", () => {
  it("lists every server that has resources under its normalized name, without Apps' resources, icons and _meta", async () => {
    const { session } = await calling(
      [FILES, DOCS, store("quiet", "direct", { resources: false })],
      lister({
        "File-Store": [
          [
            {
              uri: "file:///a.md",
              name: "a",
              title: "Notes",
              mimeType: "text/markdown",
              size: 12,
              annotations: { audience: ["user"] },
              icons: [{ src: "x" }],
              _meta: { k: 1 },
            },
            { uri: "ui://widget/app", name: "app" },
            { uri: "file:///view.html", name: "view", mimeType: "text/html;profile=mcp-app" },
          ],
        ],
        docs: [[{ uri: "docs://intro", name: "intro" }]],
      }),
      [["list_mcp_resources", {}]],
    );

    expect(await jsonOf(session)).toEqual({
      resources: [
        {
          server: "file_store",
          name: "a",
          uri: "file:///a.md",
          title: "Notes",
          mimeType: "text/markdown",
          size: 12,
          annotations: { audience: ["user"] },
        },
        { server: "docs", name: "intro", uri: "docs://intro" },
      ],
    });
  });

  it("follows a server's pages and stops at 1,000 items, whole pages only, saying where to go on", async () => {
    const { host, session } = await calling(
      [FILES, DOCS],
      lister({
        "File-Store": [resourcesOf("f", 400), resourcesOf("g", 400), resourcesOf("h", 400)],
        docs: [resourcesOf("d", 1)],
      }),
      [["list_mcp_resources", {}]],
    );

    expect(requestsOf(host)).toEqual([
      ["resources/list", "File-Store", undefined],
      ["resources/list", "File-Store", "p1"],
      ["resources/list", "File-Store", "p2"],
    ]);

    // 800 short items are within what the model is shown, so the text is the whole listing.
    const listed = await jsonOf(session);

    expect(listed.resources).toHaveLength(800);
    expect(listed.truncated).toBe(true);
    expect(listed.incomplete).toEqual([
      { server: "file_store", next_cursor: "p2" },
      { server: "docs" },
    ]);
  });

  it("stops at 256 KiB of items, and a page alone over the limits is cut to them", async () => {
    const weight = 1024;
    const perPage = 100;

    const { session } = await calling(
      [FILES],
      lister({
        "File-Store": [
          resourcesOf("a", perPage, weight),
          resourcesOf("b", perPage, weight),
          resourcesOf("c", perPage, weight),
        ],
      }),
      [["list_mcp_resources", { server: "file_store" }]],
    );

    const [detail] = await detailsOf(session);

    const listed = JSON.parse(await readFile(spillOf(detail), "utf8"));

    expect(listed.resources).toHaveLength(perPage * 2);
    expect(JSON.stringify(listed.resources).length).toBeLessThanOrEqual(MAX_LISTED_BYTES);
    expect(listed.incomplete).toEqual([{ server: "file_store", next_cursor: "p2" }]);

    const huge = await calling(
      [FILES],
      lister({ "File-Store": [resourcesOf("x", MAX_LISTED_ITEMS + 50)] }),
      [["list_mcp_resources", {}]],
    );

    const [hugeDetail] = await detailsOf(huge.session);

    const cut = JSON.parse(await readFile(spillOf(hugeDetail), "utf8"));

    expect(cut.resources).toHaveLength(MAX_LISTED_ITEMS);
    expect(cut.truncated).toBe(true);
    expect(cut.incomplete).toEqual([{ server: "file_store" }]);
  });

  it("continues one server's listing from a cursor, and takes the configured name or mcp__<name>", async () => {
    const pages = lister({ "File-Store": [resourcesOf("a", 2), resourcesOf("b", 2)], docs: [] });

    const { host, session } = await calling([FILES, DOCS], pages, [
      ["list_mcp_resources", { server: "mcp__File_Store", cursor: "p1" }],
    ]);

    expect(requestsOf(host)).toEqual([["resources/list", "File-Store", "p1"]]);
    expect((await jsonOf(session)).resources.map((item: { name: string }) => item.name)).toEqual([
      "b-0",
      "b-1",
    ]);

    const configured = await calling([FILES, DOCS], pages, [
      ["list_mcp_resources", { server: "File-Store" }],
    ]);

    expect(requestsOf(configured.host)).toEqual([
      ["resources/list", "File-Store", undefined],
      ["resources/list", "File-Store", "p1"],
    ]);
  });

  it("refuses a cursor without a server and a server that has no resources, naming those that do", async () => {
    const lonely = await calling([FILES, DOCS], lister({}), [
      ["list_mcp_resources", { cursor: "p1" }],
    ]);

    const [lonelyResult] = await results(lonely.session);

    expect(lonelyResult?.[0]).toBe(true);
    expect(textsOf(lonelyResult?.[1] ?? [])[0]).toContain("`cursor` goes with a `server`");

    const unknown = await calling([FILES, DOCS], lister({}), [
      ["list_mcp_resources", { server: "nowhere" }],
    ]);

    const [unknownResult] = await results(unknown.session);

    expect(unknownResult?.[0]).toBe(true);
    expect(textsOf(unknownResult?.[1] ?? [])[0]).toContain(
      "Servers with resources: file_store, docs.",
    );
    expect(requestsOf(unknown.host)).toEqual([]);
  });

  it("lists a server that failed as an error, and the others as usual; one server's failure is the call's", async () => {
    const reply: FakeMcpAnswer = async (input, hooks) =>
      input.server === "docs"
        ? McpHostCallFailed.make({
            error: TimedOut.make({ message: "The server did not answer in time" }),
          })
        : lister({ "File-Store": [resourcesOf("a", 1)] })(input, hooks);

    const all = await calling([FILES, DOCS], reply, [["list_mcp_resources", {}]]);

    expect(await jsonOf(all.session)).toEqual({
      resources: [{ server: "file_store", name: "a-0", uri: "file:///a/0" }],
      errors: [
        { server: "docs", error: "The request timed out: The server did not answer in time." },
      ],
    });

    const one = await calling([FILES, DOCS], reply, [["list_mcp_resources", { server: "docs" }]]);
    const [isError, content] = (await results(one.session))[0] ?? [];

    expect(isError).toBe(true);
    expect(textsOf(content ?? [])[0]).toBe(
      "The request timed out: The server did not answer in time.",
    );
  });
});

describe("a listing that cannot end", () => {
  /** `File-Store` leads to the cursor `same` from every page, `docs` lists one page. */
  const looping: FakeMcpAnswer = async (input) =>
    input.op === "resources/list"
      ? McpHostCompleted.make({
          result: {
            kind: "inline",
            value:
              input.server === "File-Store"
                ? { resources: resourcesOf("l", 2), nextCursor: "same" }
                : { resources: resourcesOf("d", 1) },
          },
        })
      : HostUnsupported.make({ message: "lists only", op: input.op });

  it("fails the server that gives a cursor twice, keeping its pages, and lists the next", async () => {
    const { host, session } = await calling([FILES, DOCS], looping, [["list_mcp_resources", {}]]);

    // The first page, then the page `same` leads to, whose own cursor is `same` again: not asked a third time.
    expect(requestsOf(host)).toEqual([
      ["resources/list", "File-Store", undefined],
      ["resources/list", "File-Store", "same"],
      ["resources/list", "docs", undefined],
    ]);

    const listed = await jsonOf(session);

    expect(listed.resources).toHaveLength(5);
    expect(listed.truncated).toBeUndefined();
    expect(listed.incomplete).toBeUndefined();
    expect(listed.errors).toEqual([
      { server: "file_store", error: expect.stringContaining("repeat a cursor") },
    ]);
  });

  it("is the call's own error for one server, and a cursor it starts from counts as given", async () => {
    const { host, session } = await calling([FILES, DOCS], looping, [
      ["list_mcp_resources", { server: "File-Store", cursor: "same" }],
    ]);

    // Asked from `same`, the server leads straight back to it.
    expect(requestsOf(host)).toEqual([["resources/list", "File-Store", "same"]]);

    const [isError, content] = (await results(session))[0] ?? [];

    expect(isError).toBe(true);
    expect(textsOf(content ?? [])[0]).toContain("repeat a cursor");
  });
});

describe("list_mcp_resource_templates", () => {
  it("lists templates under resource_templates, leaving an App's out", async () => {
    const { host, session } = await calling(
      [FILES],
      lister(
        {
          "File-Store": [
            [
              { uriTemplate: "file:///{path}", name: "file", mimeType: "text/plain" },
              { uriTemplate: "ui://{id}", name: "app" },
            ],
          ],
        },
        "resourceTemplates",
      ),
      [["list_mcp_resource_templates", {}]],
    );

    expect(requestsOf(host)).toEqual([["resources/templates/list", "File-Store", undefined]]);
    expect(await jsonOf(session)).toEqual({
      resource_templates: [
        {
          server: "file_store",
          name: "file",
          uriTemplate: "file:///{path}",
          mimeType: "text/plain",
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** A host that answers `resources/read` with `contents`. */
const reading =
  (contents: ReadonlyArray<JsonObject>): FakeMcpAnswer =>
  async (input) =>
    input.op === "resources/read"
      ? McpHostCompleted.make({ result: { kind: "inline", value: { contents } }, sha256: "00" })
      : HostUnsupported.make({ message: "reads only", op: input.op });

describe("read_mcp_resource", () => {
  it("gives the model a text as it is, and names each item when there are several", async () => {
    const one = await calling(
      [FILES],
      reading([{ uri: "file:///a.md", mimeType: "text/markdown", text: "# Notes" }]),
      [["read_mcp_resource", { server: "file_store", uri: "file:///a.md" }]],
    );

    expect(await results(one.session)).toEqual([[false, [{ type: "text", text: "# Notes" }]]]);
    expect(requestsOf(one.host)).toEqual([["resources/read", "File-Store", undefined]]);

    const several = await calling(
      [FILES],
      reading([
        { uri: "file:///a.md", text: "first" },
        { uri: "file:///b.png", mimeType: "image/png", blob: "aGk=" },
        { uri: "file:///c.txt", text: "third" },
      ]),
      [["read_mcp_resource", { server: "File-Store", uri: "file:///dir" }]],
    );

    expect(await results(several.session)).toEqual([
      [
        false,
        [
          { type: "text", text: "file:///a.md:" },
          { type: "text", text: "first" },
          { type: "text", text: "file:///b.png:" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "text", text: "file:///c.txt:" },
          { type: "text", text: "third" },
        ],
      ],
    ]);
  });

  it("saves a blob to a Result Spill through the call's environment, without a Container start or another request", async () => {
    const ready: string[] = [];
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

    const { host, session } = await calling(
      [store("File-Store", "direct", { entry: { type: "stdio" } })],
      reading([{ uri: "file:///report.pdf", mimeType: "application/pdf", blob: "JVBERi0x" }]),
      [["read_mcp_resource", { server: "file_store", uri: "file:///report.pdf" }]],
      {
        ready: async (workspace) => {
          ready.push(workspace);

          return true;
        },
      },
    );

    const [, content] = (await results(session))[0] ?? [];
    const [line = ""] = textsOf(content ?? []);
    const path = /saved to (.+)\]$/.exec(line)?.[1] ?? "";

    expect(line).toMatch(
      /^\[Binary resource file:\/\/\/report\.pdf \(application\/pdf, 6B\) saved to .+\.pdf\]$/,
    );
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);

    // The Workspace was marked used once, before the one request: saving the blob asked nothing of either.
    expect(ready).toEqual(["ws:w1"]);
    expect(host.calls.filter((each) => each.method === "request")).toHaveLength(1);

    const [detail] = await detailsOf(session);

    expect(detail).toMatchObject({
      server: "File-Store",
      tool: "read_mcp_resource",
      resources: [
        {
          uri: "file:///report.pdf",
          mimeType: "application/pdf",
          size: 6,
          kind: "spill",
          part: 0,
          path,
        },
      ],
    });
  });

  it("keeps references to a text and an image in details, and cuts a long text to a Result Spill", async () => {
    const text = Arr.makeBy(5000, (line) => `line ${line}`).join("\n");

    const { session } = await calling(
      [FILES],
      reading([
        { uri: "file:///long.txt", mimeType: "text/plain", text },
        { uri: "file:///a.png", mimeType: "image/png", blob: "aGk=" },
      ]),
      [["read_mcp_resource", { server: "file_store", uri: "file:///dir" }]],
    );

    const [, content] = (await results(session))[0] ?? [];
    const [detail] = await detailsOf(session);
    const full = spillOf(detail);

    expect(textsOf(content ?? []).join("\n")).toContain("Output truncated to its beginning");
    expect(await readFile(full, "utf8")).toBe(text);
    expect(detail).toMatchObject({
      resources: [
        {
          uri: "file:///long.txt",
          mimeType: "text/plain",
          size: text.length,
          kind: "text",
          part: 0,
        },
        { uri: "file:///a.png", mimeType: "image/png", size: 2, kind: "image", part: 1 },
      ],
    });
  });

  it("says why a server or a request cannot be read, never that it may have run", async () => {
    const { session } = await calling(
      [FILES],
      async () =>
        McpHostCallFailed.make({
          error: TimedOut.make({ message: "The server did not answer in time" }),
        }),
      [
        ["read_mcp_resource", { server: "nowhere", uri: "x://y" }],
        ["read_mcp_resource", { server: "file_store", uri: "x://y" }],
      ],
    );

    const [first, second] = await results(session);

    expect(first?.[0]).toBe(true);
    expect(textsOf(first?.[1] ?? [])[0]).toContain("Servers with resources: file_store");
    expect(second?.[0]).toBe(true);
    expect(textsOf(second?.[1] ?? [])[0]).toBe(
      "The request timed out: The server did not answer in time.",
    );
  });

  it("is sent as a read: safe to rerun, no `mcp.sent` marker written, and sent again by a rerun", async () => {
    const host = fakeMcpHost([FILES]);

    host.answer(reading([{ uri: "file:///a.txt", text: "read" }]));

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
        features: ["inventory", "call", "resources"],
      },
      host.client,
    );

    const tool = Option.getOrThrow(
      Arr.findFirst(extension.tools ?? [], (each) => each.name === "read_mcp_resource"),
    );

    const memoed: Array<string> = [];

    const parts: Partial<ToolExecutionApi> = {
      callId: "call-1",
      env: undefined,
      getTask: async () => undefined,
      details: async () => undefined,
      memo: async (name: string) => {
        memoed.push(name);

        return undefined;
      },
    };

    // SAFETY: only what the resource tools read of the api is given: the call's ids, its memo, task, details and environment.
    const api = parts as ToolExecutionApi;
    const run = () => tool.execute({ server: "file_store", uri: "file:///a.txt" }, api, context);

    const sent = () => host.calls.filter((each) => each.method === "request").length;

    expect(tool.replay).toBe("safe");
    expect((await run()).output).toEqual([{ type: "text", text: "read" }]);
    expect(sent()).toBe(1);

    // A rerun after a restart asks again, and finds nothing to settle it as interrupted.
    const rerun = await run();

    expect(rerun.isError).toBeUndefined();
    expect(rerun.output).toEqual([{ type: "text", text: "read" }]);
    expect(sent()).toBe(2);
    expect(memoed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** What a script printed with `text()` after codemode's own lines, for the one result. */
const printed = async (session: Awaited<ReturnType<typeof open>>) =>
  Arr.join(textsOf((await results(session))[0]?.[1] ?? []), "")
    .split("Output:\n")
    .slice(1)
    .join("Output:\n");

const scripted = async (
  code: string,
  reply: FakeMcpAnswer,
  server = store("File-Store", "codemode"),
) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-resources-"));
  const host = fakeMcpHost([server]);
  const tools = makeMcpTools(host.client);

  host.answer(reply);

  const session = await open(
    (request) => (request.text === "go" ? call(["codemode", { code }]) : answer("ok")),
    () => new NodeExecutionEnv({ cwd: directory }),
  );

  await session.start(tools, startOf(1, { offered: ["codemode"] }));
  await session.prompt("go");

  return { host, session };
};

describe("the value a script gets", () => {
  it("is { server, uri, contents }, a blob as its Result Spill's path and a long text cut with text_truncated", async () => {
    const long = "x".repeat(2 * 1024 * 1024);

    const { session } = await scripted(
      `const value = await tools.read_mcp_resource({ server: "file_store", uri: "file:///dir" });
       text(JSON.stringify(value, (key, each) => (key === "text" ? each.length : each)));`,
      reading([
        { uri: "file:///a.txt", mimeType: "text/plain", text: "short" },
        { uri: "file:///b.pdf", mimeType: "application/pdf", blob: "JVBERi0x" },
        { uri: "file:///long.txt", text: long },
      ]),
    );

    const value = JSON.parse(await printed(session));

    expect(value.server).toBe("file_store");
    expect(value.uri).toBe("file:///dir");
    expect(value.contents[0]).toEqual({ uri: "file:///a.txt", mimeType: "text/plain", text: 5 });
    expect(value.contents[1]).toMatchObject({
      uri: "file:///b.pdf",
      mimeType: "application/pdf",
      size: 6,
    });
    expect(value.contents[1].full_output_path).toMatch(/\.pdf$/);
    expect(value.contents[2].text_truncated).toBe(true);
    expect(value.contents[2].text).toBeLessThan(long.length);
    expect(await readFile(value.contents[2].full_output_path, "utf8")).toBe(long);
  });

  it("is the listing for a list: its items, truncated and incomplete", async () => {
    const { session } = await scripted(
      `const value = await tools.list_mcp_resources({});
       text(JSON.stringify(value));`,
      lister({ "File-Store": [resourcesOf("a", 2)] }),
    );

    expect(JSON.parse(await printed(session))).toEqual({
      resources: [
        { server: "file_store", name: "a-0", uri: "file:///a/0" },
        { server: "file_store", name: "a-1", uri: "file:///a/1" },
      ],
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("a resource link in a tool's result", () => {
  const link = {
    type: "resource_link",
    uri: "file:///a.md",
    name: "a",
    title: "Notes",
    mimeType: "text/markdown",
    size: 2048,
    description: "The notes",
  };

  /** A server with the tool `search`, which answers a link and an embedded text and blob. */
  const withTool = (more: Partial<FakeMcpServer>): FakeMcpServer => ({
    name: "Docs-Site",
    exposure: "direct",
    tools: [{ name: "search", description: "Search" }],
    ...more,
  });

  const run = async (server: FakeMcpServer) => {
    const { session } = await calling(
      [server],
      async () =>
        McpHostCompleted.make({
          result: {
            kind: "inline",
            value: {
              content: [
                { type: "text", text: "found" },
                link,
                {
                  type: "resource",
                  resource: { uri: "file:///b.txt", mimeType: "text/plain", text: "héllo" },
                },
                {
                  type: "resource",
                  resource: { uri: "file:///c.pdf", mimeType: "application/pdf", blob: "JVBERi0x" },
                },
                { type: "resource_link", uri: `file:///${"z".repeat(2100)}` },
              ],
            },
          },
        }),
      [["mcp__docs_site__search", {}]],
    );

    return session;
  };

  it("says how to read it when the resource tools reach its server, and only then", async () => {
    const reachable = await run(withTool({ resources: true }));
    const [, content] = (await results(reachable))[0] ?? [];

    expect(textsOf(content ?? [])[1]).toBe(
      '[Resource file:///a.md "Notes" (text/markdown, 2.0KB): The notes. Read it with read_mcp_resource (server "docs_site")]',
    );

    for (const server of [
      withTool({}),
      withTool({ resources: true, exposure: "hidden", toolExposure: { search: "direct" } }),
    ]) {
      const other = await run(server);
      const [, text] = (await results(other))[0] ?? [];

      expect(textsOf(text ?? [])[1]).toBe(
        '[Resource file:///a.md "Notes" (text/markdown, 2.0KB): The notes]',
      );
    }
  });

  it("keeps a reference for each link and embedded resource in details, not for a URI over 2,048 characters", async () => {
    const session = await run(withTool({ resources: true }));
    const [detail] = await detailsOf(session);

    expect(refsIn(detail)).toEqual([
      { uri: "file:///a.md", mimeType: "text/markdown", size: 2048, kind: "link", part: 1 },
      // The transcript holds the text itself, where the output has it.
      { uri: "file:///b.txt", mimeType: "text/plain", size: 6, kind: "text", part: 2, at: 2 },
      expect.objectContaining({
        uri: "file:///c.pdf",
        kind: "spill",
        size: 6,
        part: 3,
        path: expect.stringMatching(/\.pdf$/),
      }),
    ]);
  });

  it("says where the output holds an embedded image or text, so the card previews it from the transcript", async () => {
    const { session } = await calling(
      [withTool({ resources: true })],
      async () =>
        McpHostCompleted.make({
          result: {
            kind: "inline",
            value: {
              content: [
                { type: "resource_link", uri: "file:///l.md" },
                {
                  type: "resource",
                  resource: { uri: "file:///p.png", mimeType: "image/png", blob: "iVBORw0KGgo=" },
                },
                { type: "resource", resource: { uri: "file:///t.md", text: "# T" } },
              ],
            },
          },
        }),
      [["mcp__docs_site__search", {}]],
    );

    const [detail] = await detailsOf(session);
    const [, content] = (await results(session))[0] ?? [];

    expect(refsIn(detail)).toEqual([
      expect.objectContaining({ uri: "file:///l.md", kind: "link" }),
      expect.objectContaining({ uri: "file:///p.png", kind: "image", part: 1, at: 1 }),
      expect.objectContaining({ uri: "file:///t.md", kind: "text", part: 2, at: 2 }),
    ]);
    expect(refsIn(detail)[0]).not.toHaveProperty("at");
    expect(content?.[1]).toMatchObject({ type: "image", data: "iVBORw0KGgo=" });
    expect(content?.[2]).toEqual({ type: "text", text: "# T" });
  });

  it("gives no `at` to a text the limits cut, which the output no longer holds, and moves an image's to where it is", async () => {
    const { session } = await calling(
      [withTool({ resources: true })],
      async () =>
        McpHostCompleted.make({
          result: {
            kind: "inline",
            value: {
              content: [
                { type: "text", text: "line\n".repeat(3000) },
                { type: "resource", resource: { uri: "file:///t.md", text: "# T" } },
                {
                  type: "resource",
                  resource: { uri: "file:///p.png", mimeType: "image/png", blob: "iVBORw0KGgo=" },
                },
              ],
            },
          },
        }),
      [["mcp__docs_site__search", {}]],
    );

    const [detail] = await detailsOf(session);
    const [, content] = (await results(session))[0] ?? [];

    const [text, image] = refsIn(detail);

    expect(text).toMatchObject({ uri: "file:///t.md", kind: "text", part: 1 });
    expect(text).not.toHaveProperty("at");
    expect(image).toMatchObject({ uri: "file:///p.png", kind: "image", part: 2, at: 1 });
    expect(content?.[1]).toMatchObject({ type: "image" });
  });

  it("keeps at most 20", async () => {
    const { session } = await calling(
      [withTool({ resources: true })],
      async () =>
        McpHostCompleted.make({
          result: {
            kind: "inline",
            value: {
              content: Arr.makeBy(30, (index) => ({
                type: "resource_link",
                uri: `file:///${index}`,
              })),
            },
          },
        }),
      [["mcp__docs_site__search", {}]],
    );

    const [detail] = await detailsOf(session);

    expect(refsIn(detail)).toHaveLength(20);
  });
});
