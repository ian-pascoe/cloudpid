// Spans are Effect fibers and pi callbacks: Promise code, and Promise construction in the fake backend.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off preferEffectRecord:off
import { AsyncLocalStorage } from "node:async_hooks";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import { effectTelemetry } from "./adapter.ts";
import { workersTracer, type WorkersSpan, type WorkersTracing } from "./workers.ts";

/** A recorded native span: what the Workers runtime would hold of one. */
type Recorded = {
  readonly name: string;
  /** The span active in the async context it was started in. */
  readonly parent: Recorded | undefined;
  readonly attributes: Record<string, string | number | boolean>;
  ended: boolean;
};

/**
 * A stand-in for `tracing` from `cloudflare:workers`: a span is a child of whichever span is active in the current
 * async context, and `startActiveSpan` makes its span active for the callback only, as the runtime does.
 */
const fakeTracing = (options: { readonly traced?: boolean } = {}) => {
  const active = new AsyncLocalStorage<Recorded>();
  const recorded: Recorded[] = [];

  const tracing: WorkersTracing = {
    startActiveSpan: (name, callback) => {
      const span: Recorded = { name, parent: active.getStore(), attributes: {}, ended: false };

      recorded.push(span);

      const native: WorkersSpan = {
        isTraced: options.traced ?? true,
        setAttribute: (key, value) => {
          span.attributes[key] = value;
        },
        end: () => {
          span.ended = true;
        },
      };

      return active.run(span, () => callback(native));
    },
  };

  return { tracing, recorded, active };
};

const named = (recorded: ReadonlyArray<Recorded>, name: string): Recorded => {
  const found = recorded.find((span) => span.name === name);

  if (found === undefined) throw new Error(`No span named ${name}`);

  return found;
};

describe("workersTracer", () => {
  it("sends an Effect span to the runtime with its scalar attributes, and ends it with the effect", async () => {
    const { tracing, recorded } = fakeTracing();

    const program = Effect.void.pipe(
      Effect.withSpan("effect.work", { attributes: { count: 3, nested: { skipped: true } } }),
      Effect.provideService(Tracer.Tracer, workersTracer(tracing)),
    );

    await Effect.runPromise(program);

    const span = named(recorded, "effect.work");

    expect(span.attributes).toMatchObject({ count: 3, "effect.exit": "success" });
    expect(span.attributes).not.toHaveProperty("nested");
    expect(span.ended).toBe(true);
  });

  it("records how an effect ended", async () => {
    const { tracing, recorded } = fakeTracing();
    const tracer = workersTracer(tracing);

    await Effect.runPromiseExit(
      Effect.fail("nope").pipe(
        Effect.withSpan("effect.fails"),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );

    expect(named(recorded, "effect.fails").attributes["effect.exit"]).toBe("failure");
  });

  it("nests an Effect span made inside another under it in the runtime, as the async context says", async () => {
    const { tracing, recorded } = fakeTracing();
    const tracer = workersTracer(tracing);

    const program = Effect.gen(function* () {
      yield* Effect.sleep("1 millis");
      yield* Effect.void.pipe(Effect.withSpan("inner"));
    }).pipe(Effect.withSpan("outer"), Effect.provideService(Tracer.Tracer, tracer));

    await Effect.runPromise(program);

    expect(named(recorded, "inner").parent).toBe(named(recorded, "outer"));
    expect(named(recorded, "outer").parent).toBeUndefined();
  });

  it("puts what a pi callback does under its span: a pi span's child and an Effect span both nest in it", async () => {
    const { tracing, recorded } = fakeTracing();
    const tracer = workersTracer(tracing);
    const telemetry = effectTelemetry(tracer);

    await telemetry.startSpan({ name: "pi.tool" }, async (span) => {
      await Effect.runPromise(Effect.sleep("1 millis"));
      await span.startSpan({ name: "pi.child" }, async () => undefined);
      await Effect.runPromise(
        Effect.void.pipe(
          Effect.withSpan("effect.inside"),
          Effect.provideService(Tracer.Tracer, tracer),
        ),
      );
    });

    expect(named(recorded, "pi.child").parent).toBe(named(recorded, "pi.tool"));
    // An Effect fiber started from the callback runs in the callback's async context, so it nests there too.
    expect(named(recorded, "effect.inside").parent).toBe(named(recorded, "pi.tool"));
  });

  it("starts a root pi span under the span active where it was called, not where a scheduler ran it", async () => {
    const { tracing, recorded } = fakeTracing();
    const telemetry = effectTelemetry(workersTracer(tracing));
    const request = tracing.startActiveSpan("request", (native) => native);

    expect(request.isTraced).toBe(true);

    // Called in the async context of an outer native span, as a Harness phase is called in a request's.
    await tracing.startActiveSpan("invocation", () =>
      telemetry.startSpan({ name: "pi.ai.request" }, async () => undefined),
    );

    expect(named(recorded, "pi.ai.request").parent).toBe(named(recorded, "invocation"));
  });

  it("starts a child under an explicit parent whichever context it is called from", async () => {
    const { tracing, recorded } = fakeTracing();
    const telemetry = effectTelemetry(workersTracer(tracing));
    let parent!: { startSpan: typeof telemetry.startSpan };

    await telemetry.startSpan({ name: "parent" }, async (span) => {
      parent = span;
    });

    // The parent's callback is over, and the call is made outside its async context.
    await parent.startSpan({ name: "late.child" }, async () => undefined);

    expect(named(recorded, "late.child").parent).toBe(named(recorded, "parent"));
  });

  it("keeps spans in Effect when the runtime is not tracing the invocation, and stops asking it", async () => {
    const { tracing, recorded } = fakeTracing({ traced: false });
    const tracer = workersTracer(tracing);

    await Effect.runPromise(
      Effect.void.pipe(
        Effect.withSpan("outer"),
        Effect.withSpan("wrapper"),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );

    // The first span asked once and learned the invocation is untraced; its descendants are unsampled.
    expect(recorded.map((span) => span.name)).toEqual(["wrapper"]);
  });

  it("works with no runtime tracing API, as under an old local workerd", async () => {
    const tracer = workersTracer(undefined);

    const exit = await Effect.runPromiseExit(
      Effect.succeed(1).pipe(Effect.withSpan("x"), Effect.provideService(Tracer.Tracer, tracer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("forwards a span's events as attributes, since the runtime has none", async () => {
    const { tracing, recorded } = fakeTracing();
    const telemetry = effectTelemetry(workersTracer(tracing));

    await telemetry.startSpan({ name: "pi.ai.request" }, async (span) => {
      span.addEvent("pi.ai.first_chunk");
      span.setStatus({ status: "error", error: { name: "provider_error", message: "overloaded" } });
    });

    const { attributes } = named(recorded, "pi.ai.request");

    expect(attributes["event.pi.ai.first_chunk"]).toEqual(expect.any(Number));
    expect(attributes).toMatchObject({ error: true, "error.name": "provider_error" });
  });

  it("adds no attribute for a log made inside a span, whatever the message carries", async () => {
    const { tracing, recorded } = fakeTracing();
    const tracer = workersTracer(tracing);

    await Effect.runPromise(
      Effect.gen(function* () {
        // Effect's tracer logger turns each of these into an event of the current span, named by the message.
        yield* Effect.logWarning(
          "Session command submit failed",
          new Error("bad request: secret-ish text"),
        );
        yield* Effect.logInfo("Session title request", { model: "anthropic/x", cost: 0.01 });
        yield* Effect.log("x".repeat(500));
      }).pipe(Effect.withSpan("session.message"), Effect.provideService(Tracer.Tracer, tracer)),
    );

    const keys = Object.keys(named(recorded, "session.message").attributes);

    expect(keys.filter((key) => key.startsWith("event."))).toEqual([]);
    expect(JSON.stringify(keys)).not.toContain("secret-ish");
  });
});
