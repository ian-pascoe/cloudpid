// An App View's call that its server asks questions or answers with an MCP task, end to end (`docs/architecture/
// mcp-apps.md` → Server requests from an App View's calls): the View's `tools/call` goes socket → Session → host → the real
// `McpEngine` → a fake Modern server. A form or a Sampling request waits on a card in the conversation's waiting area
// (never inside the View), the owner answers over the socket and the View's call completes; nobody is notified; a hidden
// page withdraws a Sampling card and not a form; the View's teardown withdraws both; one form waits for a View at a time. A
// task is polled while the request is in flight, asks its questions the same way (the answers go with `tasks/update`, a
// refusal ends it with `tasks/cancel`), ends with `tasks/cancel` at the View's teardown or the bound, and is never in
// `mcp_tasks`.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  APP_MIME_TYPE,
  appTool,
  ASK_TOOL,
  modernServer,
  modernTaskServer,
  type FakeServer,
} from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpAppEntry,
  type McpElicitationRequest,
  type McpSamplingRequest,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as SchemaModule from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { TestMcpHost } from "../mcp/host.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 25 });

let counter = 0;

const URI = "ui://docs/app";
const PAGE = "<main>fixture</main>";

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

const RESOURCES = [
  {
    uri: URI,
    name: "app",
    mimeType: APP_MIME_TYPE,
    contents: [{ uri: URI, mimeType: APP_MIME_TYPE, text: PAGE }],
  },
];

/** `ask` as a tool the View may call. */
const viewAsk = { ...ASK_TOOL, _meta: { ui: { resourceUri: URI, visibility: ["app"] } } };

const FORM = {
  message: "Which name?",
  requestedSchema: { type: "object", properties: { name: { type: "string" } } },
};

const decode = SchemaModule.decodeUnknownEffect(ServerMessageJson);

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
    forms: (): ReadonlyArray<McpElicitationRequest> => {
      const last = received.findLast((message) => message.type === "mcp_elicitation_requests");

      return last?.type === "mcp_elicitation_requests" ? last.requests : [];
    },
    samples: (): ReadonlyArray<McpSamplingRequest> => {
      const last = received.findLast((message) => message.type === "mcp_sampling_requests");

      return last?.type === "mcp_sampling_requests" ? last.requests : [];
    },
    tasks: () => received.findLast((message) => message.type === "mcp_tasks"),
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    answer: async (id: string) => {
      await settles(async () =>
        expect(received.some((message) => message.type === "result" && message.id === id)).toBe(
          true,
        ),
      );

      const found = received.find((message) => message.type === "result" && message.id === id);

      return found?.type === "result" ? found.result : undefined;
    },
  };
};

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

/**
 * A Session over `server`, whose model has called the App tool `app` (which keeps the call's record) and a client of its
 * socket whose page is visible, as a tab's is.
 */
const withView = async <S extends FakeServer>(server: S, timing?: Record<string, number>) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.useRealEngine();
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);

    if (timing !== undefined) instance.mcpTaskTiming(timing);

    instance.script(['call:mcp__docs__app:{"text":"hi"}', "done"]);
    await instance.submit({ requestId: `turn-${counter++}`, text: "call app" });
  });
  await idle(stub);

  const entry: McpAppEntry | undefined = (
    await runInDurableObject(stub, (instance: TestSession) => instance.appCalls())
  ).at(-1);

  if (entry === undefined) throw new Error("No App call was recorded");

  const client = await connect(stub);

  await settles(async () =>
    expect(client.received.some((message) => message.type === "hello")).toBe(true),
  );

  const visible = async (value = true) => {
    const id = `visible-${counter++}`;

    client.send({ type: "page_visible", id, visible: value });
    await client.answer(id);
  };

  /** An App View's `tools/call`, answered when it ends. */
  const call = (name: string, args: Record<string, Schema.Json>, requestId: string) => {
    const id = `call-${counter++}`;

    client.send({
      type: "mcp_app_request",
      id,
      callId: entry.callId,
      requestId,
      method: "tools/call",
      params: { name, arguments: args },
    });

    return client.answer(id);
  };

  const cancel = (requestId: string) => {
    client.send({
      type: "mcp_app_cancel",
      id: `cancel-${counter++}`,
      callId: entry.callId,
      requestId,
    });
  };

  const pushes = async () =>
    (await runInDurableObject(stub, (instance: TestSession) => instance.notified())).filter(
      (event) => event.kind === "input",
    );

  const audit = async () => {
    const mounted = await runInDurableObject(stub, (instance: TestSession) =>
      instance.appMount(entry.callId),
    );

    return mounted.status === "record" && "record" in mounted
      ? mounted.record.audit.map((each) => each.summary)
      : [];
  };

  await visible();

  return { stub, client, visible, call, cancel, pushes, audit, server, entry, environment };
};

const textOf = <A>(answer: A): string => JSON.stringify(answer);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an App View's call that its server asks a form", () => {
  const open = () =>
    withView(
      modernServer({
        resources: RESOURCES,
        moreTools: [appTool("app", URI), viewAsk],
      }),
    );

  it("waits on a card in the waiting area, completes after Submit, and tells nobody", async () => {
    const { client, call, pushes, audit } = await open();
    const calling = call("ask", FORM, "r1");

    await settles(async () => expect(client.forms()).toHaveLength(1));

    // Drawn by cloudpid, as the app's, never inside the View; the card waits at most 5 minutes.
    expect(client.forms()[0]).toMatchObject({
      server: "docs",
      app: true,
      message: "Which name?",
    });
    expect(client.forms()[0]?.waits).toBeUndefined();

    client.send({
      type: "mcp_elicitation_answer",
      id: "answer",
      request: client.forms()[0]?.id ?? "",
      action: "accept",
      content: { name: "Ada" },
    });

    const answer = await calling;

    expect(answer).toMatchObject({ status: "result" });
    expect(textOf(answer)).toContain("Ada");
    await settles(async () => expect(client.forms()).toEqual([]));
    expect(await pushes()).toEqual([]);
    expect(await audit()).toEqual([expect.stringMatching(/form answered/)]);
  });

  it("turns away a second form while one waits for the View, and keeps the first", async () => {
    const { client, call, audit } = await open();
    const first = call("ask", FORM, "r1");

    await settles(async () => expect(client.forms()).toHaveLength(1));

    const second = await call("ask", FORM, "r2");

    expect(textOf(second)).toContain("cancel");
    expect(client.forms()).toHaveLength(1);

    client.send({
      type: "mcp_elicitation_answer",
      id: "answer",
      request: client.forms()[0]?.id ?? "",
      action: "decline",
    });

    expect(textOf(await first)).toContain("decline");
    expect((await audit()).join("\n")).toContain("already has one waiting");
  });

  it("stays when the page is hidden, and ends with the View's teardown", async () => {
    const { client, call, cancel, visible } = await open();
    const calling = call("ask", FORM, "r1");

    await settles(async () => expect(client.forms()).toHaveLength(1));
    await visible(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.forms()).toHaveLength(1);

    cancel("r1");

    expect(await calling).toMatchObject({ status: "error", reason: "cancelled" });
    await settles(async () => expect(client.forms()).toEqual([]));
  });
});

describe("an App View's call that its server asks for a model reply", () => {
  const open = () =>
    withView(
      modernServer({
        resources: RESOURCES,
        moreTools: [appTool("app", URI), viewAsk],
      }),
    );

  const SAMPLE = { message: "m", forms: 0, samples: 1 };

  it("is withdrawn when the page is hidden, which errors the View's call", async () => {
    const { client, call, visible, audit } = await open();
    const calling = call("ask", SAMPLE, "r1");

    await settles(async () => expect(client.samples()).toHaveLength(1));
    expect(client.samples()[0]).toMatchObject({ server: "docs", app: true });

    await visible(false);

    expect(await calling).toMatchObject({ status: "error", reason: "refused" });
    await settles(async () => expect(client.samples()).toEqual([]));
    expect((await audit()).join("\n")).toContain("asked for a model reply");
  });

  it("is withdrawn at the View's teardown, and tells nobody", async () => {
    const { client, call, cancel, pushes } = await open();
    const calling = call("ask", SAMPLE, "r1");

    await settles(async () => expect(client.samples()).toHaveLength(1));
    cancel("r1");

    expect(await calling).toMatchObject({ status: "error", reason: "cancelled" });
    await settles(async () => expect(client.samples()).toEqual([]));
    expect(await pushes()).toEqual([]);
  });

  it("is refused by the owner, which errors the call and notes it in the audit log", async () => {
    const { client, call, audit } = await open();
    const calling = call("ask", SAMPLE, "r1");

    await settles(async () => expect(client.samples()).toHaveLength(1));
    client.send({
      type: "mcp_sampling_answer",
      id: "no",
      request: client.samples()[0]?.id ?? "",
      choice: "refuse",
    });

    expect(await calling).toMatchObject({
      status: "error",
      reason: "refused",
      message: expect.stringContaining("refused by you"),
    });
    expect((await audit()).join("\n")).toContain("refused by you");
  });
});

describe("an App View's call that its server answers with an MCP task", () => {
  const TIMING = { pollMs: 20, viewWindowMs: 60_000 };

  const open = (timing: Record<string, number> = TIMING) =>
    withView(
      modernTaskServer({
        resources: RESOURCES,
        moreTools: [appTool("app", URI)],
        appUri: URI,
      }),
      timing,
    );

  it("polls the task while the View waits, answers its result, and never lists it in mcp_tasks", async () => {
    const { client, call, server } = await open();

    const answer = await call("report", { region: "eu", polls: 3 }, "r1");

    expect(answer).toMatchObject({
      status: "result",
      result: { content: [{ type: "text", text: "report:eu" }] },
    });
    expect(server.tasks.size).toBe(1);
    expect(client.tasks()).toMatchObject({ tasks: [] });
  });

  describe("that waits for input", () => {
    const answerForm = (client: Awaited<ReturnType<typeof withView>>["client"]) =>
      client.send({
        type: "mcp_elicitation_answer",
        id: `answer-${counter++}`,
        request: client.forms()[0]?.id ?? "",
        action: "accept",
      });

    it("asks its form on a card, sends the answer to the task, and completes after Submit", async () => {
      const { client, call, server, pushes, audit } = await open();
      const calling = call("report", { ask: true, region: "eu" }, "r1");

      await settles(async () => expect(client.forms()).toHaveLength(1));
      expect(client.forms()[0]).toMatchObject({ server: "docs", app: true });

      answerForm(client);

      expect(await calling).toMatchObject({
        status: "result",
        result: { content: [{ type: "text", text: "report:eu" }] },
      });
      expect([...server.tasks.values()][0]?.answers).toMatchObject({
        which: { action: "accept" },
      });
      await settles(async () => expect(client.forms()).toEqual([]));
      expect(client.tasks()).toMatchObject({ tasks: [] });
      expect(await pushes()).toEqual([]);
      expect((await audit()).join("\n")).toContain("form answered");
    });

    it("answers a page its task asks for with cancel and no card, and the task goes on", async () => {
      const { client, call, server } = await open();

      const answer = await call("report", { page: true, region: "eu" }, "r1");

      expect(answer).toMatchObject({
        status: "result",
        result: { content: [{ type: "text", text: "report:eu" }] },
      });
      expect(client.forms()).toEqual([]);
      expect([...server.tasks.values()][0]?.answers).toEqual({ visit: { action: "cancel" } });
    });

    it("answers a form cloudpid cannot take with cancel, never a refusal, and the task goes on", async () => {
      const { client, call, server } = await open();

      const answer = await call("report", { unsupported: true, region: "eu" }, "r1");

      expect(answer).toMatchObject({ status: "result" });
      expect(client.forms()).toEqual([]);
      expect([...server.tasks.values()][0]?.answers).toEqual({ which: { action: "cancel" } });
      expect([...server.tasks.values()][0]?.status).not.toBe("cancelled");
    });

    it("asks a question once and sends one update, when the server is slow to move on", async () => {
      const { client, call, server } = await open();
      const calling = call("report", { ask: true, lag: 2, region: "eu" }, "r1");

      await settles(async () => expect(client.forms()).toHaveLength(1));
      answerForm(client);

      expect(await calling).toMatchObject({ status: "result" });
      expect([...server.tasks.values()][0]?.updates).toBe(1);
    });

    it("stays when the page is hidden, and is cancelled at the server with the View's teardown", async () => {
      const { client, call, cancel, visible, server } = await open();
      const calling = call("report", { ask: true }, "r1");

      await settles(async () => expect(client.forms()).toHaveLength(1));
      await visible(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(client.forms()).toHaveLength(1);

      cancel("r1");

      expect(await calling).toMatchObject({ status: "error", reason: "cancelled" });
      await settles(async () => expect(client.forms()).toEqual([]));
      await settles(async () => expect([...server.tasks.values()][0]?.status).toBe("cancelled"));
    });

    it("withdraws a Sampling card when the page is hidden and cancels the task", async () => {
      const { client, call, visible, server } = await open();
      const calling = call("report", { sample: true }, "r1");

      await settles(async () => expect(client.samples()).toHaveLength(1));
      expect(client.samples()[0]).toMatchObject({ server: "docs", app: true });

      await visible(false);

      expect(await calling).toMatchObject({ status: "error", reason: "refused" });
      await settles(async () => expect(client.samples()).toEqual([]));
      await settles(async () => expect([...server.tasks.values()][0]?.status).toBe("cancelled"));
    });

    it("cancels the task when the owner refuses its Sampling request", async () => {
      const { client, call, server } = await open();
      const calling = call("report", { sample: true }, "r1");

      await settles(async () => expect(client.samples()).toHaveLength(1));
      client.send({
        type: "mcp_sampling_answer",
        id: "no",
        request: client.samples()[0]?.id ?? "",
        choice: "refuse",
      });

      expect(await calling).toMatchObject({ status: "error", reason: "refused" });
      await settles(async () => expect([...server.tasks.values()][0]?.status).toBe("cancelled"));
    });

    it("withdraws its card and cancels the task when the bound passes", async () => {
      const { client, call, server } = await open({ pollMs: 20, viewWindowMs: 500 });
      const calling = call("report", { ask: true }, "r1");

      await settles(async () => expect(client.forms()).toHaveLength(1));

      expect(await calling).toMatchObject({ status: "error", reason: "failed" });
      await settles(async () => expect(client.forms()).toEqual([]));
      await settles(async () => expect([...server.tasks.values()][0]?.status).toBe("cancelled"));
    });
  });

  it("is cancelled at the server when the View is torn down", async () => {
    const { call, cancel, server } = await open();
    const calling = call("report", { polls: 100_000 }, "r1");

    await settles(async () => expect(server.tasks.size).toBe(1));
    cancel("r1");

    expect(await calling).toMatchObject({ status: "error", reason: "cancelled" });
    await settles(async () => expect([...server.tasks.values()][0]?.status).toBe("cancelled"));
  });

  it("is cancelled at the server when the bound passes, which errors the View's call", async () => {
    const { call, server, client } = await open({ pollMs: 20, viewWindowMs: 300 });

    const answer = await call("report", { polls: 100_000 }, "r1");

    expect(answer).toMatchObject({ status: "error", reason: "failed" });
    await settles(async () => expect([...server.tasks.values()][0]?.status).toBe("cancelled"));
    expect(client.tasks()).toMatchObject({ tasks: [] });
  });

  it("is cancelled by the next wake's sweep when the Session lost the View's request", async () => {
    const { call, server, environment } = await open();

    void call("report", { polls: 100_000 }, "r1");
    await settles(async () => expect(server.tasks.size).toBe(1));

    // The Session's object restarts, as a deploy leaves it: the request is gone with the instance, and the stored entry is
    // what the next wake's sweep cancels the task by.
    await abortAllDurableObjects();
    await env.MCP_HOSTS.getByName(`mcp:${environment}`).useRealEngine();
    await runDurableObjectAlarm(env.SESSIONS.getByName(`mcp-${environment}`));
    await settles(async () => expect([...server.tasks.values()][0]?.status).toBe("cancelled"));
  });
});
