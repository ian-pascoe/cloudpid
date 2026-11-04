// An MCP task the agent's call started, followed end to end (`docs/architecture/mcp-server-requests.md` → MCP tasks): the
// call goes Session → host → the real `McpEngine` → a fake Modern server that answers `report` with a task. One that ends
// inside the window returns as a synchronous call would; one still going at the window's end detaches, and the Session's
// follower polls it until it ends, writes the ended entry and starts a follow-up Run, which the owner is pushed the end
// of; `mcp_task_wait` reads the result; an eviction of the Session in either phase loses nothing and sends `tools/call` once;
// a server that cannot be reached is retried, one that does not know the task is given a grace and then `unknown`, one that
// ignores `tasks/cancel` is `stopped`; and the server's task id reaches nothing the model, a client, a log or the Session's
// storage holds. The times are shortened with `mcpTaskTiming` (`host.fixture.ts`): nothing else is changed.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off globalDate:off
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { modernTaskServer, rpcMethods, type TaskServer } from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import type { ApiResult, SessionVia } from "@cloudpid/protocol";
import { type ClientMessage, type ServerMessage, ServerMessageJson } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 15_000, interval: 50 });

let counter = 0;

/** The Sessions a test opened: stopped after it, so no follower of one polls through the next test's server. */
const sessions: Array<DurableObjectStub<TestSession>> = [];

const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: "https://docs.example/mcp", headers: {}, exposure: "direct" },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
};

/** Times that fit a test: a window of 400 ms, a poll every 50 ms, a grace of 300 ms. */
const TIMING = {
  windowMs: 400,
  pollMs: 50,
  unknownGraceMs: 300,
  backoffMs: 100,
  cancelGraceMs: 300,
};

const REPORT = (
  args: { readonly region?: string; readonly polls?: number; readonly inline?: boolean } = {},
) => `call:mcp__docs__report:${JSON.stringify(args)}`;

/** The fake server's own id for a task: `task-1`, which the model, a client, a log and the storage must never hold. */
const SERVER_ID = /(?<![\w-])task-\d/;

/** What a test can change in the fetch the host's engine reaches the server with. */
type Wire = {
  /** Reject `tasks/get` as an unreachable server does. */
  unreachable: boolean;
  /** Answer `tasks/cancel` with an acknowledgement and do nothing. */
  ignoreCancel: boolean;
  /** The `tasks/cancel` the fetch answered itself. */
  ignored: number;
  /** Never answer `tasks/cancel`: the request hangs, as one to a server that has stopped responding does. */
  hangCancel: boolean;
};

const rpcMethodOf = async (request: Request): Promise<string | undefined> => {
  try {
    // SAFETY: the engine posts JSON-RPC bodies.
    const body = (await request.clone().json()) as { readonly method?: string };

    return body.method;
  } catch {
    return undefined;
  }
};

/** A Session whose host runs the real engine against a fake Modern server that has the `report` tool. */
const open = async (timing: Record<string, number> = TIMING, name = "mcp") => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const server = modernTaskServer();
  const wire: Wire = { unreachable: false, ignoreCancel: false, ignored: 0, hangCancel: false };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const method = await rpcMethodOf(request);

    if (wire.unreachable && method === "tasks/get") throw new TypeError("Network connection lost");

    if (wire.hangCancel && method === "tasks/cancel") return new Promise<Response>(() => {});

    if (wire.ignoreCancel && method === "tasks/cancel") {
      wire.ignored += 1;

      return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } });
    }

    return server.handle(request);
  });

  await host.useRealEngine();
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`${name}-${environment}`);

  sessions.push(stub);
  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
    instance.mcpTaskTiming(timing);
  });

  return { stub, server, wire, environment };
};

/** The Session after every object was aborted, as a deploy leaves it: the host hands its work to the real engine again. */
const evict = async (environment: string) => {
  await abortAllDurableObjects();
  await env.MCP_HOSTS.getByName(`mcp:${environment}`).useRealEngine();

  const after = env.SESSIONS.getByName(`mcp-${environment}`);

  await runDurableObjectAlarm(after);

  return after;
};

/** Submit a turn on the Session. */
const submit = (stub: DurableObjectStub<TestSession>, text: string, requestId = "turn-1") =>
  runInDurableObject(stub, (instance: TestSession) => instance.submit({ requestId, text }));

const script = (stub: DurableObjectStub<TestSession>, responses: ReadonlyArray<string>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.script(responses));

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

/** The numbers of MCP tasks the Session told the Registry it follows, oldest first. */
const reportedTasks = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.reportedMcpTasks());

/** Wait until the Session told the Registry it follows no MCP task: every follower has ended. */
const followingNone = (stub: DurableObjectStub<TestSession>) =>
  settles(async () => expect((await reportedTasks(stub)).at(-1)).toBe(0));

const results = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.toolResults());

const requests = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.requestMessages());

const pushes = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.notified());

/** Wait until the owner was pushed the end of `count` Runs. */
const finishedRuns = (stub: DurableObjectStub<TestSession>, count: number) =>
  settles(async () =>
    expect((await pushes(stub)).filter((event) => event.kind === "finished")).toHaveLength(count),
  );

/** The calls the server was sent, by method. */
const callsOf = (server: TaskServer, method: string) =>
  rpcMethods(server).filter((sent) => sent === method).length;

/** Everything the Session's storage holds in its key-value store, as text. */
const storageDump = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (_instance: TestSession, state) =>
    JSON.stringify([...state.storage.kv.list()]),
  );

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];

  socket.addEventListener("message", (event) => {
    received.push(Effect.runSync(decode(event.data)));
  });

  return {
    received,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
};

/**
 * The owner's Stop all, as a client sends it: the socket's `abort` with `subagents`. Says how long the Session took to
 * answer it.
 */
const stopAll = async (stub: DurableObjectStub<TestSession>) => {
  const owner = await connect(stub);
  const started = Date.now();

  owner.send({ type: "abort", id: "stop-all", subagents: true });
  await settles(async () =>
    expect(owner.received.some((message) => "id" in message && message.id === "stop-all")).toBe(
      true,
    ),
  );

  const took = Date.now() - started;

  owner.close();

  return took;
};

/** Move the Session tree to before the first message, which leaves the branch the task is on behind. */
const leaveBranch = async (stub: DurableObjectStub<TestSession>) => {
  const went = await runInDurableObject(stub, async (instance: TestSession) => {
    const tree = await instance.tree();
    const asked = tree.nodes.find((each) => each.role === "user" && each.text === "report");

    return instance.navigate({ entryId: asked?.id ?? 0, position: "before" });
  });

  expect(went).toHaveProperty("navigated");
};

const logs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    sessions
      .splice(0)
      .map((stub) =>
        runInDurableObject(stub, (instance: TestSession) => instance.stopEverything()),
      ),
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  logs.length = 0;
});

const spyOnLogs = () => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  }
};

/** What the server's id must not be found in, after a test ran: the model's context, the sockets, the logs, the storage. */
const expectNoServerId = async (
  stub: DurableObjectStub<TestSession>,
  ...more: ReadonlyArray<ReadonlyArray<ServerMessage> | undefined>
) => {
  const model = [...(await results(stub)), ...(await requests(stub))].join("\n");

  expect(model).not.toMatch(SERVER_ID);
  expect(logs.join("\n")).not.toMatch(SERVER_ID);
  expect(await storageDump(stub)).not.toMatch(SERVER_ID);

  for (const messages of more) expect(JSON.stringify(messages ?? [])).not.toMatch(SERVER_ID);
};

describe("an MCP task the agent's call started", () => {
  it("ends inside the window and returns as a synchronous call would", async () => {
    spyOnLogs();

    const opened = await open();
    const { stub, server } = opened;
    const owner = await connect(stub);

    await script(stub, [REPORT({ region: "eu", polls: 2 }), "done"]);
    await submit(stub, "report");
    await idle(stub);

    expect(await results(stub)).toEqual([expect.stringContaining("report:eu")]);
    // One `tools/call`, with the extension declared; a poll or two, and no follower left over.
    expect(callsOf(server, "tools/call")).toBe(1);
    expect(callsOf(server, "tasks/get")).toBeGreaterThanOrEqual(2);
    expect(server.declared.filter((sent) => sent.method === "tools/call")).toEqual([
      { method: "tools/call", tasks: true },
    ]);
    // Nothing detached: no tool was loaded, no entry told of an end.
    expect((await requests(stub)).join("\n")).not.toContain("MCP task ended");
    expect(await pushes(stub)).toEqual([expect.objectContaining({ kind: "finished" })]);
    await expectNoServerId(stub, owner.received);
    owner.close();
  });

  it("returns what a server that ends the call at once returns, with no task", async () => {
    const { stub, server } = await open();

    await script(stub, [REPORT({ inline: true }), "done"]);
    await submit(stub, "report");
    await idle(stub);

    expect(await results(stub)).toEqual([expect.stringContaining("report:")]);
    expect(callsOf(server, "tasks/get")).toBe(0);
  });

  it("detaches at the window, is followed to its end, and tells the agent in a Run of its own", async () => {
    spyOnLogs();

    const opened = await open();
    const { stub, server } = opened;
    const owner = await connect(stub);

    // 14 polls of 50 ms outlast the 400 ms window; the first turn ends detached, the follow-up Run reads the result.
    await script(stub, [
      REPORT({ region: "eu", polls: 14 }),
      "It runs in the background.",
      "call:mcp_task_wait:" + JSON.stringify({ task: "mcp-task-1" }),
      "The report is in.",
    ]);
    await submit(stub, "report");

    // The call returned its handle and loaded the tools.
    await settles(async () =>
      expect((await results(stub)).join("\n")).toContain("runs as MCP task mcp-task-1"),
    );
    await settles(async () => expect((await results(stub)).join("\n")).toContain("report:eu"));
    await idle(stub);

    const model = (await requests(stub)).join("\n");

    // The entry that told the agent says what ended in cloudpid's words, and the wait read the result.
    expect(model).toContain("[MCP task ended | task=mcp-task-1 | server=docs");
    expect(model).toContain("status=completed");
    expect(callsOf(server, "tools/call")).toBe(1);
    // The owner was told each Run ended: the turn's, and the follow-up Run the end started.
    await settles(async () =>
      expect((await pushes(stub)).filter((event) => event.kind === "finished")).toHaveLength(2),
    );
    await expectNoServerId(stub, owner.received);
    owner.close();
  });

  it("is followed through an eviction of the Session after it detached, and `tools/call` goes out once", async () => {
    const opened = await open();
    const { stub, server, environment } = opened;

    await script(stub, [
      REPORT({ region: "us", polls: 30 }),
      "It runs in the background.",
      "call:mcp_task_wait:" + JSON.stringify({ task: "mcp-task-1" }),
      "The report is in.",
    ]);
    await submit(stub, "report");
    await settles(async () =>
      expect((await results(stub)).join("\n")).toContain("runs as MCP task mcp-task-1"),
    );

    const after = await evict(environment);

    await settles(async () => expect((await results(after)).join("\n")).toContain("report:us"));
    await idle(after);

    expect(callsOf(server, "tools/call")).toBe(1);
    expect((await requests(after)).join("\n")).toContain("[MCP task ended | task=mcp-task-1");
  });

  it("is followed through an eviction of the Session inside the window, and `tools/call` goes out once", async () => {
    const opened = await open({ ...TIMING, windowMs: 5000 });
    const { stub, server, environment } = opened;

    await script(stub, [REPORT({ region: "ap", polls: 20 }), "done"]);
    await submit(stub, "report");
    await settles(async () => expect(callsOf(server, "tasks/get")).toBeGreaterThanOrEqual(2));

    const after = await evict(environment);

    await settles(async () => expect((await results(after)).join("\n")).toContain("report:ap"));
    await idle(after);

    // The call that was waiting reran, found its record and went on polling: the result is the task's.
    expect(await results(after)).toEqual([expect.stringContaining("report:ap")]);
    expect(callsOf(server, "tools/call")).toBe(1);
    await expectNoServerId(after);
  });

  it("retries a server that cannot be reached and goes on once it can", async () => {
    const opened = await open();
    const { stub, server, wire } = opened;

    await script(stub, [
      REPORT({ region: "eu", polls: 14 }),
      "It runs in the background.",
      "call:mcp_task_wait:" + JSON.stringify({ task: "mcp-task-1" }),
      "The report is in.",
    ]);
    await submit(stub, "report");
    await settles(async () =>
      expect((await results(stub)).join("\n")).toContain("runs as MCP task mcp-task-1"),
    );

    // A deploy of the server, or a network cut: the follower is not ended by it.
    wire.unreachable = true;

    const polls = callsOf(server, "tasks/get");

    await new Promise((resolve) => setTimeout(resolve, 800));
    // Following is not work: the Session reads idle, and the follower goes on retrying.
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true);
    expect((await requests(stub)).join("\n")).not.toContain("MCP task ended");

    wire.unreachable = false;
    await settles(async () => expect((await results(stub)).join("\n")).toContain("report:eu"));
    await idle(stub);

    expect(callsOf(server, "tasks/get")).toBeGreaterThan(polls);
    expect(callsOf(server, "tools/call")).toBe(1);
  });

  it("is `unknown` once a server that lost the task has not found it for the grace", async () => {
    const opened = await open();
    const { stub, server } = opened;

    await script(stub, [
      REPORT({ polls: 1000 }),
      "It runs in the background.",
      "The task is gone.",
    ]);
    await submit(stub, "report");
    await settles(async () =>
      expect((await results(stub)).join("\n")).toContain("runs as MCP task mcp-task-1"),
    );

    // The server restarted and lost its tasks: `-32602` for the 300 ms grace, then the end.
    server.tasks.clear();
    await settles(async () =>
      expect((await requests(stub)).join("\n")).toContain("status=unknown"),
    );
    await idle(stub);

    expect(callsOf(server, "tools/call")).toBe(1);
  });

  it("is `stopped` when the server ignores the agent's cancel for the grace, and the agent is told in a notice", async () => {
    const opened = await open();
    const { stub, server, wire } = opened;

    wire.ignoreCancel = true;
    await script(stub, [
      REPORT({ polls: 1000 }),
      "It runs in the background.",
      "call:mcp_task_cancel:" + JSON.stringify({ task: "mcp-task-1" }),
      "Cancelling it.",
      "It is stopped.",
    ]);
    await submit(stub, "report");
    await finishedRuns(stub, 1);
    await submit(stub, "cancel it", "turn-2");
    await finishedRuns(stub, 2);
    await followingNone(stub);

    // The server was asked to cancel; it never did, and cloudpid says so, to the agent, in a notice: no Run.
    expect(wire.ignored).toBe(1);
    expect(server.tasks.get("task-1")?.status).toBe("working");

    await submit(stub, "and?", "turn-3");
    await finishedRuns(stub, 3);

    const last = (await requests(stub)).at(-1) ?? "";

    expect(last).toContain("[MCP task notice | task=mcp-task-1 | server=docs | status=stopped");
    expect(last).not.toContain("[MCP task ended");
    await expectNoServerId(stub);
  });

  it("is cancelled at the server when the agent cancels it, and the agent is told in a notice", async () => {
    const opened = await open();
    const { stub, server } = opened;

    await script(stub, [
      REPORT({ polls: 1000 }),
      "It runs in the background.",
      "call:mcp_task_cancel:" + JSON.stringify({ task: "mcp-task-1" }),
      "Cancelling it.",
      "It is cancelled.",
    ]);
    await submit(stub, "report");
    await finishedRuns(stub, 1);
    await submit(stub, "cancel it", "turn-2");
    await finishedRuns(stub, 2);
    await followingNone(stub);
    await submit(stub, "and?", "turn-3");
    await finishedRuns(stub, 3);

    expect(server.tasks.get("task-1")?.status).toBe("cancelled");
    expect(callsOf(server, "tools/call")).toBe(1);
    expect((await requests(stub)).at(-1) ?? "").toContain(
      "[MCP task notice | task=mcp-task-1 | server=docs | status=cancelled | by=you]",
    );
  });

  it("is cancelled at the server when Stop aborts a call inside the window", async () => {
    const opened = await open({ ...TIMING, windowMs: 10_000 });
    const { stub, server } = opened;

    await script(stub, [REPORT({ polls: 1000 }), "stopped"]);
    await submit(stub, "report");
    await settles(async () => expect(callsOf(server, "tasks/get")).toBeGreaterThanOrEqual(1));
    await runInDurableObject(stub, (instance: TestSession) => instance.abortRoot());
    await settles(async () => expect(server.tasks.get("task-1")?.status).toBe("cancelled"));
    await idle(stub);
  });
});

/** How many times the Session noted its activity to its Workspaces. */
const activity = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(
    stub,
    (_instance: TestSession, state) => state.storage.kv.get<number>("workspace-activity") ?? 0,
  );

/** A Session whose first turn detached an MCP task that never ends and whose Run has ended. */
const following = async () => {
  const opened = await open();

  await script(opened.stub, [REPORT({ polls: 100_000 }), "It runs in the background.", "Noted."]);
  await submit(opened.stub, "report");
  await finishedRuns(opened.stub, 1);
  await idle(opened.stub);

  return opened;
};

describe("a Session that only follows an MCP task", () => {
  it("is idle, tells the Registry how many tasks it follows, and notes no activity", async () => {
    const { stub, server } = await following();

    await settles(async () => expect(await reportedTasks(stub)).toContain(1));
    // An alarm keeps it woken, though nothing is working, and it goes on polling without noting activity.
    expect(
      await runInDurableObject(stub, (_instance: TestSession, state) => state.storage.getAlarm()),
    ).not.toBeNull();

    const polls = callsOf(server, "tasks/get");
    const noted = await activity(stub);

    await settles(async () => expect(callsOf(server, "tasks/get")).toBeGreaterThan(polls + 2));
    expect(await activity(stub)).toBe(noted);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true);

    // Once nothing follows, it tells the Registry so.
    await runInDurableObject(stub, (instance: TestSession) => instance.stopEverything());
    await followingNone(stub);
  });
});

describe("Stop all of a Session that follows a background MCP task", () => {
  it("is the socket's `abort` with `subagents`: it cancels the task at the server, tells the agent in a notice and starts no Run", async () => {
    const { stub, server } = await following();

    await stopAll(stub);
    await settles(async () => expect(server.tasks.get("task-1")?.status).toBe("cancelled"));
    await followingNone(stub);

    // No Run of its own: the owner heard of the turn's end only.
    expect((await pushes(stub)).filter((event) => event.kind === "finished")).toHaveLength(1);
    // Sent once.
    expect(callsOf(server, "tasks/cancel")).toBe(1);

    await submit(stub, "and?", "turn-2");
    await finishedRuns(stub, 2);

    expect((await requests(stub)).at(-1) ?? "").toContain(
      "[MCP task notice | task=mcp-task-1 | server=docs | status=cancelled | by=the owner]",
    );
    expect(callsOf(server, "tools/call")).toBe(1);
    await expectNoServerId(stub);
  });

  it("leaves a plain Stop alone: the task is untouched", async () => {
    const { stub, server } = await following();
    const owner = await connect(stub);

    owner.send({ type: "abort", id: "stop" });
    await settles(async () =>
      expect(owner.received.some((message) => "id" in message && message.id === "stop")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.tasks.get("task-1")?.status).toBe("working");
    owner.close();
  });

  it("does not reach a task of a branch that is not active", async () => {
    const { stub, server } = await following();

    await leaveBranch(stub);
    await stopAll(stub);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(server.tasks.get("task-1")?.status).toBe("working");
    expect(await records(stub)).toEqual([{ status: "working" }]);
    expect(callsOf(server, "tasks/cancel")).toBe(0);
  });
});

describe("Archive and Delete of a Session that follows a background MCP task", () => {
  it("cancel the task at the server (Archive stops everything), tell the agent in a notice and start no Run", async () => {
    const { stub, server } = await following();

    await runInDurableObject(stub, (instance: TestSession) => instance.stopEverything());
    await settles(async () => expect(server.tasks.get("task-1")?.status).toBe("cancelled"));
    await followingNone(stub);

    expect((await pushes(stub)).filter((event) => event.kind === "finished")).toHaveLength(1);
    expect(callsOf(server, "tasks/cancel")).toBe(1);
  });

  it("cancel the task when the Session is deleted", async () => {
    const { stub, server } = await following();

    await runInDurableObject(stub, (instance: TestSession) => instance.destroy());
    await settles(async () => expect(server.tasks.get("task-1")?.status).toBe("cancelled"));
  });

  it("cancel a task of every branch, the one that is not active included", async () => {
    const { stub, server } = await following();

    await leaveBranch(stub);
    expect(server.tasks.get("task-1")?.status).toBe("working");

    await runInDurableObject(stub, (instance: TestSession) => instance.stopEverything());
    await settles(async () => expect(server.tasks.get("task-1")?.status).toBe("cancelled"));
  });
});

/** A Session with `count` detached MCP tasks that never end, each from a turn of its own, and its Run ended. */
const followingMany = async (count: number, timing: Record<string, number> = TIMING) => {
  const opened = await open(timing);
  const { stub } = opened;

  await script(
    stub,
    Array.from({ length: count }, () => [REPORT({ polls: 100_000 }), "In the background."]).flat(),
  );

  for (let turn = 1; turn <= count; turn += 1) {
    await submit(stub, "report", `turn-${turn}`);
    await finishedRuns(stub, turn);
  }

  await idle(stub);
  await settles(async () => expect((await reportedTasks(stub)).at(-1)).toBe(count));

  return opened;
};

/** Where each MCP task record of the Session stands. */
const records = async (stub: DurableObjectStub<TestSession>) =>
  Record.values(
    await runInDurableObject(stub, (instance: TestSession) => instance.mcpTaskRecords()),
  );

const via: SessionVia = { auth: "oauth", client: { name: "claude-code" } };

/** The value of an `ok` result: a failure fails the test with its error. */
const okValue = <T>(result: ApiResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  return result.value;
};

describe("a Session that only follows an MCP task, over the MCP endpoint", () => {
  it("reads idle, and only Stop all (`subagents`) reaches the task", async () => {
    const { stub, server } = await following();

    // Following is not work: the endpoint says idle, and a plain stop has no Run to stop.
    expect(okValue(await stub.mcpStatus()).status).toBe("idle");

    const plain = okValue(await stub.mcpStop({ via }));

    expect(plain.status).toBe("idle");
    expect(plain.stopping).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.tasks.get("task-1")?.status).toBe("working");

    // Stop all is the owner's path to what a Session follows.
    okValue(await stub.mcpStop({ via, subagents: true }));
    await settles(async () => expect(server.tasks.get("task-1")?.status).toBe("cancelled"));
    await followingNone(stub);
    expect(okValue(await stub.mcpStatus()).status).toBe("idle");
  });

  it("reads idle, and its Stop all is a no-op, when only a branch that is not active has a task", async () => {
    const { stub, server } = await following();

    await leaveBranch(stub);
    expect(okValue(await stub.mcpStatus()).status).toBe("idle");

    // Stop all reaches the active branch only, which follows nothing: the call is idempotent and stops nothing.
    const result = okValue(await stub.mcpStop({ via, subagents: true }));

    expect(result.status).toBe("idle");
    expect(result.stopping).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(server.tasks.get("task-1")?.status).toBe("working");
  });
});

describe("a server that never answers `tasks/cancel`", () => {
  it("does not hold Archive for longer than the bound: the cancels go out together and every record ends by Stop", async () => {
    const { stub, wire, server } = await followingMany(2);

    wire.hangCancel = true;

    const started = Date.now();

    await runInDurableObject(stub, (instance: TestSession) => instance.stopEverything());

    // Two cancels, each bounded at 2 s, concurrently: not 4 s.
    expect(Date.now() - started).toBeLessThan(3500);
    await settles(async () =>
      expect(await records(stub)).toEqual([
        { status: "cancelled", by: "stop" },
        { status: "cancelled", by: "stop" },
      ]),
    );
    await settles(async () => expect((await reportedTasks(stub)).at(-1)).toBe(0));
    expect(callsOf(server, "tasks/cancel")).toBe(0);

    // The agent is told in a notice, and no Run was started for it.
    expect((await pushes(stub)).filter((event) => event.kind === "finished")).toHaveLength(2);

    await submit(stub, "and?", "turn-9");
    await finishedRuns(stub, 3);
    expect((await requests(stub)).at(-1) ?? "").toContain("[MCP task notice | task=mcp-task-1");
  });

  it("does not hold the owner's Stop all (the socket's `abort`) for longer than the bound, and ends every record by Stop", async () => {
    const { stub, wire } = await followingMany(2);

    wire.hangCancel = true;

    const took = await stopAll(stub);

    expect(took).toBeLessThan(3500);
    await settles(async () =>
      expect(await records(stub)).toEqual([
        { status: "cancelled", by: "stop" },
        { status: "cancelled", by: "stop" },
      ]),
    );
    await followingNone(stub);
    // The agent is told in a notice, and no Run was started for it.
    expect((await pushes(stub)).filter((event) => event.kind === "finished")).toHaveLength(2);
  });

  it("does not hold the Session's deletion for longer than the bound either", async () => {
    const { stub, wire } = await followingMany(2);

    wire.hangCancel = true;

    const started = Date.now();

    await runInDurableObject(stub, (instance: TestSession) => instance.destroy());

    expect(Date.now() - started).toBeLessThan(8000);
  });
});

describe("a server a deploy of the host reached", () => {
  it("is retried by the follower when the host's RPC breaks, and nothing is resent", async () => {
    const { stub, server, environment } = await following();
    const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

    await host.failRequests("tasks/get");

    const polls = callsOf(server, "tasks/get");

    await new Promise((resolve) => setTimeout(resolve, 600));
    // Nothing reached the server, and the task is neither ended nor told of.
    expect(callsOf(server, "tasks/get")).toBe(polls);
    expect(await records(stub)).toEqual([{ status: "working" }]);
    expect((await requests(stub)).join("\n")).not.toContain("MCP task ended");

    await host.failRequests(undefined);
    await settles(async () => expect(callsOf(server, "tasks/get")).toBeGreaterThan(polls));

    expect(callsOf(server, "tools/call")).toBe(1);
    expect(await records(stub)).toEqual([{ status: "working" }]);
  });

  it("is retried by the call inside the window when the host's RPC breaks, and `tools/call` goes out once", async () => {
    const opened = await open({ ...TIMING, windowMs: 20_000 });
    const { stub, server, environment } = opened;
    const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

    await script(stub, [REPORT({ region: "eu", polls: 40 }), "done"]);
    await submit(stub, "report");
    await settles(async () => expect(callsOf(server, "tasks/get")).toBeGreaterThanOrEqual(1));
    await host.failRequests("tasks/get");
    // One poll may have been on its way.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const polls = callsOf(server, "tasks/get");

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(callsOf(server, "tasks/get")).toBe(polls);
    await host.failRequests(undefined);
    await idle(stub);

    expect(await results(stub)).toEqual([expect.stringContaining("report:eu")]);
    expect(callsOf(server, "tools/call")).toBe(1);
  });
});

describe("the alarm of a Session that only follows an MCP task", () => {
  it("is the follower's own time to poll, not the heartbeat", async () => {
    const { stub, server } = await following20s();

    await settles(async () => expect(callsOf(server, "tasks/get")).toBeGreaterThanOrEqual(1));
    await settles(async () => expect((await reportedTasks(stub)).at(-1)).toBe(1));

    const alarm = await runInDurableObject(stub, (_instance: TestSession, state) =>
      state.storage.getAlarm(),
    );

    const ahead = (alarm ?? 0) - Date.now();

    // The poll is 20 s away, the heartbeat a minute: the alarm is the first.
    expect(alarm).not.toBeNull();
    expect(ahead).toBeGreaterThan(5000);
    expect(ahead).toBeLessThanOrEqual(21_000);
  });
});

/** `following`, with a poll every 20 s. */
const following20s = async () => {
  const opened = await open({ ...TIMING, pollMs: 20_000 });

  await script(opened.stub, [REPORT({ polls: 100_000 }), "It runs in the background.", "Noted."]);
  await submit(opened.stub, "report");
  await finishedRuns(opened.stub, 1);
  await idle(opened.stub);

  return opened;
};

describe("the sweep at a wake", () => {
  it("ends an inline task whose call is gone, cancelling it at the server once", async () => {
    const { stub, server, environment } = await open();

    // A call was made, so the Session kept its settings, the Environment among them, as any Session that has MCP tasks has.
    await script(stub, ["Hello."]);
    await submit(stub, "hi");
    await idle(stub);
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.leaveOrphanMcpTask("task-orphan"),
    );
    expect(await records(stub)).toEqual([{ status: "working" }]);

    const after = await evict(environment);

    await settles(async () =>
      expect(await records(after)).toEqual([{ status: "cancelled", by: "stop" }]),
    );
    expect(callsOf(server, "tasks/cancel")).toBe(1);
  });
});

describe("the count of followed MCP tasks the Registry is told", () => {
  it("is never told by a Session that never ran an MCP tool", async () => {
    const stub = env.SESSIONS.getByName(`plain-${counter++}`);

    await script(stub, ["Hello."]);
    await submit(stub, "hi");
    await idle(stub);
    await runInDurableObject(stub, (instance: TestSession) => instance.stopEverything());

    expect(await reportedTasks(stub)).toEqual([]);
  });

  it("is kept as unknown when the Registry is down, and told again once it answers", async () => {
    const { stub } = await open();

    await runInDurableObject(stub, (instance: TestSession) => instance.reports("failing"));
    await script(stub, [REPORT({ polls: 100_000 }), "It runs in the background."]);
    await submit(stub, "report");
    await finishedRuns(stub, 1);
    await settles(async () =>
      expect(
        await runInDurableObject(stub, (_instance: TestSession, state) =>
          state.storage.kv.get<number>("mcp-tasks-reported"),
        ),
      ).toBe(-1),
    );
    // Nothing the Registry received.
    expect(await reportedTasks(stub)).toEqual([]);

    await runInDurableObject(stub, (instance: TestSession) => instance.reports("working"));
    await settles(async () => expect(await reportedTasks(stub)).toEqual([1]));
    expect(
      await runInDurableObject(stub, (_instance: TestSession, state) =>
        state.storage.kv.get<number>("mcp-tasks-reported"),
      ),
    ).toBe(1);
  });

  it("is remembered across an eviction, so the new instance does not tell it again", async () => {
    const { stub, environment } = await following();

    await settles(async () => expect(await reportedTasks(stub)).toEqual([1]));

    const after = await evict(environment);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await reportedTasks(after)).toEqual([1]);
  });
});
