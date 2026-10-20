import type { NestedTool } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { liveCalls, settledCalls } from "./nested-calls.ts";

const nested = (change: Partial<NestedTool>): NestedTool => ({
  callId: "c1/c1",
  parentCallId: "c1",
  name: "read",
  args: {},
  output: "",
  status: "running",
  isError: false,
  ...change,
});

describe("the calls a script made", () => {
  it("lists the live calls of one tool call, in order, with how each stands", () => {
    expect(
      liveCalls(
        [
          nested({ callId: "c1/c1", status: "done", durationMs: 9 }),
          nested({ callId: "c2/c1", parentCallId: "c2" }),
          nested({ callId: "c1/c2", status: "done", isError: true, error: "no file" }),
          nested({ callId: "c1/c3" }),
        ],
        "c1",
      ),
    ).toEqual([
      { id: "c1/c1", name: "read", args: {}, status: "ok", durationMs: 9 },
      { id: "c1/c2", name: "read", args: {}, status: "error", error: "no file" },
      { id: "c1/c3", name: "read", args: {}, status: "running" },
    ]);
  });

  it("reads the calls of a result's details, whose arguments are cut JSON", () => {
    expect(
      settledCalls({
        calls: [
          { id: 1, name: "read", args: '{"path":"a"}', status: "ok", durationMs: 4 },
          { id: 2, name: "bash", args: '{"command":"a very lo…', status: "cancelled" },
          { id: 3, name: "grep", args: "{}", status: "error", error: "bad" },
        ],
        fullOutputPath: "/tmp/x",
      }),
    ).toEqual([
      { id: "1", name: "read", args: { path: "a" }, status: "ok", durationMs: 4 },
      { id: "2", name: "bash", args: {}, status: "cancelled" },
      { id: "3", name: "grep", args: {}, status: "error", error: "bad" },
    ]);
  });

  it("finds no calls in details of another shape", () => {
    expect(settledCalls(undefined)).toEqual([]);
    expect(settledCalls({ exitCode: 0 })).toEqual([]);
    expect(settledCalls({ calls: "x" })).toEqual([]);
    expect(settledCalls({ calls: [{ id: "one" }] })).toEqual([]);
  });
});
