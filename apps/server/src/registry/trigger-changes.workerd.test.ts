// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The agent's Trigger changes (`docs/architecture/triggers.md` → Agent tools and Approval): each one recorded as an Agent
// change of the field `triggers.<id>` under the Trigger's Environment, and the owner's revert of each.
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentTriggerInput,
  MAX_AGENT_CHANGES,
  type TriggerChangeValue,
  triggerField,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentChangeAuthor } from "./agent-changes.ts";
import type { TestRegistry } from "./store.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const fresh = () => env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

const weekly: EnvironmentTriggerInput = {
  kind: "environment",
  environment: DEFAULT_ENVIRONMENT,
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
};

/** The value its Agent changes record of `weekly`, as created. */
const weeklyValue: TriggerChangeValue = {
  kind: "environment",
  name: "Weekly report",
  message: "Summarize last week's PRs.",
  source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
  whenBusy: "skip",
  paused: false,
};

const author = (tool: string, approved?: true): AgentChangeAuthor => ({
  session: "s-1",
  conversation: 0,
  tool,
  reason: "the owner asked for a weekly summary",
  approved,
});

describe("the agent's Trigger changes", () => {
  it("record making a Trigger under its Environment, once for its id", async () => {
    const registry = fresh();

    const made = await registry.agentCreateTrigger(
      "t1",
      weekly,
      author("trigger_create", true),
      1_000,
    );

    expect(made).toMatchObject({
      status: "changed",
      definition: { id: "t1", revision: 1 },
      environment: { id: DEFAULT_ENVIRONMENT },
      change: {
        scope: DEFAULT_ENVIRONMENT,
        actor: "agent",
        session: "s-1",
        tool: "trigger_create",
        field: triggerField("t1"),
        before: null,
        after: weeklyValue,
        approved: true,
      },
    });

    // A rerun of the approved call (its id kept in the Approval) makes nothing more.
    expect(
      await registry.agentCreateTrigger("t1", weekly, author("trigger_create", true), 2_000),
    ).toMatchObject({ status: "unchanged", definition: { id: "t1", revision: 1 } });
    expect(await registry.listAgentChanges(DEFAULT_ENVIRONMENT)).toHaveLength(1);

    expect(
      await registry.agentCreateTrigger(
        "t2",
        { ...weekly, source: { type: "schedule", cron: "0 0 9 * * MON", zone: "UTC" } },
        author("trigger_create", true),
        2_000,
      ),
    ).toMatchObject({ status: "invalid" });
    expect(
      await registry.agentCreateTrigger(
        "t3",
        { ...weekly, environment: "0000abcd" },
        author("trigger_create", true),
        2_000,
      ),
    ).toEqual({ status: "missing" });
  });

  it("record a change of its fields, only while it is as the owner saw it", async () => {
    const registry = fresh();

    await registry.agentCreateTrigger("t1", weekly, author("trigger_create", true), 1_000);

    const changed = await registry.agentUpdateTrigger(
      "t1",
      { message: "Summarize this week's PRs.", model: "anthropic/claude-sonnet-5-5" },
      weeklyValue,
      author("trigger_message_set", true),
      2_000,
    );

    expect(changed).toMatchObject({
      status: "changed",
      definition: { revision: 2, message: "Summarize this week's PRs." },
      change: {
        field: triggerField("t1"),
        before: weeklyValue,
        after: {
          ...weeklyValue,
          message: "Summarize this week's PRs.",
          model: "anthropic/claude-sonnet-5-5",
        },
      },
    });

    // The owner saw the message before: it is not that any more.
    expect(
      await registry.agentUpdateTrigger(
        "t1",
        { message: "Summarize nothing." },
        weeklyValue,
        author("trigger_message_set", true),
        3_000,
      ),
    ).toMatchObject({ status: "changed-since", current: { revision: 2 } });

    // The rerun of the approved call, which made the change before an eviction: the values are there already.
    expect(
      await registry.agentUpdateTrigger(
        "t1",
        { message: "Summarize this week's PRs." },
        weeklyValue,
        author("trigger_message_set", true),
        3_000,
      ),
    ).toMatchObject({ status: "unchanged", definition: { revision: 2 } });

    // A change to the values it has is none.
    expect(
      await registry.agentUpdateTrigger(
        "t1",
        { message: "Summarize this week's PRs." },
        undefined,
        author("trigger_message_set", true),
        3_000,
      ),
    ).toMatchObject({ status: "unchanged", definition: { revision: 2 } });
    expect(
      await registry.agentUpdateTrigger(
        "t1",
        { name: "" },
        undefined,
        author("trigger_options_set", true),
        3_000,
      ),
    ).toMatchObject({ status: "invalid" });
    expect(
      await registry.agentUpdateTrigger(
        "t9",
        { name: "x" },
        undefined,
        author("trigger_options_set", true),
        3_000,
      ),
    ).toEqual({ status: "missing" });
    expect(await registry.listAgentChanges(DEFAULT_ENVIRONMENT)).toHaveLength(2);
  });

  it("record a pause and a resume, and nothing for a Trigger already so", async () => {
    const registry = fresh();

    await registry.agentCreateTrigger("t1", weekly, author("trigger_create", true), 1_000);

    expect(
      await registry.agentSetTriggerPaused("t1", true, undefined, author("trigger_pause"), 2_000),
    ).toMatchObject({
      status: "changed",
      definition: { paused: true, revision: 2 },
      change: { before: weeklyValue, after: { ...weeklyValue, paused: true } },
    });
    expect(
      await registry.agentSetTriggerPaused("t1", true, undefined, author("trigger_pause"), 3_000),
    ).toMatchObject({ status: "unchanged" });
    expect(
      await registry.agentSetTriggerPaused(
        "t1",
        false,
        weeklyValue,
        author("trigger_resume", true),
        3_000,
      ),
    ).toMatchObject({ status: "changed-since" });
    expect(
      await registry.agentSetTriggerPaused(
        "t1",
        false,
        { ...weeklyValue, paused: true },
        author("trigger_resume", true),
        3_000,
      ),
    ).toMatchObject({ status: "changed", definition: { paused: false, revision: 3 } });
  });

  it("remove a Trigger from every read, its Fires refused, and record it", async () => {
    const registry = fresh();

    await registry.agentCreateTrigger("t1", weekly, author("trigger_create", true), 1_000);

    expect(await registry.agentRemoveTrigger("t1", author("trigger_remove"), 2_000)).toMatchObject({
      status: "changed",
      definition: null,
      change: { field: triggerField("t1"), before: weeklyValue, after: null },
    });
    expect(await registry.triggerDefinition("t1")).toBeNull();
    expect(await registry.listTriggers()).toEqual([]);
    expect(
      await registry.admitFire(
        { trigger: "t1", revision: 1, requestId: "t1:a" },
        { session: "s-2", workspace: "00000002" },
        3_000,
      ),
    ).toEqual({ status: "removed" });
    expect(await registry.agentRemoveTrigger("t1", author("trigger_remove"), 3_000)).toEqual({
      status: "missing",
    });
  });
});

describe("the owner's revert of a Trigger change", () => {
  /** A Registry with Trigger t1 made by the agent; the change's number. */
  const made = async () => {
    const registry = fresh();

    const creation = await registry.agentCreateTrigger(
      "t1",
      weekly,
      author("trigger_create", true),
      1_000,
    );

    if (creation.status !== "changed") throw new Error("not made");

    return { registry, creation: creation.change.id };
  };

  it("brings a removed Trigger back, at a new revision", async () => {
    const { registry } = await made();

    await registry.agentSetTriggerPaused("t1", true, undefined, author("trigger_pause"), 1_500);

    const removal = await registry.agentRemoveTrigger("t1", author("trigger_remove"), 2_000);

    if (removal.status !== "changed") throw new Error("not removed");

    const revert = await registry.revertAgentChange(DEFAULT_ENVIRONMENT, removal.change.id, 3_000);

    expect(revert).toMatchObject({
      status: "reverted",
      change: {
        actor: "owner",
        field: triggerField("t1"),
        before: null,
        after: { ...weeklyValue, paused: true },
        reverts: removal.change.id,
      },
    });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      id: "t1",
      revision: 3,
      paused: true,
      updatedAt: 3_000,
    });
  });

  it("removes a Trigger the agent made", async () => {
    const { registry, creation } = await made();

    expect(await registry.revertAgentChange(DEFAULT_ENVIRONMENT, creation, 2_000)).toMatchObject({
      status: "reverted",
      change: { before: weeklyValue, after: null, reverts: creation },
    });
    expect(await registry.triggerDefinition("t1")).toBeNull();
  });

  it("puts a change's values back, and refuses once the Trigger changed since", async () => {
    const { registry, creation } = await made();

    const changed = await registry.agentUpdateTrigger(
      "t1",
      { source: { type: "schedule", cron: "@daily", zone: "UTC" }, whenBusy: "start" },
      weeklyValue,
      author("trigger_schedule_set", true),
      2_000,
    );

    if (changed.status !== "changed") throw new Error("not changed");

    // The creation's value after is not the Trigger's now.
    expect(await registry.revertAgentChange(DEFAULT_ENVIRONMENT, creation, 2_500)).toMatchObject({
      status: "changed-since",
      field: triggerField("t1"),
    });

    expect(
      await registry.revertAgentChange(DEFAULT_ENVIRONMENT, changed.change.id, 3_000),
    ).toMatchObject({ status: "reverted", change: { after: weeklyValue } });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      revision: 3,
      source: weekly.source,
      whenBusy: "skip",
    });
  });

  it("refuses to bring back a Trigger the owner removed for good", async () => {
    const { registry, creation } = await made();

    await registry.removeTrigger("t1");

    expect(await registry.revertAgentChange(DEFAULT_ENVIRONMENT, creation, 2_000)).toMatchObject({
      status: "changed-since",
      current: null,
    });
  });
});

describe("a removed Trigger", () => {
  it("is kept while a change in the history refers to it, then forgotten", async () => {
    const registry = fresh();

    await registry.agentCreateTrigger("t1", weekly, author("trigger_create", true), 1_000);
    await registry.agentRemoveTrigger("t1", author("trigger_remove"), 2_000);
    await registry.agentCreateTrigger("t2", weekly, author("trigger_create", true), 3_000);

    expect(await registry.storedTriggerIds()).toEqual(["t1", "t2"]);

    // Enough changes of t2 to push both of t1's out of the history.
    for (let n = 0; n < MAX_AGENT_CHANGES; n++) {
      await registry.agentSetTriggerPaused(
        "t2",
        n % 2 === 0,
        undefined,
        author("trigger_pause"),
        4_000 + n,
      );
    }

    expect(await registry.storedTriggerIds()).toEqual(["t2"]);
  });

  it("goes with its Environment, answered among its Triggers", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 500);
    await registry.agentCreateTrigger(
      "t1",
      { ...weekly, environment: "0000abcd" },
      author("trigger_create", true),
      1_000,
    );
    await registry.agentRemoveTrigger("t1", author("trigger_remove"), 2_000);

    expect(await registry.deleteEnvironmentWithTriggers("0000abcd")).toEqual({
      deletion: "deleted",
      triggers: ["t1"],
    });
    expect(await registry.storedTriggerIds()).toEqual([]);
  });
});
