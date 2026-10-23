import { describe, expect, it } from "vitest";
import { selectWindow, stripOf, windowClosed, type WindowStrip } from "./windows.ts";

const tab = { targetId: "T", link: "wss://x/T" };

const win = (targetId: string, openerId = "T", title = targetId) => ({
  targetId,
  openerId,
  title,
  link: `wss://x/${targetId}`,
});

describe("the window strip", () => {
  it("shows the handed-over tab when the Live View opens", () => {
    const strip = stripOf({ tab, windows: [win("A")] }, undefined);

    expect(strip.shown).toBe("T");
    expect(strip.windows.map((each) => each.targetId)).toEqual(["A"]);
  });

  it("switches to a window when one opens", () => {
    const opened = stripOf({ tab, windows: [] }, undefined);

    expect(stripOf({ tab, windows: [win("A")] }, opened).shown).toBe("A");
  });

  it("switches to the newest of several windows that opened at once", () => {
    const opened = stripOf({ tab, windows: [] }, undefined);

    expect(stripOf({ tab, windows: [win("A"), win("B", "A")] }, opened).shown).toBe("B");
  });

  it("keeps the window shown when the windows are read again and nothing opened", () => {
    const strip: WindowStrip = { tab: "T", windows: [win("A"), win("B")], shown: "A" };

    expect(stripOf({ tab, windows: [win("A"), win("B")] }, strip).shown).toBe("A");
  });

  it("goes back to the window's opener when it closes", () => {
    const strip: WindowStrip = { tab: "T", windows: [win("A"), win("B", "A")], shown: "B" };

    const closed = windowClosed(strip, "B");

    expect(closed.shown).toBe("A");
    expect(closed.windows.map((each) => each.targetId)).toEqual(["A"]);
  });

  it("goes back past openers that closed too, to the tab at last", () => {
    const strip: WindowStrip = { tab: "T", windows: [win("A"), win("B", "A")], shown: "B" };

    // Both closed while the Live View was away: the next reading has neither.
    expect(stripOf({ tab, windows: [] }, strip).shown).toBe("T");
    expect(windowClosed(windowClosed(strip, "A"), "B").shown).toBe("T");
  });

  it("leaves the shown window alone when another one closes", () => {
    const strip: WindowStrip = { tab: "T", windows: [win("A"), win("B")], shown: "A" };

    expect(windowClosed(strip, "B").shown).toBe("A");
  });

  it("switches to a window or the tab the owner picks, and ignores one it does not know", () => {
    const strip: WindowStrip = { tab: "T", windows: [win("A")], shown: "A" };

    expect(selectWindow(strip, "T").shown).toBe("T");
    expect(selectWindow(strip, "Z")).toBe(strip);
  });

  it("keeps titles fresh from each reading", () => {
    const strip = stripOf({ tab, windows: [win("A", "T", "Loading")] }, undefined);

    expect(stripOf({ tab, windows: [win("A", "T", "Sign in")] }, strip).windows[0]?.title).toBe(
      "Sign in",
    );
  });
});
