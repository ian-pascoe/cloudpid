// pi-durable's Harness is Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import { defineExtension, type Harness, ToolTask } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import {
  answer,
  callTool,
  context,
  openFauxHarness,
  openRestartingHarness,
  resultText,
  until,
} from "./harness.fixture.ts";
import { callDurable } from "./Harness.ts";
import { ChordContext } from "./chord.ts";
import { mcpToolName, mcpToolNames } from "@cloudpid/config";
import { defineEffectTool, isToolName, reachedWait } from "./tool.ts";

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

  it("refuses a model-facing name that is neither snake_case nor an MCP tool name", () => {
    const camel = defineEffectTool({
      name: "rollDie",
      description: "Roll one die",
      parameters: Schema.Struct({}),
      execute: () => Effect.succeed({}),
    });

    expect(() => Effect.runSync(camel)).toThrow(
      "Tool name rollDie is not snake_case or an MCP tool name",
    );
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

describe("reachedWait", () => {
  it("marks a running call's wait, and never fails once the call has ended", async () => {
    let lateMark: Effect.Effect<void> = Effect.die(new Error("The call never ran"));

    const waitOnce = defineEffectTool({
      name: "wait_once",
      description: "Reach a wait",
      parameters: Schema.Struct({}),
      execute: (_args, callApi) =>
        Effect.gen(function* () {
          lateMark = reachedWait(callApi);
          yield* reachedWait(callApi);

          return { output: [{ type: "text", text: "waited" }] };
        }),
    });

    const { prompt, lastToolResult } = await openFauxHarness(
      [defineExtension({ name: "wait_once", tools: [Effect.runSync(waitOnce)] })],
      [callTool("wait_once", {}), answer("done")],
    );

    await prompt("wait");

    expect(resultText(await lastToolResult())).toBe("waited");

    // pi-durable refuses a mark from a call that has ended; the mark is only logged.
    await expect(
      Effect.runPromise(lateMark.pipe(Effect.provideService(ChordContext, context))),
    ).resolves.toBeUndefined();
  });
});

/**
 * A call (`caller`) that makes one nested call (`waiter`) and waits for it in memory, as a `codemode` call does. `seen`
 * records each attempt of either; `callerHangs` says whether the caller's attempt hangs before it makes its call, and
 * `waiterMarks` whether the waiter's marks its wait (`reachedWait`) before it waits for good.
 */
const nesting = (behaviour: {
  readonly callerHangs: (attempt: number) => boolean;
  readonly waiterMarks: (attempt: number) => boolean;
}) => {
  const seen: string[] = [];
  let callers = 0;
  let waiters = 0;

  const waiter = defineEffectTool({
    name: "waiter",
    description: "Wait for the owner",
    parameters: Schema.Struct({}),
    replay: "safe",
    execute: (_args, api) =>
      Effect.gen(function* () {
        waiters += 1;

        const attempt = waiters;

        if (behaviour.waiterMarks(attempt)) yield* reachedWait(api);
        seen.push(`waiter ${attempt}`);

        return yield* Effect.never;
      }),
  });

  const caller = defineEffectTool({
    name: "caller",
    description: "Call the waiter",
    parameters: Schema.Struct({}),
    replay: "safe",
    execute: (_args, api) =>
      Effect.gen(function* () {
        callers += 1;

        const attempt = callers;

        seen.push(`caller ${attempt}`);

        if (behaviour.callerHangs(attempt)) return yield* Effect.never;

        yield* callDurable("executeTool", (callContext) =>
          api.executeTool("waiter", {}, callContext, { key: "c1" }),
        );

        return {};
      }),
  });

  const extension = defineExtension({
    name: "nesting",
    tools: [Effect.runSync(caller), Effect.runSync(waiter)],
  });

  /** Wait until `attempt` was seen. */
  const reached = (attempt: string) =>
    until(
      () => seen.includes(attempt),
      () => Arr.join(seen, ", "),
    );

  return { extension, reached };
};

/** What a tool call's task input says of the call: who made it, the model (`model`) or another call (`nested`). */
const isCallInput = Schema.is(Schema.Struct({ kind: Schema.String }));

/** Each live tool call: the caller's (`model`) and the waiter's (`nested`), its restart count and its state. */
const toolCalls = async (harness: Harness) =>
  Arr.flatMap((await harness.inspect(context)).tasks, ({ record, state }) =>
    record.kind === ToolTask.definition.name
      ? [
          {
            call: isCallInput(record.input) ? record.input.kind : undefined,
            restarts: record.restarts,
            state,
          },
        ]
      : [],
  );

describe("reachedWait across restarts", () => {
  it("starts the restart count over for the call and for the call that waits on it, past the restart limit", async () => {
    const { extension, reached } = nesting({ callerHangs: () => false, waiterMarks: () => true });

    const { harness, restart } = await openRestartingHarness(
      [extension],
      [callTool("caller", {}), answer("done")],
      { restartLimit: 3 },
    );

    await reached("waiter 1");

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await restart();
      await reached(`waiter ${attempt}`);
    }

    expect(await toolCalls(harness())).toEqual([
      { call: "model", restarts: undefined, state: { kind: "running" } },
      { call: "nested", restarts: undefined, state: { kind: "running" } },
    ]);
  });

  it("ends a caller cut off at the restart limit, though the call it waits for marks its wait", async () => {
    // The caller is cut off twice before it makes its call, and once more after: at the third restart it has reached
    // the limit, and the waiter's mark, which starts the count over only for calls below the limit, does not save it.
    const { extension, reached } = nesting({
      callerHangs: (attempt) => attempt <= 2,
      waiterMarks: (attempt) => attempt > 1,
    });

    const { harness, restart, lastToolResult } = await openRestartingHarness(
      [extension],
      [callTool("caller", {}), answer("done")],
      { restartLimit: 3 },
    );

    await reached("caller 1");
    await restart();
    await reached("caller 2");
    await restart();
    await reached("waiter 1");
    await restart();

    // pi-durable ends the caller with an error result, aborting the waiter, and the Run goes on to its answer.
    await harness().waitForIdle(context);

    expect(await toolCalls(harness())).toEqual([]);
    expect(resultText(await lastToolResult())).toContain("Tool caller was interrupted 3 times");
  });
});

describe("isToolName", () => {
  it.each(["roll_die", "a1", "mcp"])("accepts the snake_case name %s", (name) => {
    expect(isToolName(name)).toBe(true);
  });

  it.each(["mcp__github__get_user", "mcp__a__b__x", "mcp__s__2fa"])(
    "accepts the MCP tool name %s",
    (name) => {
      expect(isToolName(name)).toBe(true);
    },
  );

  it.each([
    "rollDie",
    "roll__die",
    "mcp__github",
    "mcp__GitHub__get_user",
    "mcp__github__get-user",
    "x__github__get_user",
  ])("refuses %s: the exception is only for `mcp__<server>__<tool>`", (name) => {
    expect(isToolName(name)).toBe(false);
  });

  it("accepts every name the MCP naming function gives", () => {
    const tools = [
      "getUser",
      "get_user",
      "get-user",
      "---",
      "_",
      "tool",
      "x".repeat(80),
      "y".repeat(55),
      `${"a".repeat(46)}_${"b".repeat(10)}`,
      "résumé",
      "2fa",
    ];

    for (const server of [
      "github",
      "My-Server",
      "a--b",
      "-",
      "_x",
      "z".repeat(64),
      "q".repeat(49),
    ]) {
      for (const name of mcpToolNames(server, tools).values()) {
        expect(isToolName(name), name).toBe(true);
        expect(name.length).toBeLessThanOrEqual(64);
      }

      expect(isToolName(mcpToolName(server, "getUser", { collides: true }))).toBe(true);
    }
  });
});
