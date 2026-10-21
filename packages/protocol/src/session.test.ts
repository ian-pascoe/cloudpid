// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { Catalog, CommandOutcome, decodeClientMessage, ServerMessageJson } from "./session.ts";

const readServer = (text: string) =>
  Effect.runPromise(Schema.decodeEffect(ServerMessageJson)(text));

const readClient = (text: string) =>
  decodeClientMessage(text).pipe(Effect.option, Effect.runPromise);

describe("the Session socket messages", () => {
  it("carry pi's agent events unchanged", async () => {
    const events = [
      { type: "run_start", inputs: [1] },
      {
        type: "message_update",
        usage: { input: 1 },
        changes: [{ type: "text_delta", contentIndex: 0, delta: "Hi" }],
      },
    ];

    const text = JSON.stringify({ type: "events", conversationId: 1, events });

    const decoded = await readServer(text);

    expect(decoded).toEqual({ type: "events", conversationId: 1, events });
    expect(await Effect.runPromise(Schema.encodeEffect(ServerMessageJson)(decoded))).toBe(text);
  });

  it("carry which of the model and thinking level the Session picked", async () => {
    expect(await readServer('{"type":"picked","model":true,"thinkingLevel":false}')).toEqual({
      type: "picked",
      model: true,
      thinkingLevel: false,
    });
  });

  it("read a submit with its whenBusy mode, and reject an unknown command or key", async () => {
    expect(
      await readClient(
        '{"type":"submit","id":"1","input":"stop","whenBusy":"steer","requestId":"r1"}',
      ),
    ).toEqual(
      Option.some({ type: "submit", id: "1", input: "stop", whenBusy: "steer", requestId: "r1" }),
    );
    expect(await readClient('{"type":"reset"}')).toEqual(Option.none());
    expect(await readClient('{"type":"submit","input":"stop","whenbusy":"steer"}')).toEqual(
      Option.none(),
    );
  });

  it("read a configure with a model and a thinking level, or null to follow the default", async () => {
    expect(
      await readClient(
        '{"type":"configure","id":"1","model":"anthropic/claude-sonnet-5-5","thinkingLevel":"low"}',
      ),
    ).toEqual(
      Option.some({
        type: "configure",
        id: "1",
        model: "anthropic/claude-sonnet-5-5",
        thinkingLevel: "low",
      }),
    );
    expect(await readClient('{"type":"configure","model":null}')).toEqual(
      Option.some({ type: "configure", model: null }),
    );
  });

  it("carry the Secret requests waiting for the owner, never a value", async () => {
    const text = JSON.stringify({
      type: "secret_requests",
      lifetimeMinutes: 15,
      requests: [{ id: "12", conversationId: 1, names: ["API_KEY"], reason: "deploy" }],
    });

    expect(await readServer(text)).toEqual(JSON.parse(text));
  });

  it("carry the Browser Handoffs waiting for the owner, with the link they open", async () => {
    const text = JSON.stringify({
      type: "browser_handoff_requests",
      requests: [
        {
          id: "12",
          conversationId: 1,
          instructions: "Log in, then press Done",
          url: "https://live.browser.run/ui/view?mode=tab",
          deadline: 1_800_000,
        },
      ],
    });

    expect(await readServer(text)).toEqual(JSON.parse(text));
    expect(await readServer('{"type":"browser_handoff_requests","requests":[]}')).toEqual({
      type: "browser_handoff_requests",
      requests: [],
    });
  });

  it("read the owner's answer to a Secret request, or its cancellation", async () => {
    expect(
      await readClient(
        '{"type":"secret_answer","id":"c1","request":"12","values":{"API_KEY":"v"}}',
      ),
    ).toEqual(
      Option.some({
        type: "secret_answer",
        id: "c1",
        request: "12",
        values: { API_KEY: "v" },
      }),
    );
    expect(await readClient('{"type":"secret_answer","request":"12","values":null}')).toEqual(
      Option.some({ type: "secret_answer", request: "12", values: null }),
    );
    expect(await readClient('{"type":"secret_answer","request":"12"}')).toEqual(Option.none());
  });

  it("reject a configure for a model the proxy does not serve or a thinking level pi does not have", async () => {
    expect(await readClient('{"type":"configure","model":"anthropic/nope"}')).toEqual(
      Option.none(),
    );
    expect(await readClient('{"type":"configure","thinkingLevel":"extreme"}')).toEqual(
      Option.none(),
    );
  });

  it("read a submit and an abort addressed to a subagent's conversation, and the abort's reach into its subagents", async () => {
    expect(
      await readClient(
        '{"type":"submit","id":"1","conversationId":4,"input":"hi","whenBusy":"steer"}',
      ),
    ).toEqual(
      Option.some({ type: "submit", id: "1", conversationId: 4, input: "hi", whenBusy: "steer" }),
    );
    expect(await readClient('{"type":"abort","conversationId":4,"subagents":true}')).toEqual(
      Option.some({ type: "abort", conversationId: 4, subagents: true }),
    );
    expect(await readClient('{"type":"abort","subagents":"yes"}')).toEqual(Option.none());
    expect(await readClient('{"type":"submit","input":"hi","conversationId":0}')).toEqual(
      Option.none(),
    );
  });

  it("read a catalog request and a Slash command, for the root or a subagent's conversation", async () => {
    expect(await readClient('{"type":"catalog","id":"c1"}')).toEqual(
      Option.some({ type: "catalog", id: "c1" }),
    );
    expect(
      await readClient(
        '{"type":"command","id":"c2","conversationId":3,"name":"compact","args":"the API"}',
      ),
    ).toEqual(
      Option.some({
        type: "command",
        id: "c2",
        conversationId: 3,
        name: "compact",
        args: "the API",
      }),
    );
    expect(await readClient('{"type":"command","id":"c3","name":"export"}')).toEqual(Option.none());
    expect(
      await Effect.runPromise(
        Schema.decodeEffect(CommandOutcome)({
          notice: "Exported",
          file: { name: "a.md", mimeType: "text/markdown", content: "# A" },
        }),
      ),
    ).toEqual({
      notice: "Exported",
      file: { name: "a.md", mimeType: "text/markdown", content: "# A" },
    });
    expect(
      (
        await Effect.runPromise(
          Schema.decodeEffect(Catalog)({
            commands: [{ name: "export", description: "Export", argument: "none" }],
            templates: [{ name: "review", description: "Review", argumentHint: "<ref>" }],
            skills: [],
          }),
        )
      ).templates,
    ).toEqual([{ name: "review", description: "Review", argumentHint: "<ref>" }]);
  });

  it("read a request to watch the task graph, and to stop watching it", async () => {
    expect(await readClient('{"type":"watch_task_graph","id":"w"}')).toEqual(
      Option.some({ type: "watch_task_graph", id: "w" }),
    );
    expect(await readClient('{"type":"unwatch_task_graph"}')).toEqual(
      Option.some({ type: "unwatch_task_graph" }),
    );
  });

  it("carry a compact summary of the task graph", async () => {
    const text = JSON.stringify({
      type: "task_graph",
      agents: [
        {
          id: "agent-1",
          parent: "root",
          conversationId: 2,
          role: "small",
          model: "anthropic/claude-haiku-5",
          status: "working",
        },
      ],
      background: [
        {
          id: 9,
          kind: "pi.compaction",
          agent: "root",
          conversationId: 1,
          state: "running",
          aborting: false,
        },
      ],
    });

    expect(await readServer(text)).toEqual(JSON.parse(text));
  });

  it("read a request to watch the Session's usage, and to stop watching it", async () => {
    expect(await readClient('{"type":"watch_usage","id":"u"}')).toEqual(
      Option.some({ type: "watch_usage", id: "u" }),
    );
    expect(await readClient('{"type":"unwatch_usage"}')).toEqual(
      Option.some({ type: "unwatch_usage" }),
    );
  });

  it("carry the Session's token and cost totals, and its spend limit or null for none", async () => {
    const usage = {
      input: 1200,
      output: 340,
      cacheRead: 9000,
      cacheWrite: 800,
      totalTokens: 11340,
      cost: 0.4321,
    };

    for (const limit of [null, 5]) {
      const text = JSON.stringify({ type: "usage", ...usage, limit });

      expect(await readServer(text)).toEqual(JSON.parse(text));
    }

    expect(
      await Schema.decodeEffect(ServerMessageJson)(
        JSON.stringify({ type: "usage", ...usage, cost: "free", limit: null }),
      ).pipe(Effect.option, Effect.runPromise),
    ).toEqual(Option.none());
  });

  it("carry a conversation's whole Todo List", async () => {
    const text = JSON.stringify({
      type: "todos",
      conversationId: 2,
      tasks: [
        { id: 1, title: "Write the tool", status: "completed" },
        { id: 3, title: "Test it", description: "Through runs", status: "active" },
      ],
    });

    expect(await readServer(text)).toEqual(JSON.parse(text));
    expect(
      await Schema.decodeEffect(ServerMessageJson)(
        '{"type":"todos","conversationId":2,"tasks":[{"id":1,"title":"A","status":"done"}]}',
      ).pipe(Effect.option, Effect.runPromise),
    ).toEqual(Option.none());
  });
});
