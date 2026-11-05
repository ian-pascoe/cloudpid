// @effect-diagnostics preferEffectArray:off -- plain arrays of pi's messages.
// Bounding the screenshots a request and what a conversation's watch sends carry.
import type { Op } from "@earendil-works/chord/delta";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  limitEntryImages,
  limitImages,
  limitOpsImages,
  limitViewImages,
  OMITTED_IMAGE,
} from "./images.ts";

const shot = (data: string) => ({ type: "image" as const, data, mimeType: "image/jpeg" });

const result = (id: string, ...images: string[]): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "browser",
  content: [{ type: "text", text: `result ${id}` }, ...images.map(shot)],
  isError: false,
  timestamp: 0,
});

const user: Message = { role: "user", content: "go", timestamp: 0 };

const imagesOf = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === "toolResult"
      ? message.content.map((part) => (part.type === "image" ? part.data : part.text))
      : [],
  );

// SAFETY: a fixture holds only the fields the limit reads; the other fields of pi's entry are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const entry = (id: number, ...model: Message[]) => ({ id, model }) as unknown as EntryRecord;

const view = (...entries: EntryRecord[]) =>
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: as above, for pi's conversation view.
  ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;

/** The JSON values an operation puts into a view: a whole view, entries, or an entry. */
const carried = (op: Op): readonly unknown[] => {
  switch (op[0]) {
    case "r":
      return [op[1]];
    case "p":
      return op[4];
    case "s":
      return [op[2]];
    default:
      return [];
  }
};

/** The screenshots, and what stands in for them, of the entries `ops` add. */
const addedImages = (ops: readonly Op[]) =>
  ops.flatMap((op) => {
    // SAFETY: the fixtures' operations carry entries or views of them.
    const carries = carried(op) as readonly (EntryRecord | ConversationView)[];
    const entries = carries.flatMap((each) => ("docs" in each ? each.entries : [each]));

    return imagesOf(entries.flatMap((each) => each.model ?? []));
  });

describe("limiting screenshots", () => {
  it("limits a view's entries, and leaves a view within the limit as it is", () => {
    const shown = view(entry(1, result("a", "1")), entry(2, result("b", "2")));

    expect(imagesOf(limitViewImages(shown, 1).entries.flatMap((each) => each.model ?? []))).toEqual(
      ["result a", OMITTED_IMAGE, "result b", "2"],
    );
    expect(limitViewImages(shown, 2)).toBe(shown);
  });

  it("limits the entries a call's operations add together, and leaves the other operations alone", () => {
    const text: Op = [
      "a",
      ["docs", "pi.live", "generation", "message", "content", 0, "text"],
      "hi",
    ];

    const ops: Op[] = [
      // SAFETY: an entry is JSON.
      ["p", ["entries"], 0, 0, [entry(1, result("a", "1")) as never]],
      text,
      // SAFETY: as above.
      ["s", ["entries", 1], entry(2, result("b", "2", "3")) as never],
    ];

    const limited = limitOpsImages(ops, 2);

    expect(addedImages(limited)).toEqual(["result a", OMITTED_IMAGE, "result b", "2", "3"]);
    expect(limited[1]).toBe(text);
    expect(limitOpsImages(ops, 3)).toBe(ops);
  });

  it("limits a root replacement as the view it is", () => {
    // SAFETY: a view is JSON.
    const ops: Op[] = [
      ["r", view(entry(1, result("a", "1")), entry(2, result("b", "2"))) as never],
    ];

    expect(addedImages(limitOpsImages(ops, 1))).toEqual([
      "result a",
      OMITTED_IMAGE,
      "result b",
      "2",
    ]);
  });

  it("returns the messages themselves while they carry no more than the limit", () => {
    const messages = [user, result("a", "1"), result("b", "2")];

    expect(limitImages(messages, 2)).toBe(messages);
  });

  it("replaces all but the latest screenshots with a note, keeping the text", () => {
    const messages = [result("a", "1"), user, result("b", "2"), result("c", "3")];

    expect(imagesOf(limitImages(messages, 2))).toEqual([
      "result a",
      OMITTED_IMAGE,
      "result b",
      "2",
      "result c",
      "3",
    ]);
  });

  it("keeps the last screenshots of a result that holds several", () => {
    expect(imagesOf(limitImages([result("a", "1", "2", "3")], 1))).toEqual([
      "result a",
      OMITTED_IMAGE,
      OMITTED_IMAGE,
      "3",
    ]);
  });

  it("does not touch the messages it was given", () => {
    const messages = [result("a", "1"), result("b", "2")];

    limitImages(messages, 1);

    expect(imagesOf(messages)).toEqual(["result a", "1", "result b", "2"]);
  });

  it("limits entries as the messages they carry", () => {
    const entry = (id: string, model: readonly Message[] = []) => ({ id, model });

    const entries = [
      entry("e1", [user]),
      entry("e2", [result("a", "1")]),
      entry("e3"),
      entry("e4", [result("b", "2")]),
    ];

    const limited = limitEntryImages(entries, 1);

    expect(limited.map((each) => each.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(imagesOf(limited.flatMap((each) => each.model ?? []))).toEqual([
      "result a",
      OMITTED_IMAGE,
      "result b",
      "2",
    ]);
    expect(limited[0]).toBe(entries[0]);
    expect(limitEntryImages(entries, 5)).toBe(entries);
  });
});
