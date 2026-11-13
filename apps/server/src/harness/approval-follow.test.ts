// docs/architecture/mcp-endpoint.md → Approvals with no Session: how long `approval_wait` waits (`./approval-follow.ts`).
// The waits themselves run over the real Registry in `approvals.workerd.test.ts`.
import { DEFAULT_APPROVAL_WAIT_S, MAX_APPROVAL_WAIT_S } from "@cloudpid/protocol/harness-tools";
import { describe, expect, it } from "vite-plus/test";
import { waitSeconds } from "./approval-follow.ts";

describe("waitSeconds", () => {
  it.each([
    ["no timeout", undefined, DEFAULT_APPROVAL_WAIT_S],
    ["one that is not a number", Number.NaN, DEFAULT_APPROVAL_WAIT_S],
    ["one below 0", -5, 0],
    ["0, a single read", 0, 0],
    ["one within the bounds", 30, 30],
    ["one past the most", MAX_APPROVAL_WAIT_S + 1, MAX_APPROVAL_WAIT_S],
  ])("waits as long as %s says", (_, timeout, seconds) => {
    expect(waitSeconds(timeout)).toBe(seconds);
  });
});
