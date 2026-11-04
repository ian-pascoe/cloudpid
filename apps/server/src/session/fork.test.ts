// @effect-diagnostics preferEffectArray:off -- plain arrays of fixtures.
import type { AgentState, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { McpQuestionRecord } from "@cloudpid/extensions/mcp";
import type { McpAppCopy } from "@cloudpid/protocol";
import { copiedDraft, copyAgent, exportPage, MAX_COPY_PAGE_SIZE, toolResultIds } from "./fork.ts";

type FixtureValue =
  | string
  | number
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

type Fixture = { readonly [key: string]: FixtureValue };

// SAFETY: a fixture holds only the fields a copy reads; the other fields of pi's types are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asEntry = (entry: Fixture): EntryRecord => entry as unknown as EntryRecord;

const entry = (id: number, text = `entry ${id}`) =>
  asEntry({ id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] });

describe("a page of the entries a Fork copies", () => {
  it("is every entry left, and the last page, when they all fit", () => {
    expect(exportPage([entry(1), entry(2)], false)).toEqual({
      entries: [entry(1), entry(2)],
      next: null,
    });
  });

  it("says where the next starts while the read has more", () => {
    expect(exportPage([entry(1), entry(2)], true).next).toBe(2);
  });

  it("stops before the entry that does not fit, but always holds one", () => {
    const big = (id: number) => entry(id, "z".repeat(MAX_COPY_PAGE_SIZE / 2));

    const page = exportPage([big(1), big(2), big(3)], false);

    expect(page.entries.map((each) => each.id)).toEqual([1]);
    expect(page.next).toBe(1);

    const huge = exportPage([entry(1, "z".repeat(MAX_COPY_PAGE_SIZE + 1))], false);

    expect(huge.entries).toHaveLength(1);
    expect(huge.next).toBeNull();
  });
});

/** An entry that holds the result of tool call `callId`. */
const result = (id: number, callId: string) =>
  asEntry({
    id,
    kind: "pi.tool_result",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "mcp__docs__app",
        content: [],
      },
    ],
  });

/** A stub, which a copy carries as it is. */
const stubOf = (callId: string): McpAppCopy => ({
  kind: "stub",
  stub: { callId, server: "docs", tool: "app", conversation: "1" },
});

describe("the App records a page of a Fork carries", () => {
  it("names the tool calls whose results an entry holds", () => {
    expect(toolResultIds(result(1, "call-1"))).toEqual(["call-1"]);
    expect(toolResultIds(entry(2))).toEqual([]);
  });

  it("holds the copies of the calls its entries have results of, and none when there are none", () => {
    const appsOf = (each: EntryRecord) => toolResultIds(each).map((callId) => stubOf(callId));

    const page = exportPage([entry(1), result(2, "call-2"), result(3, "call-3")], false, appsOf);

    expect(page.apps).toEqual([stubOf("call-2"), stubOf("call-3")]);
    expect(page.entries).toHaveLength(3);
    // A page of calls that have no records has no `apps` at all, as one from a Session before App records.
    expect(exportPage([entry(1)], false, appsOf)).toEqual({ entries: [entry(1)], next: null });
  });

  it("counts the copies in the page's size, so a page of large records is cut, and its copies go with its entries", () => {
    const large = (callId: string): McpAppCopy => ({
      kind: "record",
      record: {
        callId,
        server: "docs",
        tool: "app",
        conversation: "1",
        arguments: {},
        result: { text: "z".repeat(MAX_COPY_PAGE_SIZE / 2) },
        audit: [],
        at: 1,
      },
    });

    const appsOf = (each: EntryRecord) => toolResultIds(each).map(large);

    const page = exportPage([result(1, "a"), result(2, "b"), result(3, "c")], false, appsOf);

    expect(page.entries.map((each) => each.id)).toEqual([1]);
    expect(page.next).toBe(1);
    expect(page.apps).toHaveLength(1);
    expect(page.apps?.[0]).toMatchObject({ kind: "record", record: { callId: "a" } });
  });
});

describe("the question records a page of a Fork carries", () => {
  const recordOf = (callId: string): McpQuestionRecord => ({
    id: `${callId}:1`,
    callId,
    // SAFETY: a plain number stands in for the branded conversation ID, which a copy never reads.
    conversationId: 1 as McpQuestionRecord["conversationId"],
    server: "docs",
    tool: "mcp__docs__ask",
    mode: "form",
    message: "",
    notes: [],
    action: "decline",
    by: "cloudpid",
    fields: [],
    askedAt: 1,
    settledAt: 1,
  });

  const questionsOf = (each: EntryRecord) => toolResultIds(each).map(recordOf);

  it("holds the settled records of the calls its entries have results of, and none when there are none", () => {
    const page = exportPage(
      [entry(1), result(2, "call-2"), result(3, "call-3")],
      false,
      undefined,
      questionsOf,
    );

    expect(page.questions).toEqual([recordOf("call-2"), recordOf("call-3")]);
    expect(exportPage([entry(1)], false, undefined, questionsOf)).toEqual({
      entries: [entry(1)],
      next: null,
    });
  });
});

describe("the App records of one entry too large for a page", () => {
  it("carries the records that fit, in order, and the rest as stubs with the call's time", () => {
    const large = (callId: string, parentCall: string): McpAppCopy => ({
      kind: "record",
      record: {
        callId,
        server: "docs",
        tool: "app",
        conversation: "1",
        parentCall,
        arguments: {},
        result: { text: "z".repeat(MAX_COPY_PAGE_SIZE / 3) },
        audit: [],
        at: 7,
      },
    });

    // One `codemode` script's result, whose four nested calls weigh more than a page.
    const appsOf = () => ["a", "b", "c", "d"].map((callId) => large(callId, "script"));

    const page = exportPage([result(1, "script")], false, appsOf);

    expect(page.entries).toHaveLength(1);
    expect(page.apps?.map((copy) => copy.kind)).toEqual(["record", "record", "stub", "stub"]);
    expect(page.apps?.[3]).toEqual({
      kind: "stub",
      stub: {
        callId: "d",
        server: "docs",
        tool: "app",
        conversation: "1",
        parentCall: "script",
        at: 7,
      },
    });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(MAX_COPY_PAGE_SIZE + 1024);
  });
});

describe("the draft of a copied entry", () => {
  it("keeps its kind, messages and data", () => {
    const source = asEntry({
      id: 4,
      kind: "pi.compaction",
      model: [{ role: "user", content: "summary", timestamp: 4 }],
      data: { reason: "manual" },
    });

    expect(copiedDraft(source, new Map())).toEqual({
      kind: "pi.compaction",
      model: [{ role: "user", content: "summary", timestamp: 4 }],
      data: { reason: "manual" },
    });
  });

  it("renumbers the head and the edits' targets, its own head as self, and drops what was not copied", () => {
    const ids = new Map([
      [2, 12],
      [3, 13],
    ]);

    const own = copiedDraft(asEntry({ id: 5, kind: "pi.reset", head: 5 }), ids);
    const earlier = copiedDraft(asEntry({ id: 5, kind: "pi.compaction", head: 3 }), ids);
    const lost = copiedDraft(asEntry({ id: 5, kind: "pi.compaction", head: 1 }), ids);

    expect(own.head).toBe("self");
    expect(earlier.head).toBe(13);
    expect(lost).not.toHaveProperty("head");

    const edited = copiedDraft(
      asEntry({
        id: 6,
        kind: "pi.edit",
        edits: [
          { target: 2, type: "hide" },
          { target: 1, type: "hide" },
        ],
      }),
      ids,
    );

    expect(edited.edits).toEqual([{ target: 12, type: "hide" }]);
    expect(
      copiedDraft(asEntry({ id: 6, kind: "pi.edit", edits: [{ target: 1, type: "hide" }] }), ids),
    ).not.toHaveProperty("edits");
  });
});

describe("the agent a copy takes", () => {
  it("is the source's, field for field, without what the source did not set", () => {
    const draft: AgentState = {
      model: { provider: "a", modelId: "old" },
      thinkingLevel: "high",
      tools: ["read"],
    };

    const source: AgentState = {
      model: { provider: "b", modelId: "new" },
      tools: ["read", "bash"],
    };

    copyAgent(draft, source);

    expect(draft).toEqual(source);

    // A copy, not the source's own objects.
    expect(draft.tools).not.toBe(source.tools);
  });
});
