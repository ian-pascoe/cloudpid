// The names a Live View is known by across the server and the web app (`./live-view.ts`).
import { describe, expect, it } from "vitest";
import { LIVE_VIEW_HANDOFF_OVER, liveViewPaneKey, liveViewPaneQuery } from "./live-view.ts";

describe("a Live View's Pane", () => {
  it("is keyed by its handoff's request", () => {
    expect(liveViewPaneKey("12")).toBe("live-view:12");
  });

  it("opens from a query the web app reads back to the same key", () => {
    expect(liveViewPaneQuery("12")).toBe("?pane=live-view:12");

    for (const requestId of ["12", "a b&c=d", "x:y/z?#%", "é"]) {
      expect(new URLSearchParams(liveViewPaneQuery(requestId)).getAll("pane")).toEqual([
        liveViewPaneKey(requestId),
      ]);
    }
  });

  it("says a handoff is over in the words a client matches", () => {
    expect(LIVE_VIEW_HANDOFF_OVER).toBe("the handoff is over");
  });
});
