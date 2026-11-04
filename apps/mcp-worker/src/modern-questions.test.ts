/**
 * A Modern server's questions through the engine (`docs/architecture/mcp-server-requests.md` → Questions; ADR-0037): a
 * call whose caller offers elicitation declares the form in the request's `_meta`; one whose caller defers its
 * questions (`ctx.answers.defer`) is answered `input_required` with the `ResumeState`, and `op: "resume"` sends it
 * again with the answers. A caller that keeps no questions never gets `input_required`: a deferral reads as a `cancel`.
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
const send = async (
  server: FakeServer,
  req: McpEngineRequestEncoded,
  hooks: McpEngineHooks,
  to: typeof target & { readonly sampling?: boolean } = target,
) => {
  vi.stubGlobal("fetch", fetchTo(server));

  return decode(
    await Effect.runPromise(
      request(to, {}, req, hooks, { version: "test", hold: () => undefined }).pipe(
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

  it("declares the URL mode only on a call that keeps a page for later and resumes it, and never on a read", async () => {
    const paging: McpCallContext = { ...DEFERRING, answers: { ...DEFERRING.answers, pages: true } };

    const keeps = modernServer({ moreTools: [ASK_TOOL] });
    const defersOnly = modernServer({ moreTools: [ASK_TOOL] });

    const reads = modernServer({
      resources: [
        { uri: "file:///a.txt", name: "a", contents: [{ uri: "file:///a.txt", text: "a" }] },
      ],
    });

    await send(keeps, callAsk(paging), deferring);
    await send(defersOnly, callAsk(DEFERRING), deferring);
    await send(reads, { op: "resources/read", uri: "file:///a.txt", ctx: paging }, deferring);

    expect(declared(keeps)).toMatchObject({
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } },
    });
    expect(declared(defersOnly)).toMatchObject({
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
    });
    // Form only, and none on a read, which has no resume to wait for a page with.
    expect(JSON.stringify(declared(defersOnly))).toContain('"elicitation":{"form":{}}');

    const read = reads.received.find((received) => received.rpc?.method === "resources/read");

    expect(JSON.stringify(read?.rpc?.params?.["_meta"])).toContain('"elicitation":{"form":{}}');
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

  it("declares sampling only on a call whose caller offers to answer it, for a server the definition lets sample", async () => {
    const SAMPLING: McpCallContext = {
      origin: "agent",
      conversation: "c1",
      answers: { elicitation: true, sampling: true, defer: true },
    };

    const offers = modernServer({ moreTools: [ASK_TOOL] });
    const offersNone = modernServer({ moreTools: [ASK_TOOL] });
    const noHook = modernServer({ moreTools: [ASK_TOOL] });
    const notLet = modernServer({ moreTools: [ASK_TOOL] });
    const sampling = { ...target, sampling: true };

    await send(offers, callAsk(SAMPLING), deferring, sampling);
    await send(offersNone, callAsk(DEFERRING), deferring, sampling);
    await send(noHook, callAsk(SAMPLING), {}, sampling);
    // The target says the definition does not let it (`off`, or stdio): nothing is declared whatever the call says.
    await send(notLet, callAsk(SAMPLING), deferring);

    expect(declared(offers)).toMatchObject({
      "io.modelcontextprotocol/clientCapabilities": { sampling: { tools: {} } },
    });

    for (const server of [offersNone, noHook, notLet]) {
      expect(JSON.stringify(declared(server))).not.toContain("sampling");
    }
  });

  it("keeps a Sampling request for later, with the question's key and kind, and resumes it with the reply", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL], asked: [] });
    const seen: Array<McpInputRequest> = [];
    const sampling = { ...target, sampling: true };

    const ctx: McpCallContext = {
      origin: "agent",
      conversation: "c1",
      answers: { sampling: true, defer: true },
    };

    const first = await send(
      server,
      {
        op: "tools/call",
        tool: ASK_TOOL,
        arguments: { message: "?", forms: 0, samples: 1 },
        ctx,
      },
      {
        onInput: (input) => {
          seen.push(input);

          return Promise.resolve({ kind: "defer" });
        },
      },
      sampling,
    );

    expect(seen).toMatchObject([{ key: "s1", kind: "sampling", era: "modern" }]);

    if (first.kind !== "input_required") throw new Error("Expected input_required");

    const reply = { role: "assistant", content: { type: "text", text: "Hi" }, model: "m" };

    const resumed = await send(
      server,
      {
        op: "resume",
        tool: ASK_TOOL,
        resume: first.resume,
        answers: { s1: reply },
        ctx,
      },
      deferring,
      sampling,
    );

    expect(resumed.kind).toBe("complete");
    expect(textOf(resumed)).toContain('\\"model\\":\\"m\\"');
  });
});
