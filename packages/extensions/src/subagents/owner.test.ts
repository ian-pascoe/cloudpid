// Stop all of the owner (`stopConversation` with `subagents`): the subagents' aborts run side by side, since each waits for
// its followers' `tasks/cancel` (docs/architecture/mcp-server-requests.md → MCP tasks, Cancellation).
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import { type ConversationId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type BeforeAbort, type OwnerHarness, stopConversation } from "./owner.ts";
import { type AgentRecord, EMPTY_STATE, type SubagentsState } from "./state.ts";
import { context } from "./harness.fixture.ts";

// SAFETY: test conversation IDs, as pi-durable brands them.
const conversation = (id: number) => id as ConversationId;

/** Agent `id` of the root, running conversation `runs`: the fields these functions read. */
const child = (id: string, runs: number): AgentRecord =>
  // SAFETY: the fields stopConversation reads; the rest of a record is never looked at.
  ({ id, parent: "root", depth: 1, conversationId: conversation(runs) }) as AgentRecord;

const STATE: SubagentsState = {
  ...EMPTY_STATE,
  agents: { a: child("a", 2), b: child("b", 3), c: child("c", 4) },
  conversations: { "2": "a", "3": "b", "4": "c" },
};

describe("Stop all across subagents", () => {
  it("aborts the subagents side by side, so unresponsive followers cost one bound and not one each", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const everyoneStarted = Promise.withResolvers<void>();

    // SAFETY: the two methods stopConversation reads of a Harness; the rest of one is never touched.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion
    const harness = {
      snapshot: async () => STATE,
      conversation: async (id: ConversationId) => ({
        abort: async () => {
          started.push(id);

          if (id === ROOT_CONVERSATION_ID) return;

          if (started.filter((each) => each !== ROOT_CONVERSATION_ID).length === 3) {
            everyoneStarted.resolve();
          }

          // An abort that waits for its agent's followers: it ends only once every agent's abort has begun, which one
          // after another never reaches.
          await Promise.race([
            everyoneStarted.promise,
            new Promise((_, reject) =>
              setTimeout(() => {
                reject(new Error("The aborts ran one after another"));
              }, 1000),
            ),
          ]);
          finished.push(id);
        },
      }),
    } as unknown as OwnerHarness;

    const before: BeforeAbort = async () => undefined;

    await stopConversation(harness, ROOT_CONVERSATION_ID, { subagents: true }, context, before);

    const ascending = (left: number, right: number) => left - right;

    expect(started.toSorted(ascending)).toEqual(
      [ROOT_CONVERSATION_ID, 2, 3, 4].toSorted(ascending),
    );
    expect(finished.toSorted(ascending)).toEqual([2, 3, 4]);
  });
});
