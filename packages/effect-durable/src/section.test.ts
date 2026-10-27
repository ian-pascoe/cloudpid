// pi-durable's Harness is Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { answer, callTool, openFauxHarness } from "./harness.fixture.ts";
import { effectSection, frozenSection } from "./section.ts";

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

describe("frozenSection", () => {
  const noop = defineExtension({
    name: "noop",
    tools: [
      defineTool({
        name: "noop",
        description: "Does nothing",
        parameters: Type.Object({}),
        execute: async () => ({ output: [{ type: "text", text: "" }] }),
      }),
    ],
  });

  /** Three requests (two tool calls, then an answer) of a conversation whose section reads `reads` in turn. */
  const threeRequests = async (reads: ReadonlyArray<string | undefined | Error>) => {
    let read = 0;

    const frozen = Effect.runSync(
      frozenSection("frozen", () => {
        const next = reads[Math.min(read++, reads.length - 1)];

        return next instanceof Error ? Effect.fail(next) : Effect.succeed(next);
      }),
    );

    const { requests, prompt } = await openFauxHarness(
      [noop, defineExtension({ name: "frozen", sections: [frozen] })],
      [callTool("noop", {}), callTool("noop", {}), answer("Done")],
    );

    await prompt("hi");

    return { sections: Arr.map(requests, (request) => request.sections["frozen"]), reads: read };
  };

  it("reads once and shows the same text in every later request", async () => {
    const { sections, reads } = await threeRequests(["first", "second"]);

    expect(sections).toEqual(["first", "first", "first"]);
    expect(reads).toBe(1);
  });

  it("freezes an empty text, so what is read later is not shown", async () => {
    const { sections, reads } = await threeRequests(["", "later"]);

    expect(sections).toEqual(["", "", ""]);
    expect(reads).toBe(1);
  });

  it("freezes nothing when there is no text to show, and reads again", async () => {
    const { sections } = await threeRequests([undefined, "later"]);

    expect(sections).toEqual([undefined, "later", "later"]);
  });

  it("freezes nothing when the read fails, and reads again", async () => {
    const { sections } = await threeRequests([new Error("cannot read"), "later"]);

    expect(sections).toEqual([undefined, "later", "later"]);
  });
});
