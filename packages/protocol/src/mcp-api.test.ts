import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  apiFailure,
  apiOk,
  decodeCursor,
  encodeCursor,
  MCP_API_LIMITS,
  readApiErrorCode,
  runOutcome,
  SubmitRequest,
  viaLabel,
  whenBusyOf,
} from "./mcp-api.ts";

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

  it("read a code a newer deploy added as unavailable", () => {
    expect(readApiErrorCode("branch_taken")).toBe("branch_taken");
    expect(readApiErrorCode("brand_new_code")).toBe("unavailable");
    expect(readApiErrorCode(42)).toBe("unavailable");
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
    expect(viaLabel({ client: { name: "pi" } })).toBe("MCP · pi");
    expect(viaLabel({})).toBe("MCP");
    expect(viaLabel({ client: { name: "pi" } }, "import")).toBe("Imported · pi");
  });

  it("map the tool's when_busy onto the socket's", () => {
    expect(whenBusyOf("queue")).toBe("followUp");
    expect(whenBusyOf("steer")).toBe("steer");
    expect(whenBusyOf("reject")).toBe("reject");
  });

  it("are required on a submission, and never carry an email", () => {
    const decode = Schema.decodeUnknownOption(SubmitRequest);

    expect(Option.isSome(decode({ input: "hi", via: { auth: "oauth" } }))).toBe(true);
    expect(Option.isNone(decode({ input: "hi" }))).toBe(true);
    expect(Option.isNone(decode({ input: "hi", via: { auth: "password" } }))).toBe(true);
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
