// The owner's MCP resources in the composer as the `mcp` extension serves them (`docs/architecture/mcp-in-a-session.md` →
// Attached resources): the `@` menu's listing, which starts no Container, and the one read at send, which may. Over the
// in-memory host, as the App View's requests are tested.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off missingPipeableSignature:off
import {
  McpHostCallFailed,
  McpHostCompleted,
  type McpHostRequestInput,
  NotFound,
  ServerError,
  SignInRequired,
  Unreachable,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { build, startOf } from "./mcp.fixture.ts";
import { makeMcpTools } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";

const store = (name: string, more: Partial<FakeMcpServer> = {}): FakeMcpServer => ({
  name,
  exposure: "direct",
  resources: true,
  tools: [],
  ...more,
});

const started = async (
  servers: ReadonlyArray<FakeMcpServer>,
  options: Parameters<typeof makeMcpTools>[2] = {},
  features?: ReadonlyArray<string>,
) => {
  const host = fakeMcpHost(servers);

  if (features !== undefined) host.features(features);

  const tools = makeMcpTools(host.client, undefined, options);

  await build(tools, startOf(servers.length));

  return { host, tools };
};

type Started = Awaited<ReturnType<typeof started>>;

const requests = (host: Started["host"]): McpHostRequestInput[] =>
  host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

const page = (value: Schema.Json) => McpHostCompleted.make({ result: { kind: "inline", value } });

const contents = (...each: ReadonlyArray<Schema.Json>) => page({ contents: each });

const menu = (tools: Started["tools"], signal = new AbortController().signal) =>
  Effect.runPromise(tools.attachedResources.menu({ conversation: "1", signal }));

/** A read whose `use` keeps what the server returned as it is. */
const read = (
  tools: Started["tools"],
  server = "Docs",
  uri = "file:///a.md",
  signal = new AbortController().signal,
) =>
  Effect.runPromise(
    tools.attachedResources.read({
      server,
      uri,
      conversation: "1",
      signal,
      use: (kept) => Promise.resolve(kept),
    }),
  );

describe("the @ menu's listing", () => {
  it("lists each server's resources as the owner's request, one row each, following the cursor", async () => {
    const { host, tools } = await started([store("Docs"), store("Wiki")]);

    host.answer((input) =>
      Promise.resolve(
        input.server === "Wiki"
          ? page({ resources: [{ uri: "https://wiki.test/home", name: "home" }] })
          : !("cursor" in input.params)
            ? page({
                resources: [
                  {
                    uri: "file:///a.md",
                    name: "a",
                    title: "Alpha\nbeta",
                    description: "First\nline",
                    mimeType: "text/markdown",
                    size: 12,
                  },
                ],
                nextCursor: "next",
              })
            : page({ resources: [{ uri: "file:///b.md", name: "b" }] }),
      ),
    );

    const listed = await menu(tools);

    expect(listed.servers.map((server) => [server.server, server.state])).toEqual([
      ["Docs", "ok"],
      ["Wiki", "ok"],
    ]);
    expect(listed.servers[0]?.resources).toEqual([
      {
        uri: "file:///a.md",
        name: "a",
        title: "Alpha beta",
        description: "First line",
        mimeType: "text/markdown",
        size: 12,
      },
      { uri: "file:///b.md", name: "b" },
    ]);
    expect(requests(host).every((input) => input.ctx.origin === "owner")).toBe(true);
  });

  it("leaves an App's ui:// resources out", async () => {
    const { host, tools } = await started([store("Docs")]);

    host.answer(() =>
      Promise.resolve(
        page({
          resources: [
            { uri: "ui://docs/page", name: "view", mimeType: "text/html;profile=mcp-app" },
            { uri: "file:///a.md", name: "a" },
          ],
        }),
      ),
    );

    expect((await menu(tools)).servers[0]?.resources.map((each) => each.uri)).toEqual([
      "file:///a.md",
    ]);
  });

  it("asks a stdio server's pages not to start its Container, and mutes a stopped one", async () => {
    const { host, tools } = await started([store("Files", { entry: { type: "stdio" } })]);

    host.answer(() =>
      Promise.resolve(
        McpHostCallFailed.make({
          error: Unreachable.make({ message: "not running", stopped: true }),
        }),
      ),
    );

    const listed = await menu(tools);

    expect(listed.servers).toEqual([
      { server: "Files", source: "owner", state: "stopped", resources: [] },
    ]);
    expect(requests(host).map((input) => input.ctx.start)).toEqual([false]);
  });

  it("starts no stdio server through a host that would drop `start: false`, and says so in a muted row", async () => {
    const { host, tools } = await started(
      [store("Files", { entry: { type: "stdio" } }), store("Docs")],
      {},
      ["inventory", "call", "resources"],
    );

    host.answer(() => Promise.resolve(page({ resources: [{ uri: "file:///a.md", name: "a" }] })));

    const listed = await menu(tools);

    expect(listed.servers.map((server) => [server.server, server.state])).toEqual([
      ["Files", "unavailable"],
      ["Docs", "ok"],
    ]);
    expect(requests(host).map((input) => input.server)).toEqual(["Docs"]);
    // An HTTP server has no Container: its pages say nothing of `start`.
    expect(requests(host).every((input) => input.ctx.start === undefined)).toBe(true);
  });

  it("mutes a server that needs a sign-in, and one that fails", async () => {
    const { host, tools } = await started([store("Docs"), store("Wiki")]);

    host.answer((input) =>
      Promise.resolve(
        McpHostCallFailed.make({
          error:
            input.server === "Docs"
              ? SignInRequired.make({ message: "sign in", rejected: false })
              : ServerError.make({ message: "boom", code: -32603 }),
        }),
      ),
    );

    expect((await menu(tools)).servers.map((server) => [server.server, server.state])).toEqual([
      ["Docs", "sign_in"],
      ["Wiki", "unavailable"],
    ]);
  });

  it("leaves out a hidden or disabled server and one discovered with no resources", async () => {
    const { host, tools } = await started([
      store("A", { exposure: "hidden" }),
      store("B", { state: "disabled" }),
      store("C", { resources: false }),
      store("D"),
    ]);

    host.answer(() => Promise.resolve(page({ resources: [] })));

    expect((await menu(tools)).servers.map((server) => server.server)).toEqual(["D"]);
  });
});

describe("the read at send", () => {
  it("is the owner's request for the URI, with no `start` key: a stdio Container may be woken", async () => {
    const { host, tools } = await started([
      store("Docs"),
      store("Files", { entry: { type: "stdio" } }),
    ]);

    host.answer(() => Promise.resolve(contents({ uri: "file:///a.md", text: "hello" })));

    const answer = await read(tools, "Files");

    expect(answer).toEqual({
      status: "read",
      value: [{ uri: "file:///a.md", text: "hello" }],
    });

    const [request] = requests(host);

    expect(request?.op).toBe("resources/read");
    expect(request?.params).toEqual({ uri: "file:///a.md" });
    expect(request?.ctx.origin).toBe("owner");
    expect(request?.ctx.start).toBeUndefined();
    expect("start" in (request?.ctx ?? {})).toBe(false);
  });

  it("keeps a blob's data and MIME type for `use`", async () => {
    const { host, tools } = await started([store("Docs")]);

    host.answer(() =>
      Promise.resolve(contents({ uri: "file:///a.png", blob: "aGk=", mimeType: "image/png" })),
    );

    expect(await read(tools)).toMatchObject({
      status: "read",
      value: [{ blob: "aGk=", mimeType: "image/png" }],
    });
  });

  it("is gone for a resource the server does not have, and for a server that left", async () => {
    const { host, tools } = await started([store("Docs", { exposure: "hidden" }), store("Wiki")]);

    host.answer(() =>
      Promise.resolve(
        McpHostCallFailed.make({
          error: NotFound.make({ message: "No such resource", code: -32002 }),
        }),
      ),
    );

    expect((await read(tools, "Wiki")).status).toBe("gone");
    // Hidden, no longer there, or one that is not in the inventory: nothing is asked.
    expect((await read(tools, "Docs")).status).toBe("gone");
    expect((await read(tools, "Nobody")).status).toBe("gone");
    expect(requests(host)).toHaveLength(1);
  });

  it("is an error line for any other failure, a question the server asks, and an answer that is no resource", async () => {
    const { host, tools } = await started([store("Docs")]);

    host.answer(() =>
      Promise.resolve(
        McpHostCallFailed.make({ error: ServerError.make({ message: "boom", code: -1 }) }),
      ),
    );
    expect(await read(tools)).toEqual({ status: "failed", message: "boom" });

    host.answer(() =>
      Promise.resolve(
        McpHostCallFailed.make({
          error: SignInRequired.make({ message: "sign in", rejected: false }),
        }),
      ),
    );
    expect(await read(tools)).toEqual({ status: "failed", message: "Docs needs you signed in" });

    host.answer(() => Promise.resolve(page({ nothing: true })));
    expect((await read(tools)).status).toBe("failed");

    host.answer(() => Promise.resolve(contents()));
    expect(await read(tools)).toEqual({
      status: "failed",
      message: "The server gave no content for it",
    });
  });

  it("is failed, not thrown, when `use` fails", async () => {
    const { host, tools } = await started([store("Docs")]);

    host.answer(() => Promise.resolve(contents({ uri: "file:///a.md", text: "x" })));

    const answer = await Effect.runPromise(
      tools.attachedResources.read({
        server: "Docs",
        uri: "file:///a.md",
        conversation: "1",
        signal: new AbortController().signal,
        use: () => Promise.reject(new Error("The disk is full")),
      }),
    );

    expect(answer).toEqual({ status: "failed", message: "The disk is full" });
  });

  it("gives up when Stop aborts it, and the host's request is aborted too", async () => {
    const { host, tools } = await started([store("Docs")]);
    const stop = new AbortController();
    let aborted = false;

    host.answer(
      (_input, hooks) =>
        new Promise((resolve) => {
          void hooks.untilAborted?.().then(() => {
            aborted = true;
            resolve(page({ contents: [] }));
          });
        }),
    );

    const pending = read(tools, "Docs", "file:///a.md", stop.signal);

    setTimeout(() => {
      stop.abort();
    }, 10);

    expect(await pending).toEqual({ status: "failed", message: "The read was stopped" });
    expect(aborted).toBe(true);
  });

  it("times out with a line naming the server", async () => {
    const { host, tools } = await started([store("Docs", { timeout: 0.05 })], { slackMs: 10 });

    host.answer(() => new Promise(() => undefined));

    expect(await read(tools)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Docs did not answer"),
    });
  });
});
