/**
 * A Legacy server's question through the engine (`docs/architecture/mcp-server-requests.md` → Questions): the host's
 * `onInput` hook answers it while the call waits, a caller that cannot answer cancels it, and an answer this build does
 * not know is a refusal; the engine keeps nothing of either.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off
import {
  ASK_TOOL,
  fetchTo,
  legacyStatefulServer,
  type FakeOptions,
  SAMPLE_TOOL,
} from "@cloudpid/mcp/testing";
import {
  type McpEngineHooks,
  McpEngineRequestResult,
  type McpInputAnswer,
  type McpInputRequest,
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

const FORM = {
  type: "object" as const,
  properties: { name: { type: "string" } },
  required: ["name"],
};

const target = {
  kind: "http" as const,
  conn: "conn-1",
  name: "forms",
  url: "https://mcp.example.test/mcp",
  redact: [],
};

const decode = Schema.decodeSync(McpEngineRequestResult);

/** Calls `ask` on a stateful Legacy server, with `hooks` and `answers`, and what the server heard of the client. */
const asking = async (hooks: McpEngineHooks, answers: boolean, options: FakeOptions = {}) => {
  const asked = options.asked ?? [];
  const server = legacyStatefulServer({ moreTools: [ASK_TOOL], ...options, asked });

  vi.stubGlobal("fetch", fetchTo(server));

  const result = decode(
    await Effect.runPromise(
      request(
        target,
        {},
        {
          op: "tools/call",
          tool: ASK_TOOL,
          arguments: { message: "Who are you?", requestedSchema: FORM },
          ctx: answers
            ? { origin: "agent", conversation: "c1", answers: { elicitation: true } }
            : { origin: "agent", conversation: "c1" },
        },
        hooks,
        { version: "test", hold: () => undefined },
      ).pipe(Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer))),
    ),
  );

  const text =
    result.kind === "complete" && result.result.kind === "inline"
      ? JSON.stringify(result.result.value)
      : "";

  return { server, asked, text };
};

describe("a question the engine passes to the host's onInput", () => {
  it("declares the form at initialize, and carries the server's request there and the owner's answer back", async () => {
    const seen: Array<McpInputRequest> = [];

    const onInput = (input: McpInputRequest): Promise<McpInputAnswer> => {
      seen.push(input);

      return Promise.resolve({
        kind: "answered",
        result: { action: "accept", content: { name: "Ada" } },
      });
    };

    const { server, text } = await asking({ onInput }, true);

    expect(seen).toMatchObject([
      {
        kind: "elicitation",
        mode: "live",
        params: { message: "Who are you?", requestedSchema: FORM },
      },
    ]);
    expect(text).toContain('{\\"action\\":\\"accept\\",\\"content\\":{\\"name\\":\\"Ada\\"}}');

    const initialize = server.received.find((received) => received.rpc?.method === "initialize");

    expect(initialize?.rpc?.params).toMatchObject({
      capabilities: { elicitation: { form: {}, url: {} } },
    });
  });

  it("is cancelled when the call can answer nothing, or the host gave no onInput", async () => {
    const seen: Array<McpInputRequest> = [];

    const noAnswers = await asking(
      {
        onInput: (input) => {
          seen.push(input);

          return Promise.resolve({ kind: "answered", result: { action: "accept" } });
        },
      },
      false,
    );

    const noHook = await asking({}, true);

    expect(seen).toEqual([]);
    expect(noAnswers.text).toContain('{\\"action\\":\\"cancel\\"}');
    expect(noHook.text).toContain('{\\"action\\":\\"cancel\\"}');
  });

  it("is cancelled when the host cannot answer", async () => {
    const { text } = await asking(
      { onInput: () => Promise.reject(new Error("the Session is gone")) },
      true,
    );

    expect(text).toContain('{\\"action\\":\\"cancel\\"}');
  });

  it("is refused, as the server's error, when the answer is not one this build knows", async () => {
    const { asked } = await asking(
      {
        // SAFETY: a member a newer Session may add, which this build does not know.
        onInput: () => Promise.resolve({ kind: "someday" } as never),
      },
      true,
    );

    expect(asked).toEqual([{ error: "cloudpid could not read the answer to the question" }]);
  });
});

/** Calls `sample` on a stateful Legacy server whose target says `sampling`, with `hooks` and `answers`. */
const sampling = async (hooks: McpEngineHooks, flag: boolean, answers = true) => {
  const sampled: Array<unknown> = [];
  const server = legacyStatefulServer({ moreTools: [SAMPLE_TOOL], sampled: [] });

  vi.stubGlobal("fetch", fetchTo(server));

  const result = decode(
    await Effect.runPromise(
      request(
        flag ? { ...target, sampling: true } : target,
        {},
        {
          op: "tools/call",
          tool: SAMPLE_TOOL,
          arguments: { rounds: 2 },
          ctx: answers
            ? { origin: "agent", conversation: "c1", answers: { sampling: true } }
            : { origin: "agent", conversation: "c1" },
        },
        hooks,
        { version: "test", hold: () => undefined },
      ).pipe(Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer))),
    ),
  );

  const text =
    result.kind === "complete" && result.result.kind === "inline"
      ? JSON.stringify(result.result.value)
      : "";

  return { server, sampled, text };
};

const REPLY: McpInputAnswer = {
  kind: "sampled",
  result: { role: "assistant", content: { type: "text", text: "Hi" }, model: "m" },
};

describe("a Sampling request the engine passes to the host's onInput", () => {
  it("is declared at initialize only for a target that says so, and answered with the reply", async () => {
    const seen: Array<McpInputRequest> = [];

    const onInput = (input: McpInputRequest): Promise<McpInputAnswer> => {
      seen.push(input);

      return Promise.resolve(REPLY);
    };

    const declared = await sampling({ onInput }, true);
    const initialize = declared.server.received.find((each) => each.rpc?.method === "initialize");

    expect(initialize?.rpc?.params).toMatchObject({ capabilities: { sampling: { tools: {} } } });
    expect(seen).toMatchObject([{ kind: "sampling", mode: "live" }, { kind: "sampling" }]);
    expect(declared.text).toContain("Hi");

    seen.length = 0;

    const undeclared = await sampling({ onInput }, false);
    const plain = undeclared.server.received.find((each) => each.rpc?.method === "initialize");

    expect(JSON.stringify(plain?.rpc?.params)).not.toContain("sampling");
    expect(seen).toEqual([]);
  });

  it("is refused 'no conversation to sample in' when the call cannot answer it", async () => {
    const seen: Array<McpInputRequest> = [];

    const { text } = await sampling(
      {
        onInput: (input) => {
          seen.push(input);

          return Promise.resolve(REPLY);
        },
      },
      true,
      false,
    );

    expect(seen).toEqual([]);
    expect(text).toContain("no conversation to sample in");
  });
});
