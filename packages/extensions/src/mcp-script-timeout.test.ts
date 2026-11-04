// Which results of a `codemode` call end its nested calls' questions as "the script timed out"
// (`docs/architecture/mcp-server-requests.md` → `codemode`): only a model-issued call whose script set a `timeout_ms`
// and whose result is the library's own failure for it.
import type { ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import type { Mutable } from "effect/Types";
import { describe, expect, it } from "vitest";
import { endedByTimeout } from "./mcp/tools.ts";

const TIMED = `// @options: {"timeout_ms": 300}\nawait tools.mcp__docs__ask({});`;

const callOf = (code: string, name = "codemode", parent?: ToolHookCall["parent"]): ToolHookCall => {
  const call: Mutable<ToolHookCall> = { type: "toolCall", id: "call-1", name, arguments: { code } };

  if (parent !== undefined) call.parent = parent;

  return call;
};

const resultOf = (text: string, isError = true): ToolExecutionResult => ({
  isError,
  output: [{ type: "text", text }],
});

// SAFETY: a plain number stands in for the branded task ID of the script's task, which the hook never reads.
const OUTER_TASK = 1 as NonNullable<ToolHookCall["parent"]>["taskId"];

const TIMED_OUT =
  "Script failed\nOutput:\nScript error:\nScript timed out: 300 ms\n\nNo tool calls were made.";

describe("a codemode result that ends its script's questions as timed out", () => {
  it("is a failed result of a script with a timeout_ms, with the library's words for it", () => {
    expect(endedByTimeout(callOf(TIMED), resultOf(TIMED_OUT))).toBe(true);
  });

  it("is not a result that is not an error, whatever its text says", () => {
    expect(endedByTimeout(callOf(TIMED), resultOf(TIMED_OUT, false))).toBe(false);
  });

  it("is not a nested call's, which a script's own call hooks see too", () => {
    expect(
      endedByTimeout(
        callOf(TIMED, "codemode", { taskId: OUTER_TASK, callId: "outer" }),
        resultOf(TIMED_OUT),
      ),
    ).toBe(false);
  });

  it("is not another tool's result", () => {
    expect(endedByTimeout(callOf(TIMED, "bash"), resultOf(TIMED_OUT))).toBe(false);
  });

  it("is not a script that set no timeout, nor an error that only mentions one in its output", () => {
    expect(endedByTimeout(callOf("await tools.mcp__docs__ask({});"), resultOf(TIMED_OUT))).toBe(
      false,
    );
    expect(
      endedByTimeout(
        callOf(TIMED),
        resultOf("Script failed\nOutput:\nScript timed out: not really\nboom"),
      ),
    ).toBe(false);
  });
});
