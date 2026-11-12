/**
 * A Legacy server's `-32042` through the engine (`docs/architecture/mcp-server-requests.md` → Elicitation requests, URL
 * mode): a call whose caller keeps pages (`ctx.answers.pages`, with `defer`) is answered `pages_required` with the
 * `ResendState`, and `op: "resend"` sends it again with an answer for each page. A caller that does not keep pages gets
 * the server's error, as before, and an engine from before the op refuses it as unknown.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off
import { fetchTo, GATED_TOOL, legacyStatefulServer, type FakeServer } from "@cloudpid/mcp/testing";
import {
  type McpCallContext,
  type McpEngineHooks,
  type McpEngineRequestEncoded,
  McpEngineRequestResult,
  ServerError,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ByteBudget } from "./budget.ts";
import { request } from "./calls.ts";
import { Validators } from "./validators.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const target = {
  kind: "http" as const,
  conn: "conn-1",
  name: "pages",
  url: "https://mcp.example.test/mcp",
  redact: [],
};

const KEEPING: McpCallContext = {
  origin: "agent",
  conversation: "c1",
  answers: { elicitation: true, defer: true, pages: true },
};

const decode = Schema.decodeSync(McpEngineRequestResult);

const send = async (server: FakeServer, req: McpEngineRequestEncoded, hooks: McpEngineHooks) => {
  vi.stubGlobal("fetch", fetchTo(server));

  return decode(
    await Effect.runPromise(
      request(target, {}, req, hooks, { version: "test", hold: () => undefined }).pipe(
        Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer)),
      ),
    ),
  );
};

const call = (ctx: McpCallContext): McpEngineRequestEncoded => ({
  op: "tools/call",
  tool: GATED_TOOL,
  arguments: {},
  ctx,
});

const keeping: McpEngineHooks = { onInput: () => Promise.resolve({ kind: "defer" }) };

describe("a Legacy server's -32042 through the engine", () => {
  it("is answered pages_required with its ResendState, and op resend sends the call again", async () => {
    const gate = { times: 1, calls: 0, pages: 2 };
    const server = legacyStatefulServer({ moreTools: [GATED_TOOL], gate });
    const first = await send(server, call(KEEPING), keeping);

    expect(first).toMatchObject({
      kind: "pages_required",
      requests: [{ key: "page-1" }, { key: "page-2" }],
      resend: {
        v: 1,
        name: "gated",
        deferred: ["page-1", "page-2"],
        message: "Authorization needed",
      },
    });

    if (first.kind !== "pages_required") throw new Error("Expected pages_required");

    const resent = await send(
      server,
      {
        op: "resend",
        tool: GATED_TOOL,
        resend: first.resend ?? null,
        answers: { "page-1": { action: "accept" }, "page-2": { action: "accept" } },
        ctx: KEEPING,
      },
      keeping,
    );

    expect(resent.kind).toBe("complete");
    expect(gate.calls).toBe(2);
  });

  it("is the server's error to a caller that does not keep pages", async () => {
    const server = legacyStatefulServer({
      moreTools: [GATED_TOOL],
      gate: { times: 1, calls: 0 },
    });

    const failed = await send(
      server,
      call({ ...KEEPING, answers: { elicitation: true, defer: true } }),
      keeping,
    );

    expect(failed.kind === "failed" && failed.error).toEqual(
      ServerError.make({ message: "Authorization needed", code: -32042 }),
    );
  });
});
