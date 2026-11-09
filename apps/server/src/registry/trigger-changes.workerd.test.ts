// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The agent's Trigger changes (`docs/architecture/triggers.md` → Agent tools and Approval): each one recorded as an Agent
// change of the field `triggers.<id>` under the Trigger's Environment, and the owner's revert of each.
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentTriggerInput,
  MAX_AGENT_CHANGES,
  type SessionTriggerInput,
  type TriggerChangeValue,
  triggerField,
  type WorkspaceTriggerInput,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { SessionChangeAuthor } from "./agent-changes.ts";
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

const author = (tool: string, approved?: true): SessionChangeAuthor => ({
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

  it("brings a removed webhook Trigger back with its format and match", async () => {
    const registry = fresh();

    const source = {
      type: "webhook",
      format: "github",
      match: { event: ["workflow_run"], "workflow_run.conclusion": ["failure"] },
    } as const;

    await registry.agentCreateTrigger(
      "t1",
      { ...weekly, source },
      author("trigger_create", true),
      1_000,
    );

    const removal = await registry.agentRemoveTrigger("t1", author("trigger_remove"), 2_000);

    if (removal.status !== "changed") throw new Error("not removed");

    expect(
      await registry.revertAgentChange(DEFAULT_ENVIRONMENT, removal.change.id, 3_000),
    ).toMatchObject({
      status: "reverted",
      change: {
        after: { source, whenBusy: "start" },
        // Its object was wiped with it, so it has no secrets any more: it makes new ones, and the change says so.
        reason: `Reverted change ${removal.change.id} (trigger_remove). It has a new Trigger URL and Signing secret: paste them again where the old ones were used.`,
      },
    });
    expect(await registry.triggerDefinition("t1")).toMatchObject({ source, revision: 2 });
  });

  it("does not say so of a Schedule's Trigger brought back, or of a webhook's change put back", async () => {
    const { registry } = await made();
    const removal = await registry.agentRemoveTrigger("t1", author("trigger_remove"), 2_000);

    if (removal.status !== "changed") throw new Error("not removed");

    expect(
      await registry.revertAgentChange(DEFAULT_ENVIRONMENT, removal.change.id, 3_000),
    ).toMatchObject({
      change: { reason: `Reverted change ${removal.change.id} (trigger_remove)` },
    });

    const hook = fresh();

    await hook.agentCreateTrigger(
      "t2",
      { ...weekly, source: { type: "webhook", format: "github" } },
      author("trigger_create", true),
      1_000,
    );

    const changed = await hook.agentUpdateTrigger(
      "t2",
      { message: "Another." },
      { ...weeklyValue, source: { type: "webhook", format: "github" }, whenBusy: "start" },
      author("trigger_message_set", true),
      2_000,
    );

    if (changed.status !== "changed") throw new Error("not changed");

    expect(
      await hook.revertAgentChange(DEFAULT_ENVIRONMENT, changed.change.id, 3_000),
    ).toMatchObject({
      change: { reason: `Reverted change ${changed.change.id} (trigger_message_set)` },
    });
  });

  it("records a webhook Trigger's new match, and the owner's revert puts the old one back", async () => {
    const registry = fresh();
    const old = { event: ["workflow_run"], "workflow_run.conclusion": ["failure"] };
    const wanted = { event: ["push"] };

    await registry.agentCreateTrigger(
      "t1",
      { ...weekly, source: { type: "webhook", format: "github", match: old } },
      author("trigger_create", true),
      1_000,
    );

    const changed = await registry.agentUpdateTrigger(
      "t1",
      { match: wanted },
      {
        ...weeklyValue,
        source: { type: "webhook", format: "github", match: old },
        whenBusy: "start",
      },
      author("trigger_match_set", true),
      2_000,
    );

    if (changed.status !== "changed") throw new Error("not changed");

    expect(changed.change).toMatchObject({
      tool: "trigger_match_set",
      field: triggerField("t1"),
      before: { source: { type: "webhook", format: "github", match: old } },
      after: { source: { type: "webhook", format: "github", match: wanted } },
    });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      source: { type: "webhook", format: "github", match: wanted },
    });

    expect(
      await registry.revertAgentChange(DEFAULT_ENVIRONMENT, changed.change.id, 3_000),
    ).toMatchObject({
      status: "reverted",
    });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      source: { type: "webhook", format: "github", match: old },
    });

    // null takes the match away.
    const cleared = await registry.agentUpdateTrigger(
      "t1",
      { match: null },
      undefined,
      author("trigger_match_set", true),
      4_000,
    );

    expect(cleared.status).toBe("changed");
    expect((await registry.triggerDefinition("t1"))?.source).toEqual({
      type: "webhook",
      format: "github",
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

describe("the agent's Workspace triggers", () => {
  const inWorkspace: WorkspaceTriggerInput = {
    kind: "workspace",
    workspace: "0f0f0f0f",
    name: "Nightly check",
    message: "Check the build.",
    source: { type: "schedule", cron: "@daily", zone: "UTC" },
  };

  const started = async () => {
    const registry = fresh();

    await registry.createSession(
      {
        id: "s-1",
        title: null,
        workspace: {
          kind: "new",
          id: "0f0f0f0f",
          environment: DEFAULT_ENVIRONMENT,
          branch: null,
          base: null,
        },
      },
      500,
    );

    return registry;
  };

  it("are recorded under the endpoint's author, in the Workspace's Environment, with its `via`", async () => {
    const registry = await started();

    const made = await registry.agentCreateTrigger(
      "t1",
      inWorkspace,
      {
        via: { auth: "oauth", client: { name: "pi" } },
        tool: "trigger_create",
        reason: "the owner asked for a nightly check",
      },
      1_000,
    );

    expect(made).toMatchObject({
      status: "changed",
      definition: { kind: "workspace" },
      change: {
        scope: DEFAULT_ENVIRONMENT,
        actor: "agent",
        session: null,
        conversation: null,
        tool: "trigger_create",
        field: triggerField("t1"),
        via: { auth: "oauth", client: { name: "pi" } },
      },
    });
  });

  it("record the Workspace by its branch under the Workspace's Environment, and revert", async () => {
    const registry = await started();

    const made = await registry.agentCreateTrigger(
      "t1",
      inWorkspace,
      author("trigger_create", true),
      1_000,
    );

    expect(made).toMatchObject({
      status: "changed",
      definition: { kind: "workspace", workspace: { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f" } },
      environment: { id: DEFAULT_ENVIRONMENT },
      change: {
        scope: DEFAULT_ENVIRONMENT,
        field: triggerField("t1"),
        before: null,
        after: {
          kind: "workspace",
          workspace: { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f" },
          name: "Nightly check",
          whenBusy: "wait",
          paused: false,
        },
      },
    });

    const removal = await registry.agentRemoveTrigger("t1", author("trigger_remove"), 2_000);

    if (removal.status !== "changed") throw new Error("not removed");

    // Brought back, still for its Workspace.
    expect(
      await registry.revertAgentChange(DEFAULT_ENVIRONMENT, removal.change.id, 3_000),
    ).toMatchObject({
      status: "reverted",
    });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      kind: "workspace",
      workspace: { id: "0f0f0f0f" },
      whenBusy: "wait",
    });
  });

  it("are refused for a Workspace that isn't there", async () => {
    const registry = await started();

    expect(
      await registry.agentCreateTrigger(
        "t1",
        { ...inWorkspace, workspace: "feedfeed" },
        author("trigger_create", true),
        1_000,
      ),
    ).toMatchObject({ status: "invalid" });
    expect(await registry.listAgentChanges(DEFAULT_ENVIRONMENT)).toEqual([]);
  });
});

describe("the agent's Session triggers", () => {
  const checkCi: SessionTriggerInput = {
    kind: "session",
    session: "s-1",
    name: "Check CI",
    message: "Check the current state of CI.",
    source: { type: "schedule", cron: "0 * * * *", zone: "UTC" },
  };

  const checkCiValue: TriggerChangeValue = {
    kind: "session",
    name: "Check CI",
    message: "Check the current state of CI.",
    source: { type: "schedule", cron: "0 * * * *", zone: "UTC" },
    whenBusy: "queue",
    session: "s-1",
    paused: false,
  };

  /** A Registry with Session s-1 in the default Environment. */
  const inSession = async () => {
    const registry = fresh();

    await registry.createSession(
      {
        id: "s-1",
        title: null,
        workspace: {
          kind: "new",
          id: "00000001",
          environment: DEFAULT_ENVIRONMENT,
          branch: null,
          base: null,
        },
      },
      500,
    );

    return registry;
  };

  it("records making one under its Session's Environment, naming the Session", async () => {
    const registry = await inSession();

    expect(
      await registry.agentCreateTrigger("t1", checkCi, author("trigger_create", true), 1_000),
    ).toMatchObject({
      status: "changed",
      definition: { id: "t1", kind: "session", session: "s-1" },
      environment: { id: DEFAULT_ENVIRONMENT },
      change: {
        scope: DEFAULT_ENVIRONMENT,
        session: "s-1",
        field: triggerField("t1"),
        before: null,
        after: checkCiValue,
      },
    });
  });

  it("are made only by their own Session", async () => {
    const registry = await inSession();

    expect(
      await registry.agentCreateTrigger(
        "t1",
        { ...checkCi, session: "s-2" },
        author("trigger_create", true),
        1_000,
      ),
    ).toMatchObject({ status: "invalid", problem: expect.stringContaining("own Session") });
    expect(
      await registry.agentCreateTrigger(
        "t1",
        { ...checkCi, session: "s-1" },
        { ...author("trigger_create", true), session: "s-2" },
        1_000,
      ),
    ).toMatchObject({ status: "invalid" });
    expect(await registry.storedTriggerIds()).toEqual([]);
  });

  it("are changed by their own Session alone: another Session finds none", async () => {
    const registry = await inSession();
    const other = { ...author("trigger_pause"), session: "s-2" };

    await registry.agentCreateTrigger("t1", checkCi, author("trigger_create", true), 1_000);

    expect(await registry.agentSetTriggerPaused("t1", true, undefined, other, 2_000)).toEqual({
      status: "missing",
    });
    expect(
      await registry.agentUpdateTrigger("t1", { message: "Other" }, undefined, other, 2_000),
    ).toEqual({ status: "missing" });
    expect(await registry.agentRemoveTrigger("t1", other, 2_000)).toEqual({ status: "missing" });
    expect(await registry.triggerDefinition("t1")).toMatchObject({ paused: false, revision: 1 });

    expect(
      await registry.agentSetTriggerPaused("t1", true, undefined, author("trigger_pause"), 2_000),
    ).toMatchObject({ status: "changed" });
  });

  it("are changed and reverted like any Trigger, keeping their Session", async () => {
    const registry = await inSession();

    await registry.agentCreateTrigger("t1", checkCi, author("trigger_create", true), 1_000);

    const changed = await registry.agentUpdateTrigger(
      "t1",
      { whenBusy: "steer" },
      checkCiValue,
      author("trigger_options_set", true),
      2_000,
    );

    if (changed.status !== "changed") throw new Error("not changed");

    expect(changed.change.after).toEqual({ ...checkCiValue, whenBusy: "steer" });
    expect(
      await registry.revertAgentChange(DEFAULT_ENVIRONMENT, changed.change.id, 3_000),
    ).toMatchObject({ status: "reverted" });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      session: "s-1",
      whenBusy: "queue",
      revision: 3,
    });
  });
});
