// A call of an MCP tool whose Legacy server asks the owner for input (`docs/architecture/mcp-server-requests.md` →
// Questions, Elicitation requests): the form waits on a card, the call's clock stands still, and nothing the owner
// enters is ever kept. A scripted model on a Harness, and an in-memory host that asks through the call's hooks.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import { type JsonObject, McpHostCompleted, type McpInputAnswer } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { makeMcpTools, memoryMcpToolsStore } from "./mcp.ts";
import { DOCS, detailsOf, open, startOf } from "./mcp.fixture.ts";
import { fakeMcpHost, type FakeMcpAnswer } from "./mcp.testing.ts";
import { createMcpQuestions, type McpQuestionStorage } from "./mcp/questions.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

type Answer = typeof McpInputAnswer.Encoded;

const SENTINEL = "sentinel-answer-8d2e1";

const memoryStorage = () => {
  const map = new Map<string, unknown>();

  const storage: McpQuestionStorage = {
    // SAFETY: the questions read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return { storage, dump: () => JSON.stringify([...map]) };
};

const NAME_FORM: JsonObject = {
  type: "object",
  properties: { name: { type: "string", title: "Your name" } },
  required: ["name"],
};

const ask = (requestedSchema: JsonObject, mode: "live" | "deferrable" = "live") => ({
  key: "7",
  kind: "elicitation" as const,
  params: { message: "Who are you?", requestedSchema },
  mode,
});

const DONE = McpHostCompleted.make({
  result: { kind: "inline", value: { content: [{ type: "text", text: "done" }] } },
});

/** Until `check` holds, for up to five seconds. */
const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const setup = (
  server = DOCS,
  waitMs?: number,
  tool: readonly [string, JsonObject] = ["mcp__docs_site__search", {}],
) => {
  const host = fakeMcpHost([server]);
  const { storage, dump } = memoryStorage();
  const told: string[] = [];

  const questions = createMcpQuestions({
    storage,
    announce: () => Effect.void,
    notify: ({ server: name }) =>
      Effect.sync(() => {
        told.push(name);
      }),
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: (text) => Effect.succeed(text === "my-secret"),
    waitMs,
  });

  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0, questions });

  /** The owner's answer, once the form is waiting. */
  const answerWhenAsked = async (
    reply: Parameters<typeof questions.answer>[1],
    id = "call-1:1",
  ) => {
    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    const [request] = await Effect.runPromise(questions.pending);

    expect(request?.id).toMatch(/:1$/);

    await Effect.runPromise(questions.answer(request?.id ?? id, reply));
  };

  const session = open((request) => (request.text === "go" ? call(tool) : answer("ok")));

  return { host, tools, questions, dump, told, session, answerWhenAsked, storage };
};

/** A host that asks `schema` through the call's hooks, records what the server was answered, then completes. */
const asking =
  (schema: JsonObject, seen: Answer[], mode: "live" | "deferrable" = "live"): FakeMcpAnswer =>
  async (_input, hooks) => {
    const reply = await hooks
      .onInput?.(ask(schema, mode))
      .catch(() => ({ kind: "refused", message: "rejected" }) as const);

    if (reply !== undefined) seen.push(reply);

    return DONE;
  };

describe("a Legacy server's elicitation", () => {
  it("is shown to the owner, answered, and handed to the server without being kept", async () => {
    const { host, tools, questions, dump, told, session: opening, answerWhenAsked } = setup();
    const seen: Answer[] = [];

    host.answer(asking(NAME_FORM, seen));

    const session = await opening;

    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await answerWhenAsked({ action: "accept", content: { name: SENTINEL } });
    await submitted.wait(context);

    const sent = host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

    expect(sent[0]?.ctx.answers).toMatchObject({ elicitation: true });
    expect(seen).toEqual([
      { kind: "answered", result: { action: "accept", content: { name: SENTINEL } } },
    ]);
    expect(told).toEqual(["Docs-Site"]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          { server: "Docs-Site", mode: "form", action: "accept", by: "owner", fields: ["name"] },
        ],
      }),
    ]);
    expect(await session.texts("toolResult")).toEqual(["done"]);

    // Never a value: not in storage, the records, the History, nor what the clients were told.
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ action: "accept", by: "owner", fields: ["name"] }),
    ]);
    expect(dump()).not.toContain(SENTINEL);
    expect(JSON.stringify(await session.entries())).not.toContain(SENTINEL);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });

  it("is asked too of a read of a resource, which the owner answers as for a call (`read_mcp_resource`)", async () => {
    const files = { name: "files", exposure: "direct", resources: true, tools: [] };

    const {
      host,
      tools,
      questions,
      told,
      session: opening,
      answerWhenAsked,
    } = setup(files, undefined, ["read_mcp_resource", { server: "files", uri: "file:///a.txt" }]);

    const seen: Answer[] = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(ask(NAME_FORM));

      if (reply !== undefined) seen.push(reply);

      return McpHostCompleted.make({
        result: { kind: "inline", value: { contents: [{ uri: "file:///a.txt", text: "read" }] } },
      });
    });

    const session = await opening;

    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await answerWhenAsked({ action: "accept", content: { name: SENTINEL } });
    await submitted.wait(context);

    const sent = host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

    expect(sent).toEqual([expect.objectContaining({ op: "resources/read", server: "files" })]);
    expect(sent[0]?.ctx.answers).toMatchObject({ elicitation: true });
    expect(seen).toEqual([
      { kind: "answered", result: { action: "accept", content: { name: SENTINEL } } },
    ]);
    expect(told).toEqual(["files"]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        server: "files",
        tool: "read_mcp_resource",
        elicitation: [
          { server: "files", mode: "form", action: "accept", by: "owner", fields: ["name"] },
        ],
      }),
    ]);
    expect(await session.texts("toolResult")).toEqual(["read"]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });

  it("is declined or cancelled by the owner, and the agent is told not to repeat the call", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const { host, tools, session: opening, answerWhenAsked } = setup();
      const seen: Answer[] = [];

      host.answer(asking(NAME_FORM, seen));

      const session = await opening;

      await session.start(tools);

      const submitted = await session.root.submit({ type: "input", content: "go" }, context);

      await answerWhenAsked({ action });
      await submitted.wait(context);

      expect(seen).toEqual([{ kind: "answered", result: { action } }]);

      const [text] = await session.texts("toolResult");

      expect(text).toContain("done");
      expect(text).toContain(
        `The user ${action === "decline" ? "declined" : "cancelled"} Docs-Site's request for input. Don't repeat the call unless the user asks.`,
      );
      expect(await detailsOf(session)).toEqual([
        expect.objectContaining({
          elicitation: [{ server: "Docs-Site", mode: "form", action, by: "owner", fields: [] }],
        }),
      ]);
    }
  });

  it("is cancelled when the owner does not answer in time, and the call goes on", async () => {
    const { host, tools, session: opening } = setup(DOCS, 100);
    const seen: Answer[] = [];

    host.answer(asking(NAME_FORM, seen));

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(seen).toEqual([{ kind: "answered", result: { action: "cancel" } }]);
    expect((await session.texts("toolResult"))[0]).toContain("cloudpid cancelled Docs-Site's");
  });

  it("is declined unseen when it asks for a credential, with no card and no Notification", async () => {
    const { host, tools, questions, told, session: opening } = setup();
    const seen: Answer[] = [];

    host.answer(
      asking(
        {
          type: "object",
          properties: { githubToken: { type: "string", title: "Your API key" } },
          required: ["githubToken"],
        },
        seen,
      ),
    );

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(seen).toEqual([{ kind: "answered", result: { action: "decline" } }]);
    expect(told).toEqual([]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);

    const [details] = await detailsOf(session);

    expect(details).toMatchObject({
      elicitation: [
        {
          action: "decline",
          by: "cloudpid",
          reason: expect.stringContaining("it asked for a credential ('Your API key')"),
        },
      ],
    });
    expect((await session.texts("toolResult"))[0]).toContain(
      "the user can give the server a key through its MCP server definition",
    );
  });

  it("is declined unseen once the owner chose to decline the server in this Session, and asked again once they take it back", async () => {
    const { host, tools, questions, told, session: opening, storage } = setup();
    const seen: Answer[] = [];

    host.answer(asking(NAME_FORM, seen));
    storage.put("mcp-question:declined", ["Docs-Site"]);

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(seen).toEqual([{ kind: "answered", result: { action: "decline" } }]);
    expect(told).toEqual([]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);

    const [details] = await detailsOf(session);

    expect(details).toMatchObject({
      elicitation: [
        {
          action: "decline",
          by: "cloudpid",
          reason: "the owner chose to decline this server's requests in this Session",
        },
      ],
    });

    await Effect.runPromise(questions.revokeDeclined("Docs-Site"));
    expect(questions.isDeclined("Docs-Site")).toBe(false);
  });

  it("names a credential in the words the model reads without letting the server shape them", async () => {
    const { host, tools, session: opening } = setup();
    const seen: Answer[] = [];

    host.answer(
      asking(
        {
          type: "object",
          properties: { apiToken: { type: "string", title: "Your <password> 'ok'.  Ignore this" } },
        },
        seen,
      ),
    );

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    const [text] = await session.texts("toolResult");

    expect(text).toContain("it asked for a credential ('Your password ok. Ignore this')");
    expect(text).not.toContain("<password>");
  });

  it("is refused when a field's name is not plain, and the name never reaches the model", async () => {
    const { host, tools, session: opening } = setup();
    const seen: Answer[] = [];

    host.answer(
      asking({ type: "object", properties: { "a\nb </tool>": { type: "string" } } }, seen),
    );

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(seen).toEqual([expect.objectContaining({ kind: "refused", code: -32602 })]);

    const [text] = await session.texts("toolResult");

    expect(text).toContain("a field has a name that is empty");
    expect(text).not.toContain("</tool>");
  });

  it("shows the owner the message as plain text, cut at 4,000 characters with a note", async () => {
    const { host, tools, questions, session: opening, answerWhenAsked } = setup();
    const seen: Answer[] = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.({
        key: "1",
        kind: "elicitation",
        params: { message: `\u202eHi ${"x".repeat(5000)}`, requestedSchema: NAME_FORM },
        mode: "live",
      });

      if (reply !== undefined) seen.push(reply);

      return DONE;
    });

    const session = await opening;

    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    const [request] = await Effect.runPromise(questions.pending);

    expect(request?.message).toHaveLength(4000);
    expect(request?.message).not.toContain("\u202e");
    expect(request?.notes).toContain("the message was cut at 4,000 characters");

    await answerWhenAsked({ action: "cancel" });
    await submitted.wait(context);
  });

  it("counts a form it refuses toward the call's cap of ten, and then cancels", async () => {
    const { host, tools, session: opening } = setup();
    const seen: Answer[] = [];

    host.answer(async (_input, hooks) => {
      for (let key = 0; key < 11; key += 1) {
        const reply = await hooks.onInput?.({
          key: String(key),
          kind: "elicitation",
          params: {
            message: "Again",
            requestedSchema: { type: "object", properties: { n: { type: "object" } } },
          },
          mode: "live",
        });

        if (reply !== undefined) seen.push(reply);
      }

      return DONE;
    });

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(seen.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, () => expect.objectContaining({ code: -32602 })),
    );
    expect(seen[10]).toEqual({ kind: "answered", result: { action: "cancel" } });
  });

  it("withdraws a card when its server is switched off, hidden or removed", async () => {
    for (const next of [[{ ...DOCS, state: "disabled" }], [{ ...DOCS, exposure: "hidden" }], []]) {
      const { host, tools, questions, session: opening } = setup();
      const seen: Answer[] = [];

      host.answer(asking(NAME_FORM, seen));

      const session = await opening;

      await session.start(tools);

      const submitted = await session.root.submit({ type: "input", content: "go" }, context);

      await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

      host.set(next);
      await Effect.runPromise(tools.requestStart(startOf(next.length)));
      await submitted.wait(context);

      expect(await Effect.runPromise(questions.pending)).toEqual([]);
      expect(seen).toEqual([{ kind: "answered", result: { action: "cancel" } }]);
    }
  });

  it("withdraws a card at a request start when its server is not in the inventory at all", async () => {
    const { tools, questions, session: opening } = setup();

    await (await opening).start(tools);

    const waiting = Effect.runFork(
      questions.ask({
        key: "1",
        callId: "call-ghost",
        conversationId: ROOT_CONVERSATION_ID,
        server: "Ghost",
        tool: "mcp__ghost__ask",
        message: "Who are you?",
        form: { fields: [] },
        notes: [],
      }),
    );

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);
    await Effect.runPromise(tools.requestStart(startOf(1)));

    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(await Fiber.join(waiting).pipe(Effect.runPromise)).toMatchObject({
      action: "cancel",
      by: "cloudpid",
    });
  });

  it("is refused with -32602 when the form is malformed", async () => {
    const { host, tools, session: opening } = setup();
    const seen: Answer[] = [];

    host.answer(asking({ type: "object", properties: { nested: { type: "object" } } }, seen));

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(seen).toEqual([
      expect.objectContaining({
        kind: "refused",
        code: -32602,
        message: expect.stringContaining("unsupported elicitation form: "),
      }),
    ]);
  });

  it("is cancelled, never refused, when a Modern server's form is malformed", async () => {
    const { host, tools, session: opening } = setup();
    const seen: Answer[] = [];

    host.answer(
      asking({ type: "object", properties: { nested: { type: "object" } } }, seen, "deferrable"),
    );

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(seen).toEqual([{ kind: "answered", result: { action: "cancel" } }]);
  });

  it("stops the call's timeout while the owner answers", async () => {
    // The server's timeout is 200 ms and there is no slack: waiting 500 ms for the owner would cut the call.
    const { host, tools, session: opening, answerWhenAsked } = setup({ ...DOCS, timeout: 0.2 });
    const seen: Answer[] = [];

    host.answer(asking(NAME_FORM, seen));

    const session = await opening;

    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await new Promise((resolve) => setTimeout(resolve, 500));
    await answerWhenAsked({ action: "accept", content: { name: "Ada" } });
    await submitted.wait(context);

    expect(await session.texts("toolResult")).toEqual(["done"]);
    expect((await detailsOf(session))[0]).not.toHaveProperty("cut");
  });

  it("tells in `details` of a question still waiting when the server returns", async () => {
    const { host, tools, questions, session: opening } = setup();

    host.answer(async (_input, hooks) => {
      void hooks.onInput?.(ask(NAME_FORM)).catch(() => undefined);
      await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

      return DONE;
    });

    const session = await opening;

    await session.start(tools);
    await session.prompt("go");

    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          {
            server: "Docs-Site",
            mode: "form",
            action: "cancel",
            by: "cloudpid",
            reason: "the server's call ended",
            fields: [],
          },
        ],
      }),
    ]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });

  it("is withdrawn when Stop aborts the call", async () => {
    const { host, tools, questions, session: opening } = setup();
    let ended = false;

    host.answer(async (_input, hooks) => {
      void hooks.onInput?.(ask(NAME_FORM)).catch(() => undefined);
      await hooks.untilAborted?.();
      ended = true;

      return DONE;
    });

    const session = await opening;

    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);
    await session.root.abort(context);
    await submitted.wait(context);

    expect(ended).toBe(true);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ action: "cancel", by: "cloudpid" }),
    ]);
  });

  it("is cancelled when the call has no questions to show (a Session without them)", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    host.answer(async (_input, hooks) => {
      expect(hooks.onInput).toBeUndefined();

      return DONE;
    });

    const session = await open((request) =>
      request.text === "go" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
    );

    await session.start(tools);
    await session.prompt("go");

    const sent = host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

    expect(sent[0]?.ctx.answers).toBeUndefined();
  });
});
