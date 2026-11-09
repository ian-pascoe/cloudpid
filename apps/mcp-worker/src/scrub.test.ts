/**
 * What the engine scrubs (`scrub.ts`; `docs/architecture/mcp-connections.md` → Telemetry): the string values of what a
 * server says, never a key, a number or the engine's own fields, and never a name, which is left out instead.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off globalJsonInEffect:off globalDate:off
import { type FakeServer, fetchTo, hostileServer, modernServer } from "@cloudpid/mcp/testing";
import {
  type McpEngineRequestEncoded,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ByteBudget } from "./budget.ts";
import { discover, request } from "./calls.ts";
import { promptsLeftOut, scrubValues, toolsLeftOut, vetListed } from "./scrub.ts";
import { Validators } from "./validators.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const secrets = (...values: ReadonlyArray<string>) => new Set(values);

describe("scrubValues", () => {
  it("replaces inside string values only: never a key, a number or the shape", () => {
    expect(
      scrubValues(
        { "key-1759": 1759, n: 1759, s: "id 1759", list: [1759, "x1759"], nested: { ok: true } },
        secrets("1759"),
      ),
    ).toEqual({
      "key-1759": 1759,
      n: 1759,
      s: "id [REDACTED]",
      list: [1759, "x[REDACTED]"],
      nested: { ok: true },
    });
  });

  it("finds a value as it is, JSON-escaped, and encoded for a URL path and a query", () => {
    const value = 'p"w\\ &x';

    for (const echoed of [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      new URLSearchParams({ k: value }).toString().slice(2),
    ]) {
      expect(scrubValues(`echo ${echoed}!`, secrets(value))).toBe("echo [REDACTED]!");
    }
  });
});

describe("vetListed", () => {
  it("leaves out an item with a secret in its name or a key of its schema, by place, and scrubs the rest", () => {
    const vetted = vetListed(
      "tool",
      [
        { name: "acme_search" },
        { name: "ok", inputSchema: { properties: { acme_key: {} } } },
        { name: "fine", description: "about acme" },
      ],
      secrets("acme"),
    );

    expect(vetted.kept).toEqual([{ name: "fine", description: "about [REDACTED]" }]);
    expect(vetted.left).toEqual(["tool #1", "tool #2"]);
    expect(JSON.stringify([toolsLeftOut(vetted.left), promptsLeftOut(vetted.left)])).not.toContain(
      "acme",
    );
  });
});

const ENV = { version: "test", hold: () => undefined };

const AGENT = { origin: "agent" as const, conversation: "conversation-1" };

const targetOf = (redact: ReadonlyArray<string>) => ({
  kind: "http" as const,
  conn: "conn-1",
  name: "docs",
  url: "https://mcp.example.test/mcp",
  redact,
});

const onEngine = <A>(
  server: FakeServer,
  work: Effect.Effect<A, never, ByteBudget | Validators>,
) => {
  vi.stubGlobal("fetch", fetchTo(server));

  return Effect.runPromise(
    work.pipe(Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer))),
  );
};

const discovered = async (server: FakeServer, redact: ReadonlyArray<string>) =>
  Schema.decodeSync(McpEngineDiscoverResult)(
    await onEngine(server, discover(targetOf(redact), {}, {}, ENV)),
  );

const requested = async (
  server: FakeServer,
  redact: ReadonlyArray<string>,
  input: McpEngineRequestEncoded,
) =>
  Schema.decodeSync(McpEngineRequestResult)(
    await onEngine(server, request(targetOf(redact), {}, input, {}, ENV)),
  );

describe("a discovery whose Secret looks like what the engine itself reports", () => {
  it("keeps its own fields, whole, whatever a Secret holds, and scrubs the strings the server told", async () => {
    const before = await discovered(modernServer(), []);

    if (before.kind !== "discovered") throw new Error(JSON.stringify(before));

    // A year, as `protocolVersion` starts with; and the front of today's epoch milliseconds, as `fetchedAt` does.
    const year = before.protocolVersion.slice(0, 4);
    const epoch = String(Date.now()).slice(0, 4);

    const server = modernServer({
      moreTools: [
        {
          name: "dated",
          description: `Dated ${year}, stamped ${epoch}.`,
          inputSchema: { type: "object" },
        },
      ],
    });

    const after = await discovered(server, [year, epoch]);

    if (after.kind !== "discovered") throw new Error(JSON.stringify(after));

    expect(after.protocolVersion).toBe(before.protocolVersion);
    expect(after.fetchedAt).toBeTypeOf("number");
    expect(after.state).toMatchObject({ era: { era: "modern" } });
    expect(after.tools.find((tool) => tool.name === "dated")?.description).toBe(
      "Dated [REDACTED], stamped [REDACTED].",
    );
  });
});

describe("a tools/list result", () => {
  it("leaves a tool out for a Secret in its name, with a problem, instead of renaming it", async () => {
    const server = modernServer({
      moreTools: [
        { name: "acme_search", description: "about acme", inputSchema: { type: "object" } },
        { name: "plain", description: "about acme", inputSchema: { type: "object" } },
      ],
    });

    const result = await requested(server, ["acme"], { op: "tools/list", ctx: AGENT });

    if (result.kind !== "complete" || result.result.kind !== "inline") {
      throw new Error(JSON.stringify(result));
    }

    const tools = JSON.stringify(result.result.value);

    expect(tools).not.toContain("acme_search");
    expect(tools).toContain('"name":"plain"');
    expect(tools).toContain("about [REDACTED]");
    expect(result.problems).toEqual([
      expect.objectContaining({ problem: expect.stringContaining("left out") }),
    ]);
  });
});

describe("the tools listed again after a -32020", () => {
  it("are vetted as a discovery vets them", async () => {
    const stubborn = { name: "stubborn", inputSchema: { type: "object" as const } };

    const server = hostileServer(
      modernServer({
        moreTools: [
          stubborn,
          { name: "acme_search", inputSchema: { type: "object" } },
          { name: "plain", description: "about acme", inputSchema: { type: "object" } },
        ],
      }),
      (_request, rpc) =>
        rpc?.method === "tools/call" && rpc.params?.["name"] === "stubborn"
          ? Response.json(
              { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32020, message: "mismatch" } },
              { status: 400 },
            )
          : undefined,
    );

    const result = await requested(server, ["acme"], {
      op: "tools/call",
      tool: stubborn,
      ctx: AGENT,
    });

    expect(result.kind).toBe("failed");

    if (result.kind !== "failed") return;

    const names = result.tools?.map((tool) => tool.name) ?? [];

    expect(names).toContain("plain");
    expect(names).not.toContain("acme_search");
    expect(result.tools?.find((tool) => tool.name === "plain")?.description).toBe(
      "about [REDACTED]",
    );
    expect(JSON.stringify(result.problems)).not.toContain("acme");
    expect(result.problems).toContainEqual(
      expect.objectContaining({ problem: expect.stringContaining("left out") }),
    );
  });
});
