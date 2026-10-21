// The Todo List through real runs: a scripted model manages the list across turns, a batch with one bad entry changes
// nothing, programs get the structured output, every conversation keeps its own list, and the list is put back in front
// of the model after a Handoff or a nested change. pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  answer,
  call,
  context,
  type Request,
  openContextHarness,
} from "./context/harness.fixture.ts";
import { SubagentsDoc } from "./subagents.ts";
import { Todo, TodoDoc } from "./todo.ts";
import {
  CHANGED_HEADER,
  RECONCILE_INSTRUCTION,
  SNAPSHOT_HEADER,
  STALE_NOTE,
} from "./todo/projection.ts";

/** Resolves when `run_todo_and_wait` has made its nested call. */
let waiting = Promise.withResolvers<void>();

/** Calls `todo` with a nested `executeTool`, as a code mode script does, and returns what the script gets. */
const Scripts = defineExtension({
  name: "scripts",
  tools: [
    defineTool({
      name: "run_todo",
      description: "Call todo as a script would and return its structured output",
      parameters: Type.Object({ args: Type.Any(), pad: Type.Optional(Type.Number()) }),
      execute: async (params, api, ctx) => {
        const nested = await api.executeTool("todo", params.args, ctx);
        const text = JSON.stringify(nested.structuredOutput);

        return { output: [{ type: "text", text: `${text}${"x".repeat(params.pad ?? 0)}` }] };
      },
    }),
    defineTool({
      name: "run_todo_and_wait",
      description: "Call todo as a script would, then wait to be stopped",
      parameters: Type.Object({ args: Type.Any() }),
      execute: async (params, api, ctx) => {
        await api.executeTool("todo", params.args, ctx);
        waiting.resolve();

        const aborted = Promise.withResolvers<void>();

        ctx.abortSignal?.addEventListener("abort", () => aborted.resolve());
        await aborted.promise;

        return { output: [{ type: "text", text: "stopped" }] };
      },
    }),
  ],
});

const open = (script: (request: Request) => ReturnType<typeof answer>, contextWindow?: number) =>
  openContextHarness(script, contextWindow, [Todo, Effect.succeed(Scripts)]);

/** The root conversation's list, as the document holds it. */
const listOf = async (session: Awaited<ReturnType<typeof open>>, id = ROOT_CONVERSATION_ID) =>
  (await session.harness.snapshot(TodoDoc, id, context))?.tasks ?? [];

const isBig = (text: string) => text.startsWith("xxxx");

describe("todo", () => {
  it("manages one list across turns", async () => {
    const session = await open((request) => {
      switch (request.text) {
        case "Plan":
          return call([
            "todo",
            {
              action: "add",
              tasks: [
                { title: "Write the tool" },
                { title: "Test it", description: "Through runs" },
              ],
            },
          ]);
        case "Start":
          return call(["todo", { action: "update", id: 1, status: "active" }]);
        case "Finish":
          return call([
            "todo",
            {
              action: "update",
              updates: [
                { id: 1, status: "completed" },
                { id: 2, status: "active", description: null },
              ],
            },
          ]);
        case "Drop":
          return call(["todo", { action: "remove", id: 2 }]);
        case "Show":
          return call(["todo", { action: "list" }]);
        default:
          return answer("Done.");
      }
    });

    for (const turn of ["Plan", "Start", "Finish", "Drop", "Show"]) await session.prompt(turn);

    expect(await session.results()).toEqual([
      "Added 2 Tasks\n[ ] #1 Write the tool\n[ ] #2 Test it\n    Through runs",
      "Updated Task #1\n[>] #1 Write the tool\n[ ] #2 Test it\n    Through runs",
      "Updated 2 Tasks\n[x] #1 Write the tool\n[>] #2 Test it",
      "Removed Task #2\n[x] #1 Write the tool",
      "[x] #1 Write the tool",
    ]);
    expect(await listOf(session)).toEqual([
      { id: 1, title: "Write the tool", status: "completed" },
    ]);
  });

  it("changes nothing when one entry of a batch is bad", async () => {
    const session = await open((request) => {
      switch (request.text) {
        case "Plan":
          return call(["todo", { action: "add", tasks: [{ title: "One" }, { title: "Two" }] }]);
        case "Bad update":
          return call([
            "todo",
            {
              action: "update",
              updates: [
                { id: 1, status: "completed" },
                { id: 99, status: "active" },
              ],
            },
          ]);
        case "Bad add":
          return call(["todo", { action: "add", tasks: [{ title: "Three" }, { title: "  " }] }]);
        case "Mixed":
          return call([
            "todo",
            { action: "update", id: 1, status: "active", updates: [{ id: 2 }] },
          ]);
        default:
          return answer("Done.");
      }
    });

    for (const turn of ["Plan", "Bad update", "Bad add", "Mixed"]) await session.prompt(turn);

    expect((await session.results()).slice(1)).toEqual([
      "Todo update failed: updates[1].id #99 was not found",
      "Todo add failed: tasks[1].title must not be empty",
      "Todo update failed: provide either id and fields or updates, not both",
    ]);
    // Neither the first update of the batch nor the first Task of the other was kept, and no ID was spent.
    expect(await listOf(session)).toEqual([
      { id: 1, title: "One", status: "pending" },
      { id: 2, title: "Two", status: "pending" },
    ]);
    expect((await session.harness.snapshot(TodoDoc, ROOT_CONVERSATION_ID, context))?.nextId).toBe(
      3,
    );
  });

  it("takes a null for a field the model leaves out, as pi-todo does", async () => {
    const session = await open((request) => {
      switch (request.text) {
        case "Add":
          return call([
            "todo",
            { action: "add", title: "One", description: null, id: null, tasks: null, status: null },
          ]);
        case "Batch":
          return call(["todo", { action: "add", tasks: [{ title: "Two", description: null }] }]);
        case "Update":
          return call([
            "todo",
            { action: "update", id: 1, status: "completed", title: null, updates: null },
          ]);
        default:
          return answer("Done.");
      }
    });

    for (const turn of ["Add", "Batch", "Update"]) await session.prompt(turn);

    expect(await listOf(session)).toEqual([
      { id: 1, title: "One", status: "completed" },
      { id: 2, title: "Two", status: "pending" },
    ]);
  });

  it("refuses a list too long for a result to show whole, and keeps the one it had", async () => {
    const long = { title: "Long", description: "d".repeat(2_000) };

    const adding = (count: number) =>
      call(["todo", { action: "add", tasks: Array.from({ length: count }, () => long) }]);

    const session = await open((request) => {
      if (request.text === "Fill") return adding(5);

      return request.text === "Overfill" ? adding(6) : answer("Done.");
    });

    await session.prompt("Fill");
    await session.prompt("Overfill");

    expect((await session.results()).at(-1)).toMatch(/^Todo add failed: the list would be over/);
    expect(await listOf(session)).toHaveLength(5);
  });

  it("gives programs the structured output", async () => {
    const session = await open((request) => {
      switch (request.text) {
        case "Run":
          return call([
            "run_todo",
            { args: { action: "add", tasks: [{ title: "A" }, { title: "B" }] } },
          ]);
        case "Run again":
          return call(["run_todo", { args: { action: "update", id: 2, title: "B2" } }]);
        case "Run last":
          return call(["run_todo", { args: { action: "clear" } }]);
        default:
          return answer("Done.");
      }
    });

    for (const turn of ["Run", "Run again", "Run last"]) await session.prompt(turn);

    expect((await session.results()).map((text) => JSON.parse(text.split("\n\n")[0]!))).toEqual([
      {
        action: "add",
        tasks: [
          { id: 1, title: "A", status: "pending" },
          { id: 2, title: "B", status: "pending" },
        ],
      },
      { action: "update", task: { id: 2, title: "B2", status: "pending" } },
      { action: "clear", cleared: 2 },
    ]);
  });

  it("keeps a list for each conversation", async () => {
    const session = await open((request) => {
      if (request.agent === "agent-1") {
        return request.text.startsWith("Added")
          ? answer("Listed.")
          : call(["todo", { action: "add", title: "Child task" }]);
      }

      if (request.text === "Delegate it") return call(["subagent", { task: "Delegated" }]);

      if (request.text === "Add mine") return call(["todo", { action: "add", title: "Root task" }]);

      return answer("Done.");
    });

    await session.prompt("Delegate it");
    await session.settle();
    await session.prompt("Add mine");
    await session.settle();

    const child = (await session.harness.snapshot(SubagentsDoc, context))!.agents["agent-1"]!;

    expect(await listOf(session)).toEqual([{ id: 1, title: "Root task", status: "pending" }]);
    expect(await listOf(session, child.conversationId)).toEqual([
      { id: 1, title: "Child task", status: "pending" },
    ]);
  });

  it("gives a subagent started with a preset a Todo List too", async () => {
    const session = await open((request) =>
      request.agent === "agent-1"
        ? answer("Done.")
        : request.text === "Delegate it"
          ? call(["subagent", { task: "Read only", tools: "read" }])
          : answer("Done."),
    );

    await session.prompt("Delegate it");
    await session.settle();

    expect(session.requests.find((request) => request.agent === "agent-1")!.tools).toContain(
      "todo",
    );
  });

  describe("in the model's context", () => {
    /**
     * Plans two Tasks, finishes one, and then fills the context until the agent is asked to roll over, which it does. After
     * the Handoff, `after` answers.
     */
    const longTask =
      (after: (request: Request) => ReturnType<typeof answer>) => (request: Request) => {
        if (request.transcript.some((text) => text.includes("Continue with the second Task"))) {
          return after(request);
        }

        if (request.text === "Start the long task") {
          return call([
            "todo",
            { action: "add", tasks: [{ title: "First" }, { title: "Second" }] },
          ]);
        }

        if (request.text.startsWith("Added 2 Tasks")) {
          return call(["todo", { action: "update", id: 1, status: "completed" }]);
        }

        if (request.text.startsWith("Updated Task #1")) return call(["big", {}]);

        if (isBig(request.text) && request.transcript.filter(isBig).length < 2) {
          return call(["big", {}]);
        }

        if (request.text.includes("Prepare a Context Rollover")) {
          return call([
            "context_rollover",
            { handoff: "Continue with the second Task of the long task." },
          ]);
        }

        return call(["noop", {}]);
      };

    it("puts the list into the window's first message after a Handoff, the same in every request", async () => {
      const session = await open(
        longTask((request) =>
          request.text.startsWith("Updated")
            ? answer("Done.")
            : call(["todo", { action: "update", id: 2, status: "active" }]),
        ),
      );

      await session.prompt("Start the long task");
      await session.settle();

      const kinds = (await session.entries()).map((entry) => entry.kind);

      const rolled = session.requests.findIndex((request) =>
        request.transcript[0]?.includes("Continue with the second Task"),
      );

      const window = session.requests.slice(rolled);

      expect(kinds).toContain("pi.reset");
      expect(window.length).toBeGreaterThanOrEqual(2);
      // The Handoff took the `todo` results out of the context; the document still had the list, which the window's
      // first message now holds, as the first request of the window found it.
      expect(window[0]!.transcript[0]).toContain("Continue with the second Task of the long task.");
      expect(window[0]!.transcript[0]).toContain(
        `${SNAPSHOT_HEADER}\n[x] #1 First\n[ ] #2 Second\n\n${RECONCILE_INSTRUCTION}`,
      );
      expect(
        window
          .flatMap((request) => request.transcript)
          .filter((text) => text.includes("Added 2 Tasks")),
      ).toEqual([]);
      // The provider caches the messages up to the last one, so none before it may change between requests: the agent
      // changed the list in between, and the first message still says what it said.
      expect(window.map((request) => request.transcript[0])).toEqual(
        window.map(() => window[0]!.transcript[0]),
      );
      expect(window.at(-1)!.text).toContain("[>] #2 Second");
      // No message of its own: two user messages in a row are not valid for every provider.
      expect(window[0]!.transcript.filter((text) => text.includes(SNAPSHOT_HEADER))).toHaveLength(
        1,
      );
    });

    it("puts the list into the first message after a compaction took the results out", async () => {
      const session = await open((request) => {
        if (request.transcript.some((text) => text.includes("Emergency Rollover"))) {
          return answer("Recovered.");
        }

        if (request.text === "Start the long task") {
          return call([
            "todo",
            { action: "add", tasks: [{ title: "First" }, { title: "Second" }] },
          ]);
        }

        return call(["big", {}]);
      });

      await session.prompt("Start the long task");
      await session.settle();

      const kinds = (await session.entries()).map((entry) => entry.kind);
      const after = session.requests.at(-1)!;

      // Nobody rolled over: the blocking threshold took the Emergency Rollover, which drops the `todo` result too.
      expect(kinds).toContain("pi.compaction");
      expect(after.transcript.filter((text) => text.includes("Added 2 Tasks"))).toEqual([]);
      expect(after.transcript[0]).toContain(
        `${SNAPSHOT_HEADER}\n[ ] #1 First\n[ ] #2 Second\n\n${RECONCILE_INSTRUCTION}`,
      );
    });

    it("shows the list once, in the result, while a result of the current list is in the context", async () => {
      const session = await open((request) =>
        request.text === "Plan"
          ? call(["todo", { action: "add", title: "Only" }])
          : request.text.startsWith("Added")
            ? call(["todo", { action: "list" }])
            : answer("Done."),
      );

      await session.prompt("Plan");

      const sent = session.requests.flatMap((request) => request.transcript);

      expect(sent.filter((text) => text.includes(SNAPSHOT_HEADER))).toEqual([]);
    });

    it("commits the list into the result of a call whose script changed it", async () => {
      const session = await open((request) => {
        switch (request.text) {
          case "Plan":
            return call(["todo", { action: "add", tasks: [{ title: "A" }, { title: "B" }] }]);
          case "Script":
            return call(["run_todo", { args: { action: "update", id: 1, status: "completed" } }]);
          default:
            return answer("Done.");
        }
      });

      await session.prompt("Plan");

      const before = session.requests.length;

      await session.prompt("Script");

      const last = session.requests.at(-1)!;

      // The script's nested call left no `todo` result in the context, so the result of the call that ran it shows the
      // list, where it stays: nothing before the result changed, and the first message did not get a copy.
      expect(last.text).toContain(`${CHANGED_HEADER}\n[x] #1 A\n[ ] #2 B`);
      expect(last.transcript.filter((text) => text.includes(SNAPSHOT_HEADER))).toEqual([]);
      expect(session.requests[before]!.transcript.slice(0, 3)).toEqual(last.transcript.slice(0, 3));
    });

    it("tells the agent, at the end of the request, when a Stop left a script's change without a result", async () => {
      waiting = Promise.withResolvers<void>();

      const session = await open((request) => {
        switch (request.text) {
          case "Plan":
            return call(["todo", { action: "add", tasks: [{ title: "A" }, { title: "B" }] }]);
          case "Script":
            return call([
              "run_todo_and_wait",
              { args: { action: "update", id: 1, status: "completed" } },
            ]);
          case "Next":
            return call(["noop", {}]);
          default:
            return request.text.includes(STALE_NOTE)
              ? call(["todo", { action: "list" }])
              : answer("Done.");
        }
      });

      await session.prompt("Plan");

      const stopped = session.root.submit({ type: "input", content: "Script" }, context);

      await waiting.promise;
      await session.root.abort(context);
      await (await stopped).wait(context);
      await session.settle();

      const before = session.requests.length;

      await session.prompt("Next");

      const asked = session.requests.slice(before);
      const earlier = session.requests[0]!;

      // The stopped call's nested change never got a result, so the list the context shows is behind. The agent is told
      // so at the end of the request, and nothing earlier changed: the first message is as it was.
      expect(asked[0]!.text).toContain("Next");
      expect(asked.at(-1)!.text).not.toContain(STALE_NOTE);
      expect(asked.some((request) => request.text.includes(STALE_NOTE))).toBe(true);
      expect(asked.every((request) => request.transcript[0] === earlier.transcript[0])).toBe(true);
      expect(asked.flatMap((request) => request.transcript)).not.toContain(
        expect.stringContaining(SNAPSHOT_HEADER),
      );
      // Calling `todo` shows the list, which ends the note.
      expect(asked.at(-1)!.text).toBe("[x] #1 A\n[ ] #2 B");
    });

    it("does not claim a list a result is too long to show whole", async () => {
      const session = await open((request) => {
        switch (request.text) {
          case "Plan":
            return call(["todo", { action: "add", tasks: [{ title: "A" }, { title: "B" }] }]);
          case "Script":
            return call([
              "run_todo",
              { args: { action: "update", id: 1, status: "completed" }, pad: 45_000 },
            ]);
          default:
            return answer("Done.");
        }
      }, 10_000_000);

      await session.prompt("Plan");
      await session.prompt("Script");

      const last = session.requests.at(-1)!;

      expect(last.text).not.toContain(CHANGED_HEADER);
      expect(last.text).toContain(STALE_NOTE);
    });

    it("says nothing about a list that was never used", async () => {
      const session = await open(() => answer("Hello."));

      await session.prompt("Hi");

      expect(session.requests.flatMap((request) => request.transcript)).toEqual(["Hi"]);
    });

    it("tells the agent when a script emptied a list it saw", async () => {
      const session = await open((request) => {
        switch (request.text) {
          case "Plan":
            return call(["todo", { action: "add", title: "A" }]);
          case "Script":
            return call(["run_todo", { args: { action: "clear" } }]);
          default:
            return answer("Done.");
        }
      });

      await session.prompt("Plan");
      await session.prompt("Script");

      expect(session.requests.at(-1)!.text).toContain(`${CHANGED_HEADER}\nTodo List is empty`);
    });
  });
});
