// The summary of a Session's subagents it keeps in the Registry (ADR-0024): throttled, the last state always written,
// and a write that failed written again. The host's side is covered in workerd (`subagents.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import type { GraphAgent, SessionAgent } from "@cloudpid/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsReport, sessionAgentsOf } from "./agents-report.ts";

/** What the report reads, and whether its writes fail. */
type Fixture = { agents: SessionAgent[]; failing?: boolean };

const agent = (id: string, status: SessionAgent["status"]): SessionAgent => ({
  id,
  parent: "root",
  role: null,
  status,
});

describe("sessionAgentsOf", () => {
  it("keeps what the Session list shows of each agent, in the task graph's order", () => {
    const graph: GraphAgent[] = [
      {
        id: "agent-1",
        parent: "root",
        // SAFETY: a test conversation ID.
        conversationId: 3 as GraphAgent["conversationId"],
        role: "small",
        model: "anthropic/claude",
        status: "working",
        branch: "cloudpid/agent-1",
      },
      {
        id: "agent-1.child",
        parent: "agent-1",
        // SAFETY: as above.
        conversationId: 4 as GraphAgent["conversationId"],
        role: null,
        model: "anthropic/claude",
        status: "idle",
      },
    ];

    expect(sessionAgentsOf(graph)).toEqual([
      {
        id: "agent-1",
        parent: "root",
        role: "small",
        status: "working",
        branch: "cloudpid/agent-1",
      },
      { id: "agent-1.child", parent: "agent-1", role: null, status: "idle" },
    ]);
  });
});

describe("the agents report", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A report over `state`, recording each write; `failing` makes the writes fail. */
  const reporting = (state: Fixture) => {
    const writes: SessionAgent[][] = [];
    const warn = vi.fn();

    const report = new AgentsReport({
      read: async () => state.agents,
      write: async (agents) => {
        if (state.failing === true) throw new Error("The Registry is unreachable");

        writes.push([...agents]);
      },
      intervalMs: 2_000,
      warn,
    });

    return { report, writes, warn };
  };

  it("writes a change at once, then at most once per interval, the last state last", async () => {
    const state = { agents: [agent("agent-1", "working")] };
    const { report, writes } = reporting(state);

    report.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([[agent("agent-1", "working")]]);

    // A burst within the interval is one write, at its end, of how things stand then.
    state.agents = [agent("agent-1", "idle")];
    report.changed();
    state.agents = [agent("agent-1", "idle"), agent("agent-2", "working")];
    report.changed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toEqual([
      [agent("agent-1", "working")],
      [agent("agent-1", "idle"), agent("agent-2", "working")],
    ]);
  });

  it("does not write what the Registry already holds", async () => {
    const state = { agents: [agent("agent-1", "idle")] };
    const { report, writes } = reporting(state);

    expect(await report.settle()).toBe(true);
    report.changed();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toHaveLength(1);
  });

  it("writes now when settled, whatever the interval, and says whether the Registry has it", async () => {
    const state = { agents: [agent("agent-1", "working")] };
    const { report, writes } = reporting(state);

    expect(await report.settle()).toBe(true);
    state.agents = [agent("agent-1", "idle")];
    report.changed();
    // Within the interval of the last write: settling does not wait for it.
    expect(await report.settle()).toBe(true);
    expect(writes).toEqual([[agent("agent-1", "working")], [agent("agent-1", "idle")]]);
    // And the timer it replaced writes nothing more.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toHaveLength(2);
  });

  it("writes a change no one announced when settled, and only once", async () => {
    const state = { agents: [agent("agent-1", "working")] };
    const { report, writes } = reporting(state);

    expect(await report.settle()).toBe(true);
    // A stop ends the agent before the task graph's watch says `changed`: settling reads it anyway.
    state.agents = [agent("agent-1", "idle")];
    expect(await report.settle()).toBe(true);
    expect(await report.settle()).toBe(true);
    expect(writes).toEqual([[agent("agent-1", "working")], [agent("agent-1", "idle")]]);

    // The watch's late `changed` finds nothing new to write.
    report.changed();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toHaveLength(2);
  });

  it("logs a write that fails and writes it again when retried or settled", async () => {
    const state: Fixture = { agents: [agent("agent-1", "working")], failing: true };

    const { report, writes, warn } = reporting(state);

    expect(await report.settle()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // Nothing retries it by itself: the host's heartbeat does.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(warn).toHaveBeenCalledTimes(1);

    state.failing = false;
    report.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([[agent("agent-1", "working")]]);

    // A retry with nothing due writes nothing.
    report.retry();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toHaveLength(1);
  });

  it("writes nothing once stopped", async () => {
    const state = { agents: [agent("agent-1", "working")] };
    const { report, writes } = reporting(state);

    report.changed();
    report.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual([]);
  });
});
