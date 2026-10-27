import { describe, expect, it } from "vitest";
import { INITIAL_PANE_UI, reducePaneUi, withTarget } from "./pane-ui.ts";

describe("the Diff pane's own state", () => {
  it("opens the file it is asked to show and holds the scroll there until the owner scrolls", () => {
    const folded = reducePaneUi(INITIAL_PANE_UI, { type: "fold", id: "web/a.ts", folded: true });
    const asked = withTarget(folded, { file: "web/a.ts", at: 1 });

    expect(asked.overrides.get("web/a.ts")).toBe(false);
    expect(asked.anchor).toEqual({ file: "web/a.ts", at: 1 });
    expect(reducePaneUi(asked, { type: "release" }).anchor).toBeNull();
  });

  it("keeps the folds when asked for the top, and collapse all folds every file", () => {
    const opened = reducePaneUi(INITIAL_PANE_UI, { type: "fold", id: "web/a.ts", folded: false });

    expect(withTarget(opened, { file: null, at: 2 }).overrides).toBe(opened.overrides);
    expect(
      reducePaneUi(opened, { type: "collapse-all", ids: ["web/a.ts", "web/b.ts"] }).overrides,
    ).toEqual(
      new Map([
        ["web/a.ts", true],
        ["web/b.ts", true],
      ]),
    );
  });

  it("forgets what the owner did to one file, and leaves the others", () => {
    const both = reducePaneUi(
      reducePaneUi(INITIAL_PANE_UI, { type: "fold", id: "a", folded: false }),
      { type: "fold", id: "b", folded: true },
    );

    expect(reducePaneUi(both, { type: "forget", id: "a" }).overrides).toEqual(
      new Map([["b", true]]),
    );
    expect(both.overrides.has("a")).toBe(true);
  });

  it("the Pane's own file list shows a file as a place asked for", () => {
    expect(
      reducePaneUi(INITIAL_PANE_UI, { type: "show", target: { file: "web/b.ts", at: 3 } }),
    ).toEqual(withTarget(INITIAL_PANE_UI, { file: "web/b.ts", at: 3 }));
  });
});
