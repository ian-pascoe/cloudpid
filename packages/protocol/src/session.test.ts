// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { decodeClientMessage, ServerMessageJson } from "./session.ts";

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

  it("reject a configure for a model the proxy does not serve or a thinking level pi does not have", async () => {
    expect(await readClient('{"type":"configure","model":"anthropic/nope"}')).toEqual(
      Option.none(),
    );
    expect(await readClient('{"type":"configure","thinkingLevel":"extreme"}')).toEqual(
      Option.none(),
    );
  });
});
