// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentTriggerInput,
  type SessionTriggerInput,
  triggerChangeValue,
  type WorkspaceTriggerInput,
} from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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

describe("a Trigger's definition", () => {
  it("is kept at revision 1, active, skipping when busy by default", async () => {
    const registry = fresh();

    expect(await registry.createTrigger("t1", weekly, 1_000)).toMatchObject({ status: "ok" });
    expect(await registry.triggerDefinition("t1")).toEqual({
      id: "t1",
      revision: 1,
      kind: "environment",
      environment: DEFAULT_ENVIRONMENT,
      name: "Weekly report",
      message: "Summarize last week's PRs.",
      source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
      whenBusy: "skip",
      paused: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(await registry.triggerDefinition("nope")).toBeNull();
  });

  it("is refused for an Environment that isn't there, a bad Schedule, name or message", async () => {
    const registry = fresh();

    for (const input of [
      { ...weekly, environment: "0000abcd" },
      { ...weekly, source: { type: "schedule", cron: "0 0 9 * * MON", zone: "UTC" } },
      { ...weekly, source: { type: "schedule", cron: "@daily", zone: "" } },
      { ...weekly, name: " " },
      { ...weekly, message: "" },
    ] satisfies Array<EnvironmentTriggerInput>) {
      expect(await registry.createTrigger("t1", input, 1_000)).toMatchObject({
        status: "invalid",
      });
    }

    expect(await registry.listTriggers()).toEqual([]);
  });

  it("makes one Trigger of a create retried under its id, and refuses the id with other values", async () => {
    const registry = fresh();

    expect(await registry.createTrigger("t1", weekly, 1_000)).toMatchObject({ status: "ok" });
    expect(
      await registry.createTrigger("t1", { ...weekly, name: " Weekly report " }, 2_000),
    ).toMatchObject({
      status: "unchanged",
      definition: { id: "t1", revision: 1, createdAt: 1_000 },
    });
    expect(
      await registry.createTrigger("t1", { ...weekly, message: "Other words" }, 2_000),
    ).toMatchObject({
      status: "invalid",
    });
    expect(await registry.listTriggers()).toHaveLength(1);
  });

  it("changes a Trigger only while it has the fields its editor opened on, a pause aside", async () => {
    const registry = fresh();

    const made = await registry.createTrigger("t1", weekly, 1_000);
    const opened = made.status === "ok" ? triggerChangeValue(made.definition) : undefined;

    await registry.setTriggerPaused("t1", true, 1_500);

    expect(await registry.updateTrigger("t1", { message: "Mine" }, 2_000, opened)).toMatchObject({
      status: "ok",
      definition: { revision: 3, message: "Mine", paused: true },
    });
    expect(await registry.updateTrigger("t1", { name: "Stale" }, 3_000, opened)).toMatchObject({
      status: "changed-since",
      definition: { revision: 3, name: "Weekly report" },
    });
  });

  it("rises a revision with each change, and keeps its kind and Environment", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);

    expect(
      await registry.updateTrigger(
        "t1",
        {
          message: "Summarize this week's PRs.",
          source: { type: "schedule", cron: "@daily", zone: "UTC" },
          whenBusy: "start",
          base: "develop",
          model: "anthropic/claude-sonnet-5-5",
          thinking: "low",
        },
        2_000,
      ),
    ).toMatchObject({
      status: "ok",
      definition: {
        revision: 2,
        kind: "environment",
        environment: DEFAULT_ENVIRONMENT,
        message: "Summarize this week's PRs.",
        source: { type: "schedule", cron: "@daily", zone: "UTC" },
        whenBusy: "start",
        base: "develop",
        model: "anthropic/claude-sonnet-5-5",
        thinking: "low",
        updatedAt: 2_000,
      },
    });

    // An option set to null goes back to the default.
    const reset = await registry.updateTrigger("t1", { base: null, model: null }, 3_000);

    expect(reset).toMatchObject({ status: "ok", definition: { revision: 3, thinking: "low" } });
    expect(reset.status === "ok" && "base" in reset.definition).toBe(false);
    expect(reset.status === "ok" && "model" in reset.definition).toBe(false);

    expect(await registry.updateTrigger("t1", { name: "" }, 4_000)).toMatchObject({
      status: "invalid",
    });
    expect(await registry.updateTrigger("t2", { name: "x" }, 4_000)).toEqual({
      status: "missing",
    });
    expect(await registry.triggerDefinition("t1")).toMatchObject({ revision: 3 });
  });

  it("pauses and resumes at a new revision, and is removed for good", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);

    expect(await registry.setTriggerPaused("t1", true, 2_000)).toMatchObject({
      status: "ok",
      definition: { paused: true, revision: 2 },
    });
    expect(await registry.setTriggerPaused("t1", false, 3_000)).toMatchObject({
      status: "ok",
      definition: { paused: false, revision: 3 },
    });
    expect(await registry.removeTrigger("t1")).toBe(true);
    expect(await registry.removeTrigger("t1")).toBe(false);
    expect(await registry.triggerDefinition("t1")).toBeNull();
  });

  it("lists an Environment's Triggers, or every one", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 500);
    await registry.createTrigger("t1", weekly, 1_000);
    await registry.createTrigger("t2", { ...weekly, environment: "0000abcd" }, 2_000);

    expect((await registry.listTriggers()).map((trigger) => trigger.id)).toEqual(["t2", "t1"]);
    expect((await registry.listTriggers("0000abcd")).map((trigger) => trigger.id)).toEqual(["t2"]);
  });
});

/** Ids for the Fire's Session and Workspace, drawn from `n`. */
const ids = (n: number) => ({
  session: `s-${String(n)}`,
  workspace: `0000000${String(n)}`,
});

/** The Fire at Monday 2026-11-09 09:00 in Chicago (15:00 UTC). */
const monday = Date.parse("2026-11-09T15:00:00Z");

const fireOf = (revision = 1, requestId = `t1:${new Date(monday).toISOString()}`) => ({
  trigger: "t1",
  revision,
  requestId,
  scheduledAt: monday,
});

describe("a webhook Trigger's definition", () => {
  const webhookTrigger: EnvironmentTriggerInput = {
    ...weekly,
    name: "CI failed",
    source: {
      type: "webhook",
      format: "github",
      match: { "workflow_run.conclusion": ["failure"], event: ["workflow_run"] },
    },
  };

  it("is kept with its format and match, and starts a Session when busy by default", async () => {
    const registry = fresh();

    expect(await registry.createTrigger("t1", webhookTrigger, 1_000)).toMatchObject({
      status: "ok",
    });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      source: webhookTrigger.source,
      whenBusy: "start",
    });
    expect(
      await registry.createTrigger("t2", { ...webhookTrigger, whenBusy: "skip" }, 1_000),
    ).toMatchObject({
      definition: { whenBusy: "skip" },
    });
  });

  it("is made once by a create retried with its match written in another order", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", webhookTrigger, 1_000);

    expect(
      await registry.createTrigger(
        "t1",
        {
          ...webhookTrigger,
          source: {
            type: "webhook",
            format: "github",
            match: { event: ["workflow_run"], "workflow_run.conclusion": ["failure"] },
          },
        },
        2_000,
      ),
    ).toMatchObject({ status: "unchanged" });
  });

  it("is refused for a match that can't filter", async () => {
    const registry = fresh();

    for (const match of [{ "a..b": ["x"] }, { event: [] }]) {
      expect(
        await registry.createTrigger(
          "t1",
          { ...webhookTrigger, source: { type: "webhook", format: "standard", match } },
          1_000,
        ),
      ).toMatchObject({ status: "invalid" });
    }

    expect(await registry.listTriggers()).toEqual([]);
  });

  it("changes its match alone, and takes it away with null", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", webhookTrigger, 1_000);

    expect(await registry.updateTrigger("t1", { match: { event: ["push"] } }, 2_000)).toMatchObject(
      {
        status: "ok",
        definition: { revision: 2, source: { format: "github", match: { event: ["push"] } } },
      },
    );
    expect(await registry.updateTrigger("t1", { match: { event: ["push"] } }, 3_000)).toMatchObject(
      {
        status: "unchanged",
      },
    );

    const cleared = await registry.updateTrigger("t1", { match: null }, 4_000);

    expect(cleared).toMatchObject({ status: "ok", definition: { revision: 3 } });
    expect(await registry.triggerDefinition("t1")).toMatchObject({
      source: { type: "webhook", format: "github" },
    });
    expect((await registry.triggerDefinition("t1"))?.source).not.toHaveProperty("match");
  });

  it("keeps its source type and format as made: a patch that names another is refused", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);
    await registry.createTrigger("t2", webhookTrigger, 1_000);

    const refused = {
      status: "invalid",
      problem: expect.stringContaining("fixed when it is made"),
    };

    expect(
      await registry.updateTrigger("t1", { source: { type: "webhook", format: "github" } }, 2_000),
    ).toMatchObject(refused);
    expect(
      await registry.updateTrigger(
        "t2",
        { source: { type: "schedule", cron: "@daily", zone: "UTC" } },
        2_000,
      ),
    ).toMatchObject(refused);
    expect(
      await registry.updateTrigger(
        "t2",
        { source: { type: "webhook", format: "standard" } },
        2_000,
      ),
    ).toMatchObject(refused);
    expect(await registry.triggerDefinition("t1")).toMatchObject({ revision: 1 });
    expect(await registry.triggerDefinition("t2")).toMatchObject({
      revision: 1,
      source: webhookTrigger.source,
    });
  });

  it("keeps the match a patch that names the same webhook source doesn't mention", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", webhookTrigger, 1_000);

    expect(
      await registry.updateTrigger(
        "t1",
        { name: "CI broke", source: { type: "webhook", format: "github" } },
        2_000,
      ),
    ).toMatchObject({
      status: "ok",
      definition: { name: "CI broke", source: webhookTrigger.source },
    });
    // Another match inside the source is no way to change it either: `match` is the patch's own field.
    expect(
      await registry.updateTrigger(
        "t1",
        { source: { type: "webhook", format: "github", match: { event: ["push"] } } },
        3_000,
      ),
    ).toMatchObject({ status: "unchanged" });
  });

  it("refuses a match for a Trigger on a Schedule, and one that can't filter", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);
    await registry.createTrigger("t2", webhookTrigger, 1_000);

    expect(await registry.updateTrigger("t1", { match: { event: ["push"] } }, 2_000)).toMatchObject(
      {
        status: "invalid",
        problem: "Only a webhook Trigger has a match",
      },
    );
    expect(await registry.updateTrigger("t2", { match: { "": ["x"] } }, 2_000)).toMatchObject({
      status: "invalid",
    });
  });
});

describe("admitFire", () => {
  it("starts a Session in a new Workspace, titled by cloudpid and marked with the Trigger", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", { ...weekly, base: "develop" }, 1_000);

    expect(await registry.admitFire(fireOf(), ids(1), monday + 2_000)).toEqual({
      status: "started",
      session: "s-1",
      environment: DEFAULT_ENVIRONMENT,
    });
    expect(await registry.getSession("s-1")).toMatchObject({
      title: "Weekly report · Mon, Nov 9, 2026, 9:00 AM",
      environment: DEFAULT_ENVIRONMENT,
      workspace: "00000001",
      marks: { kind: "trigger", auth: "trigger", trigger: { id: "t1", name: "Weekly report" } },
    });
    expect(await registry.getWorkspace("00000001")).toMatchObject({
      branch: "cloudpid/00000001",
      base: "develop",
    });
  });

  it("takes the Environment's spare Workspace when it is current", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);
    // The Environment had a Session lately, so it gets a spare.
    await registry.createSession(
      {
        id: "s-0",
        title: null,
        workspace: {
          kind: "new",
          id: "0f0f0f0f",
          environment: DEFAULT_ENVIRONMENT,
          branch: null,
          base: null,
        },
      },
      monday - 1_000,
    );
    await registry.upkeepSpares([DEFAULT_ENVIRONMENT], ["5a5a5a5a"], monday - 1_000);

    await registry.admitFire(fireOf(), ids(1), monday);

    expect(await registry.getSession("s-1")).toMatchObject({ workspace: "5a5a5a5a" });
    expect(await registry.getSpare(DEFAULT_ENVIRONMENT)).toBeNull();
  });

  it("answers a Fire let through before its Session again, and registers no other", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);
    await registry.admitFire(fireOf(), ids(1), monday);
    await registry.setSessionStatus("s-1", "running", monday + 1_000);

    expect(await registry.admitFire(fireOf(), ids(2), monday + 2_000)).toEqual({
      status: "started",
      session: "s-1",
      environment: DEFAULT_ENVIRONMENT,
      repeated: true,
    });
    expect((await registry.listSessions()).map((session) => session.id)).toEqual(["s-1"]);
  });

  it("answers a Fire let through before its Session again after a pause, a change or a removal", async () => {
    const registry = fresh();

    const repeated = {
      status: "started",
      session: "s-1",
      environment: DEFAULT_ENVIRONMENT,
      repeated: true,
    };

    await registry.createTrigger("t1", weekly, 1_000);
    await registry.admitFire(fireOf(), ids(1), monday);
    await registry.setTriggerPaused("t1", true, monday + 1_000);

    expect(await registry.admitFire(fireOf(), ids(2), monday + 2_000)).toEqual(repeated);

    await registry.updateTrigger("t1", { message: "Newer words" }, monday + 3_000);

    expect(await registry.admitFire(fireOf(), ids(2), monday + 4_000)).toEqual(repeated);

    await registry.removeTrigger("t1");

    expect(await registry.admitFire(fireOf(), ids(2), monday + 5_000)).toEqual(repeated);
    expect((await registry.listSessions()).map((session) => session.id)).toEqual(["s-1"]);
  });

  it("answers stale with the current definition for an old revision", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);
    await registry.updateTrigger("t1", { message: "Newer words" }, 2_000);

    expect(await registry.admitFire(fireOf(1), ids(1), monday)).toMatchObject({
      status: "stale",
      definition: { revision: 2, message: "Newer words" },
    });
    expect(await registry.listSessions()).toEqual([]);
  });

  it("lets nothing through for a paused or removed Trigger", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", weekly, 1_000);
    await registry.setTriggerPaused("t1", true, 2_000);

    expect(await registry.admitFire(fireOf(2), ids(1), monday)).toEqual({ status: "paused" });

    await registry.removeTrigger("t1");

    expect(await registry.admitFire(fireOf(2), ids(1), monday)).toEqual({ status: "removed" });
    expect(await registry.listSessions()).toEqual([]);
  });

  describe("overlap", () => {
    const next = (n: number) => fireOf(1, `t1:next-${String(n)}`);

    it("skips a Fire while the last Fire's Session runs, and starts once it is idle", async () => {
      const registry = fresh();

      await registry.createTrigger("t1", weekly, 1_000);
      await registry.admitFire(fireOf(), ids(1), monday);
      await registry.setSessionStatus("s-1", "running", monday + 1_000);

      expect(await registry.admitFire(next(2), ids(2), monday + 60_000)).toEqual({
        status: "skipped",
        reason: "overlap",
      });

      await registry.setSessionStatus("s-1", "idle", monday + 90_000);

      expect(await registry.admitFire(next(3), ids(3), monday + 120_000)).toMatchObject({
        status: "started",
        session: "s-3",
      });
    });

    it("counts a Session that hasn't reported its first Run yet as busy, for a while", async () => {
      const registry = fresh();

      await registry.createTrigger("t1", weekly, 1_000);
      await registry.admitFire(fireOf(), ids(1), monday);

      expect(await registry.admitFire(next(2), ids(2), monday + 1_000)).toMatchObject({
        status: "skipped",
      });
      // Past `STARTING_MS`, a Session that never reported is taken as idle.
      expect(await registry.admitFire(next(3), ids(3), monday + 10 * 60_000)).toMatchObject({
        status: "started",
      });
    });

    it("doesn't wait on an archived or deleted Session", async () => {
      const registry = fresh();

      await registry.createTrigger("t1", weekly, 1_000);
      await registry.admitFire(fireOf(), ids(1), monday);
      await registry.setSessionStatus("s-1", "running", monday + 1_000);
      await registry.archiveSession("s-1", monday + 2_000);

      expect(await registry.admitFire(next(2), ids(2), monday + 3_000)).toMatchObject({
        status: "started",
        session: "s-2",
      });

      await registry.setSessionStatus("s-2", "running", monday + 4_000);
      await registry.deleteSession("s-2");

      expect(await registry.admitFire(next(3), ids(3), monday + 5_000)).toMatchObject({
        status: "started",
        session: "s-3",
      });
    });

    it("starts a Session anyway with when_busy start", async () => {
      const registry = fresh();

      await registry.createTrigger("t1", { ...weekly, whenBusy: "start" }, 1_000);
      await registry.admitFire(fireOf(), ids(1), monday);
      await registry.setSessionStatus("s-1", "running", monday + 1_000);

      expect(await registry.admitFire(next(2), ids(2), monday + 2_000)).toMatchObject({
        status: "started",
        session: "s-2",
      });
    });

    it("lets through at most one of concurrent admits with when_busy skip, and all with start", async () => {
      const skipping = fresh();

      await skipping.createTrigger("t1", weekly, 1_000);

      const skipped = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => skipping.admitFire(next(n), ids(n), monday)),
      );

      expect(skipped.filter((answer) => answer.status === "started")).toHaveLength(1);
      expect(skipped.filter((answer) => answer.status === "skipped")).toHaveLength(4);
      expect(await skipping.listSessions()).toHaveLength(1);

      const starting = fresh();

      await starting.createTrigger("t1", { ...weekly, whenBusy: "start" }, 1_000);

      const started = await Promise.all(
        [1, 2, 3].map((n) => starting.admitFire(next(n), ids(n), monday)),
      );

      expect(started.every((answer) => answer.status === "started")).toBe(true);
      expect(await starting.listSessions()).toHaveLength(3);
    });
  });
});

describe("deleting an Environment", () => {
  it("deletes its Triggers in the same step, and answers their ids", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 500);
    await registry.createTrigger("t1", { ...weekly, environment: "0000abcd" }, 1_000);
    await registry.createTrigger("t2", { ...weekly, environment: "0000abcd" }, 1_000);
    await registry.createTrigger("t3", weekly, 1_000);

    expect(await registry.deleteEnvironmentWithTriggers("0000abcd")).toEqual({
      deletion: "deleted",
      triggers: expect.arrayContaining(["t1", "t2"]),
    });
    expect((await registry.listTriggers()).map((trigger) => trigger.id)).toEqual(["t3"]);
    expect(await registry.triggerDefinition("t1")).toBeNull();
  });

  it("keeps them while the Environment is kept", async () => {
    const registry = fresh();

    await registry.createEnvironment("0000abcd", "Cloudpid", 500);
    await registry.createTrigger("t1", { ...weekly, environment: "0000abcd" }, 1_000);
    await registry.admitFire({ ...fireOf(), trigger: "t1" }, ids(1), monday);

    // The Fire's Workspace is made from it, so the Environment is in use.
    expect(await registry.deleteEnvironmentWithTriggers("0000abcd")).toEqual({
      deletion: "in-use",
      triggers: [],
    });
    expect(await registry.triggerDefinition("t1")).not.toBeNull();
  });
});

describe("admitFire for a webhook Trigger", () => {
  const webhookTrigger: EnvironmentTriggerInput = {
    ...weekly,
    name: "CI failed",
    source: { type: "webhook", format: "github" },
  };

  it("starts a Session titled with the event and the time in UTC", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", webhookTrigger, 1_000);

    expect(
      await registry.admitFire(
        { trigger: "t1", revision: 1, requestId: "t1:d-1", event: "workflow_run" },
        ids(1),
        monday,
      ),
    ).toMatchObject({ status: "started", session: "s-1" });
    expect(await registry.getSession("s-1")).toMatchObject({
      title: "CI failed · workflow_run · Mon, Nov 9, 2026, 3:00 PM UTC",
      marks: { kind: "trigger", auth: "trigger", trigger: { id: "t1", name: "CI failed" } },
    });
  });

  it("starts a Session for each delivery while the last one's runs, and skips when told to", async () => {
    const registry = fresh();

    await registry.createTrigger("t1", webhookTrigger, 1_000);
    await registry.createTrigger("t2", { ...webhookTrigger, whenBusy: "skip" }, 1_000);

    const at = (trigger: string, n: number) => ({
      trigger,
      revision: 1,
      requestId: `${trigger}:d-${String(n)}`,
    });

    await registry.admitFire(at("t1", 1), ids(1), monday);
    await registry.setSessionStatus("s-1", "running", monday + 1_000);

    expect(await registry.admitFire(at("t1", 2), ids(2), monday + 2_000)).toMatchObject({
      status: "started",
      session: "s-2",
    });

    await registry.admitFire(at("t2", 1), ids(3), monday);
    await registry.setSessionStatus("s-3", "running", monday + 1_000);

    expect(await registry.admitFire(at("t2", 2), ids(4), monday + 2_000)).toEqual({
      status: "skipped",
      reason: "overlap",
    });
  });
});

/** Workspace `workspace` of the default Environment, made by Session `session` at `at`. */
const startIn = (
  registry: ReturnType<typeof fresh>,
  session: string,
  workspace: string,
  at = 500,
) =>
  registry.createSession(
    {
      id: session,
      title: null,
      workspace: {
        kind: "new",
        id: workspace,
        environment: DEFAULT_ENVIRONMENT,
        branch: null,
        base: null,
      },
    },
    at,
  );

const inWorkspace = (workspace: string): WorkspaceTriggerInput => ({
  kind: "workspace",
  workspace,
  name: "Nightly check",
  message: "Check the build.",
  source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
});

describe("a Workspace trigger", () => {
  it("is kept for a Workspace, by id and branch, in its Environment, waiting when busy by default", async () => {
    const registry = fresh();

    await startIn(registry, "s-0", "0f0f0f0f");

    expect(await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 1_000)).toMatchObject({
      status: "ok",
    });
    expect(await registry.triggerDefinition("t1")).toEqual({
      id: "t1",
      revision: 1,
      kind: "workspace",
      environment: DEFAULT_ENVIRONMENT,
      workspace: { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f" },
      name: "Nightly check",
      message: "Check the build.",
      source: { type: "schedule", cron: "0 9 * * MON", zone: "America/Chicago" },
      whenBusy: "wait",
      paused: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("is refused for a Workspace that isn't there, a spare, or a Subagent Workspace", async () => {
    const registry = fresh();

    await startIn(registry, "s-0", "0f0f0f0f", monday);
    await registry.createSubagentWorkspace(
      { id: "2b3c4d5e", session: "s-0", agent: "agent-1", branch: null, base: null, limit: 3 },
      monday,
    );
    await registry.upkeepSpares([DEFAULT_ENVIRONMENT], ["5a5a5a5a"], monday);

    expect(await registry.getSpare(DEFAULT_ENVIRONMENT)).toBe("5a5a5a5a");

    for (const workspace of ["feedfeed", "5a5a5a5a", "2b3c4d5e"]) {
      expect(await registry.createTrigger("t1", inWorkspace(workspace), 1_000)).toMatchObject({
        status: "invalid",
      });
    }

    expect(await registry.createTrigger("t1", inWorkspace("2b3c4d5e"), 1_000)).toEqual({
      status: "invalid",
      problem: "A subagent's Workspace can't hold a Trigger: it lasts only as long as its subagent",
    });
    expect(await registry.listTriggers()).toEqual([]);
  });

  it("takes no base, and only a Workspace trigger waits", async () => {
    const registry = fresh();

    await startIn(registry, "s-0", "0f0f0f0f");
    await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 1_000);
    await registry.createTrigger("t2", weekly, 1_000);

    expect(await registry.updateTrigger("t1", { base: "develop" }, 2_000)).toMatchObject({
      status: "invalid",
    });
    expect(await registry.updateTrigger("t1", { whenBusy: "start" }, 2_000)).toMatchObject({
      status: "ok",
      definition: { whenBusy: "start" },
    });
    expect(await registry.updateTrigger("t2", { whenBusy: "wait" }, 2_000)).toMatchObject({
      status: "invalid",
    });
    expect(
      await registry.createTrigger("t3", { ...weekly, whenBusy: "wait" }, 2_000),
    ).toMatchObject({ status: "invalid" });
  });

  it("may fire on a webhook, waiting when busy by default, and starts its Session in the Workspace", async () => {
    const registry = fresh();

    await startIn(registry, "s-0", "0f0f0f0f");
    await registry.createTrigger(
      "t1",
      {
        ...inWorkspace("0f0f0f0f"),
        name: "CI failed",
        source: { type: "webhook", format: "github" },
      },
      1_000,
    );

    expect(await registry.triggerDefinition("t1")).toMatchObject({
      kind: "workspace",
      workspace: { id: "0f0f0f0f", branch: "cloudpid/0f0f0f0f" },
      source: { type: "webhook", format: "github" },
      whenBusy: "wait",
    });

    const delivery = (n: number) => ({
      trigger: "t1",
      revision: 1,
      requestId: `t1:d-${String(n)}`,
      event: "push",
    });

    await registry.setSessionStatus("s-0", "running", monday - 1_000);

    expect(await registry.admitFire(delivery(1), ids(1), monday)).toEqual({ status: "busy" });

    await registry.setSessionStatus("s-0", "idle", monday + 1_000);

    expect(await registry.admitFire(delivery(1), ids(1), monday + 2_000)).toMatchObject({
      status: "started",
      session: "s-1",
    });
    expect(await registry.getSession("s-1")).toMatchObject({
      title: expect.stringMatching(/^CI failed · push · .* UTC$/),
      workspace: "0f0f0f0f",
    });
    expect((await registry.listWorkspaces()).map((workspace) => workspace.id)).toEqual([
      "0f0f0f0f",
    ]);
  });

  it("makes one Trigger of a create retried under its id", async () => {
    const registry = fresh();

    await startIn(registry, "s-0", "0f0f0f0f");
    await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 1_000);

    expect(await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 2_000)).toMatchObject({
      status: "unchanged",
    });
    expect(await registry.listTriggers()).toHaveLength(1);
  });

  describe("admitFire", () => {
    const first = (requestId = "t1:one") => ({ trigger: "t1", revision: 1, requestId });

    const kept = async (when?: WorkspaceTriggerInput["whenBusy"]) => {
      const registry = fresh();

      await startIn(registry, "s-0", "0f0f0f0f");
      await registry.createTrigger("t1", { ...inWorkspace("0f0f0f0f"), whenBusy: when }, 1_000);

      return registry;
    };

    it("starts a Session in its Workspace, on its branch, titled and marked as an Environment trigger's", async () => {
      const registry = await kept();

      expect(await registry.admitFire({ ...first(), scheduledAt: monday }, ids(1), monday)).toEqual(
        { status: "started", session: "s-1", environment: DEFAULT_ENVIRONMENT },
      );
      expect(await registry.getSession("s-1")).toMatchObject({
        title: "Nightly check · Mon, Nov 9, 2026, 9:00 AM",
        workspace: "0f0f0f0f",
        marks: { kind: "trigger", auth: "trigger", trigger: { id: "t1", name: "Nightly check" } },
      });
      // No Workspace is made for it.
      expect((await registry.listWorkspaces()).map((workspace) => workspace.id)).toEqual([
        "0f0f0f0f",
      ]);
    });

    it("answers busy while any Session in the Workspace isn't idle, the owner's own included", async () => {
      const registry = await kept();

      await registry.setSessionStatus("s-0", "running", monday - 1_000);

      expect(await registry.admitFire(first(), ids(1), monday)).toEqual({ status: "busy" });
      expect(await registry.listSessions()).toHaveLength(1);

      await registry.setSessionStatus("s-0", "idle", monday + 3_000);

      expect(await registry.admitFire(first(), ids(1), monday + 4_000)).toMatchObject({
        status: "started",
        session: "s-1",
      });
    });

    it("doesn't wait on an archived Session or on a Session in another Workspace", async () => {
      const registry = await kept();

      await startIn(registry, "s-9", "0e0e0e0e");
      await registry.setSessionStatus("s-9", "running", monday - 1_000);
      await registry.setSessionStatus("s-0", "running", monday - 1_000);
      await registry.archiveSession("s-0", monday - 500);

      expect(await registry.admitFire(first(), ids(1), monday)).toMatchObject({
        status: "started",
      });
    });

    it("is busy while the Session a Fire just started hasn't reported its first Run", async () => {
      const registry = await kept();

      await registry.admitFire(first("t1:one"), ids(1), monday);

      expect(await registry.admitFire(first("t1:two"), ids(2), monday + 1_000)).toEqual({
        status: "busy",
      });
    });

    it("lets one of concurrent admits through, and the rest wait", async () => {
      const registry = await kept();

      const answers = await Promise.all(
        [1, 2, 3, 4].map((n) => registry.admitFire(first(`t1:${String(n)}`), ids(n), monday)),
      );

      expect(answers.filter((answer) => answer.status === "started")).toHaveLength(1);
      expect(answers.filter((answer) => answer.status === "busy")).toHaveLength(3);
      expect(await registry.listSessions()).toHaveLength(2);
    });

    it("records skipped: overlap with when_busy skip, and starts at once with start", async () => {
      const skipping = await kept("skip");

      await skipping.setSessionStatus("s-0", "running", monday - 1_000);

      expect(await skipping.admitFire(first(), ids(1), monday)).toEqual({
        status: "skipped",
        reason: "overlap",
      });

      const starting = await kept("start");

      await starting.setSessionStatus("s-0", "running", monday - 1_000);

      expect(await starting.admitFire(first(), ids(1), monday)).toMatchObject({
        status: "started",
        session: "s-1",
      });
    });

    it("answers a Fire let through before its Session again, though the Workspace is busy now", async () => {
      const registry = await kept();

      await registry.admitFire(first(), ids(1), monday);
      await registry.setSessionStatus("s-1", "running", monday + 1_000);

      expect(await registry.admitFire(first(), ids(2), monday + 2_000)).toEqual({
        status: "started",
        session: "s-1",
        environment: DEFAULT_ENVIRONMENT,
        repeated: true,
      });
    });
  });

  describe("keeps its Workspace", () => {
    it("deleting the last Session leaves the Workspace's record while a Workspace trigger holds it", async () => {
      const registry = fresh();

      await startIn(registry, "s-0", "0f0f0f0f");
      await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 1_000);
      await registry.deleteSession("s-0");

      expect(await registry.workspaceKept("0f0f0f0f")).toBe(true);
      expect(await registry.deleteWorkspace("0f0f0f0f")).toBe("in-use");
      expect(await registry.getWorkspace("0f0f0f0f")).toMatchObject({ id: "0f0f0f0f" });
      expect((await registry.listWorkspaces()).map((workspace) => workspace.id)).toEqual([
        "0f0f0f0f",
      ]);
      expect(await registry.listSessions()).toEqual([]);
    });

    it("deletes it once the Trigger is gone, and when the agent removed it", async () => {
      const registry = fresh();

      await startIn(registry, "s-0", "0f0f0f0f");
      await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 1_000);
      await registry.deleteSession("s-0");
      await registry.removeTrigger("t1");

      // Without a Session or a Trigger the Workspace stays, listed, for the owner to remove: it may hold unpushed work.
      expect(await registry.workspaceKept("0f0f0f0f")).toBe(false);
      expect(await registry.getWorkspace("0f0f0f0f")).toMatchObject({ id: "0f0f0f0f" });
      expect(await registry.deleteWorkspace("0f0f0f0f")).toBe("deleted");

      await startIn(registry, "s-1", "0e0e0e0e");
      await registry.agentCreateTrigger(
        "t2",
        inWorkspace("0e0e0e0e"),
        { session: "s-1", conversation: 0, tool: "trigger_create", reason: "asked" },
        2_000,
      );
      await registry.deleteSession("s-1");

      expect(await registry.deleteWorkspace("0e0e0e0e")).toBe("in-use");

      await registry.agentRemoveTrigger(
        "t2",
        { session: "s-1", conversation: 0, tool: "trigger_remove", reason: "done" },
        3_000,
      );

      // The agent's removal keeps its row for a revert, but it no longer keeps the Workspace; the row goes with it.
      expect(await registry.deleteWorkspace("0e0e0e0e")).toBe("deleted");
      expect(await registry.storedTriggerIds()).toEqual([]);
    });

    it("keeps its record while a Session is bound to it, and Remove takes its Triggers first, whatever Sessions are bound", async () => {
      const registry = fresh();

      await startIn(registry, "s-0", "0f0f0f0f");
      await startIn(registry, "s-9", "0e0e0e0e");
      await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 1_000);
      await registry.createTrigger("t2", { ...inWorkspace("0f0f0f0f"), name: "Another" }, 1_000);
      await registry.createTrigger("t3", inWorkspace("0e0e0e0e"), 1_000);

      expect(await registry.workspaceKept("0f0f0f0f")).toBe(true);
      expect(await registry.workspaceKept("0e0e0e0e")).toBe(true);
      expect(await registry.workspaceKept("0a0a0a0a")).toBe(false);

      // The record and the Triggers stay while a Session is bound.
      expect(await registry.deleteWorkspaceWithTriggers("0f0f0f0f")).toEqual({
        deletion: "in-use",
        triggers: [],
      });
      expect(await registry.listTriggers()).toHaveLength(3);

      // The owner's Remove takes the Triggers alone first, whatever Sessions are bound.
      expect(await registry.deleteWorkspaceTriggers("0f0f0f0f")).toEqual(
        expect.arrayContaining(["t1", "t2"]),
      );
      expect((await registry.listTriggers()).map((trigger) => trigger.id)).toEqual(["t3"]);
      expect(await registry.workspaceKept("0f0f0f0f")).toBe(false);
      expect(await registry.triggerDefinition("t1")).toBeNull();
      expect(await registry.getWorkspace("0f0f0f0f")).toMatchObject({ id: "0f0f0f0f" });

      await registry.deleteSession("s-0");

      expect(await registry.deleteWorkspaceWithTriggers("0f0f0f0f")).toEqual({
        deletion: "deleted",
        triggers: [],
      });
    });

    it("goes with its Environment: it is in use until its Workspaces are removed, then its Triggers go", async () => {
      const registry = fresh();

      await registry.createEnvironment("0000abcd", "Cloudpid", 500);
      await registry.createSession(
        {
          id: "s-0",
          title: null,
          workspace: {
            kind: "new",
            id: "0f0f0f0f",
            environment: "0000abcd",
            branch: null,
            base: null,
          },
        },
        600,
      );
      await registry.createTrigger("t1", inWorkspace("0f0f0f0f"), 1_000);
      await registry.deleteSession("s-0");

      expect(await registry.deleteEnvironmentWithTriggers("0000abcd")).toEqual({
        deletion: "in-use",
        triggers: [],
      });
      expect(await registry.deleteWorkspaceWithTriggers("0f0f0f0f")).toEqual({
        deletion: "deleted",
        triggers: ["t1"],
      });
      expect(await registry.deleteEnvironmentWithTriggers("0000abcd")).toEqual({
        deletion: "deleted",
        triggers: [],
      });
    });
  });
});

/** A Session in the default Environment, which a Session trigger belongs to. */
const sessionIn = async (registry: ReturnType<typeof fresh>, id = "s-1") => {
  await registry.createSession(
    {
      id,
      title: null,
      workspace: {
        kind: "new",
        id: `ws-${id}`,
        environment: DEFAULT_ENVIRONMENT,
        branch: null,
        base: null,
      },
    },
    1_000,
  );
};

const daily = (session = "s-1"): SessionTriggerInput => ({
  kind: "session",
  session,
  name: "Check CI",
  message: "Check the current state of CI.",
  source: { type: "schedule", cron: "0 * * * *", zone: "UTC" },
});

describe("a Session trigger's definition", () => {
  it("belongs to its Session and the Session's Environment, queueing by default", async () => {
    const registry = fresh();

    await sessionIn(registry);

    expect(await registry.createTrigger("t1", daily(), 2_000)).toMatchObject({ status: "ok" });
    expect(await registry.triggerDefinition("t1")).toEqual({
      id: "t1",
      revision: 1,
      kind: "session",
      environment: DEFAULT_ENVIRONMENT,
      session: "s-1",
      name: "Check CI",
      message: "Check the current state of CI.",
      source: { type: "schedule", cron: "0 * * * *", zone: "UTC" },
      whenBusy: "queue",
      paused: false,
      createdAt: 2_000,
      updatedAt: 2_000,
    });
  });

  it("is refused for a Session that isn't there, and for options its kind doesn't take", async () => {
    const registry = fresh();

    await sessionIn(registry);

    expect(await registry.createTrigger("t1", daily("nope"), 2_000)).toMatchObject({
      status: "invalid",
      problem: "There is no Session nope",
    });
    expect(
      await registry.createTrigger("t1", { ...daily(), whenBusy: "start" }, 2_000),
    ).toMatchObject({ status: "invalid", problem: expect.stringContaining("when_busy") });
    expect(
      await registry.createTrigger("t1", { ...weekly, whenBusy: "queue" }, 2_000),
    ).toMatchObject({ status: "invalid", problem: expect.stringContaining("when_busy") });
    expect(await registry.listTriggers()).toEqual([]);
  });

  it("takes a Schedule only: a webhook source is refused, though RPC input is not decoded", async () => {
    const registry = fresh();

    await sessionIn(registry);

    const webhook = { ...daily(), source: { type: "webhook" as const, format: "github" as const } };

    // The type has a Schedule source only; a crafted call is not decoded over RPC.
    // @ts-expect-error -- the webhook source is the point.
    const made = await registry.createTrigger("t1", webhook, 2_000);

    expect(made).toMatchObject({
      status: "invalid",
      problem: "A Session trigger fires on a Schedule only",
    });
    expect(await registry.listTriggers()).toEqual([]);
  });

  it("takes queue, steer and skip, and no base, model or thinking", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);

    expect(await registry.updateTrigger("t1", { whenBusy: "steer" }, 3_000)).toMatchObject({
      status: "ok",
      definition: { whenBusy: "steer", revision: 2 },
    });
    expect(await registry.updateTrigger("t1", { whenBusy: "skip" }, 3_000)).toMatchObject({
      status: "ok",
    });
    expect(await registry.updateTrigger("t1", { whenBusy: "start" }, 3_000)).toMatchObject({
      status: "invalid",
    });
    expect(await registry.updateTrigger("t1", { model: "openai/gpt-5" }, 3_000)).toMatchObject({
      status: "invalid",
    });
    expect(await registry.updateTrigger("t1", { base: "main" }, 3_000)).toMatchObject({
      status: "invalid",
    });
  });

  it("is listed under its Session, and its Environment's", async () => {
    const registry = fresh();

    await sessionIn(registry, "s-1");
    await sessionIn(registry, "s-2");
    await registry.createTrigger("t1", daily("s-1"), 2_000);
    await registry.createTrigger("t2", daily("s-2"), 3_000);
    await registry.createTrigger("t3", weekly, 4_000);

    expect((await registry.listSessionTriggers("s-1")).map((each) => each.id)).toEqual(["t1"]);
    expect((await registry.listTriggers(DEFAULT_ENVIRONMENT)).map((each) => each.id)).toEqual([
      "t3",
      "t2",
      "t1",
    ]);
  });
});

describe("admitFire for a Session trigger", () => {
  const sessionFire = (revision = 1, requestId = "t1:2026-11-09T15:00:00.000Z") => ({
    trigger: "t1",
    revision,
    requestId,
    scheduledAt: monday,
    sessionTriggers: true as const,
  });

  it("answers the Session itself, registering none and taking no Workspace", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);

    expect(await registry.admitFire(sessionFire(), ids(1), monday)).toEqual({
      status: "send",
      session: "s-1",
      environment: DEFAULT_ENVIRONMENT,
    });
    expect((await registry.listSessions()).map((session) => session.id)).toEqual(["s-1"]);
    expect(await registry.listWorkspaces()).toHaveLength(1);
  });

  it("does not look at the Session's status: the Session decides the overlap", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.setSessionStatus("s-1", "running", monday - 1_000);
    await registry.createTrigger("t1", { ...daily(), whenBusy: "skip" }, 2_000);

    expect(await registry.admitFire(sessionFire(), ids(1), monday)).toMatchObject({
      status: "send",
      session: "s-1",
    });
  });

  it("is never answered to a caller that does not know Session triggers: its Fire fails, to be tried again", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);

    const { sessionTriggers: _known, ...older } = sessionFire();

    expect(await registry.admitFire(older, ids(1), monday)).toEqual({ status: "unsupported" });
    // Nothing was kept of it: the same Fire from a caller that knows them is let through.
    expect(await registry.admitFire(sessionFire(), ids(1), monday)).toMatchObject({
      status: "send",
    });
  });

  it("answers a Fire it let through before its Session again, whatever came since", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);

    const admitted = {
      status: "send",
      session: "s-1",
      environment: DEFAULT_ENVIRONMENT,
    } as const;

    expect(await registry.admitFire(sessionFire(), ids(1), monday)).toEqual(admitted);

    // Paused: the Fire admitted before goes on, as an Environment trigger's does; a new one does not.
    await registry.setTriggerPaused("t1", true, 3_000);
    expect(await registry.admitFire(sessionFire(), ids(2), monday + 1)).toEqual({
      ...admitted,
      repeated: true,
    });
    expect(await registry.admitFire(sessionFire(2, "t1:another"), ids(3), monday + 1)).toEqual({
      status: "paused",
    });

    // Archived, and its revision since changed: still answered.
    await registry.archiveSession("s-1", 4_000);
    expect(await registry.admitFire(sessionFire(1), ids(4), monday + 2)).toEqual({
      ...admitted,
      repeated: true,
    });
  });

  it("answers a removed Trigger's admitted Fire its Session again, and none once the Session is gone", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);
    await registry.admitFire(sessionFire(), ids(1), monday);
    await registry.removeTrigger("t1");

    expect(await registry.admitFire(sessionFire(), ids(2), monday + 1)).toMatchObject({
      status: "send",
      session: "s-1",
      repeated: true,
    });

    await registry.deleteSessionWithTriggers("s-1");

    expect(await registry.admitFire(sessionFire(), ids(3), monday + 2)).toEqual({
      status: "removed",
    });
  });

  it("forgets a Fire it let through after a day, as a start's request id is", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);
    await registry.admitFire(sessionFire(), ids(1), monday);
    await registry.setTriggerPaused("t1", true, 3_000);

    expect(
      await registry.admitFire(sessionFire(), ids(2), monday + 24 * 60 * 60 * 1000 + 1),
    ).toEqual({ status: "paused" });
  });

  it("lets nothing through for a paused Trigger, and answers stale for an old revision", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);

    expect(await registry.admitFire(sessionFire(5), ids(1), monday)).toMatchObject({
      status: "stale",
      definition: { id: "t1", kind: "session" },
    });

    await registry.setTriggerPaused("t1", true, 3_000);

    expect(await registry.admitFire(sessionFire(2), ids(1), monday)).toEqual({ status: "paused" });
  });

  it("is let through for an archived Session, which refuses the Fire itself", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);
    await registry.archiveSession("s-1", 3_000);

    expect(await registry.admitFire(sessionFire(), ids(1), monday)).toMatchObject({
      status: "send",
      session: "s-1",
    });
  });
});

describe("a Fork or Clone of a Session with a Session trigger", () => {
  it("has none of its own: the Trigger stays its source's alone", async () => {
    const registry = fresh();

    await sessionIn(registry, "s-1");
    await registry.createTrigger("t1", daily("s-1"), 2_000);

    for (const [id, kind] of [
      ["s-2", "fork"],
      ["s-3", "clone"],
    ] as const) {
      await registry.createSession(
        {
          id,
          title: `Check CI (${kind})`,
          workspace: { kind: "existing", id: "ws-s-1" },
          origin: { session: "s-1", kind },
        },
        3_000,
      );
    }

    expect(await registry.listSessionTriggers("s-2")).toEqual([]);
    expect(await registry.listSessionTriggers("s-3")).toEqual([]);
    expect((await registry.listSessionTriggers("s-1")).map((each) => each.id)).toEqual(["t1"]);
    expect(await registry.storedTriggerIds()).toEqual(["t1"]);
  });
});

describe("deleting a Session", () => {
  it("deletes its Session triggers in the same step, and answers their ids", async () => {
    const registry = fresh();

    await sessionIn(registry, "s-1");
    await sessionIn(registry, "s-2");
    await registry.createTrigger("t1", daily("s-1"), 2_000);
    await registry.createTrigger("t2", daily("s-1"), 2_000);
    await registry.createTrigger("t3", daily("s-2"), 2_000);
    await registry.createTrigger("t4", weekly, 2_000);

    expect(await registry.deleteSessionWithTriggers("s-1")).toEqual({
      deleted: true,
      triggers: expect.arrayContaining(["t1", "t2"]),
    });
    expect(await registry.storedTriggerIds()).toEqual(["t3", "t4"]);
    expect(await registry.triggerDefinition("t1")).toBeNull();
  });

  it("deletes only the Session triggers with deleteSessionTriggers, leaving the Session", async () => {
    const registry = fresh();

    await sessionIn(registry, "s-1");
    await registry.createTrigger("t1", daily("s-1"), 2_000);
    await registry.createTrigger("t2", weekly, 2_000);

    expect(await registry.deleteSessionTriggers("s-1")).toEqual(["t1"]);
    expect(await registry.storedTriggerIds()).toEqual(["t2"]);
    expect((await registry.listSessions()).map((session) => session.id)).toEqual(["s-1"]);
    // A Fire on its way finds no Trigger to let through.
    expect(
      await registry.admitFire(
        { trigger: "t1", revision: 1, requestId: "r", sessionTriggers: true },
        ids(1),
        monday,
      ),
    ).toEqual({ status: "removed" });
  });

  it("forgets the Fires it let through with the Session triggers, so a repeat finds none", async () => {
    const registry = fresh();

    const fire = {
      trigger: "t1",
      revision: 1,
      requestId: "t1:2026-11-09T15:00:00.000Z",
      sessionTriggers: true as const,
    };

    await sessionIn(registry, "s-1");
    await registry.createTrigger("t1", daily("s-1"), 2_000);
    expect(await registry.admitFire(fire, ids(1), monday)).toMatchObject({ status: "send" });

    await registry.deleteSessionTriggers("s-1");

    expect(await registry.admitFire(fire, ids(2), monday + 1)).toEqual({ status: "removed" });
  });

  it("leaves another Session's admitted Fires when one Session's Triggers go", async () => {
    const registry = fresh();

    const fire = (trigger: string) => ({
      trigger,
      revision: 1,
      requestId: `${trigger}:2026-11-09T15:00:00.000Z`,
      sessionTriggers: true as const,
    });

    await sessionIn(registry, "s-1");
    await sessionIn(registry, "s-2");
    await registry.createTrigger("t1", daily("s-1"), 2_000);
    await registry.createTrigger("t2", daily("s-2"), 2_000);
    await registry.admitFire(fire("t1"), ids(1), monday);
    await registry.admitFire(fire("t2"), ids(2), monday);

    await registry.deleteSessionTriggers("s-1");
    await registry.setTriggerPaused("t2", true, 3_000);

    expect(await registry.admitFire(fire("t2"), ids(3), monday + 1)).toMatchObject({
      status: "send",
      session: "s-2",
      repeated: true,
    });
  });

  it("deletes one the agent removed too", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);
    await registry.agentRemoveTrigger(
      "t1",
      { session: "s-1", conversation: 0, tool: "trigger_remove", reason: "r" },
      3_000,
    );

    // The removed one's row is kept for a revert; its Session's deletion drops it, and its object was wiped already.
    expect(await registry.deleteSessionWithTriggers("s-1")).toEqual({
      deleted: true,
      triggers: [],
    });
    expect(await registry.storedTriggerIds()).toEqual([]);
  });

  it("deletes them with the old deleteSession too", async () => {
    const registry = fresh();

    await sessionIn(registry);
    await registry.createTrigger("t1", daily(), 2_000);

    expect(await registry.deleteSession("s-1")).toBe(true);
    expect(await registry.storedTriggerIds()).toEqual([]);
  });

  it("keeps a Session's Triggers when another Session is deleted", async () => {
    const registry = fresh();

    await sessionIn(registry, "s-1");
    await sessionIn(registry, "s-2");
    await registry.createTrigger("t1", daily("s-1"), 2_000);

    expect(await registry.deleteSessionWithTriggers("s-2")).toEqual({
      deleted: true,
      triggers: [],
    });
    expect(await registry.triggerDefinition("t1")).not.toBeNull();
  });
});
