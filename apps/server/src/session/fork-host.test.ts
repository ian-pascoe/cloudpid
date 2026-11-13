// What a page the Session exports for a Fork carries of its question records (`fork-host.ts`, #569): one copier for the
// whole page, so the Session's Sampling records are read once, not once per entry.
// @effect-diagnostics preferEffectArray:off asyncFunction:off -- plain arrays of fixtures; the harness is Promise-based.
import type { McpQuestionCopier, McpQuestionCopies } from "@cloudpid/extensions/mcp";
import type { EntryRecord, Harness } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { sessionForks } from "./fork-host.ts";

type Fixture = { readonly [key: string]: string | number | readonly unknown[] };

// SAFETY: a fixture holds only the fields an export reads; the other fields of pi's types are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asEntry = (entry: Fixture): EntryRecord => entry as unknown as EntryRecord;

const result = (id: number) =>
  asEntry({
    id,
    kind: "pi.tool_result",
    model: [
      { role: "toolResult", toolCallId: `call-${id}`, toolName: "mcp__docs__ask", content: [] },
    ],
  });

describe("a page the Session exports for a Fork", () => {
  it("is given one copier for all its entries, and each entry's calls go to it", async () => {
    const made: McpQuestionCopier[] = [];
    const asked: Array<ReadonlyArray<string>> = [];

    const questions: McpQuestionCopies = {
      copier: () => {
        const copier: McpQuestionCopier = (callIds: ReadonlyArray<string>) => {
          asked.push(callIds);

          return [];
        };

        made.push(copier);

        return copier;
      },
      adopt: () => undefined,
    };

    const conversation = {
      id: 1,
      entries: async () => ({ items: [result(1), result(2), result(3)], next: undefined }),
    };

    // SAFETY: only the harness's `conversation` is read by an export, and the rest of the options are not reached.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const harness = { conversation: async () => conversation } as unknown as Harness;

    const forks = sessionForks({
      harness,
      // SAFETY: an export reads no key-value storage.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      kv: {} as never,
      root: Effect.never,
      active: Effect.never,
      // SAFETY: nothing keeps the Session from a Fork here, which an undefined reason says.
      busyReason: () => Effect.succeed(undefined as string | undefined),
      inspect: Effect.never,
      pendingCompactions: () => ({}),
      // SAFETY: an export never reads the pick.
      picked: () => ({}) as never,
      questions,
      inArrivalOrder: (effect) => effect,
    });

    await Effect.runPromise(
      // SAFETY: a plain number stands in for the branded conversation ID.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      forks.exportEntries({ conversationId: 1 as never, through: 3, after: null }),
    );

    expect(made).toHaveLength(1);
    expect(asked).toEqual([["call-1"], ["call-2"], ["call-3"]]);
  });
});
