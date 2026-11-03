// docs/architecture/mcp-endpoint.md → Tools: the read tools' arguments, and the operation each is served by.
// @effect-diagnostics preferEffectArray:off preferTypedSchemaDecoder:off
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { McpAuth } from "./mcp-api.ts";
import {
  MCP_TOOL_OPERATIONS,
  SessionGetInput,
  SessionsListInput,
  SessionTranscriptInput,
} from "./mcp-tools.ts";

const ID = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

const accepts = (schema: Schema.Decoder<object>, value: Schema.Json) =>
  Option.isSome(Schema.decodeUnknownOption(schema)(value));

describe("sessions_list's arguments", () => {
  it("take every filter, and a page of 1 to 50", () => {
    expect(accepts(SessionsListInput, {})).toBe(true);
    expect(
      accepts(SessionsListInput, {
        environment: "Default",
        status: "running",
        archived: true,
        query: "fix",
        cursor: "c",
        limit: 50,
      }),
    ).toBe(true);
    expect(accepts(SessionsListInput, { limit: 0 })).toBe(false);
    expect(accepts(SessionsListInput, { limit: 51 })).toBe(false);
    expect(accepts(SessionsListInput, { limit: 1.5 })).toBe(false);
    expect(accepts(SessionsListInput, { status: "waiting" })).toBe(false);
  });
});

describe("session_get's and session_transcript's arguments", () => {
  it("name a Session by its full id", () => {
    expect(accepts(SessionGetInput, { session_id: ID })).toBe(true);
    expect(accepts(SessionGetInput, {})).toBe(false);
    expect(accepts(SessionGetInput, { session_id: 7 })).toBe(false);
  });

  it("bound a page's characters to 2,000 to 40,000, and take the detail and cursors", () => {
    expect(accepts(SessionTranscriptInput, { session_id: ID })).toBe(true);
    expect(
      accepts(SessionTranscriptInput, {
        session_id: ID,
        agent_id: "agent-1",
        before: "b",
        detail: "full",
        max_chars: 40_000,
      }),
    ).toBe(true);
    expect(accepts(SessionTranscriptInput, { session_id: ID, max_chars: 1_999 })).toBe(false);
    expect(accepts(SessionTranscriptInput, { session_id: ID, max_chars: 40_001 })).toBe(false);
    expect(accepts(SessionTranscriptInput, { session_id: ID, detail: "brief" })).toBe(false);
  });
});

describe("the operations", () => {
  it("name the `api` operation of each tool, the four read ones first", () => {
    expect(MCP_TOOL_OPERATIONS.environments_list).toBe("environments");
    expect(MCP_TOOL_OPERATIONS.sessions_list).toBe("sessions");
    expect(MCP_TOOL_OPERATIONS.session_get).toBe("session");
    expect(MCP_TOOL_OPERATIONS.session_transcript).toBe("transcript");
  });
});

describe("how the caller got in", () => {
  it("is oauth, a service token, or local (alchemy dev), and anything newer reads as unknown", () => {
    const read = Schema.decodeUnknownOption(McpAuth);

    for (const auth of ["oauth", "service_token", "local"]) {
      expect(read(auth)).toStrictEqual(Option.some(auth));
    }

    expect(read("passkey")).toStrictEqual(Option.some("unknown"));
  });
});
