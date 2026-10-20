// pi-durable's Harness is Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import { defineExtension, ToolTask } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { answer, callTool, openFauxHarness, resultText } from "./harness.fixture.ts";
import { effectHook } from "./hook.ts";
import { defineEffectTool } from "./tool.ts";

/** Which tools may not run: a service the hook reads. */
class Blocked extends Context.Service<Blocked, ReadonlySet<string>>()(
  "@cloudpid/effect-durable/hook.test/Blocked",
) {}

describe("effectHook", () => {
  it("runs an Effect handler with its services and applies its decision", async () => {
    let ran = false;

    const rollDie = defineEffectTool({
      name: "roll_die",
      description: "Roll one die",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.sync(() => {
          ran = true;

          return {};
        }),
    });

    const guard = effectHook(ToolTask, {
      beforeTool: Effect.fnUntraced(function* (call) {
        const blocked = yield* Blocked;

        return blocked.has(call.name) ? { block: `${call.name} is blocked here` } : undefined;
      }),
    }).pipe(Effect.provideService(Blocked, new Set(["roll_die"])));

    const { prompt, lastToolResult } = await openFauxHarness(
      [
        defineExtension({
          name: "guarded",
          tools: [Effect.runSync(rollDie)],
          hooks: [Effect.runSync(guard)],
        }),
      ],
      [callTool("roll_die", {}), answer("done")],
    );

    await prompt("roll");

    expect(ran).toBe(false);

    const result = await lastToolResult();

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toContain("roll_die is blocked here");
  });
});
