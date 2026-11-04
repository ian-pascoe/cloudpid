// A Legacy MCP server's Sampling request end to end (`docs/architecture/mcp-server-requests.md` → Sampling requests;
// ADR-0039): the agent's call goes Session → host → the real `McpEngine` → a fake Legacy server whose tool asks the client
// for model replies during the call. A server whose definition says `sampling: "allow"` is declared a client that samples,
// and each request runs on the Session's models (the `small` Role's), is counted in the Session's usage and spend, and is
// refused with `-1` once the Session is at its Spend limit. A server that says `ask` (the default) has each request shown
// to the owner on a card over the Session socket, which the owner allows or refuses; `off` is declared nothing.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { legacyStatefulServer, SAMPLE_TOOL } from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpSamplingRequest,
  type McpSamplingSessionGrant,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_COST, type TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

const setOf = (server: Record<string, Schema.Json>): McpApplySet => ({
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: {
        type: "http",
        url: "https://docs.example/mcp",
        headers: {},
        exposure: "direct",
        ...server,
      },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
});

/** A Session whose host runs the real engine against a Legacy server. */
const open = async (
  server: Record<string, Schema.Json>,
  sampled: Array<Schema.Json>,
  name = "mcp-sampling",
) => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const fake = legacyStatefulServer({ moreTools: [SAMPLE_TOOL], sampled });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fake.handle(new Request(input, init)),
  );

  await host.useRealEngine();
  await host.apply(setOf(server));

  const stub = env.SESSIONS.getByName(`${name}-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
  });

  return { stub };
};

const sample = (rounds: number) => `call:mcp__docs__sample:${JSON.stringify({ rounds })}`;

const run = async (stub: DurableObjectStub<TestSession>, script: ReadonlyArray<string>) => {
  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.script(script);
    await instance.submit({ requestId: "turn-1", text: "sample" });
  });
  await settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Legacy MCP server's Sampling request in a Session", () => {
  it("runs on the small Role's model, is counted in the Session's usage and spend, and is recorded", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({ sampling: "allow" }, sampled);

    // The Run's first request calls the tool; the sample takes the next scripted reply; the Run's next one is the last.
    await run(stub, [sample(1), "a sampled reply", "done"]);

    expect(sampled).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: { type: "text", text: "a sampled reply" },
        model: "claude-haiku-5-5",
        stopReason: "endTurn",
      }),
    ]);

    const usage = await runInDurableObject(stub, (instance: TestSession) =>
      instance.samplingUsage(),
    );

    expect(usage.requests).toBe(1);
    expect(usage.cost).toBeCloseTo(REQUEST_COST);

    // Two requests of the Run and the sample, each at the same price.
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.spent())).toBeCloseTo(
      3 * REQUEST_COST,
    );

    const records = await runInDurableObject(stub, (instance: TestSession) =>
      instance.samplingRecords(),
    );

    expect(records).toEqual([
      expect.objectContaining({
        server: "docs",
        status: "answered",
        role: "small",
        by: "definition",
      }),
    ]);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).not.toContain("refused");
  });

  it("is refused with -1, costing nothing, once the Session is at its Spend limit", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({ sampling: "allow" }, sampled);

    // The Run's first request and the first sample fill the limit: the second sample finds the Session at it.
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.mcpSpendLimit(2 * REQUEST_COST),
    );
    await run(stub, [sample(2), "first reply", "never sent"]);

    expect(sampled).toEqual([
      expect.objectContaining({ content: { type: "text", text: "first reply" } }),
      { error: expect.stringContaining("out of budget"), code: -1 },
    ]);

    const usage = await runInDurableObject(stub, (instance: TestSession) =>
      instance.samplingUsage(),
    );

    expect(usage.requests).toBe(1);

    const records = await runInDurableObject(stub, (instance: TestSession) =>
      instance.samplingRecords(),
    );

    expect(records.map((record) => record.status)).toEqual(["answered", "refused"]);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain("docs asked for a model reply; refused: out of budget");
  });

  it("is not declared by a server whose definition says off", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({ sampling: "off" }, sampled);

    await run(stub, [sample(1), "done"]);

    // The server asked, got an error of the client's lack of the capability, and nothing reached a model.
    expect(sampled).toEqual([{ error: expect.any(String), code: expect.any(Number) }]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 0 });
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingRecords()),
    ).toEqual([]);
  });
});

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

  const last = () => received.findLast((message) => message.type === "mcp_sampling_requests");

  return {
    received,
    requests: (): ReadonlyArray<McpSamplingRequest> => {
      const message = last();

      return message?.type === "mcp_sampling_requests" ? message.requests : [];
    },
    grants: (): ReadonlyArray<McpSamplingSessionGrant> => {
      const message = last();

      return message?.type === "mcp_sampling_requests" ? message.grants : [];
    },
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
};

/** Start a Run that calls the tool and return at once: the owner has a card to answer. */
const start = async (stub: DurableObjectStub<TestSession>, script: ReadonlyArray<string>) => {
  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.script(script);
    await instance.submit({ requestId: `turn-${counter++}`, text: "sample" });
  });
};

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

describe("a Legacy MCP server whose definition says ask, in a Session", () => {
  it.each([
    ["says ask", { sampling: "ask" }],
    ["has no sampling key", {}],
  ])(
    "shows its request on a card, tells the owner, and runs it on their yes when it %s",
    async (_name, server) => {
      const sampled: Array<Schema.Json> = [];
      const { stub } = await open(server, sampled);
      const owner = await connect(stub);

      await start(stub, [sample(1), "a sampled reply", "done"]);
      await settles(async () => expect(owner.requests()).toHaveLength(1));

      const [request] = owner.requests();

      expect(request).toMatchObject({
        server: "docs",
        tool: "mcp__docs__sample",
        role: "small",
        model: "claude-haiku-5-5",
        messages: [{ role: "user", text: expect.any(String) }],
        writable: true,
        source: { kind: "global" },
      });
      expect(request?.roles.map((option) => option.role)).toContain("small");
      expect(sampled).toEqual([]);

      // Told once, in words that carry nothing of what was asked.
      const pushes = (
        await runInDurableObject(stub, (instance: TestSession) => instance.notified())
      ).filter((event) => event.kind === "input");

      expect(pushes).toEqual([
        expect.objectContaining({ mcp: { server: "docs", kind: "sampling" } }),
      ]);

      owner.send({
        type: "mcp_sampling_answer",
        id: "yes",
        request: request?.id ?? "",
        choice: "allow_call",
      });
      await settles(async () => expect(owner.requests()).toEqual([]));
      await idle(stub);

      expect(sampled).toEqual([
        expect.objectContaining({
          content: { type: "text", text: "a sampled reply" },
          model: "claude-haiku-5-5",
        }),
      ]);
      expect(
        (await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()))
          .requests,
      ).toBe(1);

      const records = await runInDurableObject(stub, (instance: TestSession) =>
        instance.samplingRecords(),
      );

      expect(records).toEqual([
        expect.objectContaining({ status: "answered", by: "owner", grant: "call", role: "small" }),
      ]);

      // The card expands the settled record.
      owner.send({ type: "mcp_sampling_get", id: "get", request: request?.id ?? "" });
      await settles(async () =>
        expect(owner.received).toContainEqual(
          expect.objectContaining({
            type: "result",
            id: "get",
            result: expect.objectContaining({
              status: "answered",
              by: "owner",
              reply: "a sampled reply",
            }),
          }),
        ),
      );
      owner.send({ type: "mcp_sampling_get", id: "none", request: "nope:1" });
      await settles(async () =>
        expect(owner.received).toContainEqual({ type: "result", id: "none", result: null }),
      );
    },
  );

  it("answers the server -1 when the owner refuses, and tells the agent it was the owner", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({}, sampled);
    const owner = await connect(stub);

    await start(stub, [sample(1), "never sampled", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    owner.send({
      type: "mcp_sampling_answer",
      id: "no",
      request: owner.requests()[0]?.id ?? "",
      choice: "refuse",
    });
    await idle(stub);

    expect(sampled).toEqual([{ error: "refused by the owner", code: -1 }]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 0 });

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain("docs asked for a model reply; refused by you");
  });

  it("keeps Allow in this Session for the next call, lists it, and asks again once the owner takes it back", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({}, sampled);
    const owner = await connect(stub);

    await start(stub, [sample(1), "first", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    owner.send({
      type: "mcp_sampling_answer",
      id: "session",
      request: owner.requests()[0]?.id ?? "",
      choice: "allow_session",
    });
    await idle(stub);
    await settles(async () =>
      expect(owner.grants()).toEqual([{ server: "docs", action: "allow" }]),
    );

    // The next call's request needs no card.
    await start(stub, [sample(1), "second", "done"]);
    await idle(stub);

    expect(
      sampled.map((each) =>
        Schema.is(Schema.Struct({ content: Schema.Json }))(each) ? each.content : null,
      ),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);

    // A client that connects later is told of the grant too.
    const later = await connect(stub);

    await settles(async () =>
      expect(later.grants()).toEqual([{ server: "docs", action: "allow" }]),
    );
    later.close();

    owner.send({ type: "mcp_sampling_revoke", id: "revoke", server: "docs" });
    await settles(async () => expect(owner.grants()).toEqual([]));

    await start(stub, [sample(1), "third", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    owner.send({
      type: "mcp_sampling_answer",
      id: "no",
      request: owner.requests()[0]?.id ?? "",
      choice: "refuse",
    });
    await idle(stub);
  });

  it("writes the definition on Always allow and Never", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({}, sampled);
    const owner = await connect(stub);

    await start(stub, [sample(1), "always", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    owner.send({
      type: "mcp_sampling_answer",
      id: "always",
      request: owner.requests()[0]?.id ?? "",
      choice: "allow_always",
    });
    await idle(stub);

    await start(stub, [sample(1), "never sampled", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    // The Session's own grant is the call's only, so this second call asks again; it is Never this time.
    owner.send({
      type: "mcp_sampling_answer",
      id: "never",
      request: owner.requests()[0]?.id ?? "",
      choice: "refuse_never",
    });
    await idle(stub);

    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingWrites()),
    ).toEqual([
      { server: "docs", value: "allow" },
      { server: "docs", value: "off" },
    ]);
  });

  it("answers -1 when the owner does not answer in time, and withdraws the card", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({}, sampled, "mcp-short-wait-sampling");
    const owner = await connect(stub);

    await start(stub, [sample(1), "never sampled", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    await settles(async () => expect(owner.requests()).toEqual([]));
    await idle(stub);

    expect(sampled).toEqual([{ error: "the owner did not answer in time", code: -1 }]);
  });

  it('withdraws the card and records "Run stopped" when the owner stops the Run', async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({}, sampled);
    const owner = await connect(stub);

    await start(stub, [sample(1), "never sampled", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    owner.send({ type: "abort", id: "stop" });
    await settles(async () => expect(owner.requests()).toEqual([]));
    await idle(stub);

    const records = await runInDurableObject(stub, (instance: TestSession) =>
      instance.samplingRecords(),
    );

    expect(records).toMatchObject([{ status: "refused", reason: "Run stopped" }]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 0 });
  });

  it("checks the Spend limit again after the owner decides, and refuses what the wait made too dear", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({}, sampled);
    const owner = await connect(stub);

    // Room for the Run's first request and one more: the card is shown, then the limit is lowered while it waits.
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.mcpSpendLimit(10 * REQUEST_COST),
    );
    await start(stub, [sample(1), "never sampled", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.mcpSpendLimit(REQUEST_COST / 2),
    );
    owner.send({
      type: "mcp_sampling_answer",
      id: "yes",
      request: owner.requests()[0]?.id ?? "",
      choice: "allow_call",
    });
    await idle(stub);

    expect(sampled).toEqual([{ error: expect.stringContaining("out of budget"), code: -1 }]);

    const records = await runInDurableObject(stub, (instance: TestSession) =>
      instance.samplingRecords(),
    );

    expect(records).toMatchObject([{ status: "refused", why: "budget" }]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingUsage()),
    ).toMatchObject({ requests: 0 });
  });

  it("offers no Always allow or Never where the Session cannot write a definition, and refuses to", async () => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open({}, sampled, "mcp-unwritable-sampling");
    const owner = await connect(stub);

    await start(stub, [sample(1), "never sampled", "done"]);
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    expect(owner.requests()[0]?.writable).toBe(false);

    owner.send({
      type: "mcp_sampling_answer",
      id: "always",
      request: owner.requests()[0]?.id ?? "",
      choice: "allow_always",
    });
    await settles(async () =>
      expect(owner.received.some((message) => message.type === "error")).toBe(true),
    );
    expect(owner.requests()).toHaveLength(1);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.samplingWrites()),
    ).toEqual([]);

    owner.send({
      type: "mcp_sampling_answer",
      id: "no",
      request: owner.requests()[0]?.id ?? "",
      choice: "refuse",
    });
    await idle(stub);
  });
});
