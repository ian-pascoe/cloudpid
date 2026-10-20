// The subagent tools through real runs: a scripted model drives the root and its children in one Harness.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import { answer, call, context, gate, openSubagentHarness } from "./subagents/harness.fixture.ts";

describe("subagents", () => {
  it("reports a child's answer back to its parent as a follow-up when nobody waits for it", async () => {
    const session = await openSubagentHarness((request) => {
      if (request.agent === "agent-1") return answer("The answer is 42.");

      if (request.text === "Delegate it") {
        return call(["subagent", { task: "Find the answer", tools: "read" }]);
      }

      if (request.text.startsWith("Spawned")) return answer("Delegated.");

      return answer("Noted.");
    });

    await session.prompt("Delegate it");
    await session.settle();

    const inputs = await session.texts("user");

    expect(inputs).toEqual([
      "Delegate it",
      "[Subagent result | agent=agent-1 | turn=turn-1 | status=completed]\nThe answer is 42.",
    ]);
    expect((await session.state()).agents["agent-1"]?.turns).toMatchObject([
      { id: "turn-1", status: "completed", delivery: "auto" },
    ]);
  });

  it("hands a child's answer to a wait blocked on its turn, and reports nothing else", async () => {
    const ready = gate();

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        await ready.promise;

        return answer("The answer is 42.");
      }

      if (request.text === "Delegate it") {
        return call(
          ["subagent", { task: "Find the answer" }],
          ["subagent_wait", { agent_id: "agent-1" }],
        );
      }

      return answer(`Root saw: ${request.text}`);
    });

    const answered = session.prompt("Delegate it");

    await session.until(
      async () => Object.keys((await session.state()).waiters).length === 1,
      "the wait to block",
    );
    ready.resolve();
    await answered;
    await session.settle();

    const results = await session.texts("toolResult");

    expect(results[1]).toMatch(/^agent-1 turn-1 completed \([\d.]+s\)\n\nThe answer is 42\.$/);
    expect(await session.texts("user")).toEqual(["Delegate it"]);
    expect((await session.state()).agents["agent-1"]?.turns).toMatchObject([
      { id: "turn-1", status: "completed", delivery: "wait" },
    ]);
    expect((await session.state()).waiters).toEqual({});
  });

  it("delivers a child's message through its parent's wait, and its later answer as a follow-up", async () => {
    let waiting = async () => false;

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        if (request.text === "Find the answer") {
          while (!(await waiting())) await new Promise((resolve) => setTimeout(resolve, 5));

          return call(["agent_message", { message: "Which answer?" }]);
        }

        return answer("The answer is 42.");
      }

      if (request.text === "Delegate it") {
        return call(
          ["subagent", { task: "Find the answer" }],
          ["subagent_wait", { agent_id: "agent-1" }],
        );
      }

      return answer("Noted.");
    });

    waiting = async () => Object.keys((await session.state()).waiters).length === 1;
    await session.prompt("Delegate it");
    await session.settle();

    expect((await session.texts("toolResult"))[1]).toBe(
      "Message from agent-1 (turn-1):\n\nWhich answer?",
    );
    expect(
      (
        await session.texts("toolResult", (await session.state()).agents["agent-1"]!.conversationId)
      )[0],
    ).toBe("Message delivered to root through its active wait.");
    expect(await session.texts("user")).toEqual([
      "Delegate it",
      "[Subagent result | agent=agent-1 | turn=turn-1 | status=completed]\nThe answer is 42.",
    ]);
  });

  it("starts a new turn on an idle child with agent_message, and reports its answer", async () => {
    const session = await openSubagentHarness((request) => {
      if (request.agent === "agent-1") {
        return answer(request.text.endsWith("Again") ? "Second answer." : "First answer.");
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "First" }]);

      if (request.text.endsWith("First answer.")) {
        return call(["agent_message", { agent_id: "agent-1", message: "Again" }]);
      }

      return answer("Noted.");
    });

    await session.prompt("Delegate it");
    await session.settle();

    expect(await session.texts("toolResult")).toContain(
      "agent-1 was idle; the message started turn turn-2. Wait on it with subagent_wait.",
    );
    expect(await session.texts("user")).toEqual([
      "Delegate it",
      "[Subagent result | agent=agent-1 | turn=turn-1 | status=completed]\nFirst answer.",
      "[Subagent result | agent=agent-1 | turn=turn-2 | status=completed]\nSecond answer.",
    ]);
  });

  it("ends a wait at its timeout without stopping the child, whose answer then arrives as a follow-up", async () => {
    const ready = gate();

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        await ready.promise;

        return answer("Late answer.");
      }

      if (request.text === "Delegate it") {
        return call(
          ["subagent", { task: "Take your time" }],
          ["subagent_wait", { agent_id: "agent-1", timeout_ms: 30 }],
        );
      }

      return answer("Noted.");
    });

    await session.prompt("Delegate it");

    expect((await session.texts("toolResult"))[1]).toMatch(
      /^Timed out after [\d.]+s; agent-1 is running on turn-1\. It keeps working/,
    );

    ready.resolve();
    await session.settle();

    expect((await session.texts("user")).at(-1)).toBe(
      "[Subagent result | agent=agent-1 | turn=turn-1 | status=completed]\nLate answer.",
    );
  });

  it("ends a wait when a steer is queued for the waiting agent", async () => {
    const ready = gate();

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        await ready.promise;

        return answer("Answer.");
      }

      if (request.text === "Delegate it") {
        return call(["subagent", { task: "Work" }], ["subagent_wait", { agent_id: "agent-1" }]);
      }

      return answer("Noted.");
    });

    const answered = session.prompt("Delegate it");

    await session.until(
      async () => Object.keys((await session.state()).waiters).length === 1,
      "the wait to block",
    );
    await session.root.submit({ type: "input", content: "Look here", whenBusy: "steer" }, context);
    await answered;

    expect((await session.texts("toolResult"))[1]).toMatch(
      /^A message is waiting for you, so the wait ended after [\d.]+s; agent-1 is running on turn-1/,
    );

    ready.resolve();
    await session.settle();
  });
});
