// The owner's read of a resource a card links (`docs/architecture/mcp-in-a-session.md` → Resource links and embedded
// resources) as the `mcp` extension sends it: checked against the inventory, sent as an `owner` read that declares nothing a
// server could answer with a request of its own and, for a stdio server, never starts its Container (`ctx.start: false`,
// and no read at all through a host that lacks `no_start`), and its answer as the card gets it.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off missingPipeableSignature:off
import {
  HostFailed,
  McpHostCallFailed,
  McpHostCompleted,
  McpHostInputRequired,
  McpHostPagesRequired,
  MCP_HOST_FEATURES,
  MCP_URL_REQUIRED_CODE,
  Unreachable,
  ProtocolViolation,
  ServerError,
  SignInRequired,
} from "@cloudpid/mcp/types";
import { MAX_MCP_RESOURCE_PREVIEW_BYTES } from "@cloudpid/protocol";
import { jsonBytesOf, MAX_MCP_RESOURCE_ANSWER_BYTES } from "./mcp/resource-preview.ts";
import { DECODE_SLOT_OVER, PREVIEW_SLOT_OVER, takeDecodeSlot } from "./mcp/stream.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { build, DOCS, startOf } from "./mcp.fixture.ts";
import { MCP_NO_START_FEATURE, makeMcpTools, type McpResourcePreviewInput } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";

const server = (more: Partial<FakeMcpServer> = {}): FakeMcpServer => ({
  ...DOCS,
  exposure: "direct",
  toolExposure: {},
  resources: true,
  ...more,
});

/** A stdio server of the Environment. */
const STDIO: FakeMcpServer = server({ entry: { type: "stdio", command: "docs-server" } });

const NAME = "Docs-Site";

const input = (more: Partial<McpResourcePreviewInput> = {}): McpResourcePreviewInput => ({
  server: NAME,
  uri: "file:///notes.md",
  conversation: "1",
  signal: new AbortController().signal,
  ...more,
});

const started = async (
  servers: ReadonlyArray<FakeMcpServer> = [server()],
  features: ReadonlyArray<string> = MCP_HOST_FEATURES,
) => {
  const host = fakeMcpHost(servers);

  host.features(features);

  const tools = makeMcpTools(host.client);

  await build(tools, startOf(servers.length));

  return { host, tools };
};

const run = (tools: Awaited<ReturnType<typeof started>>["tools"], asked: McpResourcePreviewInput) =>
  Effect.runPromise(tools.resourcePreview(asked));

const requests = (host: Awaited<ReturnType<typeof started>>["host"]) =>
  host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

const contents = (...items: ReadonlyArray<object>) =>
  McpHostCompleted.make({ result: { kind: "inline", value: { contents: items } } });

describe("the owner's preview of a link", () => {
  it("reads it as the owner's own request that asks the server nothing: no questions, no task", async () => {
    const { host, tools } = await started();

    host.answer(async () => contents({ uri: "file:///notes.md", text: "# Notes" }));

    expect(await run(tools, input())).toEqual({
      status: "contents",
      contents: [{ uri: "file:///notes.md", text: "# Notes" }],
    });

    const [sent] = requests(host);

    expect(sent).toMatchObject({
      op: "resources/read",
      server: NAME,
      params: { uri: "file:///notes.md" },
      ctx: { origin: "owner", conversation: "1" },
    });
    expect(sent?.ctx).not.toHaveProperty("answers");
    expect(sent?.ctx).not.toHaveProperty("allowTask");
    // An HTTP server has no Container to leave stopped.
    expect(sent?.ctx).not.toHaveProperty("start");
  });

  it("says `start: false` for a stdio server, in the Workspace of the conversation, and reads it only through a host that takes it", async () => {
    const { host, tools } = await started([STDIO]);

    host.answer(async () => contents({ uri: "file:///a", text: "x" }));

    expect(await run(tools, input({ workspaceOf: Effect.succeed("ws:aaaa1111") }))).toMatchObject({
      status: "contents",
    });

    expect(requests(host)[0]?.ctx).toMatchObject({
      origin: "owner",
      workspace: "ws:aaaa1111",
      start: false,
    });
  });

  it("never sends a stdio server's read to a host that lists no `no_start`, which would drop the key and start the Container", async () => {
    const { host, tools } = await started(
      [STDIO],
      MCP_HOST_FEATURES.filter((each) => each !== MCP_NO_START_FEATURE),
    );

    expect(await run(tools, input({ workspaceOf: Effect.succeed("ws:aaaa1111") }))).toMatchObject({
      status: "unavailable",
      reason: "host_unsupported",
    });
    expect(requests(host)).toEqual([]);
  });

  it("still reads an HTTP server through such a host", async () => {
    const { host, tools } = await started(
      [server()],
      MCP_HOST_FEATURES.filter((each) => each !== MCP_NO_START_FEATURE),
    );

    host.answer(async () => contents({ uri: "file:///a", text: "x" }));

    expect(await run(tools, input())).toMatchObject({ status: "contents" });
  });

  it("says why a stdio server whose Container is stopped has no preview", async () => {
    const { host, tools } = await started([STDIO]);

    host.answer(async () =>
      McpHostCallFailed.make({
        error: Unreachable.make({ message: "The Workspace's Container is stopped", stopped: true }),
      }),
    );

    expect(await run(tools, input({ workspaceOf: Effect.succeed("ws:aaaa1111") }))).toMatchObject({
      status: "unavailable",
      reason: "stopped",
    });
  });

  it("reads a stdio server in the Session's own Workspace when the conversation names none", async () => {
    const { host, tools } = await started([STDIO]);

    host.answer(async () => contents({ uri: "file:///a", text: "x" }));

    expect(await run(tools, input({ workspaceOf: Effect.undefined }))).toMatchObject({
      status: "contents",
    });
    expect(requests(host)[0]?.ctx).toMatchObject({ workspace: "ws:w1", start: false });
  });

  it("refuses a server that is hidden, switched off or not there, without asking the host", async () => {
    for (const more of [{ exposure: "hidden" }, { state: "disabled" }]) {
      const { host, tools } = await started([server(more)]);

      expect(await run(tools, input())).toMatchObject({ status: "unavailable", reason: "hidden" });
      expect(requests(host)).toEqual([]);
    }

    const { host, tools } = await started();

    expect(await run(tools, input({ server: "Elsewhere" }))).toMatchObject({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(requests(host)).toEqual([]);
  });

  it("answers the host's failures as the card says them", async () => {
    const { host, tools } = await started();

    const cases: ReadonlyArray<readonly [Parameters<typeof host.answer>[0], object]> = [
      [
        async () =>
          McpHostCallFailed.make({
            error: SignInRequired.make({ message: "401", rejected: false }),
          }),
        { reason: "sign_in" },
      ],
      [
        async () =>
          McpHostCallFailed.make({
            error: ServerError.make({
              message: "URL elicitation required",
              code: MCP_URL_REQUIRED_CODE,
            }),
          }),
        { reason: "input_required" },
      ],
      [
        // A host that kept the server's questions anyway: a preview asks the owner nothing.
        async () => McpHostInputRequired.make({ requests: [], resume: {}, conn: "conn-docs" }),
        { reason: "input_required", message: expect.stringContaining("open it in a conversation") },
      ],
      [
        async () =>
          McpHostPagesRequired.make({ requests: [], message: "Authorize", conn: "conn-docs" }),
        { reason: "input_required", message: expect.stringContaining("open it in a conversation") },
      ],
      [
        async () =>
          McpHostCallFailed.make({
            error: ServerError.make({ message: "Internal error", code: -32603 }),
          }),
        { reason: "failed", message: "Internal error" },
      ],
      [
        // Said as the engine says it, a message that merely mentions the words is no question.
        async () =>
          McpHostCallFailed.make({
            error: ProtocolViolation.make({
              message: "The engine answered resources/read with input_required",
            }),
          }),
        { reason: "failed" },
      ],
      [
        async () => McpHostCallFailed.make({ error: Unreachable.make({ message: "down" }) }),
        { reason: "unavailable", message: "down" },
      ],
      [async () => HostFailed.make({ message: "storage" }), { reason: "failed" }],
    ];

    for (const [answer, expected] of cases) {
      host.answer(answer);
      expect(await run(tools, input())).toMatchObject({ status: "unavailable", ...expected });
    }
  });

  it("is too large past a preview's bytes, counted as decoded", async () => {
    const { host, tools } = await started();

    host.answer(async () =>
      contents({
        uri: "u",
        blob: "A".repeat(Math.ceil((MAX_MCP_RESOURCE_PREVIEW_BYTES * 4) / 3) + 8),
      }),
    );
    expect(await run(tools, input())).toMatchObject({ status: "unavailable", reason: "too_large" });
  });

  it("counts the bytes of a text's JSON without making it: its escapes, its pairs and its lone halves", () => {
    for (const text of [
      "plain",
      'say "hi" \\ there',
      "tab\tnewline\n\r\b\f",
      "\u0000\u0001\u001f\u007f",
      "café — 日本語",
      "pair 😀 whole",
      "lone \ud83d half",
      "lone \ude00 low",
    ]) {
      const written = new TextEncoder().encode(JSON.stringify(text)).length - 2;
      const counted = jsonBytesOf([{ uri: "", text }]);

      // A lone half is three bytes to a TextEncoder (U+FFFD) and six to JSON's escape: counted on the same terms.
      expect(counted).toBe(written);
    }
  });

  it("is too large when its JSON, escapes and all, is more than the socket carries", async () => {
    const { host, tools } = await started();

    // 8 MiB of control characters weigh 8 MiB, and are 6 bytes each in JSON.
    const text = "\u0001".repeat(8 * 1024 * 1024);

    expect(
      JSON.stringify({ status: "contents", contents: [{ uri: "u", text }] }).length,
    ).toBeGreaterThan(MAX_MCP_RESOURCE_ANSWER_BYTES);

    host.answer(async () => contents({ uri: "u", text }));

    expect(await run(tools, input())).toMatchObject({ status: "unavailable", reason: "too_large" });
  });

  describe("a result over 1 MiB, which the host returns as a stream", () => {
    const streamOf = (text: string, bytes = text.length) =>
      McpHostCompleted.make({
        result: {
          kind: "stream",
          bytes,
          body: new ReadableStream<Uint8Array>({
            start: (controller) => {
              const encoded = new TextEncoder().encode(text);

              for (let at = 0; at < encoded.length; at += 64 * 1024) {
                controller.enqueue(encoded.slice(at, at + 64 * 1024));
              }

              controller.close();
            },
          }),
        },
      });

    it("reads it to its end and gives the contents, up to the 16 MiB of every path", async () => {
      const { host, tools } = await started();
      const text = "x".repeat(2 * 1024 * 1024);

      host.answer(async () => streamOf(JSON.stringify({ contents: [{ uri: "u", text }] })));

      expect(await run(tools, input())).toEqual({
        status: "contents",
        contents: [{ uri: "u", text }],
      });
    });

    it("is read under the isolate's decode slot, which the Session holds through its send, when it is over the slot's size", async () => {
      const { host, tools } = await started();
      const text = "x".repeat(1024);
      const json = JSON.stringify({ contents: [{ uri: "u", text }] });
      const asked: Array<string> = [];
      let release = () => {};

      // The Session's hold: a real take, which a read that tried to take the slot again would wait on for ever.
      const holdSlot = Effect.promise(async () => {
        const taken = await takeDecodeSlot(undefined, 2000);

        if (taken.kind !== "held") return taken.kind;

        release = taken.release;
        asked.push("held");

        return "held" as const;
      });

      // Under the call's own 4 MiB: a preview holds the slot from 1 MiB, so a few of them at once never add up.
      host.answer(async () => streamOf(json, PREVIEW_SLOT_OVER + 1));

      expect(await run(tools, input({ holdSlot }))).toEqual({
        status: "contents",
        contents: [{ uri: "u", text }],
      });
      expect(asked).toEqual(["held"]);

      // Held still: the next read waits for the Session's release, as another preview's would.
      const next = takeDecodeSlot(undefined, 2000);

      const before = await Promise.race([
        next,
        new Promise((resolve) => setTimeout(resolve, 30, "waiting")),
      ]);

      expect(before).toBe("waiting");
      release();
      expect(await next).toMatchObject({ kind: "held" });
      const second = await next;

      if (second.kind === "held") second.release();
    });

    it("does not ask for the slot for a result at or under 1 MiB, and lets the stream go when it is not given", async () => {
      const { host, tools } = await started();
      let asked = 0;

      const holdSlot = Effect.sync(() => (asked++, "waited" as const));

      host.answer(async () =>
        streamOf(JSON.stringify({ contents: [{ uri: "u", text: "x" }] }), PREVIEW_SLOT_OVER),
      );
      expect(await run(tools, input({ holdSlot }))).toMatchObject({ status: "contents" });
      expect(asked).toBe(0);

      let cancelled = false;

      host.answer(async () =>
        McpHostCompleted.make({
          result: {
            kind: "stream",
            bytes: DECODE_SLOT_OVER + 1,
            body: new ReadableStream<Uint8Array>({
              cancel: () => {
                cancelled = true;
              },
            }),
          },
        }),
      );
      expect(await run(tools, input({ holdSlot }))).toMatchObject({
        status: "unavailable",
        reason: "failed",
        message: expect.stringContaining("try the preview again"),
      });
      expect(asked).toBe(1);
      expect(cancelled).toBe(true);
    });

    it("is too large past 16 MiB, and cancels what it has not read", async () => {
      const { host, tools } = await started();
      const text = "x".repeat(MAX_MCP_RESOURCE_PREVIEW_BYTES + 1);

      host.answer(async () => streamOf(JSON.stringify({ contents: [{ uri: "u", text }] })));

      expect(await run(tools, input())).toMatchObject({
        status: "unavailable",
        reason: "too_large",
      });
    });

    it("is a failed read when the stream is not JSON, and cancelled when the owner closes it", async () => {
      const { host, tools } = await started();

      host.answer(async () => streamOf("not json", 5 * 1024 * 1024));
      expect(await run(tools, input())).toMatchObject({ status: "unavailable", reason: "failed" });

      const stop = new AbortController();
      let cancelled = false;

      host.answer(async () =>
        McpHostCompleted.make({
          result: {
            kind: "stream",
            bytes: 5 * 1024 * 1024,
            body: new ReadableStream<Uint8Array>({
              cancel: () => {
                cancelled = true;
              },
            }),
          },
        }),
      );

      const pending = run(tools, input({ signal: stop.signal }));

      await new Promise((resolve) => setTimeout(resolve, 10));
      stop.abort();

      expect(await pending).toMatchObject({ status: "unavailable", reason: "cancelled" });
      expect(cancelled).toBe(true);
    });
  });

  it("is a failed read when the server's answer is not a resource", async () => {
    const { host, tools } = await started();

    host.answer(async () =>
      McpHostCompleted.make({ result: { kind: "inline", value: { contents: "no" } } }),
    );

    expect(await run(tools, input())).toMatchObject({ status: "unavailable", reason: "failed" });
  });

  it("answers cancelled when the owner closes it, and tells the host to stop", async () => {
    const { host, tools } = await started();
    const stop = new AbortController();
    let hooked: Parameters<Parameters<typeof host.answer>[0]>[1] | undefined;

    host.answer(async (_request, hooks) => {
      hooked = hooks;

      return new Promise(() => undefined);
    });

    const pending = run(tools, input({ signal: stop.signal }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();

    expect(await pending).toMatchObject({ status: "unavailable", reason: "cancelled" });
    await expect(hooked?.untilAborted?.()).resolves.toBeUndefined();
  });
});
