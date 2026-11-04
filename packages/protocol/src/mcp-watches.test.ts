// The Resource watches' socket messages (`docs/architecture/mcp-in-a-session.md` → Resource watches → UI).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ClientMessage, ServerMessage } from "./session.ts";

const read = <A, I>(schema: Schema.Codec<A, I>, input: Schema.Json) =>
  Schema.decodeUnknownOption(schema)(input);

describe("the Resource watches' messages", () => {
  it("send the whole list, an empty one too", () => {
    const watches = [{ conversationId: 1, server: "docs", uri: "file:///guide.md" }];

    expect(Option.getOrThrow(read(ServerMessage, { type: "mcp_watches", watches }))).toEqual({
      type: "mcp_watches",
      watches,
    });
    expect(Option.isSome(read(ServerMessage, { type: "mcp_watches", watches: [] }))).toBe(true);
    expect(
      Option.isNone(read(ServerMessage, { type: "mcp_watches", watches: [{ server: "docs" }] })),
    ).toBe(true);
  });

  it("take the owner's end of one watch, by conversation, server and URI", () => {
    const end = { type: "mcp_watch_end", id: "1", conversationId: 2, server: "docs", uri: "u" };

    expect(Option.getOrThrow(read(ClientMessage, end))).toEqual(end);
    expect(
      Option.isNone(
        read(ClientMessage, {
          type: end.type,
          id: end.id,
          conversationId: end.conversationId,
          server: end.server,
        }),
      ),
    ).toBe(true);
  });
});
