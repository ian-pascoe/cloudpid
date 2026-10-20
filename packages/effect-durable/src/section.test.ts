// pi-durable's Harness is Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import { defineExtension } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { answer, openFauxHarness } from "./harness.fixture.ts";
import { effectSection } from "./section.ts";

/** The name the section greets: a service it reads. */
class Greeted extends Context.Service<Greeted, string>()(
  "@cloudpid/effect-durable/section.test/Greeted",
) {}

describe("effectSection", () => {
  it("renders an Effect with its services into the system prompt", async () => {
    const greeting = effectSection(
      "greeting",
      Effect.fnUntraced(function* () {
        return `Greet ${yield* Greeted}.`;
      }),
    ).pipe(Effect.provideService(Greeted, "Ada"));

    const { requests, prompt } = await openFauxHarness(
      [defineExtension({ name: "greeting", sections: [Effect.runSync(greeting)] })],
      [answer("Hello, Ada")],
    );

    await prompt("hi");

    expect(requests[0]?.sections).toMatchObject({
      greeting: "<greeting>\nGreet Ada.\n</greeting>",
    });
  });
});
