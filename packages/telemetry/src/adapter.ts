// @effect-diagnostics asyncFunction:off -- pi's `TelemetryContext` takes callbacks that return promises.
// pi-telemetry → Effect `Tracer` (`docs/spec.md` → Operations → Telemetry). pi code starts spans through a
// `TelemetryContext`, passing the parent explicitly; this one makes each of them an Effect span, so pi's spans and
// Effect's (`Effect.withSpan`, `Effect.fn`) are made by one tracer and nest in one trace. Which tracer decides where
// they go: `workersTracer` sends them to Workers Observability.
import type {
  AttributeValue,
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";
import { CallerFrame, captureFrame } from "@cloudpid/effect-durable";

/** Attributes with every value defined. */
type Attributes = Record<string, AttributeValue>;

/** Record `status` on `span` as attributes: Workers tracing has no span status of its own yet. */
const markStatus = (span: Tracer.Span, status: SpanStatus): void => {
  span.attribute("error", status.status === "error");

  if (status.status === "error" && status.error !== undefined) {
    span.attribute("error.name", status.error.name);
    span.attribute("error.message", status.error.message);
  }
};

/** `attributes` without the ones left undefined, which pi-telemetry's contract has ignored. */
const defined = (attributes: SpanAttributes | undefined): Attributes =>
  Rec.filterMap(attributes ?? {}, (value) =>
    value === undefined ? Result.failVoid : Result.succeed(value),
  );

type Start = (parent: Tracer.AnySpan | undefined) => TelemetryContext["startSpan"];

/** pi's span over one Effect span; once the span has ended, recording is ignored, as pi-telemetry's contract has it. */
const piSpan = (span: Tracer.Span, clock: Clock.Clock, start: Start): TelemetrySpan => {
  const open = () => Predicate.isTagged(span.status, "Started");

  return {
    startSpan: start(span),
    addEvent: (name, attributes) => {
      if (open()) span.event(name, clock.currentTimeNanosUnsafe(), defined(attributes));
    },
    setAttributes: (attributes) => {
      if (!open()) return;

      for (const [key, value] of Rec.toEntries(defined(attributes))) span.attribute(key, value);
    },
    setStatus: (status) => {
      if (!open()) return;

      markStatus(span, status);
    },
  };
};

/**
 * A `TelemetryContext` whose spans are Effect spans made by `tracer`: pass it to pi code that takes one (pi-ai's
 * `telemetryContext`, pi-durable's `HarnessOptions.telemetry` once released). A span started from the context is a
 * root; one started from a span the context gave out is its child.
 *
 * The callback's return value and rejection come back as they are, a synchronous throw as a rejected promise, and the
 * span ends when the callback's promise settles. The callback runs in the async context of the call that started the
 * span, plus the span's own, so what it does nests under it in the backend.
 */
export const effectTelemetry = (tracer: Tracer.Tracer): TelemetryContext => {
  const services = Context.make(Tracer.Tracer, tracer);

  const start: Start =
    (parent) =>
    <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> => {
      const run = Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        const clock = yield* Clock.Clock;

        const outcome = yield* Effect.promise(async () => {
          try {
            return { rejected: false, value: await callback(piSpan(span, clock, start)) } as const;
          } catch (reason) {
            // Kept whole, so the caller gets its own rejection back, whatever it is.
            return { rejected: true, reason } as const;
          }
        });

        // A defect, for the span to end failed; it is thrown back out below as it was.
        return outcome.rejected ? yield* Effect.die(outcome.reason) : outcome.value;
      }).pipe(
        Effect.withSpan(options.name, {
          attributes: defined(options.attributes),
          ...(parent === undefined ? { root: true } : { parent }),
        }),
        Effect.provideService(CallerFrame, captureFrame()),
      );

      return Effect.runPromiseExitWith(services)(run).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;

        throw Cause.squash(exit.cause);
      });
    };

  return { startSpan: start(undefined) };
};
