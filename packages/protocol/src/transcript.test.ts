import type { EntryRecord } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import type { Annotation, PageAnnotation } from "./annotations.ts";
import { cropLabel, renderReview, reviewMessage } from "./review.ts";
import { fencePayload } from "./trigger-payload.ts";
import { projectEntry } from "./transcript.ts";
import { USER_ENTRY_KIND } from "./user-entry.ts";

const annotation: Annotation = {
  id: "a1",
  source: { kind: "changes", repo: "app", head: null },
  path: "src/a.ts",
  side: "new",
  start: 2,
  end: 3,
  quote: ["b", "c"],
  more: 0,
  text: "Why two?",
  createdAt: 1,
  updatedAt: 1,
};

/** A Review's entry, as the Session places it. */
const reviewEntry = (summary: string): EntryRecord => {
  const { markdown, data } = renderReview([annotation]);

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fields of an entry the projection reads.
  return {
    id: 7,
    kind: USER_ENTRY_KIND,
    data: { display: summary, skills: [], review: data },
    model: [
      {
        role: "user",
        content: [{ type: "text", text: reviewMessage(summary, markdown) }],
        timestamp: 9,
      },
    ],
  } as unknown as EntryRecord;
};

describe("a Review in the transcript", () => {
  it("shows its summary, with its Annotations' quotes and texts", () => {
    const message = projectEntry(reviewEntry("Have a look."));

    expect(message?.parts).toEqual([{ type: "text", text: "Have a look." }]);
    expect(message?.review).toMatchObject([
      { file: "/workspace/app/src/a.ts", start: 2, end: 3, quote: ["b", "c"], text: "Why two?" },
    ]);
  });

  it("keeps the crops the message carried out of its parts, and gives each to its page Annotation", () => {
    const crop = { mimeType: "image/jpeg" as const, data: "QUJD" };

    const page: PageAnnotation = {
      id: "p1",
      source: {
        kind: "page",
        url: "https://app.test/",
        ownerTabId: "tab-1",
        box: { x: 0, y: 0, width: 10, height: 10 },
        scroll: { x: 0, y: 0 },
        viewport: { width: 100, height: 100 },
      },
      quote: [],
      more: 0,
      crop,
      text: "This.",
      createdAt: 2,
      updatedAt: 2,
    };

    const { markdown, data } = renderReview([annotation, page]);

    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fields of an entry the projection reads.
    const entry = {
      id: 8,
      kind: USER_ENTRY_KIND,
      data: { display: "", skills: [], review: { ...data, crops: [2] } },
      model: [
        {
          role: "user",
          content: [
            { type: "text", text: markdown },
            { type: "image", mimeType: "image/png", data: "QQ==" },
            { type: "text", text: cropLabel(2) },
            { type: "image", ...crop },
          ],
          timestamp: 9,
        },
      ],
    } as unknown as EntryRecord;

    const message = projectEntry(entry);

    expect(message?.parts).toEqual([
      { type: "text", text: "Review: 2 Annotations" },
      { type: "image", mimeType: "image/png", data: "QQ==" },
    ]);
    expect(message?.review?.[1]).toMatchObject({ text: "This.", crop });
  });

  it('shows "Review: n Annotations" when it has no summary', () => {
    expect(projectEntry(reviewEntry(""))?.parts).toEqual([
      { type: "text", text: "Review: 1 Annotation" },
    ]);
  });
});

describe("App messages in the transcript", () => {
  const entryWith = (app: ReadonlyArray<object> | string, typed: string): EntryRecord =>
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fields of an entry the projection reads.
    ({
      id: 3,
      kind: USER_ENTRY_KIND,
      data: { display: typed, skills: [], app },
      model: [
        {
          role: "user",
          content: [
            { type: "text", text: typed },
            { type: "text", text: "Pick A" },
            { type: "text", text: "Pick B" },
          ],
          timestamp: 4,
        },
      ],
    }) as unknown as EntryRecord;

  it("takes each App message's part out of the typed message and carries it as `app`", () => {
    const app = [
      { callId: "c1", server: "docs", text: "Pick A" },
      { callId: "c2", server: "docs", text: "Pick B" },
    ];

    const message = projectEntry(entryWith(app, "Do it"));

    expect(message?.parts).toEqual([{ type: "text", text: "Do it" }]);
    expect(message?.app).toEqual(app);
  });

  it("keeps a typed text that equals an App message's, and reads an entry with a mark it cannot read without it", () => {
    const same = projectEntry(
      entryWith([{ callId: "c1", server: "docs", text: "Pick B" }], "Pick B"),
    );

    expect(Arr.map(same?.parts ?? [], (part) => (part.type === "text" ? part.text : ""))).toEqual([
      "Pick B",
      "Pick A",
    ]);

    expect(projectEntry(entryWith("nonsense", "Do it"))?.app).toBeUndefined();
  });
});

describe("a Trigger's webhook payload in the transcript", () => {
  const made = fencePayload({
    payload: {
      format: "github",
      event: "issues",
      action: "opened",
      delivery: "d-1",
      size: 2,
      body: "{}",
    },
    path: "/workspace/.cloudpid/triggers/t1_d-1.json",
    redact: (text) => text,
  });

  const entry = (data: { readonly triggerPayload: unknown }): EntryRecord =>
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fields of an entry the projection reads.
    ({
      id: 3,
      kind: USER_ENTRY_KIND,
      data: { display: "[cloudpid] Trigger fired.\n\nTriage it.", skills: [], ...data },
      model: [
        {
          role: "user",
          content: [
            { type: "text", text: "[cloudpid] Trigger fired.\n\nTriage it." },
            { type: "text", text: made.block },
          ],
          timestamp: 9,
        },
      ],
    }) as unknown as EntryRecord;

  it("takes its block out of the message and carries its chip data", () => {
    const message = projectEntry(entry({ triggerPayload: made.chip }));

    expect(message?.parts).toEqual([
      { type: "text", text: "[cloudpid] Trigger fired.\n\nTriage it." },
    ]);
    expect(message?.triggerPayload).toEqual(made.chip);
  });

  it("leaves the block alone in an entry whose chip it cannot read", () => {
    const message = projectEntry(entry({ triggerPayload: { format: "later" } }));

    expect(message?.parts).toHaveLength(2);
    expect(message?.triggerPayload).toBeUndefined();
  });
});
