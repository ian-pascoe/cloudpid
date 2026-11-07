import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  ApiErrorCode,
  ApiResult,
  Delivery,
  EndedBy,
  McpAuth,
  McpEra,
  McpSessionOrigin,
  McpSessionStatus,
  McpSessionSummary,
  RunOutcome,
  SessionVia,
  SessionDetail,
  TranscriptEntry,
  Via,
  WaitingKind,
  WaitingRequest,
  apiFailure,
  apiOk,
  decodeCursor,
  encodeCursor,
  MCP_API_LIMITS,
  runOutcome,
  SubmitRequest,
  sessionOriginLabel,
  MarkedOrigin,
  inputViaChipLabel,
  whenBusyOf,
} from "./mcp-api.ts";

// The helper feeds malformed and future members to a schema, which is what it tests.
const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  input: unknown,
) => Effect.runSync(Schema.decodeUnknownEffect(schema)(input));

describe("cursors", () => {
  const state = { c: 3, e: 41, w: 1_700_000_000_123, s: 7 };

  it("round-trips as base64url", () => {
    const cursor = encodeCursor(state);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(Option.some(state));
  });

  it("reads anything that is not a cursor as none", () => {
    for (const bad of [
      "",
      "not a cursor!",
      "e30",
      btoa("[1]"),
      encodeCursor({ ...state, e: 1.5 }),
    ]) {
      expect(Option.isNone(decodeCursor(bad))).toBe(true);
    }
  });
});

describe("failures", () => {
  it("are values whose retryability follows the code", () => {
    expect(apiFailure("session_busy", "Busy.")).toEqual({
      ok: false,
      error: { code: "session_busy", message: "Busy.", retryable: true },
    });
    expect(apiFailure("not_found", "No.", { details: { id: "x" } })).toEqual({
      ok: false,
      error: { code: "not_found", message: "No.", retryable: false, details: { id: "x" } },
    });
    expect(apiOk(1)).toEqual({ ok: true, value: 1 });
  });
});

describe("runOutcome", () => {
  it("maps a settled submission", () => {
    expect(runOutcome({ status: "done" })).toEqual({ result: "answered" });

    for (const reason of ["aborted", "withdrawn", "reset"]) {
      expect(runOutcome({ status: "unanswered", reason })).toEqual({ result: "stopped", reason });
    }

    expect(runOutcome({ status: "unanswered", reason: "model_error", detail: "boom" })).toEqual({
      result: "failed",
      reason: "model_error",
      message: "boom",
    });
    expect(
      runOutcome({
        status: "unanswered",
        reason: "model_error",
        detail: "Session is out of budget",
      }),
    ).toMatchObject({ result: "failed", reason: "spend_limit" });
  });
});

describe("marks", () => {
  it("name the client, or say MCP alone", () => {
    expect(sessionOriginLabel({ client: { name: "pi" } })).toBe("MCP · pi");
    expect(sessionOriginLabel({})).toBe("MCP");
    expect(sessionOriginLabel({ client: { name: "pi" } }, "import")).toBe("Imported · pi");
  });

  it("name the Trigger a Fire came from, on its Session and on its input", () => {
    const trigger = { id: "t1", name: "Weekly report" };

    expect(sessionOriginLabel({ trigger }, "trigger")).toBe("Trigger · Weekly report");
    expect(inputViaChipLabel({ auth: "trigger", trigger })).toBe("via Weekly report (Trigger)");
    expect(inputViaChipLabel({ auth: "oauth", client: { name: "pi" } })).toBe("via pi (MCP)");
  });

  it("keep a Trigger's mark, which an older reader reads as an unknown way in", () => {
    const marks = { kind: "trigger", auth: "trigger", trigger: { id: "t1", name: "Nightly" } };

    expect(read(MarkedOrigin, marks)).toEqual(marks);
    expect(read(SessionVia, { auth: "trigger", trigger: { id: "t1", name: "Nightly" } })).toEqual({
      auth: "trigger",
      trigger: { id: "t1", name: "Nightly" },
    });
  });

  it("map the tool's when_busy onto the socket's", () => {
    expect(whenBusyOf("queue")).toBe("followUp");
    expect(whenBusyOf("steer")).toBe("steer");
    expect(whenBusyOf("reject")).toBe("reject");
  });

  it("are required on a submission, and an unknown way in reads as unknown", () => {
    const decode = Schema.decodeUnknownOption(SubmitRequest);

    expect(Option.isSome(decode({ input: "hi", via: { auth: "oauth" } }))).toBe(true);
    expect(Option.isNone(decode({ input: "hi" }))).toBe(true);
    expect(decode({ input: "hi", via: { auth: "password" } })).toMatchObject({
      value: { via: { auth: "unknown" } },
    });
  });
});

describe("describe() limits", () => {
  it("are the endpoint's", () => {
    expect(MCP_API_LIMITS).toEqual({
      maxInputBytes: 1_900_000,
      maxSliceBytes: 2 * 1024 * 1024,
      maxImportBytes: 64 * 1024 * 1024,
      maxWaitMs: 300_000,
    });
  });
});

describe("a value a newer deploy added", () => {
  const future = "from-the-future";

  it("reads as the generic member, never as a decoding failure", () => {
    expect(read(ApiErrorCode, future)).toBe("unavailable");
    expect(read(McpSessionStatus, future)).toBe("unknown");
    expect(read(EndedBy, future)).toBe("timeout");
    expect(read(WaitingKind, future)).toBe("unknown");
    expect(read(Delivery, future)).toBe("unknown");
    expect(read(McpAuth, future)).toBe("unknown");
    expect(read(McpEra, future)).toBe("unknown");
    expect(read(RunOutcome, { result: future })).toEqual({ result: "unknown" });
    expect(read(TranscriptEntry, { entry_id: 1, role: future, at: "", text: "x" }).role).toBe(
      "notice",
    );
  });

  it("reads known members as they are", () => {
    expect(read(ApiErrorCode, "branch_taken")).toBe("branch_taken");
    expect(read(ApiErrorCode, "stopped")).toBe("stopped");
    expect(read(McpSessionStatus, "waiting_for_owner")).toBe("waiting_for_owner");
    expect(read(EndedBy, "owner_needed")).toBe("owner_needed");
  });

  it("reads inside what carries it: failures, waiting requests, marks and the listing", () => {
    expect(read(ApiError, { code: future, message: "m", retryable: true })).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    // A reader that does not know `stopped` (a message the owner's Stop withdrew) sees `unavailable` and, as the flag
    // travels, that sending it again will not help.
    expect(read(ApiError, { code: future, message: "m", retryable: false })).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    expect(apiFailure("stopped", "m", { retryable: false })).toMatchObject({
      ok: false,
      error: { code: "stopped", retryable: false },
    });
    expect(
      read(ApiResult(Schema.String), {
        ok: false,
        error: { code: future, message: "m", retryable: false },
      }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(
      read(WaitingRequest, {
        kind: future,
        request_id: "r",
        agent_id: "root",
        summary: "s",
        since: 1,
        url: "/",
      }).kind,
    ).toBe("unknown");
    expect(read(SessionVia, { auth: future, era: future, client: { name: "pi" } })).toEqual({
      auth: "unknown",
      era: "unknown",
      client: { name: "pi" },
    });
    // The owner's grant id travels in the mark when there is one; a version that predates it reads the mark without it.
    expect(read(SessionVia, { auth: "oauth", clientId: "dcr-1" })).toEqual({
      auth: "oauth",
      clientId: "dcr-1",
    });
    expect(read(SessionVia, { auth: "oauth" })).toEqual({ auth: "oauth" });
    expect(read(Via, { era: future })).toEqual({ era: "unknown" });
    expect(read(McpSessionOrigin, { kind: future, auth: future })).toEqual({
      kind: "unknown",
      auth: "unknown",
    });
    expect(read(McpSessionOrigin, { kind: future, session: "s" })).toEqual({
      kind: "unknown",
      session: "s",
    });
    expect(read(McpSessionOrigin, { kind: "clone", session: "s" })).toEqual({
      kind: "clone",
      session: "s",
    });

    const summary = read(McpSessionSummary, {
      session_id: "s",
      title: null,
      environment: { id: "e", name: "E" },
      status: future,
      updated_at: "",
      archived: false,
      url: "/",
    });

    expect(summary.status).toBe("unknown");
    expect(
      read(SessionDetail, {
        session_id: "s",
        title: null,
        environment: { id: "e", name: "E" },
        status: future,
        updated_at: "",
        archived: false,
        url: "/",
        waiting: [],
        cursor: "c",
        agents: [{ agent_id: "agent-1", parent: "root", role: null, status: future }],
        workspace: { branch: null, base: null, repos: [] },
      }),
    ).toMatchObject({ status: "unknown", agents: [{ status: "unknown" }] });
  });
});

describe("Via", () => {
  it("carries the era, and never how the caller got in", () => {
    expect(Option.isNone(Schema.decodeUnknownOption(Via)({}))).toBe(true);
    expect(read(Via, { era: "modern", auth: "oauth" })).toEqual({ era: "modern" });
  });
});
