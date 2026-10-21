import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { effectTelemetry } from "./adapter.ts";
import { workersTracer, type WorkersTracing } from "./workers.ts";

export type TelemetryService = {
  /** The Effect tracer every span of the object is made by. */
  readonly tracer: Tracer.Tracer;
  /** pi's view of it: pass it to pi code that takes a `TelemetryContext`. */
  readonly context: TelemetryContext;
};

/** The object's telemetry: one tracer, seen by Effect as its `Tracer` and by pi as a `TelemetryContext`. */
export class Telemetry extends Context.Service<Telemetry, TelemetryService>()(
  "@cloudpid/telemetry/service/Telemetry",
) {}

/** Telemetry over `tracer`. */
export const telemetryService = (tracer: Tracer.Tracer): TelemetryService => ({
  tracer,
  context: effectTelemetry(tracer),
});

/** `service` as the `Telemetry` service, and its tracer as Effect's `Tracer`, so every Effect run with the layer's services makes its spans there. */
export const telemetryLayer = (service: TelemetryService): Layer.Layer<Telemetry> =>
  Layer.merge(Layer.succeed(Telemetry, service), Layer.succeed(Tracer.Tracer, service.tracer));

/**
 * The telemetry of a Durable Object over Workers Observability. `tracing` is `cloudflare:workers`'s; undefined keeps spans
 * in Effect.
 */
export const workersTelemetry = (tracing: WorkersTracing | undefined): TelemetryService =>
  telemetryService(workersTracer(tracing));
