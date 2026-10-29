// The `instructions` section (docs/architecture/workspace.md → Instructions) through real runs: the owner's Instructions
// in front of the model from the start of each Context Window, frozen within it, read again after a Handoff, and given
// to subagents too. pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { Harness, openHarness } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { ContextManagement } from "./context.ts";
import {
  type InstructionsInForce,
  Instructions,
  InstructionsSettings,
  SECTION_INTRODUCTION,
  SECTION_KEY,
} from "./instructions.ts";
import { answer, call as subagentCall, openSubagentHarness } from "./subagents/harness.fixture.ts";

const context = BACKGROUND_CONTEXT;

let calls = 0;

/** A response that calls one tool. */
const call = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${(calls += 1)}` })], {
    stopReason: "toolUse",
  });

/** The `owner_instructions` section a request's system messages leave in effect, if any. */
const sectionOf = (messages: ReadonlyArray<Message>): string | undefined => {
  let section: string | undefined;

  for (const message of messages) {
    if (
      message.role === "system" &&
      message.sections !== undefined &&
      SECTION_KEY in message.sections
    ) {
      section = message.sections[SECTION_KEY] ?? undefined;
    }
  }

  return section;
};

const text = (content: Message["content"]): string =>
  Predicate.isString(content)
    ? content
    : content.map((block) => ("text" in block ? block.text : "")).join("");

/** A tool that does nothing, so a test can make another request in the same Context Window. */
const Noop = defineExtension({
  name: "noop",
  tools: [
    defineTool({
      name: "noop",
      description: "Do nothing",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "done" }] }),
    }),
  ],
});

/** Instructions the test changes as it goes, as the owner's save changes what the Session reads. */
const owned = (global: string, environment?: InstructionsInForce["environment"]) => {
  let current: InstructionsInForce = { global, environment };

  return {
    service: { current: () => current },
    set: (next: string) => {
      current = { global: next };
    },
  };
};

/**
 * Open a Harness with the `instructions` extension over `instructions`, `noop` and the context tools, whose model
 * answers with `steps` in order, then "Done.". Answers the section of each request, and its other text.
 */
const open = async (
  instructions: ReturnType<typeof owned>,
  steps: ReadonlyArray<AssistantMessage | (() => AssistantMessage)>,
) => {
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
  const models = createModels();
  const requests: Array<{ section: string | undefined; transcript: ReadonlyArray<string> }> = [];

  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 20 }, () => (transcript: { readonly messages: readonly Message[] }) => {
      requests.push({
        section: sectionOf(transcript.messages),
        transcript: transcript.messages
          .filter((message) => message.role !== "system")
          .map((message) => text(message.content)),
      });

      const step = steps[requests.length - 1];

      return step === undefined
        ? fauxAssistantMessage("Done.")
        : Predicate.isFunction(step)
          ? step()
          : step;
    }),
  );

  const service = await Effect.runPromise(openHarness(new MemoryStorage(), { models }));

  const extensions = await Effect.runPromise(
    Effect.all([Instructions, ContextManagement]).pipe(
      Effect.provide(
        Context.make(Harness, service).pipe(
          Context.add(InstructionsSettings, instructions.service),
        ),
      ),
    ),
  );

  for (const extension of [Noop, ...extensions]) {
    await Effect.runPromise(service.install(extension));
  }

  const conversation = await service.harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  await (await conversation.submit({ type: "input", content: "Go" }, context)).wait(context);
  await service.harness.waitForIdle(context);

  return requests;
};

describe("the owner_instructions section", () => {
  it("shows the owner's Instructions, saying whose they are and that the Project instructions win", async () => {
    const requests = await open(owned("Answer in French.\n\n- Keep commits small."), []);

    expect(requests[0]!.section).toBe(
      [
        `<${SECTION_KEY}>`,
        SECTION_INTRODUCTION,
        "",
        '<instructions scope="Global">',
        "Answer in French.",
        "",
        "- Keep commits small.",
        "</instructions>",
        `</${SECTION_KEY}>`,
      ].join("\n"),
    );
    expect(SECTION_INTRODUCTION).toContain("the Project instructions");
  });

  it("shows an Environment's Instructions after the Global ones, under a heading naming it", async () => {
    const requests = await open(
      owned("Answer in French.", { name: 'Work "main"', text: "Answer in German." }),
      [],
    );

    expect(requests[0]!.section).toBe(
      [
        `<${SECTION_KEY}>`,
        SECTION_INTRODUCTION,
        "",
        '<instructions scope="Global">',
        "Answer in French.",
        "</instructions>",
        "",
        '<instructions scope="Environment Work &quot;main&quot;">',
        "Answer in German.",
        "</instructions>",
        `</${SECTION_KEY}>`,
      ].join("\n"),
    );
    // The nearer wins: the Environment's over the Global ones, the Project instructions over both.
    expect(SECTION_INTRODUCTION).toContain("the Environment's win over the Global ones");
  });

  it("shows only the Scope that has Instructions", async () => {
    const environmentOnly = await open(owned("", { name: "Work", text: "Be terse." }), []);
    const globalOnly = await open(owned("Be kind.", { name: "Work", text: " \n" }), []);

    expect(environmentOnly[0]!.section).toContain(
      '<instructions scope="Environment Work">\nBe terse.\n</instructions>',
    );
    expect(environmentOnly[0]!.section).not.toContain('scope="Global"');
    expect(globalOnly[0]!.section).toContain('<instructions scope="Global">\nBe kind.');
    expect(globalOnly[0]!.section).not.toContain('scope="Environment');
  });

  it("adds nothing to the prompt when there are none, nor for text that is only blank", async () => {
    for (const blank of ["", " \n\t"]) {
      const requests = await open(owned(blank), []);

      // Empty, not absent: frozen as "nothing to show", so an edit is not added inside the context.
      expect(requests[0]!.section).toBe("");
    }
  });

  it("stays as it was shown when the owner edits the Instructions, and shows the edit after a Handoff", async () => {
    const instructions = owned("Use tabs.");

    const requests = await open(instructions, [
      () => {
        // The owner saves new Instructions while the Run goes on.
        instructions.set("Use spaces.");

        return call("noop", {});
      },
      call("context_rollover", { handoff: "Keep going." }),
    ]);

    expect(requests).toHaveLength(3);
    // The system prompt is the head of every request: it may not change, or the provider's cache starts over.
    expect(requests[0]!.section).toContain("Use tabs.");
    expect(requests[1]!.section).toBe(requests[0]!.section);
    // A new Context Window reads them again.
    expect(requests[2]!.transcript[0]).toContain("Keep going.");
    expect(requests[2]!.section).toContain("Use spaces.");
    expect(requests[2]!.section).not.toContain("Use tabs.");
  });

  it("does not appear inside a Context Window that began with none", async () => {
    const instructions = owned("");

    const requests = await open(instructions, [
      () => {
        instructions.set("Be terse.");

        return call("noop", {});
      },
      call("context_rollover", { handoff: "Keep going." }),
    ]);

    expect(requests.map((request) => request.section)).toEqual([
      "",
      "",
      expect.stringContaining("Be terse."),
    ]);
  });

  it("is shown to subagents too, from the start of their own Context Window", async () => {
    const instructions = owned("Never push to main.");

    const extension = await Effect.runPromise(
      Instructions.pipe(Effect.provideService(InstructionsSettings, instructions.service)),
    );

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "agent-1") return answer("Found it.");

        if (request.text === "Delegate it") {
          return subagentCall(["subagent", { task: "Find it", tools: "read" }]);
        }

        return answer("Noted.");
      },
      {},
      [extension],
    );

    await session.prompt("Delegate it");
    await session.settle();

    const child = session.requests.filter((request) => request.agent === "agent-1");

    expect(child.length).toBeGreaterThan(0);
    expect(sectionOf(child[0]!.messages)).toContain("Never push to main.");
    expect(
      sectionOf(session.requests.find((request) => request.agent === "root")!.messages),
    ).toContain("Never push to main.");
  });
});
