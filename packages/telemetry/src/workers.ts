// An Effect `Tracer` over Workers tracing (`docs/spec.md` → Operations → Telemetry): each Effect span, and so each pi
// span the adapter makes, is a custom span of Workers Observability (`tracing` from `cloudflare:workers`), nested
// among the runtime's own spans for fetches, bindings and RPC.
//
// It follows alchemy's `Cloudflare.Telemetry()` tracer, which is built per event and so cannot serve the Session DO's
// long-lived services. Workers nests a span under whichever span is active in the async context, and has no way to name
// a parent, so a span keeps the async context it was started in (`Frame`) and its descendants, and the fibers running
// inside it, run in that. `tracing` is module-global (it works anywhere in an invocation), so one tracer serves the
// object's lifetime.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Tracer from "effect/Tracer";
import { CallerFrame, captureFrame, type Frame } from "./frame.ts";

/** The parts of a `cloudflare:workers` `Span` the tracer uses. */
export type WorkersSpan = {
  /** False when the invocation is not sampled: nothing is recorded. */
  readonly isTraced: boolean;
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
};

/** The parts of `tracing` from `cloudflare:workers` the tracer uses. */
export type WorkersTracing = {
  startActiveSpan<T>(name: string, callback: (span: WorkersSpan) => T): T;
};

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0];

const evaluate = "~effect/Effect/evaluate";

/** How the effect ended, as an attribute value. */
const exitKind = (exit: Exit.Exit<unknown, unknown>): "success" | "interrupted" | "failure" => {
  if (Exit.isSuccess(exit)) return "success";

  return Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure";
};

/** An Effect span that also lives in the runtime, and the async context it was started in. */
class WorkersEffectSpan extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    readonly frame: Frame,
    readonly native: WorkersSpan | undefined,
  ) {
    // An untraced invocation, or a runtime without the API, makes the span unsampled, so its descendants do not ask.
    super({ ...options, sampled: options.sampled && (native?.isTraced ?? false) });
  }

  override attribute(...[key, value]: Parameters<Tracer.Span["attribute"]>): void {
    super.attribute(key, value);

    if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      this.native?.setAttribute(key, value);
    }
  }

  /** The runtime has no events: the first of each name is kept as the milliseconds since the span started. */
  override event(...[name, startTime, attributes]: Parameters<Tracer.Span["event"]>): void {
    super.event(name, startTime, attributes);

    this.native?.setAttribute(`event.${name}`, Number(startTime - this.startTime) / 1_000_000);
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);

    if (this.native === undefined) return;

    this.native.setAttribute("effect.exit", exitKind(exit));
    this.native.end();
  }
}

/** The frame of the nearest span of this tracer at or above `span`. */
const frameOf = (span: Tracer.AnySpan | undefined): Frame | undefined => {
  let current = span;

  while (current?._tag === "Span") {
    if (current instanceof WorkersEffectSpan) return current.frame;

    current = Option.getOrUndefined(current.parent);
  }

  return undefined;
};

/**
 * The Effect tracer for Workers Observability. `tracing` is `cloudflare:workers`'s; leave it out where the runtime has
 * none (an old local workerd), and spans stay in Effect.
 */
export const workersTracer = (tracing: WorkersTracing | undefined): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      if (!options.sampled || tracing === undefined) {
        return new WorkersEffectSpan(options, captureFrame(), undefined);
      }

      // Under its parent's native span, or where the fiber is already running: the call's own context.
      const parentFrame = frameOf(options.parent.pipe(Option.getOrUndefined));

      const start = () =>
        tracing.startActiveSpan(
          options.name,
          (native) => new WorkersEffectSpan(options, captureFrame(), native),
        );

      return options.root || parentFrame === undefined ? start() : parentFrame(start);
    },
    context(primitive, fiber) {
      const frame = frameOf(fiber.cache.span) ?? Context.get(fiber.context, CallerFrame);

      if (frame === undefined) return primitive[evaluate](fiber);

      return frame(() => primitive[evaluate](fiber));
    },
  });
