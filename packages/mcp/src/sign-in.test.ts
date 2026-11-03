/**
 * The Registry's sign-in edge as the host reads and writes it (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
 * object, Version skew): a union the other end may extend has a fallback member, so a newer build's value never fails a
 * decode on an older one.
 */
// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { McpAccessTokenAnswer, McpAuthEvent, McpAuthReport, McpAuthReportAnswer } from "./types.ts";

/** Decode `input` as the edge does: it arrives as data of any shape. */
const decode = <A, I>(schema: Schema.Codec<A, I>, input: Schema.Json): Promise<A> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.runPromise);

const base = { environment: "default", server: "linear" };

describe("a host's report (McpAuthReport)", () => {
  it("reads each event this build knows as itself", async () => {
    for (const event of ["needs_sign_in", "step_up", "rejected", "working"]) {
      expect(await decode(McpAuthEvent, event)).toBe(event);
    }
  });

  it("reads an event a newer host sends as an unknown string, not as a failure", async () => {
    expect(
      await decode(McpAuthReport, {
        ...base,
        event: "needs_consent",
        challenge: { scope: "read" },
      }),
    ).toEqual({ ...base, event: "needs_consent", challenge: { scope: "read" } });
  });

  it("still refuses an event that is not a string", async () => {
    await expect(decode(McpAuthReport, { ...base, event: 3 })).rejects.toThrow();
  });
});

describe("the Registry's answers", () => {
  it("read a status a newer Registry sends as a generic failure", async () => {
    expect(await decode(McpAccessTokenAnswer, { status: "consent_pending" })).toEqual({
      status: "consent_pending",
    });
    expect(await decode(McpAuthReportAnswer, { status: "deferred" })).toEqual({
      status: "deferred",
    });
  });

  it("keep the note of an ok answer, and drop a key this build does not know", async () => {
    const answer = await decode(McpAccessTokenAnswer, {
      status: "ok",
      token: "t",
      resource: "https://mcp.example.com/mcp",
      signIn: "grant",
      note: { status: "step_up", scope: "read write", newer: true },
      other: 1,
    });

    expect(answer).toEqual({
      status: "ok",
      token: "t",
      resource: "https://mcp.example.com/mcp",
      signIn: "grant",
      note: { status: "step_up", scope: "read write" },
    });
  });
});
