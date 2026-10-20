// @effect-diagnostics globalDate:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import { queueAdapter, textOf, UNKNOWN_QUEUED_TEXT } from "./queue-adapter.ts";

interface TextPart {
  readonly type: "text";
  readonly text: string;
}

interface ImagePart {
  readonly type: "image";
  readonly image: string;
}

const message = (...content: Array<TextPart | ImagePart>): AppendMessage => ({
  role: "user",
  content,
  attachments: [],
  metadata: { custom: {} },
  createdAt: new Date(0),
  parentId: null,
  sourceId: null,
  runConfig: undefined,
});

const text = (value: string): TextPart => ({ type: "text", text: value });

describe("the queue adapter", () => {
  it("sends the steer lane as steers and the queue lane as follow-ups", () => {
    const submit = vi.fn();
    const adapter = queueAdapter({ submit }, { steer: [], followUp: [] });

    adapter.steer(message(text("change course")));
    adapter.enqueue(message(text("then do this")));

    expect(submit.mock.calls).toEqual([
      ["change course", "steer"],
      ["then do this", "followUp"],
    ]);
  });

  it("lists the inbox's lanes, with the text this page sent and a stand-in for the rest", () => {
    const adapter = queueAdapter(
      { submit: vi.fn() },
      {
        steer: [{ id: "a", text: "now" }],
        followUp: [
          { id: "b", text: "later" },
          { id: "c", text: null },
        ],
      },
    );

    expect(adapter.steerItems.map((item) => [item.id, item.prompt])).toEqual([["a", "now"]]);
    expect(adapter.items.map((item) => [item.id, item.prompt])).toEqual([
      ["b", "later"],
      ["c", UNKNOWN_QUEUED_TEXT],
    ]);
    expect(adapter.items[0]?.parts).toEqual([{ type: "text", text: "later" }]);
  });

  it("reads the text of a message, ignoring parts that are not text", () => {
    const mixed = message(text("a"), { type: "image", image: "data:" }, text("b"));

    expect(textOf(mixed)).toBe("a\nb");
  });
});
