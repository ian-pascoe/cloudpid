// The subagent tools through real runs: a scripted model drives the root and its children in one Harness.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  answer,
  call,
  context,
  fakeSubagentWorkspaces,
  gate,
  openSubagentHarness,
} from "./subagents/harness.fixture.ts";
import { isAgentConversation, stopConversation } from "./subagents/owner.ts";
import { conversationWorkspace, SubagentsDoc } from "./subagents/state.ts";

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

  it("holds a child's answer while its parent is busy, so a later wait still claims it", async () => {
    let settled = async () => false;

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") return answer("Quick answer.");

      if (request.text === "Delegate it") return call(["subagent", { task: "Be quick" }]);

      if (request.text.startsWith("Spawned")) {
        while (!(await settled())) await new Promise((resolve) => setTimeout(resolve, 5));

        return call(["subagent_wait", { agent_id: "agent-1" }]);
      }

      return answer(`Root saw: ${request.text}`);
    });

    settled = async () =>
      (await session.state()).agents["agent-1"]?.turns[0]?.status === "completed";
    await session.prompt("Delegate it");
    await session.settle();

    expect((await session.texts("toolResult"))[1]).toMatch(
      /^agent-1 turn-1 completed \([\d.]+s\)\n\nQuick answer\.$/,
    );
    expect(await session.texts("user")).toEqual(["Delegate it"]);
    expect((await session.state()).agents["agent-1"]?.turns).toMatchObject([
      { id: "turn-1", status: "completed", delivery: "wait" },
    ]);
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

  it("sends a child's message to the root agent to the Session branch it was started from", async () => {
    const moved = gate();

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        if (request.text !== "Find the answer") return answer("Done.");

        await moved.promise;

        return call(["agent_message", { message: "Still on it" }]);
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "Find the answer" }]);

      return answer("Noted.");
    });

    await session.prompt("Delegate it");

    // The owner moves to another Session branch while the child works.
    const at = (await session.entries()).at(-1)!.id;

    const branch = await session.harness.commit(async (tx) => {
      const fork = await tx.forkConversation(ROOT_CONVERSATION_ID, at, {
        ownership: { kind: "ownerless" },
      });

      const doc = await tx.doc(SubagentsDoc);

      doc.activeBranch = fork.id;
      doc.branches = [fork.id];

      return fork.id;
    }, context);

    moved.resolve();
    await session.settle();

    expect((await session.texts("user")).some((text) => text.endsWith("Still on it"))).toBe(true);
    expect((await session.texts("user", branch)).some((text) => text.endsWith("Still on it"))).toBe(
      false,
    );
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

  it("refuses the reserved IDs root and parent", async () => {
    let step = 0;

    const steps = [
      call(["subagent", { task: "Work", agent_id: "root" }]),
      call(["subagent", { task: "Work", agent_id: "parent" }]),
    ];

    const session = await openSubagentHarness((request) =>
      request.agent === "root" ? (steps[step++] ?? answer("Done.")) : answer("Done."),
    );

    await session.prompt("Go");
    await session.settle();

    expect(await session.texts("toolResult")).toEqual([
      "root is reserved; choose another agent_id",
      "parent is reserved; choose another agent_id",
    ]);
    expect((await session.state()).agents).toEqual({});
  });

  it("refuses a second wait on a child it already waits for, and the first still gets the answer", async () => {
    const ready = gate();

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        await ready.promise;

        return answer("The answer is 42.");
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "Find the answer" }]);

      if (request.text.startsWith("Spawned")) {
        return call(
          ["subagent_wait", { agent_id: "agent-1" }],
          ["subagent_wait", { agent_id: "agent-1" }],
        );
      }

      return answer("Noted.");
    });

    const answered = session.prompt("Delegate it");

    await session.until(
      async () => (await session.texts("toolResult")).some((text) => text.startsWith("Duplicate")),
      "the second wait to be refused",
    );
    ready.resolve();
    await answered;
    await session.settle();

    expect((await session.texts("toolResult")).slice(1).sort()).toEqual([
      "Duplicate wait: you are already waiting for agent-1",
      expect.stringMatching(/^agent-1 turn-1 completed \([\d.]+s\)\n\nThe answer is 42\.$/),
    ]);
    expect((await session.state()).waiters).toEqual({});
  });

  it("delivers one answer once when a wait claims a later input steered into the same run", async () => {
    const ready = gate();

    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        if (request.text === "Work") {
          await ready.promise;

          return call(["read", {}]);
        }

        return answer("Shared answer.");
      }

      if (request.text === "Delegate it") {
        return call(
          ["subagent", { task: "Work", tools: "read" }],
          ["agent_message", { agent_id: "agent-1", message: "Also this" }],
          ["subagent_wait", { agent_id: "agent-1", turn_id: "turn-2" }],
        );
      }

      return answer("Noted.");
    });

    const answered = session.prompt("Delegate it");

    await session.until(
      async () => Object.keys((await session.state()).waiters).length === 1,
      "the wait to block",
    );
    ready.resolve();
    await answered;
    await session.settle();

    const turns = (await session.state()).agents["agent-1"]?.turns ?? [];

    expect((await session.texts("toolResult"))[1]).toBe(
      "Message queued into agent-1's active turn.",
    );
    expect((await session.texts("toolResult"))[2]).toMatch(/\n\nShared answer\.$/);
    expect(turns[0]?.answer).toBe(turns[1]?.answer);
    expect(turns.map((turn) => turn.delivery)).toEqual(["duplicate", "wait"]);
    expect(await session.texts("user")).toEqual(["Delegate it"]);
  });

  describe("a wait after inputs steered into one run have settled", () => {
    const settledRun = async (turnId: string | undefined) => {
      const ready = gate();
      let settled = async () => false;

      const session = await openSubagentHarness(async (request) => {
        if (request.agent === "agent-1") {
          if (request.text === "Work") {
            await ready.promise;

            return call(["read", {}]);
          }

          return answer("Shared answer.");
        }

        if (request.text === "Delegate it") {
          return call(
            ["subagent", { task: "Work", tools: "read" }],
            ["agent_message", { agent_id: "agent-1", message: "Also this" }],
          );
        }

        if (request.text.startsWith("Message queued")) {
          ready.resolve();

          while (!(await settled())) await new Promise((resolve) => setTimeout(resolve, 5));

          return call([
            "subagent_wait",
            turnId === undefined
              ? { agent_id: "agent-1" }
              : { agent_id: "agent-1", turn_id: turnId },
          ]);
        }

        return answer("Noted.");
      });

      settled = async () =>
        ((await session.state()).agents["agent-1"]?.turns ?? []).every(
          (turn) => turn.status === "completed",
        );
      await session.prompt("Delegate it");
      await session.settle();

      return session;
    };

    for (const turnId of [undefined, "turn-2"]) {
      it(`claims the held answer once, with turn_id ${turnId ?? "omitted"}`, async () => {
        const session = await settledRun(turnId);
        const turns = (await session.state()).agents["agent-1"]?.turns ?? [];

        expect((await session.texts("toolResult"))[2]).toMatch(
          /^agent-1 turn-2 completed \([\d.]+s\)\n\nShared answer\.$/,
        );
        expect(turns.map((turn) => turn.delivery)).toEqual(["duplicate", "wait"]);
        expect(await session.texts("user")).toEqual(["Delegate it"]);
      });
    }
  });

  describe("roles", () => {
    const roles = {
      small: { model: { provider: "faux", modelId: "faux-small" }, hint: "Cheap and fast." },
    };

    it("runs a child on its role's model and lists the roles to an agent that may spawn", async () => {
      const session = await openSubagentHarness(
        (request) =>
          request.text === "Delegate it"
            ? call(["subagent", { task: "Work", role: "small" }])
            : answer("Done."),
        { roles },
      );

      await session.prompt("Delegate it");
      await session.settle();

      expect(session.requests.find((request) => request.agent === "agent-1")?.model).toBe(
        "faux-small",
      );
      expect(session.requests[0]?.system).toContain("- small (faux/faux-small): Cheap and fast.");
      expect((await session.state()).agents["agent-1"]?.contract).toMatchObject({
        role: "small",
        model: "faux/faux-small",
      });
    });

    it("refuses an unknown role, naming the configured ones", async () => {
      const session = await openSubagentHarness(
        (request) =>
          request.text === "Delegate it"
            ? call(["subagent", { task: "Work", role: "huge" }])
            : answer("Done."),
        { roles },
      );

      await session.prompt("Delegate it");
      await session.settle();

      expect(await session.texts("toolResult")).toEqual([
        "Unknown role huge. Configured roles: small.",
      ]);
    });
  });

  describe("session_context", () => {
    const roles = {
      small: { model: { provider: "faux", modelId: "faux-small" }, hint: "Cheap and fast." },
    };

    const spawnWith = (sessionContext: "inherit" | "compact") =>
      openSubagentHarness(
        (request) => {
          if (request.text === "The code word is PINEAPPLE") return answer("Understood.");

          if (request.text === "Delegate it") {
            return call([
              "subagent",
              { task: "Say the code word", session_context: sessionContext },
            ]);
          }

          if (request.agent === "root" && request.text.includes("<parent_message")) {
            return answer("Summary: the code word is PINEAPPLE.");
          }

          return answer("Done.");
        },
        { roles },
      );

    it("inherit quotes the parent's conversation before the task", async () => {
      const session = await spawnWith("inherit");

      await session.prompt("The code word is PINEAPPLE");
      await session.prompt("Delegate it");
      await session.settle();

      const child = session.requests.find((request) => request.agent === "agent-1")?.text ?? "";

      expect(child).toMatch(/^<parent_context mode="inherit">\n/);
      expect(child).toContain(
        '<parent_message role="user">\nThe code word is PINEAPPLE\n</parent_message>',
      );
      expect(child).toContain('<parent_message role="assistant">\nUnderstood.\n</parent_message>');
      expect(child).toMatch(/Your own assignment:\n\nSay the code word$/);
    });

    it("compact summarizes the parent's conversation with the small role's model", async () => {
      const session = await spawnWith("compact");

      await session.prompt("The code word is PINEAPPLE");
      await session.prompt("Delegate it");
      await session.settle();

      const summary = session.requests.find((request) => request.text.includes("<parent_message"));
      const child = session.requests.find((request) => request.agent === "agent-1")?.text ?? "";

      expect(summary?.model).toBe("faux-small");
      expect(child).toMatch(
        /^<parent_context mode="compact">\nSummary: the code word is PINEAPPLE\.\n<\/parent_context>/,
      );
      expect(child).toMatch(/Your own assignment:\n\nSay the code word$/);
    });
  });

  it("cancels a child's turn, ending a wait on it, and keeps the child for a later message", async () => {
    const session = await openSubagentHarness(async (request) => {
      if (request.agent === "agent-1") {
        if (request.text === "Work") {
          // Ends with the cancel, which aborts the request.
          await new Promise((resolve) => request.signal?.addEventListener("abort", resolve));

          return answer("Too late.");
        }

        return answer("Resumed.");
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "Work" }]);

      if (request.text.startsWith("Spawned")) {
        return call(
          ["subagent_wait", { agent_id: "agent-1" }],
          ["subagent_cancel", { agent_id: "agent-1" }],
        );
      }

      if (request.text.startsWith("Cancelled") || request.text.startsWith("agent-1 turn-1")) {
        return call(["agent_message", { agent_id: "agent-1", message: "Continue" }]);
      }

      return answer("Noted.");
    });

    await session.prompt("Delegate it");
    await session.settle();

    const results = await session.texts("toolResult");

    expect(results).toContain("Cancelled agent-1.");
    expect(results).toContainEqual(expect.stringMatching(/^agent-1 turn-1 aborted /));
    expect((await session.state()).agents["agent-1"]?.turns).toMatchObject([
      { id: "turn-1", status: "aborted", delivery: "wait" },
      { id: "turn-2", status: "completed", delivery: "auto" },
    ]);
    expect((await session.texts("user")).at(-1)).toBe(
      "[Subagent result | agent=agent-1 | turn=turn-2 | status=completed]\nResumed.",
    );
  });

  describe("the owner stopping the root while a child's report is held", () => {
    /** The root is busy when the child answers, so the report is held; then the owner stops the root. */
    const stopWhileHeld = async (subagents: boolean) => {
      const session = await openSubagentHarness(async (request) => {
        if (request.agent === "agent-1") return answer("Quick answer.");

        if (request.text === "Delegate it") return call(["subagent", { task: "Be quick" }]);

        if (request.text.startsWith("Spawned")) {
          // Busy until the owner stops it.
          await new Promise((resolve) => request.signal?.addEventListener("abort", resolve));

          return answer("Stopped.");
        }

        return answer(`Root saw: ${request.text}`);
      });

      const run = session.prompt("Delegate it");

      await session.until(
        async () => (await session.state()).agents["agent-1"]?.turns[0]?.delivery === "pending",
        "the report to be held",
      );
      await stopConversation(session.harness, ROOT_CONVERSATION_ID, { subagents }, context);
      await run;
      await session.settle();

      return session;
    };

    it("still delivers the report once the root is idle after a plain Stop, which starts a new run", async () => {
      const session = await stopWhileHeld(false);

      expect(await session.texts("user")).toEqual([
        "Delegate it",
        "[Subagent result | agent=agent-1 | turn=turn-1 | status=completed]\nQuick answer.",
      ]);
    });

    it("drops the report when the owner stops all, so nothing starts a new run", async () => {
      const session = await stopWhileHeld(true);

      expect(await session.texts("user")).toEqual(["Delegate it"]);
      expect((await session.state()).agents["agent-1"]?.turns).toMatchObject([
        { id: "turn-1", status: "completed", delivery: "none" },
      ]);
    });
  });

  it("lets the owner address the root and a live subagent, but not one that was deleted", async () => {
    const session = await openSubagentHarness((request) => {
      if (request.agent === "agent-1") return answer("Done.");

      if (request.text === "Delegate it") return call(["subagent", { task: "Work" }]);

      if (request.text === "Remove it") return call(["subagent_delete", { agent_id: "agent-1" }]);

      return answer("Noted.");
    });

    await session.prompt("Delegate it");
    await session.settle();

    const child = (await session.state()).agents["agent-1"]?.conversationId;

    if (child === undefined) throw new Error("No child was started");

    expect(await isAgentConversation(session.harness, ROOT_CONVERSATION_ID, context)).toBe(true);
    expect(await isAgentConversation(session.harness, child, context)).toBe(true);

    await session.prompt("Remove it");
    await session.settle();

    expect((await session.state()).tombstones).toContain("agent-1");
    expect(await isAgentConversation(session.harness, child, context)).toBe(false);
  });
});

describe("Subagent Workspaces", () => {
  const CLEAN =
    "[Subagent Workspace 00000001 | branch cloudpid/00000001 | everything is committed and pushed]";

  it("starts a child in a Workspace of its own, tells it its branch, and records it", async () => {
    const workspaces = fakeSubagentWorkspaces();

    workspaces.warn(["app has 1 commit not pushed on main: it does not reach the child"]);

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "agent-1") return answer("Done.");

        if (request.text === "Delegate it") {
          return call(["subagent", { task: "Fix it", workspace: "new", base: "main" }]);
        }

        return answer("Noted.");
      },
      {},
      [],
      workspaces.host,
    );

    await session.prompt("Delegate it");
    await session.settle();

    expect(workspaces.requests).toEqual([
      { agent: "agent-1", parent: null, base: "main", branch: undefined, limit: 3 },
    ]);

    const spawned = (await session.texts("toolResult"))[0];

    expect(spawned).toContain("Subagent Workspace 00000001, on branch cloudpid/00000001");
    expect(spawned).toContain(
      "warning: app has 1 commit not pushed on main: it does not reach the child",
    );

    const agent = (await session.state()).agents["agent-1"]!;

    expect(agent.workspace).toEqual({
      id: "00000001",
      branch: "cloudpid/00000001",
      object: "ws:00000001",
      directory: "/workspace/app",
    });

    const [first] = await session.texts("user", agent.conversationId);

    expect(first).toContain("on the branch cloudpid/00000001");
    expect(first).toContain("push cloudpid/00000001");
    expect(first).toMatch(/Fix it$/);
  });

  it("ends each report with the child's branch and what it has not pushed", async () => {
    const workspaces = fakeSubagentWorkspaces();
    const ready = gate();

    const session = await openSubagentHarness(
      async (request) => {
        if (request.agent === "agent-1") {
          if (request.text.includes("again")) {
            await ready.promise;

            return answer("Second.");
          }

          return answer("First.");
        }

        if (request.text === "Delegate it") {
          return call(["subagent", { task: "Work", workspace: "new" }]);
        }

        if (request.text === "Ask again") {
          return call(
            ["agent_message", { agent_id: "agent-1", message: "Work again" }],
            ["subagent_wait", { agent_id: "agent-1" }],
          );
        }

        return answer("Noted.");
      },
      {},
      [],
      workspaces.host,
    );

    await session.prompt("Delegate it");
    await session.settle();

    expect((await session.texts("user"))[1]).toBe(
      `[Subagent result | agent=agent-1 | turn=turn-1 | status=completed]\nFirst.\n\n${CLEAN}`,
    );

    workspaces.work.set("00000001", [
      { repo: "app", cloned: true, uncommitted: 1, unpushed: 2, onRemote: true },
    ]);

    const asked = session.prompt("Ask again");

    await session.until(
      async () => Object.keys((await session.state()).waiters).length === 1,
      "the wait to block",
    );
    ready.resolve();
    await asked;
    await session.settle();

    expect((await session.texts("toolResult")).at(-1)).toMatch(
      /^agent-1 turn-2 completed \([\d.]+s\)\n\nSecond\.\n\n\[Subagent Workspace 00000001 \| branch cloudpid\/00000001 \| app: 2 commits not pushed, 1 uncommitted change\]$/,
    );
  });

  it("refuses a spawn the Session refuses a Workspace for, and base or branch for a shared one", async () => {
    const workspaces = fakeSubagentWorkspaces();

    workspaces.refuse(
      "This Session has 3 Subagent Workspaces, the Subagent Workspace limit (3): delete one with subagent_delete, or ask for a higher limit with settings_subagent_workspaces_set.",
    );

    const session = await openSubagentHarness(
      (request) => {
        if (request.text === "Delegate it") {
          return call(
            ["subagent", { task: "Work", workspace: "new" }],
            ["subagent", { task: "Work", branch: "mine" }],
          );
        }

        return answer("Noted.");
      },
      {},
      [],
      workspaces.host,
    );

    await session.prompt("Delegate it");
    await session.settle();

    const [limited, shared] = await session.texts("toolResult");

    expect(limited).toContain("the Subagent Workspace limit (3)");
    expect(limited).toContain("settings_subagent_workspaces_set");
    expect(shared).toContain('base and branch are only for workspace: "new"');
    expect((await session.state()).agents).toEqual({});
  });

  it("gives a grandchild its parent's Workspace when shared, and starts a new one from it", async () => {
    const workspaces = fakeSubagentWorkspaces();

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "agent-1" && request.text.includes("Split it")) {
          return call(
            ["subagent", { task: "Shared part", agent_id: "near" }],
            ["subagent", { task: "Own part", agent_id: "far", workspace: "new" }],
          );
        }

        if (request.text === "Delegate it") {
          return call(["subagent", { task: "Split it", workspace: "new", delegation: "fanout" }]);
        }

        return answer("Done.");
      },
      {},
      [],
      workspaces.host,
    );

    await session.prompt("Delegate it");
    await session.settle();

    const own = workspaces.made.get("agent-1");

    expect(workspaces.requests[1]).toMatchObject({ agent: "agent-1.far", parent: own });

    const state = await session.state();

    expect(state.agents["agent-1.near"]?.workspace).toBeUndefined();
    expect(conversationWorkspace(state, state.agents["agent-1.near"]!.conversationId)).toEqual(own);
    expect(conversationWorkspace(state, state.agents["agent-1.far"]!.conversationId)).toMatchObject(
      { id: "00000002" },
    );
  });

  it("refuses to delete a child whose Workspace has work not pushed, unless told to discard it, and removes it", async () => {
    const workspaces = fakeSubagentWorkspaces();

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "agent-1") return answer("Done.");

        if (request.text === "Delegate it") {
          return call(["subagent", { task: "Work", workspace: "new" }]);
        }

        if (request.text === "Remove it") {
          return call(["subagent_delete", { agent_id: "agent-1" }]);
        }

        if (request.text === "Discard it") {
          return call(["subagent_delete", { agent_id: "agent-1", discard: true }]);
        }

        return answer("Noted.");
      },
      {},
      [],
      workspaces.host,
    );

    await session.prompt("Delegate it");
    await session.settle();
    workspaces.work.set("00000001", [
      { repo: "app", cloned: true, uncommitted: 0, unpushed: 3, onRemote: false },
    ]);
    await session.prompt("Remove it");
    await session.settle();

    expect((await session.texts("toolResult")).at(-1)).toContain(
      "agent-1 (branch cloudpid/00000001): app: 3 commits not pushed",
    );
    expect((await session.state()).agents["agent-1"]).toBeDefined();
    expect(workspaces.removed).toEqual([]);

    await session.prompt("Discard it");
    await session.settle();

    expect((await session.state()).tombstones).toContain("agent-1");
    expect(workspaces.removed).toEqual(["00000001"]);
  });

  it("removes a child's Workspace with it when everything is pushed", async () => {
    const workspaces = fakeSubagentWorkspaces();

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "agent-1") return answer("Done.");

        if (request.text === "Delegate it") {
          return call(["subagent", { task: "Work", workspace: "new" }]);
        }

        if (request.text === "Remove it") {
          return call(["subagent_delete", { agent_id: "agent-1" }]);
        }

        return answer("Noted.");
      },
      {},
      [],
      workspaces.host,
    );

    await session.prompt("Delegate it");
    await session.settle();
    await session.prompt("Remove it");
    await session.settle();

    expect(workspaces.removed).toEqual(["00000001"]);
  });
});
