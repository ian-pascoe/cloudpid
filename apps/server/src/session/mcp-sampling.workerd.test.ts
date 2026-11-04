// A Legacy MCP server's Sampling request end to end (`docs/architecture/mcp-server-requests.md` → Sampling requests;
// ADR-0039): the agent's call goes Session → host → the real `McpEngine` → a fake Legacy server whose tool asks the client
// for model replies during the call. A server whose definition says `sampling: "allow"` is declared a client that samples,
// and each request runs on the Session's models (the `small` Role's), is counted in the Session's usage and spend, and is
// refused with `-1` once the Session is at its Spend limit; any other server is declared nothing.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { legacyStatefulServer, SAMPLE_TOOL } from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import type * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_COST, type TestSession } from "./host.fixture.ts";

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
const open = async (server: Record<string, Schema.Json>, sampled: Array<Schema.Json>) => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const fake = legacyStatefulServer({ moreTools: [SAMPLE_TOOL], sampled });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fake.handle(new Request(input, init)),
  );

  await host.useRealEngine();
  await host.apply(setOf(server));

  const stub = env.SESSIONS.getByName(`mcp-sampling-${environment}`);

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

  it.each([
    ["has no sampling key", {}],
    ["says ask, which is not answered yet", { sampling: "ask" }],
    ["says deny", { sampling: "deny" }],
  ])("is not declared by a server whose definition %s", async (_name, server) => {
    const sampled: Array<Schema.Json> = [];
    const { stub } = await open(server, sampled);

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
