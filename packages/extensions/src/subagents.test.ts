// The subagent tools through real runs: a scripted model drives the root and its children in one Harness.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off
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

  describe("the depth cap", () => {
    /** The root spawns a fanout child, which spawns a fanout grandchild. */
    const fanout = (maxSubagentDepth: number) =>
      openSubagentHarness(
        (request) => {
          if (request.text === "Delegate it") {
            return call(["subagent", { task: "Delegate further", delegation: "fanout" }]);
          }

          if (request.agent === "agent-1" && request.text === "Delegate further") {
            return call(["subagent", { task: "Leaf work", delegation: "fanout" }]);
          }

          return answer("Done.");
        },
        { maxSubagentDepth },
      );

    const offered = (session: Awaited<ReturnType<typeof fanout>>, agent: string) =>
      session.requests.find((request) => request.agent === agent)?.tools ?? [];

    it("lets a fanout child spawn below the cap, and gives the child at the cap only agent_message", async () => {
      const session = await fanout(2);

      await session.prompt("Delegate it");
      await session.settle();

      expect(offered(session, "agent-1")).toContain("subagent");
      expect(offered(session, "agent-1.agent-1")).toContain("agent_message");
      expect(offered(session, "agent-1.agent-1")).not.toContain("subagent");
      expect(offered(session, "agent-1.agent-1")).not.toContain("subagent_wait");
      expect(Object.keys((await session.state()).agents).sort()).toEqual([
        "agent-1",
        "agent-1.agent-1",
      ]);
    });

    it("refuses a spawn from a child at the cap, even one launched with fanout", async () => {
      const session = await fanout(1);

      await session.prompt("Delegate it");
      await session.settle();

      expect(offered(session, "agent-1")).not.toContain("subagent");
      expect(Object.keys((await session.state()).agents)).toEqual(["agent-1"]);

      const child = (await session.state()).agents["agent-1"]!.conversationId;

      // The call the model made anyway found no such tool.
      expect(await session.texts("toolResult", child)).toEqual([
        "<harness>\n[error] Tool subagent is not available\n</harness>",
      ]);
    });
  });

  it("refuses a spawn once a lowered cap reaches a child launched below the old one", async () => {
    const options = { maxSubagentDepth: 2 };

    const session = await openSubagentHarness((request) => {
      if (request.text === "Delegate it") {
        return call(["subagent", { task: "Wait for orders", delegation: "fanout" }]);
      }

      if (request.text === "Again") {
        return call(["agent_message", { agent_id: "agent-1", message: "Delegate further" }]);
      }

      if (request.agent === "agent-1" && request.text.endsWith("Delegate further")) {
        return call(["subagent", { task: "Leaf work" }]);
      }

      return answer("Done.");
    }, options);

    await session.prompt("Delegate it");
    await session.settle();
    options.maxSubagentDepth = 1;
    await session.prompt("Again");
    await session.settle();

    const { agents } = await session.state();

    expect(await session.texts("toolResult", agents["agent-1"]!.conversationId)).toEqual([
      "agent-1 is at the depth cap (1) and cannot spawn subagents",
    ]);
    expect(Object.keys(agents)).toEqual(["agent-1"]);
  });

  describe("the capability ceiling", () => {
    it("refuses to grant a child a tool its caller does not have, and keeps presets within it", async () => {
      const session = await openSubagentHarness((request) => {
        if (request.text === "Delegate it") {
          return call(["subagent", { task: "Explore", tools: "read", delegation: "fanout" }]);
        }

        if (request.agent === "agent-1" && request.text === "Explore") {
          return call(
            ["subagent", { task: "Run it", tools: ["bash"] }],
            ["subagent", { task: "Change it", tools: "modify" }],
          );
        }

        return answer("Done.");
      });

      await session.prompt("Delegate it");
      await session.settle();

      const { agents } = await session.state();
      const results = await session.texts("toolResult", agents["agent-1"]!.conversationId);

      expect(results[0]).toBe(
        "bash is unknown or outside your capability ceiling. Tools you may grant: read, grep, find, ls.",
      );
      expect(agents["agent-1"]?.contract.tools).toEqual(["read", "grep", "find", "ls"]);
      expect(agents["agent-1.agent-1"]?.contract.tools).toEqual(["read", "grep", "find", "ls"]);
      expect(results[1]).toContain(
        'warning: modifyToolset pattern "bash" matched none of your tools',
      );
      expect(
        session.requests.find((request) => request.agent === "agent-1.agent-1")?.tools,
      ).toEqual(["read", "grep", "find", "ls", "agent_message"]);
    });

    it("refuses coordinator tools in an exact tool list", async () => {
      const session = await openSubagentHarness((request) =>
        request.text === "Delegate it"
          ? call(["subagent", { task: "Work", tools: ["read", "subagent_wait"] }])
          : answer("Done."),
      );

      await session.prompt("Delegate it");

      expect((await session.texts("toolResult"))[0]).toBe(
        "Coordinator tools are granted by delegation and must not appear in tools: subagent_wait",
      );
      expect((await session.state()).agents).toEqual({});
    });
  });

  describe("tombstones", () => {
    it("never reuses a deleted ID, and skips it when numbering", async () => {
      const steps = [
        call(["subagent", { task: "Work", agent_id: "worker" }]),
        call(["subagent_delete", { agent_id: "worker" }]),
        call(["subagent", { task: "Work again", agent_id: "worker" }]),
        call(["agent_message", { agent_id: "worker", message: "Still there?" }]),
        call(["subagent", { task: "Work again", agent_id: "agent-1" }]),
        call(["subagent_delete", { agent_id: "agent-1" }]),
        call(["subagent", { task: "Numbered" }]),
      ];

      let step = 0;

      const session = await openSubagentHarness((request) => {
        if (request.agent !== "root") return answer("Done.");

        if (request.text.startsWith("[Subagent result")) return answer("Noted.");

        return steps[step++] ?? answer("Finished.");
      });

      await session.prompt("Go");
      await session.settle();

      const results = await session.texts("toolResult");

      expect(results).toEqual([
        expect.stringMatching(/^Spawned worker /),
        "Deleted worker; their IDs are retired.",
        "worker was deleted, and deleted IDs are never reused; choose another agent_id",
        "Agent worker was deleted",
        expect.stringMatching(/^Spawned agent-1 /),
        "Deleted agent-1; their IDs are retired.",
        expect.stringMatching(/^Spawned agent-2 /),
      ]);
      expect((await session.state()).tombstones).toEqual(["worker", "agent-1"]);
    });
  });
});
