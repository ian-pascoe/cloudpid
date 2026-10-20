// @effect-diagnostics preferEffectArray:off -- plain arrays of pi's messages.
// Bounding the screenshots a request and a snapshot carry.
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { limitEntryImages, limitEventImages, limitImages, OMITTED_IMAGE } from "./images.ts";

// SAFETY: a fixture holds only the fields the limit reads; the other fields of pi's event are never looked at.
const asEvent = (event: { readonly type: string; readonly entries?: unknown }): AgentEvent =>
  event as AgentEvent;

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

describe("limiting screenshots", () => {
  it("limits a snapshot in a batch of events, and leaves the other events alone", () => {
    const snapshot = asEvent({
      type: "snapshot",
      entries: [
        { id: "e1", model: [result("a", "1")] },
        { id: "e2", model: [result("b", "2")] },
      ],
    });

    const other = asEvent({ type: "turn_start" });
    const [limited, same] = limitEventImages([snapshot, other], 1);

    expect(same).toBe(other);
    expect(
      limited?.type === "snapshot" ? imagesOf(limited.entries.flatMap((e) => e.model ?? [])) : [],
    ).toEqual(["result a", OMITTED_IMAGE, "result b", "2"]);
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

  it("limits the entries of a snapshot as the messages they carry", () => {
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
