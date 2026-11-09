// The names a Live View is known by across the server and the web app (`./live-view.ts`).
import { expect, it } from "vitest";
import { liveViewPaneKey, liveViewPaneQuery } from "./live-view.ts";

it("opens a Live View's Pane from a query the web app reads back to the same key", () => {
  for (const requestId of ["12", "a b&c=d", "x:y/z?#%", "é"]) {
    expect(new URLSearchParams(liveViewPaneQuery(requestId)).getAll("pane")).toEqual([
      liveViewPaneKey(requestId),
    ]);
  }
});
