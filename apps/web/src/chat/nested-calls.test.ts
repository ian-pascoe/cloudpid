import type { NestedTool } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { liveCalls, omittedCalls, settledCalls } from "./nested-calls.ts";

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

  it("gives each call the Call diff the script's result keeps for it", () => {
    const patch = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b\n";

    const calls = settledCalls({
      calls: [
        { id: 1, name: "write", args: '{"path":"a.ts"}', status: "ok" },
        { id: 2, name: "write", args: "{}", status: "error", error: "no" },
        { id: 3, name: "edit", args: "{}", status: "ok" },
        { id: 4, name: "write", args: "{}", status: "ok" },
        { id: 5, name: "write", args: "{}", status: "ok" },
      ],
      diffs: {
        "1": { path: "a.ts", patch, created: true },
        "3": { patch: "--- b\n+++ b\n" },
        "4": { tooLarge: true, created: true },
        "5": { patch: 7, nonsense: true },
        "9": { patch },
      },
    });

    expect(Arr.map(calls, (call) => [call.id, call.diff])).toEqual([
      ["1", { path: "a.ts", patch, created: true }],
      ["2", undefined],
      ["3", { patch: "--- b\n+++ b\n" }],
      ["4", { unavailable: true, created: true }],
      ["5", undefined],
    ]);
  });

  it("reads how many calls a result's details left out, and how many of them failed", () => {
    expect(omittedCalls({ calls: [], omittedCalls: { count: 1234, failed: 1200 } })).toEqual({
      count: 1234,
      failed: 1200,
    });
    expect(omittedCalls({ calls: [], omittedCalls: { count: 3, failed: 0 } })).toEqual({
      count: 3,
      failed: 0,
    });
  });

  it("finds no omitted calls when the details have none or a bad one, and still lists their calls", () => {
    const calls = [{ id: 1, name: "read", args: "{}", status: "ok" }];

    expect(omittedCalls(undefined)).toBeUndefined();
    expect(omittedCalls({ calls })).toBeUndefined();
    expect(omittedCalls({ calls, omittedCalls: "many" })).toBeUndefined();
    expect(omittedCalls({ calls, omittedCalls: { count: 2 } })).toBeUndefined();
    expect(omittedCalls({ calls, omittedCalls: { count: -1, failed: 0 } })).toBeUndefined();
    expect(omittedCalls({ calls, omittedCalls: { count: 1.5, failed: 0 } })).toBeUndefined();
    expect(omittedCalls({ calls, omittedCalls: { count: 0, failed: 0 } })).toBeUndefined();

    expect(settledCalls({ calls, omittedCalls: "many" })).toEqual([
      { id: "1", name: "read", args: {}, status: "ok" },
    ]);
  });

  it("finds no calls in details of another shape", () => {
    expect(settledCalls(undefined)).toEqual([]);
    expect(settledCalls({ exitCode: 0 })).toEqual([]);
    expect(settledCalls({ calls: "x" })).toEqual([]);
    expect(settledCalls({ calls: [{ id: "one" }] })).toEqual([]);
  });
});
