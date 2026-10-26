// The Diff pane's line-up worker (`line-up.ts`): one pair at a time, each answered under the ID it was asked with. A pair
// that takes jsdiff its whole 2 s budget blocks this worker, never the page.
import { lineUp, type LineUpRequest } from "./line-up.ts";

addEventListener("message", (event: MessageEvent<{ id: number; request: LineUpRequest }>) => {
  const { id, request } = event.data;

  postMessage({ id, result: lineUp(request) });
});
