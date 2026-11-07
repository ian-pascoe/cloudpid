// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestRegistry } from "./store.fixture.ts";
import type { EnvironmentTriggerInput } from "./triggers.ts";

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
