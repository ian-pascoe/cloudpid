// The adapter is Promise code: pi's `TelemetryContext` takes callbacks that return promises.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off preferEffectRecord:off
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import { effectTelemetry } from "./adapter.ts";

/** A tracer that keeps every span it makes, as Effect's own `NativeSpan`s, in creation order. */
const recordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];

  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);

      spans.push(span);

      return span;
    },
  });

  return { spans, tracer };
};

const parentOf = (span: Tracer.NativeSpan): string | undefined =>
  Option.getOrUndefined(Option.map(span.parent, (parent) => parent.spanId));

describe("effectTelemetry", () => {
  it("records a pi span as an Effect span with its attributes and ends it with the callback's value", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    const value = await telemetry.startSpan(
      { name: "pi.ai.request", attributes: { provider: "anthropic", "usage.input": 12 } },
      async (span) => {
        span.setAttributes({ "usage.output": 3, ignored: undefined });

        return "answer";
      },
    );

    expect(value).toBe("answer");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("pi.ai.request");
    expect(Object.fromEntries(spans[0]!.attributes)).toEqual({
      provider: "anthropic",
      "usage.input": 12,
      "usage.output": 3,
    });
    expect(spans[0]?.status._tag).toBe("Ended");
  });

  it("nests a span started from another under it, in one trace", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    await telemetry.startSpan({ name: "outer" }, (outer) =>
      outer.startSpan({ name: "inner" }, async () => undefined),
    );

    expect(spans.map((span) => span.name)).toEqual(["outer", "inner"]);
    expect(parentOf(spans[1]!)).toBe(spans[0]!.spanId);
    expect(spans[1]!.traceId).toBe(spans[0]!.traceId);
  });

  it("makes spans started from the root separate traces", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    await telemetry.startSpan({ name: "first" }, async () => undefined);
    await telemetry.startSpan({ name: "second" }, async () => undefined);

    expect(parentOf(spans[0]!)).toBeUndefined();
    expect(parentOf(spans[1]!)).toBeUndefined();
    expect(spans[0]!.traceId).not.toBe(spans[1]!.traceId);
  });

  it("nests Effect spans made inside a pi span under it", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    await telemetry.startSpan({ name: "pi.tool" }, (span) =>
      span.startSpan({ name: "pi.child" }, async () => undefined),
    );

    const child = Effect.void.pipe(
      Effect.withSpan("effect.child", { parent: spans[0]! }),
      Effect.provideService(Tracer.Tracer, tracer),
    );

    await Effect.runPromise(child);

    expect(spans.map((span) => span.name)).toEqual(["pi.tool", "pi.child", "effect.child"]);
    expect(parentOf(spans[2]!)).toBe(spans[0]!.spanId);
  });

  it("rejects with the callback's own rejection, and marks the span failed", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);
    const failure = new Error("provider down");

    await expect(
      telemetry.startSpan({ name: "pi.ai.request" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const { status } = spans[0]!;

    expect(Predicate.isTagged(status, "Ended") && Exit.isFailure(status.exit)).toBe(true);
  });

  it("rejects with a synchronous throw, as a promise", async () => {
    const { tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);
    const failure = new Error("sync");

    await expect(
      telemetry.startSpan({ name: "pi.sync" }, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("keeps the span open until a returned promise settles, and ignores calls after", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);
    let release!: () => void;
    let late!: { setAttributes(attributes: Record<string, string>): void };

    const pending = telemetry.startSpan({ name: "pi.long" }, (span) => {
      late = span;

      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    await Promise.resolve();
    expect(spans[0]?.status._tag).toBe("Started");

    release();
    await pending;
    expect(spans[0]?.status._tag).toBe("Ended");

    late.setAttributes({ after: "end" });
    expect(spans[0]?.attributes.has("after")).toBe(false);
  });

  it("records an error status as attributes the backend can show, and an explicit ok as none", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    await telemetry.startSpan({ name: "pi.ai.request" }, async (span) => {
      span.setStatus({ status: "error", error: { name: "provider_error", message: "overloaded" } });
    });

    expect(Object.fromEntries(spans[0]!.attributes)).toMatchObject({
      error: true,
      "error.name": "provider_error",
      "error.message": "overloaded",
    });

    await telemetry.startSpan({ name: "pi.ok" }, async (span) => {
      span.setStatus({ status: "error", error: { name: "x", message: "y" } });
      span.setStatus({ status: "ok" });
    });

    expect(spans[1]!.attributes.get("error")).toBe(false);
  });

  it("records events as events on the span", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    await telemetry.startSpan({ name: "pi.ai.request" }, async (span) => {
      span.addEvent("pi.ai.first_chunk", { chars: 4 });
    });

    expect(spans[0]!.events.map(([name]) => name)).toEqual(["pi.ai.first_chunk"]);
  });

  it("links a span to the spans it names, at its start and later, settled or not", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    const first = await telemetry.startSpan({ name: "pi.first" }, async (span) => span);

    await telemetry.startSpan({ name: "pi.running" }, (running) =>
      telemetry.startSpan(
        {
          name: "pi.linked",
          links: [{ context: first, attributes: { why: "input", no: undefined } }],
        },
        async (span) => {
          span.addLink({ context: running });
        },
      ),
    );

    const linked = spans[2]!;

    expect(linked.links.map((link) => link.span.spanId)).toEqual([
      spans[0]!.spanId,
      spans[1]!.spanId,
    ]);
    expect(linked.links[0]?.attributes).toEqual({ why: "input" });
    expect(linked.links[1]?.attributes).toEqual({});
  });

  it("leaves out a link to a context with no span of its own, and a link added after the end", async () => {
    const { spans, tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    const first = await telemetry.startSpan({ name: "pi.first" }, async (span) => span);

    await telemetry.startSpan(
      { name: "pi.rooted", links: [{ context: telemetry }] },
      async () => undefined,
    );

    first.addLink({ context: first });

    expect(spans[1]!.links).toEqual([]);
    expect(spans[0]!.links).toEqual([]);
  });

  it("rejects with a rejection that is not an Error as it is", async () => {
    const { tracer } = recordingTracer();
    const telemetry = effectTelemetry(tracer);

    await expect(
      telemetry.startSpan({ name: "pi.reject" }, () => Promise.reject("plain string")),
    ).rejects.toBe("plain string");
  });
});
