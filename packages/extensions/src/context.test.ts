// Context management through real runs: a scripted model with a small context window crosses the compaction threshold,
// rolls over with its own Handoff, and reads its Notes and History afterwards. pi-durable's Harness is Promise-based,
// so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PREPARE_ENTRY } from "./context.ts";
import { PREPARE_PROMPT } from "./context/rollover.ts";
import { SubagentsDoc } from "./subagents.ts";
import {
  answer,
  call,
  context,
  contentText,
  openContextHarness,
  type Request,
} from "./context/harness.fixture.ts";

const PREPARE = "Prepare a Context Rollover";

const isBig = (text: string) => text.startsWith("xxxx");

const isEmergency = (text: string) => text.includes("Emergency Rollover");

/** What a provider answers when the request does not fit. */
const overflow = () =>
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
  });

/** pi-durable's summarization request, which the scripts answer as a summarizer would. */
const isSummarization = (request: Request) =>
  request.text.includes("Create a structured context checkpoint summary");

/**
 * The long task: two large tool results cross the threshold, and the agent keeps working until it is asked to prepare;
 * then it saves a Note and rolls over with its Handoff. After the Handoff, `after` answers.
 */
const longTask = (after: (request: Request) => ReturnType<typeof answer>) => (request: Request) => {
  if (request.transcript.some((text) => text.includes("Continue with step 3"))) {
    return after(request);
  }

  if (request.text === "Start the long task") return call(["big", {}]);

  if (isBig(request.text) && request.transcript.filter(isBig).length < 2) return call(["big", {}]);

  if (request.text.includes(PREPARE)) {
    return call(["context_notes", { action: "write", name: "plan", content: "Step 2 of 3 done." }]);
  }

  if (request.text.includes('"saved":true')) {
    return call(["context_rollover", { handoff: "Continue with step 3 of the long task." }]);
  }

  // Keep working until asked to prepare.
  return call(["noop", {}]);
};

describe("context management", () => {
  it("rolls over with the agent's own Handoff instead of a generated summary when the threshold is crossed", async () => {
    const session = await openContextHarness(longTask(() => answer("Done.")));

    await session.prompt("Start the long task");
    await session.settle();

    const kinds = (await session.entries()).map((entry) => entry.kind);

    expect(kinds).not.toContain("pi.compaction");
    expect(kinds.filter((kind) => kind === "pi.reset")).toHaveLength(1);

    const prepared = session.requests.findIndex((request) => request.text.includes(PREPARE));

    expect(prepared).toBeGreaterThan(0);

    // The request after the Handoff starts from it, without the large results, and the run went on.
    const after = session.requests.at(-1)!;

    expect(after.transcript[0]).toContain("Continue with step 3 of the long task.");
    expect(after.transcript.some(isBig)).toBe(false);
    expect(after.transcript.some((text) => text.includes(PREPARE))).toBe(false);
    expect(kinds).toContain("cloudpid.context-continue");
  });

  it("keeps Notes across a Handoff and lists them in the new context", async () => {
    const session = await openContextHarness(
      longTask((request) =>
        request.text.startsWith("{")
          ? answer("Done.")
          : call(["context_notes", { action: "read", name: "plan" }]),
      ),
    );

    await session.prompt("Start the long task");
    await session.settle();

    const after = session.requests.at(-1)!;

    expect(after.transcript[0]).toMatch(/Notes: 1\..*\n"plan" context:\d+:note:plan/s);
    expect(JSON.parse(after.text)).toMatchObject({ name: "plan", content: "Step 2 of 3 done." });
  });

  it("reads entries from before a Handoff", async () => {
    const session = await openContextHarness(
      longTask((request) => {
        if (request.text.startsWith('{"matches"')) {
          const [match] = JSON.parse(request.text).matches;

          return call(["context_history", { action: "read", ref: match.ref }]);
        }

        if (request.text.includes("recorded-entry-json")) return answer("Done.");

        return call(["context_history", { action: "search", query: "Start the long task" }]);
      }),
    );

    await session.prompt("Start the long task");
    await session.settle();

    const results = (await session.results()).slice(-2).map((text) => JSON.parse(text));

    // The search does not match its own call, only the first prompt, which the Handoff took out of the context.
    expect(results[0].matches).toHaveLength(1);
    expect(results[1]).toMatchObject({ format: "recorded-entry-json" });
    expect(JSON.parse(results[1].content)).toMatchObject({
      kind: "pi.user",
      model: [{ role: "user", content: "Start the long task" }],
    });
  });

  it("answers an overflow with an Emergency Rollover from the saved Handoff and Notes", async () => {
    let overflowed = false;

    const session = await openContextHarness((request) => {
      if (request.text === "Start") {
        return call([
          "context_notes",
          { action: "write", name: "plan", content: "y".repeat(2_000) },
        ]);
      }

      if (!overflowed) {
        overflowed = true;

        return overflow();
      }

      return answer("Recovered.");
    }, 1_000_000);

    const settled = await session.prompt("Start");

    await session.settle();

    const summary = (await session.entries()).find((entry) => entry.kind === "pi.compaction");

    expect(settled.status).toBe("done");
    expect(contentText(summary!.model![0]!.content)).toMatch(
      /Emergency Rollover.*No saved Handoff.*"plan"/s,
    );
  });

  it("falls back to an Emergency Rollover when the agent ignores the request and the context fills up", async () => {
    const session = await openContextHarness((request) =>
      request.transcript.some(isEmergency) ? answer("Recovered.") : call(["big", {}]),
    );

    const settled = await session.prompt("Start the long task");

    await session.settle();

    const entries = await session.entries();
    const kinds = entries.map((entry) => entry.kind);
    const summary = entries.find((entry) => entry.kind === "pi.compaction");

    // Asked once, ignored, and then the blocking threshold took the Emergency Rollover rather than a failed request.
    expect(settled.status).toBe("done");
    expect(kinds.filter((kind) => kind === "cloudpid.context-prepare")).toHaveLength(1);
    expect(kinds).not.toContain("pi.reset");
    expect(contentText(summary!.model![0]!.content)).toMatch(
      /Emergency Rollover.*No saved Handoff/s,
    );
  });

  it("recovers from an overflow after the threshold was crossed and the request ignored", async () => {
    let overflowed = false;

    const session = await openContextHarness((request) => {
      if (request.transcript.some(isEmergency)) return answer("Recovered.");

      if (request.transcript.some((text) => text.includes(PREPARE)) && !overflowed) {
        overflowed = true;

        return overflow();
      }

      return call(["big", {}]);
    });

    const settled = await session.prompt("Start the long task");

    await session.settle();

    const summary = (await session.entries()).find((entry) => entry.kind === "pi.compaction");

    expect(overflowed).toBe(true);
    expect(settled.status).toBe("done");
    expect(summary?.data).toEqual({ reason: "overflow" });
    expect(contentText(summary!.model![0]!.content)).toMatch(/Emergency Rollover/);
  });

  it("stops at the Handoff when the Rollover request comes after the task is answered", async () => {
    const session = await openContextHarness((request) => {
      if (request.text.includes(PREPARE)) {
        return call(["context_notes", { action: "write", name: "plan", content: "All done." }]);
      }

      if (request.text.includes('"saved":true')) {
        return call(["context_rollover", { handoff: "The task is answered; wait for the user." }]);
      }

      return answer("All done.");
    });

    await session.prompt("Answer me");

    // As the compaction hook steers it when the threshold is crossed while the answer is being made.
    const request = await session.root.submit(
      {
        type: "input",
        content: PREPARE_PROMPT,
        whenBusy: "steer",
        requestId: "context-prepare:1",
        entry: PREPARE_ENTRY,
      },
      context,
    );

    await request.wait(context);
    await session.settle();

    const kinds = (await session.entries()).map((entry) => entry.kind);

    expect(kinds).toContain("pi.reset");
    expect(kinds).not.toContain("cloudpid.context-continue");
    expect(session.requests.at(-1)?.text).toContain('"saved":true');
  });

  it("gives a subagent Notes and History but not Rollover, so its compaction stays pi-durable's", async () => {
    const session = await openContextHarness((request) => {
      if (isSummarization(request)) return answer("Child summary.");

      if (request.agent === "agent-1") {
        return request.transcript.filter(isBig).length < 3 ? call(["big", {}]) : answer("Filled.");
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "Fill your context" }]);

      return answer("Noted.");
    });

    await session.prompt("Delegate it");
    await session.settle();

    const child = (await session.harness.snapshot(SubagentsDoc, context))!.agents["agent-1"]!;
    const offered = session.requests.find((request) => request.agent === "agent-1")!.tools;
    const entries = await session.entries(child.conversationId);
    const summary = entries.find((entry) => entry.kind === "pi.compaction");

    expect(offered).toEqual(expect.arrayContaining(["context_notes", "context_history"]));
    expect(offered).not.toContain("context_rollover");
    expect(entries.map((entry) => entry.kind)).not.toContain("cloudpid.context-prepare");
    expect(contentText(summary!.model![0]!.content)).toContain("Child summary.");
  });

  it("refuses a Rollover batched with other calls, so a Handoff never splits a tool round", async () => {
    const session = await openContextHarness((request) =>
      request.text === "Batch it"
        ? call(["noop", {}], ["context_rollover", { handoff: "Too early." }])
        : answer("Done."),
    );

    await session.prompt("Batch it");
    await session.settle();

    expect((await session.entries()).map((entry) => entry.kind)).not.toContain("pi.reset");
    expect(await session.results()).toEqual([
      "noop ran",
      "Rollover must be the sole tool call of its round; call context_rollover alone",
    ]);
  });

  it("searches and reads a subagent's conversation with the lineage scope", async () => {
    const session = await openContextHarness((request) => {
      if (request.agent === "agent-1") {
        return request.text === "noop ran" ? answer("Checked.") : call(["noop", {}]);
      }

      if (request.text === "Delegate it") {
        return call(["subagent", { task: "Check something", tools: ["noop"] }]);
      }

      if (request.text === "Search History") {
        return call(["context_history", { action: "search", scope: "lineage", query: "noop ran" }]);
      }

      if (request.text.startsWith('{"matches"')) {
        const [match] = JSON.parse(request.text).matches;

        return call(["context_history", { action: "read", ref: match.ref }]);
      }

      return answer("Noted.");
    });

    await session.prompt("Delegate it");
    await session.settle();
    await session.prompt("Search History");
    await session.settle();

    const [found, read] = (await session.results()).slice(-2).map((text) => JSON.parse(text));

    expect(found.matches).toEqual([expect.objectContaining({ agent: "agent-1" })]);
    expect(read.resolved_in_session).toBe(found.matches[0].session);
    expect(JSON.parse(read.content)).toMatchObject({ kind: "pi.tool-result" });
  });
});
