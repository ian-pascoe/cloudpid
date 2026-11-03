// `McpHost.request` over real Durable Object SQLite and a scripted engine (`docs/architecture/mcp-connections.md` → RPC,
// The engine → Load caps): what reaches the engine, what is refused before it, and how a cut call reads.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import type {
  McpAccessTokenAnswer,
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequest,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { MCP_UNASKED_TASK_MESSAGE } from "@cloudpid/mcp/types";
import { modernTaskServer, REPORT_TOOL } from "@cloudpid/mcp/testing";
import { env } from "cloudflare:workers";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

let counter = 0;

/** A host named as the main Worker names one, that no earlier test has touched. */
const freshHost = () => env.MCP_HOSTS.getByName(`mcp:request${counter++}`);

type Host = ReturnType<typeof freshHost>;

const urlOf = (name: string) => `https://${name}.example/mcp`;

const entry = (name: string, server: Readonly<Record<string, Schema.Json>> = {}): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: urlOf(name), headers: {}, ...server },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.hash}`).join("|"),
  revision: revision++,
  entries,
});

/** A discovery that found `tools` (by name). */
const found = (tools: ReadonlyArray<string>): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
});

/** A completed call that answered `text`. */
const completed = (text: string): typeof McpEngineRequestResult.Encoded => ({
  kind: "complete",
  result: { kind: "inline", value: { content: [{ type: "text", text }] } },
  cacheable: true,
  fetchedAt: Date.now(),
  state: {},
});

/** A `tools/call` of `tool` on `server`, as a Session sends it. */
const call = (
  server: string,
  tool: string,
  args: Readonly<Record<string, Schema.Json>> = { q: "x" },
): typeof McpHostRequest.Encoded => ({
  op: "tools/call",
  server,
  params: { name: tool, arguments: args },
  ctx: {
    origin: "agent",
    callId: "call-1",
    session: "s-1",
    conversation: "1",
    workspace: "ws:w-1",
  },
});

/** A host whose set is `entries`, each discovered with `tools`, its Registry answering `tokens` for each in turn. */
const discovered = async (
  tools: ReadonlyArray<string>,
  ...entries: ReadonlyArray<McpSetEntry & { readonly tokens?: ReadonlyArray<McpAccessTokenAnswer> }>
) => {
  const host = freshHost();

  await host.apply(setOf(...entries.map(({ tokens: _tokens, ...each }) => each)));

  for (const each of entries) {
    if (each.tokens !== undefined) await host.scriptToken(each.name, each.tokens);
  }

  for (const each of entries) await host.scriptEngine(urlOf(each.name), [found(tools)]);

  await host.requestStart({
    caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
    waitFor: entries.map((each) => each.name),
    waitMs: 5000,
  });

  return host;
};

const tagOf = async (host: Host, input: typeof McpHostRequest.Encoded) =>
  (await host.request(input, {}))._tag;

describe("a request", () => {
  it("sends a listed tool's call to the engine with the server's target, its rows and the tool's definition", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ result: completed("found") }]);

    const answer = await host.request(call("docs", "search"), {});

    expect(answer).toEqual({
      _tag: "Completed",
      result: { kind: "inline", value: { content: [{ type: "text", text: "found" }] } },
    });

    const [sent] = await host.engineRequests();

    expect(sent?.target).toMatchObject({ kind: "http", conn: "conn-docs", url: urlOf("docs") });
    expect(sent?.prior).toMatchObject({ era: expect.objectContaining({ era: "modern" }) });
    expect(sent?.request).toEqual({
      op: "tools/call",
      tool: { name: "search", inputSchema: { type: "object" } },
      arguments: { q: "x" },
      ctx: { origin: "agent", conversation: "1", workspace: "ws:w-1" },
    });
  });

  it("refuses what it cannot send, without reaching the engine", async () => {
    const host = await discovered(["search"], entry("docs"), entry("off", { enabled: false }));

    // An `op` a later build sends, as it crosses the edge to this host (parsed, so it is not typed as ours).
    const later: typeof McpHostRequest.Encoded = JSON.parse(
      JSON.stringify({ ...call("docs", "search"), op: "resources/read" }),
    );

    expect(await tagOf(host, later)).toBe("HostUnsupported");
    expect(await tagOf(host, call("nowhere", "search"))).toBe("UnknownServer");
    expect(await tagOf(host, call("docs", "missing"))).toBe("NotAllowed");
    expect(await tagOf(host, call("off", "search"))).toBe("NotAllowed");
    expect(await host.engineRequests()).toEqual([]);
  });

  it("answers a server that wants a sign-in with SignInRequired, without sending the call", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("auth")));
    await host.scriptEngine(urlOf("auth"), [
      {
        // SAFETY: a failure as it crosses the edge, encoded.
        result: {
          kind: "failed",
          error: { _tag: "SignInRequired", message: "401", rejected: false },
          state: {},
        } as typeof McpEngineDiscoverResult.Encoded,
      },
    ]);
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["auth"],
      waitMs: 5000,
    });

    expect(await host.request(call("auth", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired", rejected: false },
    });
    expect(await host.engineRequests()).toEqual([]);
  });

  it("reads a call the caller aborts, or the engine drops, as cut and maybe run", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      { result: completed("late"), hold: true },
      { result: completed("never"), reject: "the engine went away" },
    ]);

    let abort = () => {};

    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });

    const pending = host.request(call("docs", "search"), { untilAborted: () => aborted });

    // Once the engine holds the call, the caller aborts it.
    while ((await host.engineRequests()).length === 0) await new Promise((r) => setTimeout(r, 10));

    abort();

    expect(await pending).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Cut", mayHaveRun: true },
    });

    await host.release(urlOf("docs"));

    // A cut between the host and the engine says so, and never carries the cause to the Session.
    const lost = await host.request(call("docs", "search"), {});

    expect(lost).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Cut", mayHaveRun: true, lost: "engine" },
    });
    expect(JSON.stringify(lost)).not.toContain("went away");
  });

  it("returns a 16 MiB result as the engine's stream, unread, and the Session reads every byte", async () => {
    const host = await discovered(["search"], entry("docs"));
    const bytes = 16 * 1024 * 1024;

    await host.scriptRequest(urlOf("docs"), [
      { result: completed("streamed"), streamBytes: bytes },
      { result: completed("streamed"), streamBytes: bytes },
    ]);

    // In the host's own object, before the answer crosses RPC: the stream is neither locked nor pulled.
    expect(await host.requestStreamed(call("docs", "search"))).toEqual({
      tag: "Completed",
      stream: { locked: false, bytes },
    });
    expect(await host.streamPulls()).toBe(0);

    const answer = await host.request(call("docs", "search"), {});

    expect(answer).toMatchObject({ _tag: "Completed", result: { kind: "stream", bytes } });

    if (!Predicate.isTagged(answer, "Completed") || answer.result.kind !== "stream") return;

    let read = 0;

    for await (const chunk of answer.result.body) read += chunk.byteLength;

    expect(read).toBe(bytes);
    expect(await host.streamPulls()).toBeGreaterThan(0);
  });

  it("counts a wait for a free slot toward the timeout, and never sends a call still waiting when it passes", async () => {
    const host = await discovered(["search"], entry("slow", { timeout: 1 }));

    await host.scriptRequest(
      urlOf("slow"),
      Array.from({ length: 5 }, () => ({ result: completed("held"), hold: true })),
    );

    // Five calls fill the engine queue; the sixth waits for a slot.
    const holding = Array.from({ length: 5 }, () => host.request(call("slow", "search"), {}));

    while ((await host.engineRequests()).length < 5) await new Promise((r) => setTimeout(r, 10));

    expect(await host.request(call("slow", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Cut", mayHaveRun: false, message: expect.stringMatching(/not sent/) },
    });

    const sent = await host.engineRequests();

    expect(sent).toHaveLength(5);

    // A sent call gives the engine what is left of its timeout.
    for (const each of sent) {
      expect(each.target.timeoutMs).toBeGreaterThan(0);
      expect(each.target.timeoutMs).toBeLessThanOrEqual(1000);
    }

    await host.release(urlOf("slow"));
    await Promise.all(holding);
  });
});

/** A task the server started, as the engine reports it. */
const CREATED = {
  taskId: "task-1",
  status: "working",
  createdAt: "2026-01-01T00:00:00Z",
  lastUpdatedAt: "2026-01-01T00:00:00Z",
  ttlMs: 60_000,
} as const;

const started = (): typeof McpEngineRequestResult.Encoded => ({
  kind: "task",
  task: CREATED,
  state: {},
});

/** A `tasks/*` request of the task `started` made, on the server's current `conn`. */
const taskOp = (
  op: "tasks/get" | "tasks/update" | "tasks/cancel",
  server: string,
  over: {
    readonly conn?: string;
    readonly taskId?: string;
    readonly tool?: string;
    readonly inputResponses?: Readonly<Record<string, Schema.Json>>;
  } = {},
): typeof McpHostRequest.Encoded => {
  const params = {
    taskId: over.taskId ?? "task-1",
    tool: over.tool ?? "search",
    conn: over.conn ?? `conn-${server}`,
  };

  const { ctx } = call(server, "search");

  // SAFETY: each `op` with the params it takes, encoded.
  return (
    op === "tasks/update"
      ? { op, server, params: { ...params, inputResponses: over.inputResponses ?? {} }, ctx }
      : { op, server, params, ctx }
  ) as typeof McpHostRequest.Encoded;
};

const withCtx = (
  input: typeof McpHostRequest.Encoded,
  ctx: Partial<typeof McpHostRequest.Encoded.ctx>,
): typeof McpHostRequest.Encoded => ({ ...input, ctx: { ...input.ctx, ...ctx } });

describe("an MCP task", () => {
  it("is offered to a call from the agent or an app, to an HTTP server, and to no other caller", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(
      urlOf("docs"),
      Array.from({ length: 4 }, () => ({ result: completed("done") })),
    );

    const withTask = { allowTask: true };

    await host.request(withCtx(call("docs", "search"), withTask), {});
    await host.request(withCtx(call("docs", "search"), { ...withTask, origin: "app" }), {});
    await host.request(withCtx(call("docs", "search"), { ...withTask, origin: "owner" }), {});
    await host.request(withCtx(call("docs", "search"), { ...withTask, origin: "host" }), {});

    expect((await host.engineRequests()).map((sent) => sent.request.ctx)).toEqual([
      expect.objectContaining({ origin: "agent", allowTask: true }),
      expect.objectContaining({ origin: "app", allowTask: true }),
      { origin: "owner", conversation: "1", workspace: "ws:w-1" },
      { origin: "host", conversation: "1", workspace: "ws:w-1" },
    ]);

    await host.scriptRequest(urlOf("docs"), [{ result: completed("done") }]);
    await host.request(call("docs", "search"), {});
    expect((await host.engineRequests()).at(-1)?.request.ctx).not.toHaveProperty("allowTask");
  });

  it("answers a started task with the server's conn and identity and the sign-in the call was made with", async () => {
    const host = await signedIn([granted(TOKEN)]);

    await host.scriptRequest(urlOf("sentry"), [{ result: started(), auth: [false] }]);

    expect(
      await host.request(withCtx(call("sentry", "search"), { allowTask: true }), {}),
    ).toMatchObject({
      _tag: "Task",
      task: { taskId: "task-1", status: "working" },
      conn: "conn-sentry",
      identity: "identity-sentry",
      signIn: "grant-1",
    });
  });

  it("fails a call that was not offered a task when the engine answers one", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ result: started() }, { result: started() }]);

    for (const origin of ["agent", "owner"] as const) {
      expect(await host.request(withCtx(call("docs", "search"), { origin }), {})).toMatchObject({
        _tag: "CallFailed",
        error: { _tag: "ProtocolViolation" },
      });
    }
  });

  it("reads a task with tasks/get, its result with the tool's checks, and takes an update and a cancel", async () => {
    const host = await signedIn([granted(TOKEN)]);

    await host.scriptRequest(urlOf("sentry"), [
      {
        result: {
          kind: "task_state",
          task: { ...CREATED, status: "completed" },
          result: { kind: "inline", value: { content: [{ type: "text", text: "report" }] } },
          fetchedAt: Date.now(),
          state: {},
        },
        auth: [false],
      },
      { result: { kind: "task_ack", state: {} }, auth: [false] },
      { result: { kind: "task_ack", state: {} }, auth: [false] },
    ]);

    expect(await host.request(taskOp("tasks/get", "sentry"), {})).toMatchObject({
      _tag: "TaskState",
      task: { status: "completed" },
      result: { kind: "inline" },
      signIn: "grant-1",
    });
    expect(await host.request(taskOp("tasks/update", "sentry"), {})).toMatchObject({
      _tag: "TaskAck",
      signIn: "grant-1",
    });
    expect(await tagOf(host, taskOp("tasks/cancel", "sentry"))).toBe("TaskAck");

    const sent = await host.engineRequests();

    expect(sent.map((each) => each.request.op)).toEqual([
      "tasks/get",
      "tasks/update",
      "tasks/cancel",
    ]);
    expect(sent[0]?.request).toMatchObject({
      taskId: "task-1",
      tool: { name: "search" },
      ctx: { allowTask: true },
    });
  });

  it("answers ServerChanged, sending nothing, when the server's conn is not the one the task started on", async () => {
    const host = await discovered(["search"], entry("docs"));

    expect(await host.request(taskOp("tasks/get", "docs", { conn: "conn-old" }), {})).toEqual({
      _tag: "ServerChanged",
      message: expect.stringContaining("changed"),
      conn: "conn-docs",
      identity: "identity-docs",
    });
    expect(await host.engineRequests()).toEqual([]);
  });

  it("lets a switched-off server's task be cancelled, and read or updated no more", async () => {
    const host = await discovered(["search"], entry("off", { enabled: false }));

    await host.scriptRequest(urlOf("off"), [{ result: { kind: "task_ack", state: {} } }]);

    expect(await tagOf(host, taskOp("tasks/get", "off"))).toBe("NotAllowed");
    expect(await tagOf(host, taskOp("tasks/update", "off"))).toBe("NotAllowed");
    expect(await tagOf(host, taskOp("tasks/cancel", "off"))).toBe("TaskAck");
  });

  it("refuses a malformed task request, and an unknown server's", async () => {
    const host = await discovered(["search"], entry("docs"));

    // A `tasks/get` with no `taskId`, as it crosses the edge.
    const bare: typeof McpHostRequest.Encoded = JSON.parse(
      JSON.stringify({ ...taskOp("tasks/get", "docs"), params: {} }),
    );

    expect(await tagOf(host, bare)).toBe("NotAllowed");
    expect(await tagOf(host, taskOp("tasks/get", "nowhere"))).toBe("UnknownServer");
  });
});

/** What the engine answered `call` with, when it did not answer what the call asked for. */
const taskAnswers = {
  task: started(),
  state: {
    kind: "task_state",
    task: { ...CREATED, status: "working" },
    fetchedAt: Date.now(),
    state: {},
  },
  ack: { kind: "task_ack", state: {} },
} satisfies Record<string, typeof McpEngineRequestResult.Encoded>;

describe("an engine answer that is not what the request asked for", () => {
  const MISMATCHES = [
    ["tools/call", "task_state", taskAnswers.state],
    ["tools/call", "task_ack", taskAnswers.ack],
    ["tasks/get", "complete", completed("late")],
    ["tasks/get", "task", taskAnswers.task],
    ["tasks/get", "task_ack", taskAnswers.ack],
    ["tasks/update", "complete", completed("late")],
    ["tasks/update", "task_state", taskAnswers.state],
    ["tasks/cancel", "task", taskAnswers.task],
    ["tasks/cancel", "task_state", taskAnswers.state],
  ] as const;

  it.each(MISMATCHES)(
    "fails %s answered with %s as a protocol violation",
    async (op, _kind, answer) => {
      const host = await discovered(["search"], entry("docs"));

      await host.scriptRequest(urlOf("docs"), [{ result: answer }]);

      const input = op === "tools/call" ? call("docs", "search") : taskOp(op, "docs");

      expect(await host.request(input, {})).toMatchObject({
        _tag: "CallFailed",
        error: { _tag: "ProtocolViolation" },
      });
    },
  );

  it("names a task that was not asked for the same in the host as in the core", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ result: started() }]);

    expect(await host.request(call("docs", "search"), {})).toMatchObject({
      error: { message: MCP_UNASKED_TASK_MESSAGE },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an MCP task through the real engine", () => {
  it("starts, is read, updated and cancelled over a fake Modern task server, and a call without allowTask gets the result", async () => {
    const server = modernTaskServer();

    // Every outbound `fetch` of the test Worker, the engine's included, reaches the fake server.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    const host = freshHost();

    await host.useRealEngine();
    await host.apply(setOf(entry("docs")));
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["docs"],
      waitMs: 10_000,
    });

    const report = (
      args: Readonly<Record<string, Schema.Json>>,
      ctx: Partial<typeof McpHostRequest.Encoded.ctx>,
    ) => withCtx(call("docs", REPORT_TOOL.name, args), ctx);

    const plain = await host.request(report({ region: "eu" }, {}), {});

    expect(plain).toMatchObject({ _tag: "Completed", result: { kind: "inline" } });
    expect(server.tasks.size).toBe(0);

    const made = await host.request(report({ region: "eu", ask: true }, { allowTask: true }), {});

    expect(made).toMatchObject({
      _tag: "Task",
      task: { taskId: "task-1", status: "input_required" },
      conn: "conn-docs",
      identity: "identity-docs",
    });
    expect(server.declared.at(-1)).toEqual({ method: "tools/call", tasks: true });

    const asked = { tool: "report" };

    expect(
      await host.request(
        taskOp("tasks/update", "docs", {
          ...asked,
          inputResponses: { which: { action: "accept", content: { region: "eu" } } },
        }),
        {},
      ),
    ).toMatchObject({ _tag: "TaskAck" });
    expect(await host.request(taskOp("tasks/get", "docs", asked), {})).toMatchObject({
      _tag: "TaskState",
      task: { status: "completed" },
      result: { kind: "inline", value: { content: [{ type: "text", text: "report:eu" }] } },
    });

    const second = await host.request(report({ region: "eu", polls: 9 }, { allowTask: true }), {});

    expect(second).toMatchObject({ _tag: "Task", task: { taskId: "task-2" } });
    expect(
      await host.request(taskOp("tasks/cancel", "docs", { ...asked, taskId: "task-2" }), {}),
    ).toMatchObject({ _tag: "TaskAck" });
    expect(server.tasks.get("task-2")?.status).toBe("cancelled");
  });
});

const TOKEN = "access-token-0001-secret";
const NEXT = "access-token-0002-secret";

/** The Registry's answer with `token` for `sentry`. */
const granted = (token: string): McpAccessTokenAnswer => ({
  status: "ok",
  token,
  resource: urlOf("sentry"),
  signIn: "grant-1",
});

/** A call the server failed with `error`, as the engine sends it. */
const failedCall = (error: Readonly<Record<string, Schema.Json>>) =>
  // SAFETY: a failure as it crosses the edge, encoded.
  ({ kind: "failed", error, state: {} }) as typeof McpEngineRequestResult.Encoded;

const unauthorized = failedCall({ _tag: "SignInRequired", message: "401", rejected: false });

/** `sentry` in a host's set, discovered, with its Registry answering `tokens` in turn (the last for good). */
const signedIn = (tokens: ReadonlyArray<McpAccessTokenAnswer>) =>
  discovered(["search"], { ...entry("sentry"), tokens });

describe("a request to a server with a sign-in", () => {
  it("carries the sign-in's token through the engine's auth hook, never in the target", async () => {
    const host = await signedIn([granted(TOKEN)]);

    await host.scriptRequest(urlOf("sentry"), [{ result: completed("found"), auth: [false] }]);

    expect(await tagOf(host, call("sentry", "search"))).toBe("Completed");

    const [sent] = await host.engineRequests();

    expect(sent?.hooks).toContain("auth");
    expect(sent?.tokens).toEqual([TOKEN]);
    expect(sent?.target).not.toHaveProperty("headers.Authorization");
    expect(await host.reports()).toEqual([]);
  });

  it("asks again with the refused token as stale after a 401, and reports rejected when the fresh one is refused too", async () => {
    const host = await signedIn([granted(TOKEN), granted(NEXT)]);

    await host.scriptRequest(urlOf("sentry"), [
      { result: completed("found"), auth: [false, true] },
      { result: unauthorized, auth: [false, true] },
    ]);

    // The first 401 is answered with a refreshed token, and the retry works: nothing to report.
    expect(await tagOf(host, call("sentry", "search"))).toBe("Completed");
    expect((await host.engineRequests())[0]?.tokens).toEqual([TOKEN, NEXT]);
    expect((await host.tokenAsks()).at(-1)).toMatchObject({ server: "sentry", stale: TOKEN });
    expect(await host.reports()).toEqual([]);

    // Refused after its refresh too: the sign-in is `rejected`, once.
    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired" },
    });
    expect(await host.reports()).toEqual([
      expect.objectContaining({ server: "sentry", event: "rejected" }),
    ]);
  });

  it("calls with no token when the Registry has none, and reports needs_sign_in on a 401", async () => {
    const host = await signedIn([{ status: "required", reason: "Not signed in" }]);

    await host.scriptRequest(urlOf("sentry"), [{ result: unauthorized }]);

    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "SignInRequired" },
    });
    expect((await host.engineRequests())[0]?.hooks).not.toContain("auth");
    expect(await host.reports()).toEqual([
      expect.objectContaining({ server: "sentry", event: "needs_sign_in" }),
    ]);
  });

  it("is not sent when no token stands, and reports a 403 for more scope as a step-up", async () => {
    const host = await signedIn([
      { status: "required", reason: "Not signed in" },
      { status: "step_up", reason: "More scope", scope: "admin" },
      granted(TOKEN),
    ]);

    // The discovery went without a token; the call finds a step-up the owner has not done: a step-up, with its scope,
    // which a Session words as "needs the owner to sign in again" and not as a first sign-in.
    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "StepUpRequired", scope: "admin" },
    });
    expect(await host.engineRequests()).toEqual([]);

    await host.scriptRequest(urlOf("sentry"), [
      {
        result: failedCall({ _tag: "StepUpRequired", message: "403", scope: "admin" }),
        auth: [false],
      },
    ]);

    expect(await tagOf(host, call("sentry", "search"))).toBe("CallFailed");
    expect(await host.reports()).toEqual([
      expect.objectContaining({
        server: "sentry",
        event: "step_up",
        challenge: { scope: "admin" },
      }),
    ]);
  });
});

describe("a request that is not sent for a sign-in that cannot be used for now", () => {
  it.each([
    ["refresh_failing", "Can't refresh the sign-in: The server refused the refresh"],
    ["unavailable", "The sign-in is not available"],
  ] as const)(
    "says the owner's own sign-in is the cause (signIn) when the Registry answers %s",
    async (status, message) => {
      // The discovery went without a token (a server never signed in to may need none); the call finds none that serves.
      const host = await signedIn([
        { status: "required", reason: "Not signed in" },
        {
          status,
          reason: status === "refresh_failing" ? "The server refused the refresh" : message,
        },
      ]);

      expect(await host.request(call("sentry", "search"), {})).toMatchObject({
        _tag: "CallFailed",
        error: { _tag: "Unreachable", message, signIn: true },
      });
      expect(await host.engineRequests()).toEqual([]);
    },
  );
});

describe("a request to a server that signs in on its own", () => {
  const GRANT = {
    oauth: {
      grantType: "client_credentials",
      clientId: "cloudpid-prod",
      clientSecret: "${CLIENT_SECRET}",
      issuer: "https://auth.example.com",
    },
  } as const;

  const grantHost = (tokens: ReadonlyArray<McpAccessTokenAnswer>) =>
    discovered(["search"], { ...entry("sentry", GRANT), tokens });

  const noToken = (
    status: "required" | "step_up" | "rejected" | "refresh_failing" | "unavailable" | "failed",
    reason: string,
  ): McpAccessTokenAnswer => ({ status, reason });

  it("carries the Registry's token through the auth hook and reports nothing", async () => {
    const host = await grantHost([granted(TOKEN)]);

    await host.scriptRequest(urlOf("sentry"), [{ result: completed("found"), auth: [false] }]);

    expect(await tagOf(host, call("sentry", "search"))).toBe("Completed");

    const [sent] = await host.engineRequests();

    expect(sent?.hooks).toContain("auth");
    expect(sent?.tokens).toEqual([TOKEN]);
    expect(await host.reports()).toEqual([]);
  });

  it("is not sent, and fails as unreachable with the Registry's problem, when there is no token, whatever the status", async () => {
    for (const status of [
      "failed",
      "required",
      "step_up",
      "rejected",
      "refresh_failing",
    ] as const) {
      // The discovery's token has run out by the call, and the Registry has none to give instead.
      const host = await grantHost([
        {
          status: "ok",
          token: TOKEN,
          resource: urlOf("sentry"),
          signIn: "grant-1",
          expiresAt: Date.now(),
        },
        noToken(status, "The client id is not accepted"),
      ]);

      expect(await host.request(call("sentry", "search"), {})).toMatchObject({
        _tag: "CallFailed",
        error: { _tag: "Unreachable", message: "The client id is not accepted" },
      });
      expect(await host.engineRequests()).toEqual([]);
      expect(await host.reports()).toEqual([]);
    }
  });

  it("never marks a refresh that fails, or a Registry that is not available, as a sign-in the owner could give", async () => {
    for (const status of ["refresh_failing", "unavailable"] as const) {
      const host = await grantHost([
        {
          status: "ok",
          token: TOKEN,
          resource: urlOf("sentry"),
          signIn: "grant-1",
          expiresAt: Date.now(),
        },
        noToken(status, "The authorization server did not answer"),
      ]);

      const answer = await host.request(call("sentry", "search"), {});

      expect(answer).toMatchObject({
        _tag: "CallFailed",
        error: { _tag: "Unreachable", message: expect.stringContaining("did not answer") },
      });
      // No `signIn`: the Session adds no `details.sign_in` and never says to ask the owner.
      expect(answer).not.toHaveProperty("error.signIn");
    }
  });

  it("asks again with the refused token as stale after a 401, and retries with the renewed one", async () => {
    const host = await grantHost([granted(TOKEN), granted(NEXT)]);

    await host.scriptRequest(urlOf("sentry"), [
      { result: completed("found"), auth: [false, true] },
    ]);

    expect(await tagOf(host, call("sentry", "search"))).toBe("Completed");
    expect((await host.engineRequests())[0]?.tokens).toEqual([TOKEN, NEXT]);
    expect((await host.tokenAsks()).at(-1)).toMatchObject({ server: "sentry", stale: TOKEN });
    expect(await host.reports()).toEqual([]);
  });

  it("fails as unreachable, never as a sign-in, when the renewed token is refused too, and reports nothing", async () => {
    const host = await grantHost([granted(TOKEN), granted(NEXT)]);

    await host.scriptRequest(urlOf("sentry"), [{ result: unauthorized, auth: [false, true] }]);

    const answer = await host.request(call("sentry", "search"), {});

    expect(answer).toMatchObject({
      _tag: "CallFailed",
      error: {
        _tag: "Unreachable",
        message: expect.stringContaining("refused the access token its client credentials gave"),
      },
    });
    expect(JSON.stringify(answer)).not.toContain("SignInRequired");
    expect(JSON.stringify(answer)).not.toContain("mcp_sign_in_ask");
    expect(await host.reports()).toEqual([]);
  });

  it("says the Registry's problem, not the server's bare refusal, when the renewal after a 401 fails", async () => {
    const host = await grantHost([
      granted(TOKEN),
      noToken(
        "failed",
        "The authorization server does not accept the entry's client id (invalid_client)",
      ),
    ]);

    await host.scriptRequest(urlOf("sentry"), [{ result: unauthorized, auth: [false, true] }]);

    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Unreachable", message: expect.stringContaining("invalid_client") },
    });
    expect(await host.reports()).toEqual([]);
  });

  it("fails as unreachable, naming the scope and the setting, for a 403 for more scope, and reports nothing", async () => {
    const host = await grantHost([granted(TOKEN)]);

    await host.scriptRequest(urlOf("sentry"), [
      {
        result: failedCall({ _tag: "StepUpRequired", message: "403", scope: "write" }),
        auth: [false],
      },
    ]);

    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Unreachable", message: expect.stringMatching(/scope write.*oauth\.scope/) },
    });
    expect(await host.reports()).toEqual([]);
  });

  it("leaves the server's other failures as they are", async () => {
    const host = await grantHost([granted(TOKEN)]);

    await host.scriptRequest(urlOf("sentry"), [
      {
        result: failedCall({ _tag: "OtherMcpError", message: "boom" }),
        auth: [false],
      },
    ]);

    expect(await host.request(call("sentry", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "OtherMcpError" },
    });
  });
});
