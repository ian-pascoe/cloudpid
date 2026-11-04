// The owner's completion of an argument in the composer's form (`docs/architecture/mcp-in-a-session.md` → Arguments and
// completions) as the `mcp` extension sends it: never asked of a server that does not declare `completions` or through a host
// that lacks the feature, sent as an `owner` request that asks the server nothing and never starts a Container, and its answer
// as the form is told it.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off missingPipeableSignature:off
import {
  McpHostCallFailed,
  McpHostCompleted,
  MCP_HOST_FEATURES,
  ServerError,
  SignInRequired,
  Unreachable,
  Unsupported,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { build, DOCS, startOf } from "./mcp.fixture.ts";
import { MCP_COMPLETIONS_FEATURE, makeMcpTools, type McpCompletionInput } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";

const server = (more: Partial<FakeMcpServer> = {}): FakeMcpServer => ({
  ...DOCS,
  exposure: "direct",
  toolExposure: {},
  completions: true,
  ...more,
});

const STDIO: FakeMcpServer = server({ entry: { type: "stdio", command: "docs-server" } });

const NAME = "Docs-Site";

const input = (more: Partial<McpCompletionInput> = {}): McpCompletionInput => ({
  server: NAME,
  ref: { type: "ref/prompt", name: "review_pr" },
  argument: { name: "repo", value: "cl" },
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

const run = (tools: Awaited<ReturnType<typeof started>>["tools"], asked: McpCompletionInput) =>
  Effect.runPromise(tools.complete(asked));

const requests = (host: Awaited<ReturnType<typeof started>>["host"]) =>
  host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

/** What a server's `completion` holds besides its values. */
interface CompletionMore {
  readonly total?: unknown;
  readonly hasMore?: unknown;
}

const completion = (values: ReadonlyArray<unknown>, more: CompletionMore = {}) =>
  McpHostCompleted.make({ result: { kind: "inline", value: { completion: { values, ...more } } } });

describe("completion of an argument", () => {
  it("is the owner's own request that asks the server nothing, with the other arguments as context", async () => {
    const { host, tools } = await started();

    host.answer(async () => completion(["claude", "cloud"], { total: 9, hasMore: true }));

    expect(await run(tools, input({ context: { arguments: { owner: "ian" } } }))).toEqual({
      status: "ok",
      values: ["claude", "cloud"],
      total: 9,
      hasMore: true,
    });

    const [sent] = requests(host);

    expect(sent).toMatchObject({
      op: "completion/complete",
      server: NAME,
      params: {
        ref: { type: "ref/prompt", name: "review_pr" },
        argument: { name: "repo", value: "cl" },
        context: { arguments: { owner: "ian" } },
      },
      ctx: { origin: "owner", conversation: "1", start: false },
    });
    expect(sent?.ctx).not.toHaveProperty("answers");
    expect(sent?.ctx).not.toHaveProperty("allowTask");
  });

  it("completes a resource template by its URI template", async () => {
    const { host, tools } = await started();

    host.answer(async () => completion(["a"]));

    await run(tools, input({ ref: { type: "ref/resource", uri: "repo://{owner}" } }));

    expect(requests(host)[0]?.params).toMatchObject({
      ref: { type: "ref/resource", uri: "repo://{owner}" },
    });
  });

  it("is never asked of a server that does not declare completions", async () => {
    const { host, tools } = await started([server({ completions: false })]);

    expect(await run(tools, input())).toEqual({
      status: "unsupported",
      values: [],
      hasMore: false,
    });
    expect(requests(host)).toEqual([]);
  });

  it("is never sent to a host that lists no `completions`, which would not know the op", async () => {
    const { host, tools } = await started(
      [server()],
      MCP_HOST_FEATURES.filter((each) => each !== MCP_COMPLETIONS_FEATURE),
    );

    expect(await run(tools, input())).toMatchObject({ status: "unsupported" });
    expect(requests(host)).toEqual([]);
  });

  it("refuses a server that is hidden, switched off or not there, without asking the host", async () => {
    for (const more of [{ exposure: "hidden" }, { state: "disabled" }]) {
      const { host, tools } = await started([server(more)]);

      expect(await run(tools, input())).toMatchObject({ status: "unsupported" });
      expect(requests(host)).toEqual([]);
    }

    const { host, tools } = await started();

    expect(await run(tools, input({ server: "Elsewhere" }))).toMatchObject({
      status: "unsupported",
    });
    expect(requests(host)).toEqual([]);
  });

  it("names a stdio server's Workspace, and says it is not running when its Container is stopped", async () => {
    const { host, tools } = await started([STDIO]);

    host.answer(async () =>
      McpHostCallFailed.make({
        error: Unreachable.make({ message: "The Container is stopped", stopped: true }),
      }),
    );

    expect(await run(tools, input({ workspaceOf: Effect.succeed("ws:aaaa1111") }))).toMatchObject({
      status: "not_running",
    });
    expect(requests(host)[0]?.ctx).toMatchObject({ workspace: "ws:aaaa1111", start: false });
  });

  it("answers the host's failures as the form says them", async () => {
    const { host, tools } = await started();

    const cases: ReadonlyArray<readonly [Parameters<typeof host.answer>[0], string]> = [
      [
        async () =>
          McpHostCallFailed.make({
            error: SignInRequired.make({ message: "401", rejected: false }),
          }),
        "sign_in",
      ],
      [
        async () =>
          McpHostCallFailed.make({ error: Unsupported.make({ message: "no completions" }) }),
        "unsupported",
      ],
      [
        async () =>
          McpHostCallFailed.make({ error: ServerError.make({ message: "boom", code: -32603 }) }),
        "failed",
      ],
      [
        async () => McpHostCompleted.make({ result: { kind: "inline", value: { nope: 1 } } }),
        "failed",
      ],
    ];

    for (const [answer, status] of cases) {
      host.answer(answer);

      expect(await run(tools, input())).toMatchObject({ status, values: [] });
    }
  });

  it("keeps at most 100 suggestions in the server's order, without repeats or any over 1,000 characters", async () => {
    const { host, tools } = await started();

    const many = Array.from({ length: 150 }, (_unused, index) => `v${index}`);

    host.answer(async () => completion(["a", "a", "x".repeat(1001), 7, ...many]));

    const answered = await run(tools, input());

    expect(answered.values).toHaveLength(100);
    expect(answered.values.slice(0, 3)).toEqual(["a", "v0", "v1"]);
    expect(answered.hasMore).toBe(false);
  });

  it("is cancelled with the request: the host is told, and the answer reads nothing", async () => {
    const { host, tools } = await started();
    const stop = new AbortController();
    let untilAborted: (() => Promise<void>) | undefined;

    host.answer(async (_request, hooks) => {
      untilAborted = hooks.untilAborted;

      return new Promise(() => undefined);
    });

    const answered = run(tools, input({ signal: stop.signal }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();

    expect(await answered).toMatchObject({ status: "failed", values: [] });
    await expect(untilAborted?.()).resolves.toBeUndefined();
  });
});
