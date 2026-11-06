// docs/architecture/operations.md → Telemetry; docs/architecture/visuals.md → Telemetry. A tool's own counts on its call's
// `pi.tool.<name>` span. The span is made by the tracing wrap around the tool (`@cloudpid/telemetry`'s `tracingTools`), which
// a tool never sees, so the wrap lists its span by the call's ID while the call runs, and a tool adds fixed values and counts
// to it by that ID (never content: a span carries no arguments, results, text or hosts).
//
// The list is a Session's own (`makeToolSpans`): each Session object makes one, hands it to its tracing wrap and gives it to
// its tools as `ToolSpans`, so a call is found by its Session and its ID together. A Fork reuses its source's call IDs, and
// one isolate may host several Sessions; a list shared by the isolate would let one Session's call annotate another's span.
// A call whose tools are not traced (a test's) has no span listed, and its attributes go nowhere.
// @effect-diagnostics missingPipeableSignature:off -- a registry of plain functions.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** An attribute's value on a span: a fixed value or a count. */
export type ToolSpanValue = string | number | boolean;

export type ToolSpanAttributes = Readonly<Record<string, ToolSpanValue>>;

type Annotate = (attributes: ToolSpanAttributes) => void;

/** One Session's spans of the calls running now, by call ID. */
export interface ToolSpanRegistry {
  /** List the span of call `callId` while it runs; the returned function takes it off the list. */
  readonly list: (callId: string, annotate: Annotate) => () => void;
  /** Add `attributes` to the span of call `callId`, if its call is traced. */
  readonly annotate: (callId: string, attributes: ToolSpanAttributes) => void;
}

/** A Session's list of the spans of its running calls: one per Session object. */
export const makeToolSpans = (): ToolSpanRegistry => {
  const spans = new Map<string, Annotate>();

  return {
    list: (callId, annotate) => {
      spans.set(callId, annotate);

      return () => {
        if (spans.get(callId) === annotate) spans.delete(callId);
      };
    },
    annotate: (callId, attributes) => {
      spans.get(callId)?.(attributes);
    },
  };
};

/** The Session's spans of its running calls, as its tools reach them. */
export class ToolSpans extends Context.Service<ToolSpans, ToolSpanRegistry>()(
  "@cloudpid/effect-durable/tool-span/ToolSpans",
) {}

/** `ToolSpans` that list nothing: for a Session whose tools are not traced. */
export const noToolSpans: Layer.Layer<ToolSpans> = Layer.sync(ToolSpans, makeToolSpans);

/** Add `attributes` to the span of call `callId` of this Session, if its call is traced. */
export const annotateToolSpan = (
  callId: string,
  attributes: ToolSpanAttributes,
): Effect.Effect<void, never, ToolSpans> =>
  Effect.flatMap(Effect.service(ToolSpans), (spans) =>
    Effect.sync(() => {
      spans.annotate(callId, attributes);
    }),
  );
