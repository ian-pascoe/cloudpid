/**
 * A Modern server's questions through the engine (`docs/architecture/mcp-server-requests.md` → Questions; ADR-0037): a
 * call whose caller offers elicitation declares the form in the request's `_meta`; one whose caller defers its questions
 * (`ctx.answers.defer`) is answered `input_required` with the `ResumeState`, and `op: "resume"` sends it again with the
 * answers. A caller that keeps no questions never gets `input_required`: a deferral reads as a `cancel`.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off
import { ASK_TOOL, fetchTo, modernServer, type FakeServer } from "@cloudpid/mcp/testing";
import {
  MCP_RESUME_STATE_EXPIRED,
  type McpCallContext,
  type McpEngineHooks,
  type McpEngineRequestEncoded,
  McpEngineRequestResult,
  type McpInputRequest,
  Unsupported,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ByteBudget } from "./budget.ts";
import { request } from "./calls.ts";
import { Validators } from "./validators.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const FORM = { type: "object", properties: { name: { type: "string" } } };

const target = {
  kind: "http" as const,
  conn: "conn-1",
  name: "forms",
  url: "https://mcp.example.test/mcp",
  redact: [],
};

const DEFERRING: McpCallContext = {
  origin: "agent",
  conversation: "c1",
  answers: { elicitation: true, defer: true },
};

const decode = Schema.decodeSync(McpEngineRequestResult);

/** Sends `req` to `server` through the engine. */
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

const callAsk = (ctx: McpCallContext): McpEngineRequestEncoded => ({
  op: "tools/call",
  tool: ASK_TOOL,
  arguments: { message: "Who are you?", requestedSchema: FORM },
  ctx,
});

/** The client capabilities the first `tools/call` declared in its `_meta`. */
const declared = (server: FakeServer) =>
  server.received.find((received) => received.rpc?.method === "tools/call")?.rpc?.params?.["_meta"];

const textOf = (result: McpEngineRequestResult) =>
  result.kind === "complete" && result.result.kind === "inline"
    ? JSON.stringify(result.result.value)
    : "";

const deferring: McpEngineHooks = {
  onInput: () => Promise.resolve({ kind: "defer" }),
};

describe("a Modern server's questions through the engine", () => {
  it("answers a deferred round input_required with its ResumeState, and resumes it with the answers", async () => {
    const options = { moreTools: [ASK_TOOL], asked: [] };
    const server = modernServer(options);
    const seen: Array<McpInputRequest> = [];

    const first = await send(server, callAsk(DEFERRING), {
      onInput: (input) => {
        seen.push(input);

        return Promise.resolve({ kind: "defer" });
      },
    });

    expect(declared(server)).toMatchObject({
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
    });
    expect(seen).toMatchObject([{ key: "q1", kind: "elicitation", mode: "deferrable" }]);
    expect(first).toMatchObject({
      kind: "input_required",
      requests: [{ key: "q1", kind: "elicitation", mode: "deferrable" }],
      resume: { v: 1, name: "ask", requestState: "round-1", deferred: ["q1"] },
    });

    if (first.kind !== "input_required") throw new Error("Expected input_required");

    const resumed = await send(
      server,
      {
        op: "resume",
        tool: ASK_TOOL,
        resume: first.resume,
        answers: { q1: { action: "accept", content: { name: "Ada" } } },
        ctx: DEFERRING,
      },
      deferring,
    );

    expect(resumed.kind).toBe("complete");
    expect(textOf(resumed)).toContain('\\"name\\":\\"Ada\\"');
    expect(options.asked).toEqual([expect.objectContaining({ round: 1, state: "round-1" })]);
  });

  it("reads a deferral as a cancel for a caller that keeps no questions", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const result = await send(
      server,
      callAsk({ origin: "agent", conversation: "c1", answers: { elicitation: true } }),
      deferring,
    );

    expect(result.kind).toBe("complete");
    expect(textOf(result)).toContain('{\\"action\\":\\"cancel\\"}');
  });

  it("declares no elicitation on a call that offers none, or has no onInput", async () => {
    const offersNone = modernServer({ moreTools: [ASK_TOOL] });
    const noHook = modernServer({ moreTools: [ASK_TOOL] });

    await send(offersNone, callAsk({ origin: "agent", conversation: "c1" }), deferring);
    await send(noHook, callAsk(DEFERRING), {});

    for (const server of [offersNone, noHook]) {
      expect(declared(server)).not.toMatchObject({
        "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
      });
    }
  });

  it("refuses to resume a state of a format it does not know, sending nothing", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const result = await send(
      server,
      {
        op: "resume",
        tool: ASK_TOOL,
        resume: { v: 99 },
        answers: { q1: { action: "cancel" } },
        ctx: DEFERRING,
      },
      deferring,
    );

    expect(result.kind === "failed" && result.error).toEqual(
      Unsupported.make({ message: MCP_RESUME_STATE_EXPIRED }),
    );
    expect(server.received.some((received) => received.rpc?.method === "tools/call")).toBe(false);
  });
});
