// A fake Approvals for tests of tools that never ask the owner: every method fails when called.
// @effect-diagnostics missingPipeableSignature:off
import * as Effect from "effect/Effect";
import type { ApprovalsService } from "./approvals.ts";

/** Approvals that fail when asked, for tests of tools that wait for an Approval only in cases the test does not run. */
export const unusedApprovals: ApprovalsService = {
  ask: () => Effect.die("ask is not used here"),
  settle: () => Effect.die("settle is not used here"),
  holds: () => Effect.succeed(false),
  pending: Effect.succeed([]),
  answer: () => Effect.die("answer is not used here"),
  dropAbandoned: Effect.void,
};
