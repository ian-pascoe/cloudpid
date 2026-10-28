// pi-durable's Harness is Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import { defineExtension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import { answer, callTool, context, openFauxHarness, resultText } from "./harness.fixture.ts";
import { ChordContext } from "./chord.ts";
import { defineEffectTool } from "./tool.ts";

const Sides = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 20 }));

const rollDie = defineEffectTool({
  name: "roll_die",
  description: "Roll one die",
  parameters: Schema.Struct({ sides: Sides }),
  execute: ({ sides }) =>
    Effect.succeed({ output: [{ type: "text", text: `rolled a d${sides}` }] }),
});

const dice = defineExtension({ name: "dice", tools: [Effect.runSync(rollDie)] });

describe("defineEffectTool", () => {
  it("offers its Schema parameters to the model as JSON Schema and answers a call with its result", async () => {
    const { requests, prompt, lastToolResult } = await openFauxHarness(
      [dice],
      [callTool("roll_die", { sides: 6 }), answer("done")],
    );

    await prompt("roll");

    expect(requests[0]?.tools).toEqual([
      {
        name: "roll_die",
        description: "Roll one die",
        parameters: {
          type: "object",
          properties: { sides: { type: "integer", minimum: 2, maximum: 20 } },
          required: ["sides"],
          additionalProperties: false,
        },
      },
    ]);
    expect(resultText(await lastToolResult())).toBe("rolled a d6");
  });

  it("refuses a model-facing name that is not snake_case", () => {
    const camel = defineEffectTool({
      name: "rollDie",
      description: "Roll one die",
      parameters: Schema.Struct({}),
      execute: () => Effect.succeed({}),
    });

    expect(() => Effect.runSync(camel)).toThrow("Tool name rollDie is not snake_case");
  });

  it("answers arguments its Schema rejects with an error result, without running", async () => {
    let ran = false;

    // A check JSON Schema cannot express: only the Effect decoder enforces it.
    const Shout = Schema.String.check(
      Schema.makeFilter((text: string) => text === text.toUpperCase() || "must be upper case"),
    );

    const shout = defineEffectTool({
      name: "shout",
      description: "Shout",
      parameters: Schema.Struct({ text: Shout }),
      execute: ({ text }) =>
        Effect.sync(() => {
          ran = true;

          return { output: [{ type: "text", text }] };
        }),
    });

    const { prompt, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "shout", tools: [Effect.runSync(shout)] })],
      [callTool("shout", { text: "quiet" }), answer("done")],
    );

    await prompt("shout");

    expect(ran).toBe(false);

    const result = await lastToolResult();

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toContain("must be upper case");
  });

  it("interrupts the call's fiber when its conversation is aborted", async () => {
    const started = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();

    const waitForever = defineEffectTool({
      name: "wait_forever",
      description: "Never finish",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.sync(() => started.resolve()).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
        ),
    });

    const { root, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "waiting", tools: [Effect.runSync(waitForever)] })],
      [callTool("wait_forever", {}), answer("unreachable")],
    );

    await root.submit({ type: "input", content: "wait" }, context);
    await started.promise;
    await root.abort(context);
    await interrupted.promise;

    expect(await lastToolResult()).toMatchObject({ isError: true });
  });

  it("answers a typed failure with an error result carrying the failure's message", async () => {
    class DiceLost extends Schema.TaggedError<DiceLost, { readonly brand: unique symbol }>()(
      "DiceLost",
      { message: Schema.String },
    ) {}

    const rollLost = defineEffectTool({
      name: "roll_lost",
      description: "Roll dice that are gone",
      parameters: Schema.Struct({}),
      execute: () => Effect.fail(DiceLost.make({ message: "The dice are lost" })),
    });

    const { prompt, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "lost", tools: [Effect.runSync(rollLost)] })],
      [callTool("roll_lost", {}), answer("done")],
    );

    await prompt("roll");

    expect(await lastToolResult()).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "The dice are lost" }],
    });
  });

  it("inlines identified schemas, so the model is offered one object schema", async () => {
    const Die = Schema.Struct({ sides: Sides }).annotate({ identifier: "Die" });

    const rollOne = defineEffectTool({
      name: "roll_one",
      description: "Roll one die",
      parameters: Schema.Struct({ die: Die }).annotate({ identifier: "RollOne" }),
      execute: ({ die }) =>
        Effect.succeed({ output: [{ type: "text", text: `rolled a d${die.sides}` }] }),
    });

    const { requests, prompt, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "one", tools: [Effect.runSync(rollOne)] })],
      [callTool("roll_one", { die: { sides: 8 } }), answer("done")],
    );

    await prompt("roll");

    expect(requests[0]?.tools[0]?.parameters).toEqual({
      type: "object",
      properties: {
        die: {
          type: "object",
          properties: { sides: { type: "integer", minimum: 2, maximum: 20 } },
          required: ["sides"],
          additionalProperties: false,
        },
      },
      required: ["die"],
      additionalProperties: false,
    });
    expect(resultText(await lastToolResult())).toBe("rolled a d8");
  });

  it("offers a tool without parameters an empty object schema", () => {
    const tool = Effect.runSync(
      defineEffectTool({
        name: "no_arguments",
        description: "Take nothing",
        parameters: Schema.Struct({}),
        execute: () => Effect.succeed({}),
      }),
    );

    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("decodes optional and defaulted arguments the model leaves out", async () => {
    const label = defineEffectTool({
      name: "label_roll",
      description: "Label a roll",
      parameters: Schema.Struct({
        count: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
        label: Schema.optional(Schema.String),
      }),
      execute: ({ count, label }) =>
        Effect.succeed({ output: [{ type: "text", text: `${count} ${label ?? "unlabelled"}` }] }),
    });

    const { prompt, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "label", tools: [Effect.runSync(label)] })],
      [callTool("label_roll", { label: null }), answer("done")],
    );

    await prompt("label");

    const result = await lastToolResult();

    expect(result).toMatchObject({ isError: false });
    expect(resultText(result)).toBe("1 unlabelled");
  });

  it("answers a defect with pi-durable's tool_error result, even when the call also failed", async () => {
    class DiceLost extends Schema.TaggedError<DiceLost, { readonly brand: unique symbol }>()(
      "DiceLost",
      { message: Schema.String },
    ) {}

    const crash = defineEffectTool({
      name: "crash",
      description: "Crash",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.fail(DiceLost.make({ message: "The dice are lost" })).pipe(
          Effect.ensuring(Effect.die(new Error("The table broke"))),
        ),
    });

    const { prompt, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "crash", tools: [Effect.runSync(crash)] })],
      [callTool("crash", {}), answer("done")],
    );

    await prompt("crash");

    const result = await lastToolResult();

    expect(result).toMatchObject({ isError: true });
    // Since effect 4.0.6 the failure beside a defect is a defect too, so both are reported, the crash included.
    expect(resultText(result)).toContain("The table broke");
    expect(resultText(result)).toContain("The dice are lost");
  });

  it("settles a call that fails while being aborted as aborted", async () => {
    const started = Promise.withResolvers<void>();

    const stubborn = defineEffectTool({
      name: "stubborn",
      description: "Fail once aborted",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const { abortSignal } = yield* ChordContext;

            started.resolve();
            yield* Effect.callback<void>((resume) => {
              abortSignal?.addEventListener("abort", () => resume(Effect.void), { once: true });
            });

            return yield* Effect.fail({ message: "gave up" });
          }),
        ),
    });

    const { root, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "stubborn", tools: [Effect.runSync(stubborn)] })],
      [callTool("stubborn", {}), answer("unreachable")],
    );

    await root.submit({ type: "input", content: "go" }, context);
    await started.promise;
    await root.abort(context);

    const result = await lastToolResult();

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toContain("Tool stubborn was aborted");
    expect(resultText(result)).not.toContain("gave up");
  });

  it("runs calls outside the span the tool was built in", async () => {
    const spans: string[] = [];

    const traced = defineEffectTool({
      name: "traced",
      description: "Report the parent span",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.serviceOption(Tracer.ParentSpan).pipe(
          Effect.map((parent) => {
            spans.push(
              Option.match(parent, { onNone: () => "none", onSome: (span) => span.spanId }),
            );

            return {};
          }),
        ),
    }).pipe(Effect.withSpan("startup"));

    const { prompt } = await openFauxHarness(
      [defineExtension({ name: "traced", tools: [Effect.runSync(traced)] })],
      [callTool("traced", {}), answer("done")],
    );

    await prompt("trace");

    expect(spans).toEqual(["none"]);
  });
});
