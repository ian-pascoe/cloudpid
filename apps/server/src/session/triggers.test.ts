// The Session's `TriggerAccess` over a fake Registry and fake Trigger objects: each change is the Registry's Agent change
// by this Session, and the Trigger's object is woken after one that changed something.
// @effect-diagnostics asyncFunction:off
import type {
  AgentChange,
  EnvironmentTriggerInput,
  SessionRecord,
  TriggerChanged,
  TriggerDefinition,
  WorkspaceRecord,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { TriggerUnreachable } from "../trigger/object.ts";
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

const setUp = (
  answer: TriggerChanged = CHANGED,
  { listed = true, unreachable = 0 }: { listed?: boolean; unreachable?: number } = {},
) => {
  /** How many more wakes fail, as an object that doesn't answer after all its tries. */
  let failing = unreachable;

  /** The wakes asked for. */
  const woken: string[] = [];

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
    // SAFETY: the Triggers read only a Session's Workspace and a Workspace's branch and Environment.
    getSession: ({ id }) =>
      Effect.succeed(id === "s-1" ? ({ id, workspace: "0f0f0f0f" } as SessionRecord) : null),
    // SAFETY: as above.
    getWorkspace: ({ id }) =>
      Effect.succeed(
        id === "0f0f0f0f"
          ? ({ id, branch: "cloudpid/0f0f0f0f", environment: "default" } as WorkspaceRecord)
          : null,
      ),
    agentCreateTrigger: (input) => answered("agentCreateTrigger", input),
    agentUpdateTrigger: (input) => answered("agentUpdateTrigger", input),
    agentSetTriggerPaused: (input) => answered("agentSetTriggerPaused", input),
    agentRemoveTrigger: (input) => answered("agentRemoveTrigger", input),
  };

  const access = sessionTriggers({
    registry,
    session: listed ? "s-1" : undefined,
    objects: {
      wake: (id) =>
        Effect.suspend(() => {
          woken.push(id);

          if (failing > 0) {
            failing--;

            return Effect.fail(TriggerUnreachable.make({ message: "no answer" }));
          }

          return Effect.void;
        }),
      sync: (id) =>
        Effect.sync(() => {
          synced.push(id);
        }),
    },
  });

  return { access, calls, synced, woken };
};

const author = { conversation: 0, tool: "trigger_pause", reason: "r" };

const INPUT: EnvironmentTriggerInput = {
  kind: "environment",
  environment: "default",
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
};

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

  it("wakes the object when nothing changed too: the change may have gone through before an eviction", async () => {
    const { access, synced, woken } = setUp({ status: "unchanged", definition: DEFINITION });

    await Effect.runPromise(access.setPaused({ id: "t1", paused: true, author }));
    // The rerun of an approved create the Registry made before the Session restarted.
    await Effect.runPromise(access.create({ id: "t1", trigger: INPUT, author }));

    expect(synced).toEqual(["t1"]);
    expect(woken).toEqual(["t1"]);
  });

  it("wakes no object for a change refused", async () => {
    const { access, synced, woken } = setUp({ status: "invalid", problem: "no" });

    await Effect.runPromise(access.setPaused({ id: "t1", paused: true, author }));

    expect([...synced, ...woken]).toEqual([]);
  });

  it("fails the call when a new or resumed Trigger's object never answers, saying how to schedule it", async () => {
    const answered = setUp(CHANGED);

    await Effect.runPromise(answered.access.create({ id: "t1", trigger: INPUT, author }));

    expect(answered.woken).toEqual(["t1"]);

    const unreachable = setUp(CHANGED, { unreachable: 1 });

    const failed = await Effect.runPromise(
      unreachable.access.setPaused({ id: "t1", paused: false, author }).pipe(Effect.flip),
    );

    expect(unreachable.woken).toEqual(["t1"]);
    expect(failed.message).toContain("trigger_resume");

    // A change that only narrows, or edits, is left to the object's next alarm.
    const narrowing = setUp(CHANGED, { unreachable: 10 });

    await Effect.runPromise(narrowing.access.setPaused({ id: "t1", paused: true, author }));
    await Effect.runPromise(narrowing.access.update({ id: "t1", patch: { message: "m" }, author }));

    expect(narrowing.synced).toEqual(["t1", "t1"]);
    expect(narrowing.woken).toEqual([]);
  });

  it("reads the Registry's Triggers", async () => {
    const { access } = setUp();

    expect(await Effect.runPromise(access.list("default"))).toEqual([DEFINITION]);
    expect(await Effect.runPromise(access.get("nope"))).toBeNull();
    expect(await Effect.runPromise(access.newId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says which Workspace this Session works in, for a Workspace trigger", async () => {
    const { access } = setUp();

    expect(await Effect.runPromise(access.workspace)).toEqual({
      id: "0f0f0f0f",
      branch: "cloudpid/0f0f0f0f",
      environment: "default",
    });

    const unlisted = setUp(CHANGED, { listed: false });

    expect(
      (await Effect.runPromise(unlisted.access.workspace.pipe(Effect.flip))).message,
    ).toContain("not one the Registry lists");
  });

  it("changes nothing for a Session the Registry does not list", async () => {
    const { access, calls } = setUp(CHANGED, { listed: false });

    const failed = await Effect.runPromise(
      access.setPaused({ id: "t1", paused: true, author }).pipe(Effect.flip),
    );

    expect(failed.message).toContain("not one the Registry lists");
    expect(calls).toEqual([]);
  });
});
