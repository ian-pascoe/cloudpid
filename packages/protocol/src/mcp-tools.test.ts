// docs/architecture/mcp-endpoint.md → Tools: the read tools' arguments, and the operation each is served by.
// @effect-diagnostics preferEffectArray:off preferTypedSchemaDecoder:off
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { McpAuth } from "./mcp-api.ts";
import {
  MCP_TOOL_OPERATIONS,
  MAX_REQUEST_ID_CHARS,
  SessionGetInput,
  SessionSendInput,
  SessionsListInput,
  SessionStartInput,
  SessionStopInput,
  SessionTranscriptInput,
  SessionWaitInput,
  SessionWaitResult,
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

describe("session_start's arguments", () => {
  it("need only the first message, and take the rest as `createSession` does", () => {
    expect(accepts(SessionStartInput, { text: "Fix it" })).toBe(true);
    expect(
      accepts(SessionStartInput, {
        environment: "Docs",
        text: "Fix it",
        title: "Fix",
        branch: "feat/x",
        base: "main",
        model: "anthropic/claude-opus-5-5",
        thinking: "max",
        request_id: "r-1",
      }),
    ).toBe(true);
    expect(accepts(SessionStartInput, {})).toBe(false);
    expect(accepts(SessionStartInput, { text: "" })).toBe(false);
    expect(accepts(SessionStartInput, { text: "x", thinking: "turbo" })).toBe(false);
    expect(accepts(SessionStartInput, { text: "x", request_id: "" })).toBe(false);
    expect(
      accepts(SessionStartInput, { text: "x", request_id: "r".repeat(MAX_REQUEST_ID_CHARS + 1) }),
    ).toBe(false);
  });
});

describe("session_send's and session_stop's arguments", () => {
  it("take queue, steer or reject, and an optional request id", () => {
    for (const when_busy of ["queue", "steer", "reject"]) {
      expect(accepts(SessionSendInput, { session_id: ID, text: "go", when_busy })).toBe(true);
    }

    expect(accepts(SessionSendInput, { session_id: ID, text: "go", request_id: "r" })).toBe(true);
    expect(accepts(SessionSendInput, { session_id: ID, text: "go", when_busy: "now" })).toBe(false);
    expect(accepts(SessionSendInput, { session_id: ID, text: "" })).toBe(false);
    expect(accepts(SessionSendInput, { text: "go" })).toBe(false);
  });

  it("stop a Session, and its subagents when asked", () => {
    expect(accepts(SessionStopInput, { session_id: ID })).toBe(true);
    expect(accepts(SessionStopInput, { session_id: ID, subagents: true })).toBe(true);
    expect(accepts(SessionStopInput, { session_id: ID, subagents: "yes" })).toBe(false);
    expect(accepts(SessionStopInput, {})).toBe(false);
  });
});

describe("the operations", () => {
  it("take session_wait's cursor, and a timeout of 0 to 300 whole seconds", () => {
    expect(accepts(SessionWaitInput, { session_id: ID })).toBe(true);
    expect(accepts(SessionWaitInput, { session_id: ID, after: "c", timeout_s: 0 })).toBe(true);
    expect(accepts(SessionWaitInput, { session_id: ID, timeout_s: 300 })).toBe(true);
    expect(accepts(SessionWaitInput, { session_id: ID, timeout_s: 301 })).toBe(false);
    expect(accepts(SessionWaitInput, { session_id: ID, timeout_s: -1 })).toBe(false);
    expect(accepts(SessionWaitInput, { session_id: ID, timeout_s: 1.5 })).toBe(false);
    expect(accepts(SessionWaitInput, { after: "c" })).toBe(false);
  });

  it("read a wait that ended for a reason this version does not know as a timeout, and a request kind it does not know as unknown", () => {
    const decoded = Schema.decodeUnknownExit(SessionWaitResult)({
      session_id: ID,
      status: "paused",
      ended_by: "owner_gone",
      waiting: [
        { kind: "poll", request_id: "r", agent_id: "root", summary: "s", since: 1, url: "/u" },
      ],
      activity: { entries: 0, tool_calls: 0, latest: [] },
      cursor: "c",
    });

    expect(Exit.isSuccess(decoded) && decoded.value.ended_by).toBe("timeout");
    expect(Exit.isSuccess(decoded) && decoded.value.status).toBe("unknown");
    expect(Exit.isSuccess(decoded) && decoded.value.waiting[0]?.kind).toBe("unknown");
  });

  it("name the `api` operation of each tool, the four read ones first", () => {
    expect(MCP_TOOL_OPERATIONS.environments_list).toBe("environments");
    expect(MCP_TOOL_OPERATIONS.sessions_list).toBe("sessions");
    expect(MCP_TOOL_OPERATIONS.session_get).toBe("session");
    expect(MCP_TOOL_OPERATIONS.session_transcript).toBe("transcript");
    expect(MCP_TOOL_OPERATIONS.session_start).toBe("start");
    expect(MCP_TOOL_OPERATIONS.session_send).toBe("send");
    expect(MCP_TOOL_OPERATIONS.session_stop).toBe("stop");
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
