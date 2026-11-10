// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  decodeClientMessage,
  MAX_FILE_QUERY_LENGTH,
  ServerMessageJson,
  SESSION_COMMANDS,
  sessionCommandsFor,
} from "./session.ts";

const readServer = (text: string) =>
  Effect.runPromise(Schema.decodeEffect(ServerMessageJson)(text));

const readClient = (text: string) =>
  decodeClientMessage(text).pipe(Effect.option, Effect.runPromise);

describe("the Session socket messages", () => {
  it("refuse operations Chord's applier would refuse", async () => {
    for (const ops of [[["x", ["a"]]], [["s", ["__proto__", "polluted"], true]], [["a", "text"]]]) {
      await expect(
        readServer(JSON.stringify({ type: "ops", conversationId: 1, ops })),
      ).rejects.toThrow();
    }
  });

  it("read a watch that resumes after an entry, and a page of entries", async () => {
    expect(await readClient('{"type":"watch","id":"1","conversationId":2,"from":7}')).toEqual(
      Option.some({ type: "watch", id: "1", conversationId: 2, from: 7 }),
    );
    expect(
      await readClient(
        '{"type":"entries","id":"2","query":{"maxEntryId":6,"order":"descending"},"limit":50}',
      ),
    ).toEqual(
      Option.some({
        type: "entries",
        id: "2",
        query: { maxEntryId: 6, order: "descending" },
        limit: 50,
      }),
    );

    for (const text of [
      '{"type":"watch","conversationId":2,"from":0}',
      '{"type":"entries","query":{},"limit":0}',
      '{"type":"entries","query":{},"limit":201}',
      '{"type":"entries","query":{"order":"sideways"},"limit":5}',
      '{"type":"entries","query":{"conversationId":3},"limit":5}',
    ]) {
      expect(await readClient(text)).toEqual(Option.none());
    }
  });

  // Whether the proxy serves a model is the Session's check, against the Model catalog: the message checks its format.
  it("reject a configure for a model not written as provider/id or a thinking level pi does not have", async () => {
    expect(await readClient('{"type":"configure","model":"nope"}')).toEqual(Option.none());
    expect(await readClient('{"type":"configure","thinkingLevel":"extreme"}')).toEqual(
      Option.none(),
    );
  });

  it("read a files request, for the root or a subagent's conversation, with a bounded query", async () => {
    expect(await readClient('{"type":"files","id":"f1","query":"src/app"}')).toEqual(
      Option.some({ type: "files", id: "f1", query: "src/app" }),
    );
    expect(await readClient('{"type":"files","id":"f2","conversationId":3,"query":""}')).toEqual(
      Option.some({ type: "files", id: "f2", conversationId: 3, query: "" }),
    );
    expect(await readClient('{"type":"files","id":"f3"}')).toEqual(Option.none());
    expect(await readClient('{"type":"files","id":"f4","query":"a","limit":5}')).toEqual(
      Option.none(),
    );
    expect(
      await readClient(
        JSON.stringify({ type: "files", id: "f5", query: "a".repeat(MAX_FILE_QUERY_LENGTH + 1) }),
      ),
    ).toEqual(Option.none());
  });

  it("name the Session's Slash commands, and leave /rollover out where the agent cannot roll over", () => {
    expect(SESSION_COMMANDS.map(({ name }) => name)).toEqual([
      "compact",
      "rollover",
      "todo",
      "export",
    ]);
    expect(sessionCommandsFor(true)).toBe(SESSION_COMMANDS);
    expect(sessionCommandsFor(false).map(({ name }) => name)).toEqual([
      "compact",
      "todo",
      "export",
    ]);
  });

  it("read the owner's decline of a Sign-in request, with a bounded reason, and nothing else as an answer", async () => {
    expect(
      await readClient(
        '{"type":"mcp_sign_in_answer","id":"c1","request":"signin-1","action":"decline"}',
      ),
    ).toEqual(
      Option.some({
        type: "mcp_sign_in_answer",
        id: "c1",
        request: "signin-1",
        action: "decline",
      }),
    );
    expect(
      await readClient(
        '{"type":"mcp_sign_in_answer","id":"c1","request":"signin-1","action":"decline","reason":"not now"}',
      ),
    ).toEqual(expect.objectContaining({ value: expect.objectContaining({ reason: "not now" }) }));

    // Signing in is the card's link, not a command; a reason is bounded.
    expect(
      await readClient(
        '{"type":"mcp_sign_in_answer","id":"c1","request":"signin-1","action":"accept"}',
      ),
    ).toEqual(Option.none());
    expect(
      await readClient(
        JSON.stringify({
          type: "mcp_sign_in_answer",
          id: "c1",
          request: "signin-1",
          action: "decline",
          reason: "x".repeat(301),
        }),
      ),
    ).toEqual(Option.none());
  });

  it("read a Decline's scope and a revoke, read a scope it does not know as `call`, and refuse a scope on another action", async () => {
    const answer = {
      type: "mcp_elicitation_answer",
      id: "c1",
      request: "call-1:1",
      action: "decline",
    };

    expect(await readClient(JSON.stringify({ ...answer, scope: "call" }))).toEqual(
      Option.some({ ...answer, scope: "call" }),
    );
    expect(await readClient(JSON.stringify({ ...answer, scope: "session" }))).toEqual(
      Option.some({ ...answer, scope: "session" }),
    );
    // A scope a later build adds reads as the narrower `call`.
    expect(await readClient(JSON.stringify({ ...answer, scope: "server" }))).toEqual(
      Option.some({ ...answer, scope: "call" }),
    );
    // A scope on any other action is refused by the schema.
    expect(
      await readClient(JSON.stringify({ ...answer, action: "cancel", scope: "call" })),
    ).toEqual(Option.none());

    const revoke = { type: "mcp_elicitation_revoke", id: "c2", server: "docs" };

    expect(await readClient(JSON.stringify(revoke))).toEqual(Option.some(revoke));
  });
});
