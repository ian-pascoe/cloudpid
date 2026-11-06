// docs/architecture/visuals.md → The copy (Revisions), The frame (Height), Testing. What a thread's Visuals come to without
// a DOM: which are superseded by a newer one of the same file, worked out from the transcript; the height a frame fits and
// the guard that freezes a page that climbs; the heights a device remembers; a page's answer checked before it is framed; and
// the thread's width the guidance tells the agent, held to the layout's classes.
// @effect-diagnostics preferEffectArray:off nodeBuiltinImport:off -- a transcript in native lists, and the layout's source read as text.
import { readFileSync } from "node:fs";
import {
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
  VISUAL_THREAD_WIDTH,
  type TranscriptMessage,
  type VisualEntry,
  type VisualRecord,
} from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { loadOf } from "./atoms.ts";
import {
  fitHeight,
  GROWTH_WINDOW_MS,
  GUARD_START,
  guardReport,
  MAX_REMEMBERED_HEIGHTS,
  rememberedHeight,
  withHeight,
  type GrowthGuard,
} from "./height.ts";
import { shouldMount } from "./lazy.ts";
import { NO_SUPERSEDED, supersededIn, visualEntryOf, visualsOfScript } from "./visuals.ts";

const entry = (callId: string, more: Partial<VisualEntry> = {}): VisualEntry => ({
  callId,
  title: callId,
  summary: `What ${callId} shows`,
  source: { kind: "path", path: "/workspace/v.html" },
  state: "kept",
  bytes: 10,
  at: 1,
  ...more,
});

const assistant = (...calls: string[]): Pick<TranscriptMessage, "parts"> => ({
  parts: calls.map((id) => ({ type: "tool-call", id, name: "visual_show", arguments: {} })),
});

describe("which Visuals of a thread are superseded", () => {
  it("collapses each earlier Visual of a file to the next one shown from it, in the transcript's order", () => {
    const entries = [
      entry("c"),
      entry("a"),
      entry("b", { source: { kind: "path", path: "/workspace/other.html" } }),
    ];

    expect(supersededIn([assistant("a"), assistant("b", "c")], entries)).toEqual(
      new Map([["a", "c"]]),
    );
  });

  it("places a script's Visuals by its call, then by when each was shown", () => {
    const entries = [
      entry("n2", { parentCall: "s", at: 5 }),
      entry("n1", { parentCall: "s", at: 2 }),
    ];

    expect(supersededIn([assistant("s")], entries)).toEqual(new Map([["n1", "n2"]]));
  });

  it("supersedes nothing with an inline page, or with a call the transcript does not hold", () => {
    expect(
      supersededIn(
        [assistant("a", "b")],
        [entry("a", { source: { kind: "inline" } }), entry("b", { source: { kind: "inline" } })],
      ),
    ).toBe(NO_SUPERSEDED);
    expect(supersededIn([assistant("a")], [entry("a"), entry("elsewhere")])).toBe(NO_SUPERSEDED);
  });

  it("finds a call's Visual in any conversation, and a script's", () => {
    const visuals = { "1": [entry("a")], "2": [entry("b", { parentCall: "s" })] };

    expect(visualEntryOf(visuals, "b")?.callId).toBe("b");
    expect(visualEntryOf(visuals, "none")).toBeUndefined();
    expect(visualsOfScript([entry("a"), entry("b", { parentCall: "s" })], "s")).toHaveLength(1);
  });
});

describe("a Visual's height", () => {
  it("fits its content from 160 px to 20,000 px", () => {
    expect(fitHeight(10)).toBe(VISUAL_MIN_HEIGHT);
    expect(fitHeight(480.2)).toBe(481);
    expect(fitHeight(1e6)).toBe(VISUAL_MAX_HEIGHT);
  });

  const reports = (heights: ReadonlyArray<number>, every = 50) => {
    let guard: GrowthGuard = GUARD_START;
    const set: Array<number | undefined> = [];

    heights.forEach((height, index) => {
      const step = guardReport(guard, height, index * every);

      guard = step.guard;
      set.push(step.height);
    });

    return { guard, set };
  };

  it("freezes a page that grows after each of 3 host resizes in a row, by any amount", () => {
    const steady = reports([400, 420, 440, 460, 480]);

    expect(steady.guard.frozen).toBe(true);
    expect(steady.set).toEqual([400, 420, 440, 440, 440]);

    // A page sized by its frame in proportion (10% more each time) climbs as surely as one that adds a fixed step.
    const proportional = reports([400, 440, 484, 533, 587]);

    expect(proportional.guard.frozen).toBe(true);
    expect(proportional.set).toEqual([400, 440, 484, 484, 484]);
  });

  it("does not freeze a page that loads in stages, or that shrinks between growths", () => {
    // A font, a chart, then an image, each a few hundred milliseconds after the last.
    expect(reports([300, 340, 900, 1300], 300).guard.frozen).toBe(false);
    expect(reports([300, 340, 900, 1300], 500).guard.frozen).toBe(false);
    expect(reports([400, 420, 440, 460], GROWTH_WINDOW_MS + 1).guard.frozen).toBe(false);
    expect(reports([400, 420, 410, 430, 450]).guard.frozen).toBe(false);
  });

  it("is remembered on this device, the Visual shown last first, within a bound", () => {
    let heights = withHeight([], "a", 300);

    heights = withHeight(heights, "b", 500);
    heights = withHeight(heights, "a", 320);
    expect(heights).toEqual([
      ["a", 320],
      ["b", 500],
    ]);
    expect(rememberedHeight(heights, "b")).toBe(500);
    expect(withHeight(heights, "a", 320)).toBe(heights);

    for (let index = 0; index < MAX_REMEMBERED_HEIGHTS + 5; index++) {
      heights = withHeight(heights, `v${index}`, index);
    }

    expect(heights).toHaveLength(MAX_REMEMBERED_HEIGHTS);
  });
});

describe("lazy mounting", () => {
  it("mounts near the viewport, and keeps a frame that has the focus", () => {
    expect(shouldMount(true, false)).toBe(true);
    expect(shouldMount(false, true)).toBe(true);
    expect(shouldMount(false, false)).toBe(false);
  });
});

describe("a Visual's page as the Session answers it", () => {
  const record: VisualRecord = {
    callId: "c1",
    conversation: "1",
    title: "Sales",
    summary: "Sales by month",
    source: { kind: "inline" },
    html: "<p>hi</p>",
    bytes: 9,
    warnings: [],
    at: 1,
  };

  const page = "https://app.example";
  const sandbox = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";

  it("is framed only at an App sandbox origin", () => {
    expect(loadOf({ status: "page", record, origin: sandbox }, page)).toEqual({
      status: "page",
      record,
      origin: sandbox,
    });
    expect(loadOf({ status: "page", record, origin: "https://evil.example" }, page)).toMatchObject({
      status: "failed",
    });
    expect(loadOf({ status: "page", record }, page)).toMatchObject({ status: "failed" });
  });

  it("reads an evicted Visual's stub, and a status it does not know as none", () => {
    const { html: _html, warnings: _warnings, ...stub } = record;

    expect(loadOf({ status: "evicted", stub }, page)).toEqual({ status: "evicted", stub });
    expect(loadOf({ status: "gone" }, page)).toEqual({ status: "none" });
  });
});

describe("the thread's width the guidance names", () => {
  it("is the transcript column's: max-w-3xl (48rem) less px-4 on both sides", () => {
    const thread = readFileSync(new URL("../chat/thread.tsx", import.meta.url), "utf8");

    expect(thread).toContain('"mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6"');
    expect(48 * 16 - 2 * 16).toBe(VISUAL_THREAD_WIDTH);
  });
});
