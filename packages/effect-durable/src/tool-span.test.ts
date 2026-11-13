// docs/architecture/operations.md → Telemetry. A Session's list of its running calls' spans: a tool's counts reach the span
// its call is listed under in that Session's list, never another Session's with the same call ID, and nothing once the call
// is over.
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import {
  annotateToolSpan,
  makeToolSpans,
  type ToolSpanAttributes,
  ToolSpans,
} from "./tool-span.ts";

describe("a Session's tool spans", () => {
  it("annotate the listed span of the call in this Session only, while it runs", () => {
    const mine = makeToolSpans();
    const forked = makeToolSpans();
    const seen: ToolSpanAttributes[] = [];
    const unlist = mine.list("call-1", (attributes) => seen.push(attributes));

    Effect.runSync(
      annotateToolSpan("call-1", { "visual.bytes": 10 }).pipe(
        Effect.provideService(ToolSpans, mine),
      ),
    );
    // A Fork's list holds the same call ID: nothing it is told reaches this Session's span.
    Effect.runSync(
      annotateToolSpan("call-1", { "visual.bytes": 99 }).pipe(
        Effect.provideService(ToolSpans, forked),
      ),
    );
    unlist();
    mine.annotate("call-1", { "visual.bytes": 7 });

    expect(seen).toEqual([{ "visual.bytes": 10 }]);
  });

  it("keep a newer listing of the same call when an older one is taken off", () => {
    const spans = makeToolSpans();
    const seen: string[] = [];
    const first = spans.list("c", () => seen.push("first"));

    spans.list("c", () => seen.push("second"));
    first();
    spans.annotate("c", {});

    expect(seen).toEqual(["second"]);
  });
});
