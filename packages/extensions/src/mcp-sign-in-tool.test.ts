// `mcp_sign_in_ask` and the fail-fast error that points at it (`docs/architecture/mcp-sign-in.md` → Sign-in requests):
// registered only when the set has an OAuth-capable HTTP entry, deferred, the model's and the root's alone, and a call that
// waits on the owner's sign-in with no deadline. pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off anyUnknownInErrorContext:off globalJsonInEffect:off preferEffectRecord:off strictEffectProvide:off
import type { McpSignInKnownAskAnswer } from "@cloudpid/mcp/types";
import {
  McpHostCallFailed,
  SignInRequired,
  StepUpRequired,
  Unreachable,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { DOCS, deferredIn, detailsOf, open, results, startOf } from "./mcp.fixture.ts";
import { makeMcpTools, memoryMcpToolsStore } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { createMcpSignIns, MCP_SIGN_IN_TOOL, type McpSignInStorage } from "./mcp/sign-in.ts";
import { mcpServersIntro } from "./mcp/servers.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { answer, call, context, openSubagentHarness } from "./subagents/harness.fixture.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const OPEN: McpSignInKnownAskAnswer = {
  status: "open",
  first: true,
  key: "key-1",
  why: "required",
  scopes: [],
  source: { kind: "global" },
  urlHost: "docs-site.test",
};

const memoryStorage = () => {
  const map = new Map<string, unknown>();

  const storage: McpSignInStorage = {
    // SAFETY: the requests read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return storage;
};

/** The Session's Sign-in requests over memory, with the Registry's answers and what it was told. */
const requestsOf = (answerOf: () => McpSignInKnownAskAnswer = () => OPEN) => {
  const withdrawn: string[] = [];
  const told: string[] = [];

  const signIns = createMcpSignIns({
    storage: memoryStorage(),
    registry: {
      ask: () => Effect.sync(answerOf),
      withdraw: (request) =>
        Effect.sync(() => {
          withdrawn.push(request);
        }),
    },
    announce: () => Effect.void,
    notify: ({ server }) =>
      Effect.sync(() => {
        told.push(server);
      }),
    redact: (value) => Effect.succeed(value),
  });

  return { signIns, withdrawn, told };
};

const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const SERVER: FakeMcpServer = { ...DOCS, state: "sign_in", tools: [] };

/** What each kind of entry can do: the only one that can need a sign-in is an HTTP server with no sign-in of its own. */
const ENTRIES: ReadonlyArray<readonly [string, FakeMcpServer["entry"], boolean]> = [
  ["an HTTP server", undefined, true],
  ["an HTTP server with an authorization-code OAuth block", { oauth: { clientId: "a" } }, true],
  [
    "an HTTP server that sends its own Authorization header",
    { headers: { authorization: "x" } },
    false,
  ],
  [
    "an HTTP server that signs in with client credentials",
    { oauth: { grantType: "client_credentials", clientId: "a" } },
    false,
  ],
  ["a stdio server", { type: "stdio" }, false],
];

const builtWith = async (
  servers: ReadonlyArray<FakeMcpServer>,
  requests = requestsOf(),
  more: { readonly appOrigin?: string } = {},
) => {
  const host = fakeMcpHost(servers);

  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), {
    slackMs: 0,
    signIns: requests.signIns,
    environment: "env_1",
    connectWaitMs: 50,
    ...more,
  });

  return { host, tools, ...requests };
};

describe("mcp_sign_in_ask's registration", () => {
  it.each(ENTRIES)("for %s is %s", async (_name, entry, registered) => {
    const { tools } = await builtWith([entry === undefined ? SERVER : { ...SERVER, entry }]);

    await Effect.runPromise(tools.requestStart(startOf(1)));

    const names: ReadonlyArray<string> = Option.match(tools.reinstall([]), {
      onNone: () => [],
      onSome: ({ mcp }) => (mcp.tools ?? []).map((tool) => tool.name),
    });

    expect(names.includes(MCP_SIGN_IN_TOOL)).toBe(registered);
  });

  it("is absent without the Session's Sign-in requests, and for a build whose servers are all off", async () => {
    const host = fakeMcpHost([SERVER]);
    const bare = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0 });

    await Effect.runPromise(bare.requestStart(startOf(1)));

    const names = Option.match(bare.reinstall([]), {
      onNone: () => [],
      onSome: ({ mcp }) => (mcp.tools ?? []).map((tool) => tool.name),
    });

    expect(names).not.toContain(MCP_SIGN_IN_TOOL);

    const { tools } = await builtWith([{ ...SERVER, state: "disabled" }]);

    await Effect.runPromise(tools.requestStart(startOf(1)));
    expect(
      Option.match(tools.reinstall([]), {
        onNone: () => [],
        onSome: ({ mcp }) => (mcp.tools ?? []).map((tool) => tool.name),
      }),
    ).not.toContain(MCP_SIGN_IN_TOOL);
  });

  it("is deferred and the model's alone, and turns on the intro sentence", async () => {
    const { tools } = await builtWith([SERVER]);

    await Effect.runPromise(tools.requestStart(startOf(1)));

    const built = Option.getOrThrow(tools.reinstall([]));
    const tool = (built.mcp.tools ?? []).find((each) => each.name === MCP_SIGN_IN_TOOL);

    expect(tool).toMatchObject({ deferred: true, callers: ["model"], replay: "safe" });

    expect(
      mcpServersIntro({ resourceTools: false, signIn: true, codemodeDeferred: false }),
    ).toContain(MCP_SIGN_IN_TOOL);
  });

  it("is not named in the deferred_tools list", async () => {
    const { tools } = await builtWith([SERVER]);
    const session = await open(() => answer("ok"));

    await session.start(tools);
    await session.prompt("hi");

    const system = session.requests.at(-1)?.system;

    expect(deferredIn(system)).not.toContain(MCP_SIGN_IN_TOOL);
  });

  it("cannot be granted to a subagent", () => {
    const ceiling = ["bash", MCP_SIGN_IN_TOOL];

    expect(resolveTools(undefined, ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      success: { tools: ["bash"] },
    });
    expect(resolveTools([MCP_SIGN_IN_TOOL], ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      failure: expect.stringContaining(`${MCP_SIGN_IN_TOOL} is unknown or outside`),
    });
  });
});

/** A session whose model asks for the sign-in, then says `ok`. */
const asking = async (
  setup: Awaited<ReturnType<typeof builtWith>>,
  args: Record<string, string> = { server: "Docs-Site", reason: "I need the docs" },
) => {
  // The tool is deferred: the model loads it with `tool_search`, then asks.
  let step = 0;

  const session = await open(() => {
    step += 1;

    if (step === 1) return call(["tool_search", { query: "sign in" }]);

    return step === 2 ? call([MCP_SIGN_IN_TOOL, args]) : answer("ok");
  });

  await session.start(setup.tools);

  const submitted = await session.root.submit({ type: "input", content: "go" }, context);

  return { session, submitted };
};

describe("mcp_sign_in_ask", () => {
  it("waits for the owner, who signs in, and says what the server gives from the next request", async () => {
    const setup = await builtWith([SERVER]);
    const { session, submitted } = await asking(setup);

    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length > 0);

    const [request] = await Effect.runPromise(setup.signIns.pending);

    expect(request).toMatchObject({ server: "Docs-Site", reason: "I need the docs" });
    expect(setup.told).toEqual(["Docs-Site"]);

    // The owner signs in: the host rediscovers the server, which now has tools.
    setup.host.set([{ ...DOCS, tools: [DOCS.tools[0]!, DOCS.tools[1]!] }]);
    await Effect.runPromise(setup.signIns.resolve([request?.id ?? ""]));
    await submitted.wait(context);

    expect((await session.texts("toolResult")).at(-1)).toBe(
      "Signed in to Docs-Site. 2 tools from your next request.",
    );
    expect((await detailsOf(session)).at(-1)).toMatchObject({
      server: "Docs-Site",
      sign_in_request: "signed_in",
    });
  });

  it("counts the tools of the own endpoint without the ones Self-use hides", async () => {
    const own: FakeMcpServer = { ...SERVER, name: "cloudpid" };
    const setup = await builtWith([own], requestsOf(), { appOrigin: "https://cloudpid.test" });

    const { session, submitted } = await asking(setup, { server: "cloudpid", reason: "I need it" });

    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length > 0);

    const [request] = await Effect.runPromise(setup.signIns.pending);

    setup.host.set([
      {
        ...DOCS,
        name: "cloudpid",
        tools: [{ name: "environment_list" }, { name: "session_get" }, { name: "sessions_list" }],
      },
    ]);
    await Effect.runPromise(setup.signIns.resolve([request?.id ?? ""]));
    await submitted.wait(context);

    expect((await session.texts("toolResult")).at(-1)).toBe(
      "Signed in to cloudpid. 2 tools from your next request.",
    );
  });

  it("says the server is still connecting when it has not connected by the time the answer is read", async () => {
    const setup = await builtWith([SERVER]);
    const { session, submitted } = await asking(setup);

    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length > 0);
    await Effect.runPromise(setup.signIns.resolve(["signin-1"]));
    await submitted.wait(context);

    expect((await session.texts("toolResult")).at(-1)).toContain("still connecting");
  });

  it("tells the agent what a decline means, with the owner's reason, and not to ask again", async () => {
    const setup = await builtWith([SERVER]);
    const { session, submitted } = await asking(setup);

    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length > 0);
    await Effect.runPromise(setup.signIns.decline("signin-1", "not now"));
    await submitted.wait(context);

    const text = (await session.texts("toolResult")).at(-1);

    expect(text).toContain("The owner declined to sign in to Docs-Site.");
    expect(text).toContain("Their reason: not now");
    expect(text).toContain("do not ask again");
    expect(setup.withdrawn).toEqual(["signin-1"]);
  });

  it("answers at once when the sign-in stands, and names no URL, code or token", async () => {
    const setup = await builtWith(
      [SERVER],
      requestsOf(() => ({ status: "signed_in" })),
    );

    const { session, submitted } = await asking(setup);

    await submitted.wait(context);

    const text = (await session.texts("toolResult")).at(-1);

    expect(text).toMatch(/^Signed in to Docs-Site/);
    expect(text).not.toContain("http");
  });

  it("is refused for a name no enabled server has, naming the servers that can need a sign-in", async () => {
    const setup = await builtWith([SERVER]);
    const { session, submitted } = await asking(setup, { server: "nowhere", reason: "x" });

    await submitted.wait(context);

    const [isError, content] = (await results(session)).at(-1) ?? [];

    expect(isError).toBe(true);
    expect(JSON.stringify(content)).toContain("Servers that can need a sign-in: Docs-Site");
    expect(await Effect.runPromise(setup.signIns.pending)).toEqual([]);
  });

  it.each([
    ["a stdio server", { type: "stdio" }],
    ["a server with its own Authorization header", { headers: { authorization: "Bearer ${T}" } }],
    [
      "a server that signs in on its own",
      { oauth: { grantType: "client_credentials", clientId: "a" } },
    ],
  ] as const)("answers not_applicable, a result and not an error, for %s", async (_name, entry) => {
    const other: FakeMcpServer = { ...DOCS, name: "other", state: "sign_in", tools: [], entry };

    const setup = await builtWith(
      [SERVER, other],
      requestsOf(() => ({ status: "not_applicable", reason: "it has no sign-in of the owner's" })),
    );

    const { session, submitted } = await asking(setup, { server: "other", reason: "x" });

    await submitted.wait(context);

    const [isError, content] = (await results(session)).at(-1) ?? [];

    expect(isError).toBe(false);
    expect(JSON.stringify(content)).toContain("it has no sign-in of the owner's");
    expect((await detailsOf(session)).at(-1)).toMatchObject({
      server: "other",
      sign_in_request: "not_applicable",
    });
    expect(await Effect.runPromise(setup.signIns.pending)).toEqual([]);
  });

  it("tells the agent a request ended when its server was removed, switched off or hidden", async () => {
    const setup = await builtWith([SERVER]);
    const { session, submitted } = await asking(setup);

    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length > 0);
    await Effect.runPromise(setup.signIns.withdrawServer("Docs-Site", "Docs-Site was removed"));
    await submitted.wait(context);

    const [isError, content] = (await results(session)).at(-1) ?? [];

    expect(isError).toBe(false);
    expect(JSON.stringify(content)).toContain("Docs-Site was removed. Nothing was signed in");
    expect((await detailsOf(session)).at(-1)).toMatchObject({ sign_in_request: "withdrawn" });
  });

  it("is an error, step_up_failed, when the Registry says the server still wants more access after the step-ups", async () => {
    const setup = await builtWith(
      [SERVER],
      requestsOf(() => ({
        status: "step_up_failed",
        reason: "asked three times",
        scopes: ["issues:write"],
      })),
    );

    const { session, submitted } = await asking(setup);

    await submitted.wait(context);

    const [isError, content] = (await results(session)).at(-1) ?? [];

    expect(isError).toBe(true);
    expect(JSON.stringify(content)).toContain("still wants more access");
    expect((await detailsOf(session)).at(-1)).toMatchObject({ sign_in_request: "step_up_failed" });
  });

  it("is never step_up_failed because the server is slow to connect after a step-up: it says it is still connecting", async () => {
    const setup = await builtWith(
      [SERVER],
      requestsOf(() => ({ ...OPEN, why: "step_up", scopes: ["issues:write"] })),
    );

    const { session, submitted } = await asking(setup);

    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length > 0);
    // The owner completed the step-up; the host still reads `sign_in` when the wait is over.
    await Effect.runPromise(setup.signIns.resolve(["signin-1"]));
    await submitted.wait(context);

    const [isError, content] = (await results(session)).at(-1) ?? [];

    expect(isError).toBe(false);
    expect(JSON.stringify(content)).toContain("still connecting");
    expect(JSON.stringify(content)).not.toContain("more access");
    expect((await detailsOf(session)).at(-1)).toMatchObject({ sign_in_request: "signed_in" });
  });

  it("is a call Stop ends: the request goes and its waiter is withdrawn", async () => {
    const setup = await builtWith([SERVER]);
    const { session, submitted } = await asking(setup);

    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length > 0);
    await session.root.abort(context);
    await submitted.wait(context).catch(() => undefined);
    await until(async () => (await Effect.runPromise(setup.signIns.pending)).length === 0);

    expect(setup.withdrawn).toEqual(["signin-1"]);
  });
});

describe("a call that failed fast for a sign-in", () => {
  const failing = (error: Parameters<typeof McpHostCallFailed.make>[0]["error"]) => async () =>
    McpHostCallFailed.make({ error });

  const run = async (
    error: Parameters<typeof McpHostCallFailed.make>[0]["error"],
    server: FakeMcpServer = DOCS,
  ) => {
    const host = fakeMcpHost([server]);

    host.answer(failing(error));

    const tools = makeMcpTools(host.client, memoryMcpToolsStore(), {
      slackMs: 0,
      signIns: requestsOf().signIns,
      environment: "env_1",
    });

    const session = await open((request) =>
      request.text === "go" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
    );

    await session.start(tools);
    await session.prompt("go");

    return session;
  };

  it("points the root at mcp_sign_in_ask, with details.sign_in saying why", async () => {
    const session = await run(
      SignInRequired.make({ message: "401 Unauthorized", rejected: false }),
    );

    const [isError, content] = (await results(session)).at(-1) ?? [];

    expect(isError).toBe(true);
    expect(JSON.stringify(content)).toContain("Docs-Site needs the owner to sign in");
    expect(JSON.stringify(content)).toContain("Ask with `mcp_sign_in_ask`");
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({ sign_in: { status: "required" } }),
    ]);
  });

  it("says rejected for a token the server refused, and step_up with the scope for a 403", async () => {
    const rejected = await run(SignInRequired.make({ message: "refused", rejected: true }));

    expect(await detailsOf(rejected)).toEqual([
      expect.objectContaining({ sign_in: { status: "rejected" } }),
    ]);

    const stepped = await run(StepUpRequired.make({ message: "403", scope: "issues:write" }));

    expect(await detailsOf(stepped)).toEqual([
      expect.objectContaining({ sign_in: { status: "step_up", scope: "issues:write" } }),
    ]);
    expect(JSON.stringify(await results(stepped))).toContain("issues:write");
  });

  it("says to try again shortly for a sign-in that cannot be used now, and asks nothing of the owner", async () => {
    const session = await run(Unreachable.make({ message: "refresh failed", signIn: true }));
    const content = (await results(session)).at(-1)?.[1];

    expect(JSON.stringify(content)).toContain("Try again shortly");
    expect(JSON.stringify(content)).not.toContain("mcp_sign_in_ask");
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({ sign_in: { status: "unavailable" } }),
    ]);
  });

  it("is an ordinary failure for an unreachable server that has nothing to do with a sign-in", async () => {
    const session = await run(Unreachable.make({ message: "connection refused" }));

    expect((await detailsOf(session))[0]).not.toHaveProperty("sign_in");
  });

  it("tells a subagent to report it to its parent, who alone can ask", async () => {
    const host = fakeMcpHost([DOCS]);

    host.answer(failing(SignInRequired.make({ message: "401", rejected: false })));

    const tools = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0 });

    const session = await openSubagentHarness((request) => {
      if (request.agent === "agent-1") {
        return request.text === "use docs" ? call(["mcp__docs_site__search", {}]) : answer("done");
      }

      return request.text === "go"
        ? call(["subagent", { task: "use docs", tools: ["mcp__docs_site__search"] }])
        : answer("ok");
    });

    await Effect.runPromise(tools.requestStart(startOf(1)));
    session.registry.install(Option.getOrThrow(tools.reinstall([])).mcp);
    await session.prompt("go");
    await session.settle();

    const child = (await session.state()).agents["agent-1"];
    const [text] = await session.texts("toolResult", child?.conversationId);

    expect(text).toContain("Report it to your parent");
    expect(text).not.toContain("mcp_sign_in_ask");
  });
});
