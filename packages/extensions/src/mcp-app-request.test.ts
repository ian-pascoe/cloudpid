// An App View's request to its server (`docs/architecture/mcp-apps.md` → An App View's calls) as the `mcp` extension sends
// it: checked against the inventory (the tool's visibility, the server's Exposure and state), sent as an `app` request that
// declares nothing a server could answer with a request of its own, and its answer as the View gets it.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off missingPipeableSignature:off
import {
  HostFailed,
  McpHostCallFailed,
  McpHostCompleted,
  NotAllowed,
  ServerChanged,
  ServerError,
  SignInRequired,
  StepUpRequired,
  Unreachable,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { build, DOCS, startOf } from "./mcp.fixture.ts";
import { makeMcpTools, type McpAppRequestInput } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";

/** A server with a tool for both, one only an App sees, one only the model sees, and one with no `_meta`. */
const server = (more: Partial<FakeMcpServer> = {}): FakeMcpServer => ({
  ...DOCS,
  exposure: "direct",
  toolExposure: {},
  resources: true,
  tools: [
    { name: "both", _meta: { ui: { resourceUri: "ui://docs/page" } } },
    { name: "refresh", _meta: { ui: { visibility: ["app"] } } },
    { name: "private", _meta: { ui: { visibility: ["model"] } } },
    { name: "plain" },
  ],
  ...more,
});

const NAME = "Docs-Site";

/** What every request of the call carries besides its method. */
type Extras = {
  readonly server?: string;
  readonly workspaceOf?: Effect.Effect<string | undefined>;
};

const common = (more: Extras = {}, signal = new AbortController().signal) => ({
  server: NAME,
  callId: "c1",
  conversation: "1",
  viewHash: "abcdefghijklmnopqrstuvwxyz",
  signal,
  ...more,
});

const toolCall = (name: string, more: Extras = {}, signal?: AbortSignal): McpAppRequestInput => ({
  method: "tools/call",
  name,
  arguments: { q: "x" },
  ...common(more, signal),
});

const readOf = (uri: string, more: Extras = {}): McpAppRequestInput => ({
  method: "resources/read",
  uri,
  ...common(more),
});

const started = async (
  servers: ReadonlyArray<FakeMcpServer> = [server()],
  options: Parameters<typeof makeMcpTools>[2] = {},
) => {
  const host = fakeMcpHost(servers);
  const tools = makeMcpTools(host.client, undefined, options);

  await build(tools, startOf(servers.length));

  return { host, tools };
};

const run = (tools: Awaited<ReturnType<typeof started>>["tools"], input: McpAppRequestInput) =>
  Effect.runPromise(Effect.map(tools.appRequest(input), (reply) => reply.answer));

const requests = (host: Awaited<ReturnType<typeof started>>["host"]) =>
  host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

/** What a call's conversation works in, as the Session names it. */
const inWorkspace = (workspace: string | undefined) => Effect.succeed(workspace);

const result = McpHostCompleted.make({
  result: { kind: "inline", value: { content: [{ type: "text", text: "ok" }] } },
});

describe("an App View's request", () => {
  it("calls a tool whose visibility includes app, as the App's own request that declares nothing a server could ask with", async () => {
    const { host, tools } = await started();

    host.answer(async () => result);

    for (const name of ["both", "refresh", "plain"]) {
      expect(await run(tools, toolCall(name))).toEqual({
        status: "result",
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }

    const sent = requests(host);

    expect(sent).toHaveLength(3);

    for (const each of sent) {
      expect(each).toMatchObject({
        op: "tools/call",
        server: NAME,
        ctx: {
          origin: "app",
          callId: "c1",
          conversation: "1",
          viewHash: "abcdefghijklmnopqrstuvwxyz",
        },
      });

      // Nothing that invites a server's own request: no questions to answer, no MCP task to wait for.
      expect(each.ctx).not.toHaveProperty("answers");
      expect(each.ctx).not.toHaveProperty("allowTask");
    }
  });

  it("refuses a tool that only the model sees, and one the server does not list, without asking the host", async () => {
    const { host, tools } = await started();

    expect(await run(tools, toolCall("private"))).toMatchObject({
      status: "error",
      reason: "refused",
    });

    expect(await run(tools, toolCall("nothing"))).toMatchObject({
      status: "error",
      reason: "refused",
    });

    expect(requests(host)).toEqual([]);
  });

  it("refuses a server that is hidden, switched off or not there, without asking the host", async () => {
    for (const more of [{ exposure: "hidden" }, { state: "disabled" }]) {
      const { host, tools } = await started([server(more)]);

      expect(await run(tools, toolCall("both"))).toMatchObject({
        status: "error",
        reason: "hidden",
      });
      expect(await run(tools, readOf("ui://docs/page"))).toMatchObject({
        status: "error",
        reason: "hidden",
      });
      expect(requests(host)).toEqual([]);
    }

    const { host, tools } = await started();

    expect(await run(tools, toolCall("both", { server: "Elsewhere" }))).toMatchObject({
      status: "error",
      reason: "unavailable",
    });

    expect(requests(host)).toEqual([]);
  });

  it("reads a resource of its own server as the App's request", async () => {
    const { host, tools } = await started();

    host.answer(async () =>
      McpHostCompleted.make({
        result: { kind: "inline", value: { contents: [{ uri: "ui://docs/page", text: "hi" }] } },
      }),
    );

    expect(await run(tools, readOf("ui://docs/page"))).toEqual({
      status: "result",
      result: { contents: [{ uri: "ui://docs/page", text: "hi" }] },
    });

    expect(requests(host)).toEqual([
      {
        op: "resources/read",
        server: NAME,
        params: { uri: "ui://docs/page" },
        ctx: expect.objectContaining({ origin: "app", callId: "c1" }),
      },
    ]);

    expect(requests(host)[0]?.ctx).not.toHaveProperty("answers");
  });

  it("answers the host's refusals and failures as the View's errors, with why", async () => {
    const { host, tools } = await started();

    const cases: ReadonlyArray<readonly [Parameters<typeof host.answer>[0], object]> = [
      [
        async () =>
          McpHostCallFailed.make({
            error: SignInRequired.make({ message: "401", rejected: false }),
          }),
        { reason: "sign_in", server: NAME },
      ],
      [
        async () =>
          McpHostCallFailed.make({
            error: StepUpRequired.make({ message: "403", scope: "write" }),
          }),
        { reason: "sign_in", server: NAME, stepUp: true },
      ],
      [
        async () => McpHostCallFailed.make({ error: Unreachable.make({ message: "down" }) }),
        { reason: "unavailable", message: "down" },
      ],
      [
        async () =>
          McpHostCallFailed.make({ error: ServerError.make({ message: "boom", code: -32_050 }) }),
        { reason: "failed", code: -32_050, message: "boom" },
      ],
      [async () => NotAllowed.make({ message: "not for apps" }), { reason: "refused" }],
      [
        async () => ServerChanged.make({ message: "shadowed", conn: "c" }),
        { reason: "unavailable" },
      ],
      [async () => HostFailed.make({ message: "storage" }), { reason: "failed" }],
    ];

    for (const [answer, expected] of cases) {
      host.answer(answer);
      expect(await run(tools, toolCall("both"))).toMatchObject({ status: "error", ...expected });
    }
  });

  it("answers a result over 1 MiB as an error, and cancels its stream", async () => {
    const { host, tools } = await started();
    let cancelled = false;

    host.answer(async () =>
      McpHostCompleted.make({
        result: {
          kind: "stream",
          bytes: 2 * 1024 * 1024,
          body: new ReadableStream<Uint8Array>({
            cancel: () => {
              cancelled = true;
            },
          }),
        },
      }),
    );

    expect(await run(tools, toolCall("both"))).toMatchObject({ status: "error", reason: "failed" });
    expect(cancelled).toBe(true);
  });

  it("answers cancelled when the View cancels, whether or not the host answers, and the host's request is told to stop", async () => {
    const { host, tools } = await started();
    const stop = new AbortController();
    let hooked: Parameters<Parameters<typeof host.answer>[0]>[1] | undefined;

    host.answer(
      (_input, hooks) =>
        new Promise(() => {
          hooked = hooks;
        }),
    );

    const answered = run(tools, toolCall("both", {}, stop.signal));

    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();

    expect(await answered).toMatchObject({ status: "error", reason: "cancelled" });

    // The host's hook resolves, which is what cancels its request.
    await expect(hooked?.untilAborted?.()).resolves.toBeUndefined();
  });

  it("answers cancelled at once for a request cancelled before it was sent", async () => {
    const { host, tools } = await started();
    const stop = new AbortController();

    stop.abort();

    expect(await run(tools, toolCall("both", {}, stop.signal))).toMatchObject({
      reason: "cancelled",
    });

    expect(requests(host)).toEqual([]);
  });

  it("gives up on a host that does not answer within the server's timeout", async () => {
    const { host, tools } = await started([server({ timeout: 0.01 })], { slackMs: 0 });

    host.answer(() => new Promise(() => undefined));

    expect(await run(tools, toolCall("both"))).toMatchObject({ status: "error", reason: "failed" });
  });
});

describe("an App View's request to a stdio server", () => {
  const stdio = () => server({ entry: { type: "stdio", command: "docs" } });

  it("runs in the Workspace of the call's conversation, marked used first, and is not sent when it did not answer", async () => {
    const marked: string[] = [];
    let ready = true;

    const { host, tools } = await started([stdio()], {
      ready: async (workspace) => {
        marked.push(workspace);

        return ready;
      },
    });

    host.answer(async () => result);

    const workspaceOf = inWorkspace("ws:sub-1");

    expect(await run(tools, toolCall("both", { workspaceOf }))).toMatchObject({
      status: "result",
    });

    expect(marked).toEqual(["ws:sub-1"]);
    expect(requests(host)[0]?.ctx).toMatchObject({ workspace: "ws:sub-1" });

    // No Workspace of its own: the Session's.
    await run(
      tools,
      toolCall("both", {
        workspaceOf: inWorkspace(undefined),
      }),
    );
    expect(marked.at(-1)).toBe("ws:w1");

    ready = false;

    const before = requests(host).length;

    expect(await run(tools, toolCall("both"))).toMatchObject({
      status: "error",
      reason: "unavailable",
    });

    expect(requests(host)).toHaveLength(before);
  });
});
