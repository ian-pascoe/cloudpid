// pi-durable's Harness is Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import { defineExtension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { answer, callTool, context, openFauxHarness, resultText } from "./harness.fixture.ts";
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
});
