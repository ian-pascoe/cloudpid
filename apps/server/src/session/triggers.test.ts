// The Session's `TriggerAccess` over a fake Registry and fake Trigger objects: each change is the Registry's Agent change
// by this Session, and the Trigger's object is woken after one that changed something.
// @effect-diagnostics asyncFunction:off
import type { AgentChange, TriggerDefinition } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { TriggerChanged } from "../registry/trigger-changes.ts";
import { sessionTriggers, type TriggersRegistry } from "./triggers.ts";

const DEFINITION: TriggerDefinition = {
  id: "t1",
  revision: 2,
  kind: "environment",
  environment: "default",
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
  whenBusy: "skip",
  paused: true,
  createdAt: 1,
  updatedAt: 2,
};

const CHANGE: AgentChange = {
  id: 7,
  scope: "default",
  at: 1,
  actor: "agent",
  session: "s-1",
  conversation: 0,
  tool: "trigger_pause",
  reason: "r",
  field: "triggers.t1",
  before: null,
  after: null,
  reverts: null,
  revertedBy: null,
};

const CHANGED: TriggerChanged = {
  status: "changed",
  definition: DEFINITION,
  environment: { id: "default", name: "Default" },
  change: CHANGE,
};

const setUp = (answer: TriggerChanged = CHANGED, listed = true) => {
  const calls: Array<{
    method: string;
    input: Parameters<TriggersRegistry[keyof TriggersRegistry]>[0];
  }> = [];

  const synced: string[] = [];

  /** What the fake Registry answers a change with, once it noted the change. */
  const answered = (
    method: string,
    input: Parameters<TriggersRegistry[keyof TriggersRegistry]>[0],
  ) =>
    Effect.sync(() => {
      calls.push({ method, input });

      return answer;
    });

  const registry: TriggersRegistry = {
    listTriggers: ({ environment }) =>
      Effect.succeed(environment === undefined || environment === "default" ? [DEFINITION] : []),
    triggerDefinition: ({ id }) => Effect.succeed(id === "t1" ? DEFINITION : null),
    agentCreateTrigger: (input) => answered("agentCreateTrigger", input),
    agentUpdateTrigger: (input) => answered("agentUpdateTrigger", input),
    agentSetTriggerPaused: (input) => answered("agentSetTriggerPaused", input),
    agentRemoveTrigger: (input) => answered("agentRemoveTrigger", input),
  };

  const access = sessionTriggers({
    registry,
    session: listed ? "s-1" : undefined,
    objects: {
      sync: (id) =>
        Effect.sync(() => {
          synced.push(id);
        }),
    },
  });

  return { access, calls, synced };
};

const author = { conversation: 0, tool: "trigger_pause", reason: "r" };

describe("the Session's Triggers", () => {
  it("makes each change as this Session's, and wakes the Trigger's object after it", async () => {
    const { access, calls, synced } = setUp();

    expect(
      await Effect.runPromise(access.setPaused({ id: "t1", paused: true, author })),
    ).toMatchObject({ status: "changed" });
    await Effect.runPromise(access.remove({ id: "t1", author }));
    await Effect.runPromise(access.update({ id: "t1", patch: { message: "m" }, author }));

    expect(calls).toEqual([
      {
        method: "agentSetTriggerPaused",
        input: {
          id: "t1",
          paused: true,
          expected: undefined,
          author: { session: "s-1", ...author },
        },
      },
      { method: "agentRemoveTrigger", input: { id: "t1", author: { session: "s-1", ...author } } },
      {
        method: "agentUpdateTrigger",
        input: {
          id: "t1",
          patch: { message: "m" },
          expected: undefined,
          author: { session: "s-1", ...author },
        },
      },
    ]);
    expect(synced).toEqual(["t1", "t1", "t1"]);
  });

  it("wakes no object when nothing changed", async () => {
    const { access, synced } = setUp({ status: "unchanged", definition: DEFINITION });

    await Effect.runPromise(access.setPaused({ id: "t1", paused: true, author }));

    expect(synced).toEqual([]);
  });

  it("reads the Registry's Triggers", async () => {
    const { access } = setUp();

    expect(await Effect.runPromise(access.list("default"))).toEqual([DEFINITION]);
    expect(await Effect.runPromise(access.get("nope"))).toBeNull();
    expect(await Effect.runPromise(access.newId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("changes nothing for a Session the Registry does not list", async () => {
    const { access, calls } = setUp(CHANGED, false);

    const failed = await Effect.runPromise(
      access.setPaused({ id: "t1", paused: true, author }).pipe(Effect.flip),
    );

    expect(failed.message).toContain("not one the Registry lists");
    expect(calls).toEqual([]);
  });
});
