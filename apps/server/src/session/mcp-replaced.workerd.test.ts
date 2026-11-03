// A Session replaced by a code update while an MCP tool's call is out (`docs/architecture/mcp-connections.md` → Deploys;
// [Deploys under deferred Durable Object code updates](https://github.com/ian-pascoe/cloudpid/issues/423) D4, D6): the old
// instance keeps its call, which runs to its end, but every storage operation of the Session fails (`refusingStorage`, tripped
// through the test Session's `replace()`). The result is dropped, since nothing can record it, and the new instance settles
// the call as one that may have partially run, never sending it again.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { McpApplySet, McpEngineDiscoverResult } from "@cloudpid/mcp/types";
import { describe, expect, it, vi } from "vitest";
import type { EngineScript } from "../mcp/host.fixture.ts";
import { constructions, type TestSession } from "./host.fixture.ts";

/** `vi.waitFor`, with room for a loaded CI runner. */
const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

const DOCS = "https://docs.example/mcp";

const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: DOCS, headers: {}, exposure: "direct" },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
};

/** A discovery of `docs` that found the tool `work`. */
const FOUND: EngineScript = {
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: [{ name: "work", inputSchema: { type: "object" } }],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
};

describe("a Session replaced mid-call", () => {
  it("drops the result of the call it holds, and the new instance settles it as one that may have partially run, never sending it again", async () => {
    const environment = `env-${counter++}`;
    const name = `mcp-replaced-${environment}`;
    const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

    await host.script({ hash: SET.hash, signInsRevision: 0 });
    await host.scriptEngine(DOCS, [FOUND]);
    await host.apply(SET);

    const stub = env.SESSIONS.getByName(name);

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.mcpEnvironment(environment, 1);
    });

    await host.scriptRequest(DOCS, [
      {
        result: {
          kind: "complete",
          result: { kind: "inline", value: { content: [{ type: "text", text: "late" }] } },
          cacheable: true,
          fetchedAt: Date.now(),
          state: {},
        },
        hold: true,
      },
    ]);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["call:mcp__docs__work:{}", "done"]);
      await instance.submit({ requestId: "turn-1", text: "work" });
    });

    // The call is out at the engine, which holds it. The code update reaches the Session; the host's call goes on.
    await settles(async () => expect(await host.engineRequests()).toHaveLength(1));
    await runInDurableObject(stub, (instance: TestSession) => instance.replace());
    await host.release(DOCS);

    // The host's answer reaches a Session that cannot record it: the instance is reset, and the next event starts a new one.
    const id = stub.id.toString();

    await settles(async () => {
      const after = env.SESSIONS.getByName(name);

      await runDurableObjectAlarm(after);
      expect(constructions.get(id)).toBeGreaterThan(1);
    });

    const after = env.SESSIONS.getByName(name);

    await settles(async () =>
      expect(await runInDurableObject(after, (instance: TestSession) => instance.idle())).toBe(
        true,
      ),
    );

    const results = await runInDurableObject(after, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.at(-1)).toMatch(
      /mcp__docs__work was interrupted and may have partially run; it was not sent again\./,
    );
    expect(results.join("\n")).not.toContain("late");

    // The call went to the host once: the new instance did not send it again.
    expect(await host.engineRequests()).toHaveLength(1);
  });
});
