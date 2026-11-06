// docs/architecture/operations.md → Telemetry; docs/architecture/visuals.md → Telemetry. A tool's own counts on its call's
// `pi.tool.<name>` span. The span is made by the tracing wrap around the tool (`@cloudpid/telemetry`'s `tracingTools`), which
// a tool never sees, so the wrap lists its span by the call's ID while the call runs, and a tool adds fixed values and counts
// to it by that ID (never content: a span carries no arguments, results, text or hosts). A call whose tools are not traced
// (a test's) has no span listed, and its attributes go nowhere.
// @effect-diagnostics missingPipeableSignature:off -- a registry of plain functions.
import * as Effect from "effect/Effect";

/** An attribute's value on a span: a fixed value or a count. */
export type ToolSpanValue = string | number | boolean;

type Annotate = (attributes: Readonly<Record<string, ToolSpanValue>>) => void;

/** The spans of the calls running now, by call ID. */
const spans = new Map<string, Annotate>();

/** List the span of call `callId` while it runs; the returned function takes it off the list. */
export const listToolSpan = (callId: string, annotate: Annotate): (() => void) => {
  spans.set(callId, annotate);

  return () => {
    if (spans.get(callId) === annotate) spans.delete(callId);
  };
};

/** Add `attributes` to the span of call `callId`, if its call is traced. */
export const annotateToolSpan = (
  callId: string,
  attributes: Readonly<Record<string, ToolSpanValue>>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    spans.get(callId)?.(attributes);
  });
