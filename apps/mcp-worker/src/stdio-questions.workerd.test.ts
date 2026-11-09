/**
 * A stdio server's questions through the engine (`docs/architecture/mcp-server-requests.md` → Questions, #569): its
 * bridge carries the server's `elicitation/create` and `sampling/createMessage` on the call's stream and the answer back
 * by POST, as an HTTP server's are, so a Legacy stdio server is declared elicitation and (when its definition says
 * `allow` or `ask`) sampling, and its questions reach the host's `onInput`. The bridge is a stand-in over a fake server.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off
import {
  ASK_TOOL,
  legacyStatefulServer,
  type FakeServer,
  SAMPLE_TOOL,
} from "@cloudpid/mcp/testing";
import {
  type McpEngineHooks,
  McpEngineRequestResult,
  type McpInputAnswer,
  type McpInputRequest,
} from "@cloudpid/mcp/types";
import { MCP_BRIDGE_LEVEL_HEADER } from "@cloudpid/sandbox-image/mcp-bridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { McpBridgeBinding } from "./binding.ts";
import { ByteBudget } from "./budget.ts";
import { request } from "./calls.ts";
import { MCP_BRIDGE_MIN_LEVEL } from "./bridge.ts";
import { Validators } from "./validators.ts";

const FORM = {
  type: "object" as const,
  properties: { name: { type: "string" } },
  required: ["name"],
};

const stdio = {
  kind: "stdio" as const,
  conn: "conn-1",
  name: "forms",
  workspace: "ws:aaaa1111",
  start: true,
  command: "fake-server",
  redact: [],
};

const decode = Schema.decodeSync(McpEngineRequestResult);

/** A `MCP_BRIDGE` that hands each request to `server`, answering as a bridge of the minimum level does. */
const bridgeTo = (server: FakeServer): McpBridgeBinding => ({
  mcpBridge: async (_workspace, incoming) => {
    const answered = await server.handle(incoming);
    const response = new Response(answered.body, answered);

    response.headers.set(MCP_BRIDGE_LEVEL_HEADER, String(MCP_BRIDGE_MIN_LEVEL));

    return response;
  },
});

const textOf = (result: McpEngineRequestResult) =>
  result.kind === "complete" && result.result.kind === "inline"
    ? JSON.stringify(result.result.value)
    : "";

const send = async (
  server: FakeServer,
  to: typeof stdio & { readonly sampling?: boolean },
  tool: typeof ASK_TOOL | typeof SAMPLE_TOOL,
  args: Record<string, Schema.Json>,
  answers: { readonly elicitation?: true; readonly sampling?: true },
  hooks: McpEngineHooks,
) =>
  decode(
    await Effect.runPromise(
      request(
        to,
        {},
        {
          op: "tools/call",
          tool,
          arguments: args,
          ctx: { origin: "agent", conversation: "c1", answers },
        },
        hooks,
        { version: "test", hold: () => undefined, bridge: bridgeTo(server) },
      ).pipe(Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer))),
    ),
  );

const initializeOf = (server: FakeServer) =>
  server.received.find((received) => received.rpc?.method === "initialize")?.rpc?.params;

describe("a Legacy stdio server's question", () => {
  it("is declared at initialize and reaches the host's onInput, with the owner's answer carried back", async () => {
    const seen: Array<McpInputRequest> = [];
    const server = legacyStatefulServer({ moreTools: [ASK_TOOL], asked: [] });

    const result = await send(
      server,
      stdio,
      ASK_TOOL,
      { message: "Who are you?", requestedSchema: FORM },
      { elicitation: true },
      {
        onInput: (input): Promise<McpInputAnswer> => {
          seen.push(input);

          return Promise.resolve({
            kind: "answered",
            result: { action: "accept", content: { name: "Ada" } },
          });
        },
      },
    );

    expect(initializeOf(server)).toMatchObject({
      capabilities: { elicitation: { form: {}, url: {} } },
    });
    expect(seen).toMatchObject([
      { kind: "elicitation", mode: "live", params: { message: "Who are you?" } },
    ]);
    expect(textOf(result)).toContain(
      '{\\"action\\":\\"accept\\",\\"content\\":{\\"name\\":\\"Ada\\"}}',
    );
  });
});

describe("a Legacy stdio server's Sampling request", () => {
  const reply: McpInputAnswer = {
    kind: "sampled",
    result: { role: "assistant", content: { type: "text", text: "Hi" }, model: "m" },
  };

  it("is declared at initialize when the target says sampling, and answered with the reply", async () => {
    const seen: Array<McpInputRequest> = [];
    const server = legacyStatefulServer({ moreTools: [SAMPLE_TOOL], sampled: [] });

    await send(
      server,
      { ...stdio, sampling: true },
      SAMPLE_TOOL,
      { rounds: 1 },
      { sampling: true },
      {
        onInput: (input) => {
          seen.push(input);

          return Promise.resolve(reply);
        },
      },
    );

    expect(initializeOf(server)).toMatchObject({ capabilities: { sampling: { tools: {} } } });
    expect(seen).toMatchObject([{ kind: "sampling", mode: "live" }]);
  });

  it("is not declared when the target says nothing of sampling", async () => {
    const server = legacyStatefulServer({ moreTools: [SAMPLE_TOOL], sampled: [] });

    await send(
      server,
      stdio,
      SAMPLE_TOOL,
      { rounds: 1 },
      { sampling: true },
      {
        onInput: () => Promise.resolve(reply),
      },
    );

    expect(JSON.stringify(initializeOf(server))).not.toContain("sampling");
  });
});
