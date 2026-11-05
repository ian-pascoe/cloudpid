// A Modern MCP server's Sampling request end to end (`docs/architecture/mcp-server-requests.md` → Sampling requests;
// ADR-0039): the agent's call goes Session → host → the real `McpEngine` → a fake Modern server whose tool asks, in one
// `input_required` round, a form and a model reply. Both reach the owner over the Session socket and are kept with the
// call's round while it waits; the owner's answers send one resume, and the reply is made on the Session's models as the
// round resumes. An owner who refuses the Sampling request ends the call: the form beside it is withdrawn and the agent
// reads `sampling_refused`.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalTimers:off globalJsonInEffect:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ASK_TOOL, modernServer, rpcMethods } from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpElicitationRequest,
  type McpSamplingRequest,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

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

const NAME_FORM = {
  type: "object",
  properties: { name: { type: "string", title: "Your name" } },
  required: ["name"],
};

/** The agent's call: one round of one form and one Sampling request. */
const ASK = `call:mcp__docs__ask:${JSON.stringify({
  message: "Who?",
  requestedSchema: NAME_FORM,
  forms: 1,
  samples: 1,
})}`;

/** The same, with two Sampling requests in the round. */
const ASK_TWO = `call:mcp__docs__ask:${JSON.stringify({
  message: "Who?",
  requestedSchema: NAME_FORM,
  forms: 1,
  samples: 2,
})}`;

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
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
};

/** A Session whose host runs the real engine against a fake Modern server that has the `ask` tool. */
const open = async () => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const asked: Array<Schema.Json> = [];
  const server = modernServer({ moreTools: [ASK_TOOL], asked });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  await host.useRealEngine();
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`mcp-sampling-modern-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
  });

  return { stub, server, asked, owner: await connect(stub) };
};

const start = (stub: DurableObjectStub<TestSession>, script: ReadonlyArray<string>) =>
  runInDurableObject(stub, async (instance: TestSession) => {
    instance.script(script);
    await instance.submit({ requestId: `turn-${counter++}`, text: "ask" });
  });

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Modern MCP server's Sampling request in a Session", () => {
  it("is kept with the call's round beside its form, and is run once, on the owner's yes, as the one resume starts", async () => {
    const { stub, server, asked, owner } = await open();

    await start(stub, [ASK, "a sampled reply", "done"]);
    await settles(async () => expect(owner.samples()).toHaveLength(1));
    await settles(async () => expect(owner.forms()).toHaveLength(1));

    const [request] = owner.samples();

    // No countdown: the call waits as long as the owner takes.
    expect(request).toMatchObject({
      server: "docs",
      tool: "mcp__docs__ask",
      role: "small",
      waits: "owner",
      messages: [{ role: "user", text: "Sample 1" }],
    });

    // Nothing has reached a model while the owner has not said yes.
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 0 });

    owner.send({
      type: "mcp_sampling_answer",
      id: "yes",
      request: request?.id ?? "",
      choice: "allow_call",
    });
    owner.send({
      type: "mcp_elicitation_answer",
      id: "form",
      request: owner.forms()[0]?.id ?? "",
      action: "accept",
      content: { name: "Ada" },
    });

    await idle(stub);

    // The call went out once, then its one resume carrying the form's answer and the model's reply.
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(2);
    expect(asked).toEqual([
      expect.objectContaining({
        round: 1,
        responses: {
          q1: { action: "accept", content: { name: "Ada" } },
          s1: expect.objectContaining({
            role: "assistant",
            content: { type: "text", text: "a sampled reply" },
          }),
        },
      }),
    ]);

    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 1 });
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingRecords()),
    ).toEqual([expect.objectContaining({ server: "docs", status: "answered", by: "owner" })]);
    expect(owner.samples()).toEqual([]);
    owner.close();
  });

  it("is decided once for every Sampling request of the call's round, and each runs once as the one resume starts", async () => {
    const { stub, server, asked, owner } = await open();

    await start(stub, [ASK_TWO, "first reply", "second reply", "done"]);
    await settles(async () => expect(owner.samples()).toHaveLength(2));
    await settles(async () => expect(owner.forms()).toHaveLength(1));

    const [first, second] = owner.samples();

    // Both are the one call's, which the client draws as one card.
    expect(first?.callId).toBe(second?.callId);
    expect(owner.forms()[0]?.callId).toBe(first?.callId);

    owner.send({
      type: "mcp_sampling_answer",
      id: "yes",
      request: first?.id ?? "",
      choice: "allow_call",
    });
    await settles(async () => expect(owner.samples()).toEqual([]));
    owner.send({
      type: "mcp_elicitation_answer",
      id: "form",
      request: owner.forms()[0]?.id ?? "",
      action: "accept",
      content: { name: "Ada" },
    });

    await idle(stub);

    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(2);
    expect(asked).toEqual([
      expect.objectContaining({
        responses: expect.objectContaining({
          s1: expect.objectContaining({ content: { type: "text", text: "first reply" } }),
          s2: expect.objectContaining({ content: { type: "text", text: "second reply" } }),
        }),
      }),
    ]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 2 });
    owner.close();
  });

  it("is refused by the owner: the form beside it is withdrawn, no resume is sent, and the call ends with details.error sampling_refused", async () => {
    const { stub, server, asked, owner } = await open();

    await start(stub, [ASK, "done"]);
    await settles(async () => expect(owner.samples()).toHaveLength(1));
    await settles(async () => expect(owner.forms()).toHaveLength(1));

    owner.send({
      type: "mcp_sampling_answer",
      id: "no",
      request: owner.samples()[0]?.id ?? "",
      choice: "refuse",
    });

    await idle(stub);

    expect(owner.forms()).toEqual([]);
    expect(owner.samples()).toEqual([]);
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(1);
    expect(asked).toEqual([]);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain("ends the call, which may have done part of its work");
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.toolResultDetails()),
    ).toEqual([expect.objectContaining({ error: "sampling_refused" })]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 0 });
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingRecords()),
    ).toEqual([expect.objectContaining({ status: "refused", by: "owner" })]);
    owner.close();
  });
});
