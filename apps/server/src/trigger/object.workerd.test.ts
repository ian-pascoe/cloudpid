// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
// The Trigger object over real storage and alarms (`docs/architecture/triggers.md` → Testing): a `TestTrigger`
// (`object.fixture.ts`) reads its definitions from, and admits its Fires through, a real `TestRegistry`; the Sessions'
// `fire` is scripted.
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentTriggerInput,
  MAX_FIRE_LOG,
  type WorkspaceTriggerInput,
} from "@cloudpid/protocol";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { TestTrigger } from "./object.fixture.ts";
import { MAX_FIRE_ATTEMPTS, RETRY_MS } from "./object.ts";
import { openTriggerStore } from "./store.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
      readonly TRIGGERS: DurableObjectNamespace<TestTrigger>;
    }
  }
}

const HOUR = 60 * 60_000;

const DAY = 24 * HOUR;

/**
 * 8:00 UTC on a day a week after the real clock: an hour before the daily Schedule's first Fire. It follows the real
 * clock, since workerd runs an alarm set in the past at once.
 */
const start = (() => {
  const day = new Date(Date.now() + 7 * DAY);

  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8);
})();

const nine = start + HOUR;

const daily: EnvironmentTriggerInput = {
  kind: "environment",
  environment: DEFAULT_ENVIRONMENT,
  name: "Daily triage",
  message: "Triage the new issues.",
  source: { type: "schedule", cron: "0 9 * * *", zone: "UTC" },
};

let counter = 0;

/** A Trigger, made in a new Registry at `start`, and its object, synced at `start`. */
const made = async (input: EnvironmentTriggerInput = daily) => {
  const id = `t${String(counter++)}`;
  const registry = env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

  expect(await registry.createTrigger(id, input, start)).toMatchObject({ status: "ok" });

  const trigger = env.TRIGGERS.getByName(`trigger:${id}`);

  await trigger.use(registry.id.toString());
  await trigger.setNow(start);
  await trigger.sync();

  return { id, registry, trigger };
};

const keyAt = (id: string, at: number) => `${id}:${new Date(at).toISOString()}`;

describe("a Trigger's object", () => {
  it("arms its alarm at the next Fire, fires when due and arms again", async () => {
    const { id, registry, trigger } = await made();

    expect(await trigger.alarmAt()).toBe(nine);
    expect(await trigger.state()).toMatchObject({ nextFireAt: nine, pending: 0 });

    await trigger.setNow(nine + 5_000);

    expect(await runDurableObjectAlarm(trigger)).toBe(true);

    const sent = await trigger.sent();

    expect(sent).toEqual([
      {
        session: "s-1",
        request: {
          trigger: { id, name: "Daily triage" },
          requestId: keyAt(id, nine),
          message: "Triage the new issues.",
          header: { name: "Daily triage", zone: "UTC", firedAt: nine + 5_000, scheduledAt: nine },
        },
      },
    ]);
    expect(await trigger.fireLog()).toEqual([
      {
        key: keyAt(id, nine),
        at: nine + 5_000,
        source: { type: "schedule", scheduledAt: nine },
        outcome: { type: "started", session: "s-1" },
      },
    ]);
    expect(await registry.getSession("s-1")).toMatchObject({
      marks: { kind: "trigger", trigger: { id } },
    });
    expect(await trigger.upkeep()).toEqual([DEFAULT_ENVIRONMENT]);
    expect(await trigger.alarmAt()).toBe(nine + DAY);
  });

  it("tries a Fire whose Session did not answer again, with the same key, and starts no second Session", async () => {
    const { id, registry, trigger } = await made();

    await trigger.scriptFires(["unreachable"]);
    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.fireLog()).toEqual([]);
    expect(await trigger.state()).toMatchObject({ pending: 1, nextFireAt: nine + RETRY_MS });
    expect(await trigger.alarmAt()).toBe(nine + RETRY_MS);

    await trigger.setNow(nine + RETRY_MS);
    await runDurableObjectAlarm(trigger);

    const sent = await trigger.sent();

    expect(sent.map((fire) => [fire.session, fire.request.requestId])).toEqual([
      ["s-1", keyAt(id, nine)],
      ["s-1", keyAt(id, nine)],
    ]);
    expect((await registry.listSessions()).map((session) => session.id)).toEqual(["s-1"]);
    expect(await trigger.fireLog()).toMatchObject([
      { key: keyAt(id, nine), outcome: { type: "started", session: "s-1" } },
    ]);
    // The spare was taken at the first admission only.
    expect(await trigger.upkeep()).toEqual([DEFAULT_ENVIRONMENT]);
    expect(await trigger.state()).toMatchObject({ pending: 0, nextFireAt: nine + DAY });
  });

  it("tries a retryable refusal again, and records a Fire failed once refused for good", async () => {
    const { id, trigger } = await made();

    await trigger.scriptFires([
      { ok: false, error: { code: "unavailable", message: "Busy", retryable: true } },
      { ok: false, error: { code: "session_archived", message: "Archived", retryable: false } },
    ]);
    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.state()).toMatchObject({ pending: 1 });

    await trigger.setNow(nine + RETRY_MS);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.fireLog()).toMatchObject([
      { key: keyAt(id, nine), outcome: { type: "failed", reason: "Archived" } },
    ]);
    expect(await trigger.failedNotices()).toEqual([{ trigger: id, reason: "Archived" }]);
    expect(await trigger.state()).toMatchObject({ pending: 0 });
  });

  it(`gives a Fire up after ${String(MAX_FIRE_ATTEMPTS)} tries and tells the owner`, async () => {
    const { id, trigger } = await made();

    await trigger.scriptFires(
      Array.from({ length: MAX_FIRE_ATTEMPTS }, () => "unreachable" as const),
    );

    let now = nine;

    for (let attempt = 0; attempt < MAX_FIRE_ATTEMPTS; attempt++) {
      await trigger.setNow(now);
      await trigger.runAlarm();
      now += 2 * HOUR;
    }

    expect(await trigger.sent()).toHaveLength(MAX_FIRE_ATTEMPTS);
    expect(await trigger.fireLog()).toMatchObject([
      { key: keyAt(id, nine), outcome: { type: "failed", reason: "The Session did not answer" } },
    ]);
    expect(await trigger.failedNotices()).toEqual([
      { trigger: id, reason: "The Session did not answer" },
    ]);
  });

  it("catches up with one Fire, the latest, and records the ones it missed", async () => {
    const { id, trigger } = await made();
    const late = nine + 3 * DAY + HOUR;

    await trigger.setNow(late);
    await runDurableObjectAlarm(trigger);

    expect((await trigger.sent()).map((fire) => fire.request.requestId)).toEqual([
      keyAt(id, nine + 3 * DAY),
    ]);
    expect(await trigger.fireLog()).toMatchObject([
      { key: keyAt(id, nine + 3 * DAY), outcome: { type: "started" } },
      { key: keyAt(id, nine + 2 * DAY), outcome: { type: "skipped", reason: "missed" } },
      { key: keyAt(id, nine + DAY), outcome: { type: "skipped", reason: "missed" } },
      { key: keyAt(id, nine), outcome: { type: "skipped", reason: "missed" } },
    ]);
    expect(await trigger.alarmAt()).toBe(nine + 4 * DAY);
  });

  it("records a Fire skipped while the last one's Session still runs", async () => {
    const { id, registry, trigger } = await made();

    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);
    await registry.setSessionStatus("s-1", "running", nine + 1_000);
    await trigger.setNow(nine + DAY);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toHaveLength(1);
    expect(await trigger.fireLog()).toMatchObject([
      { key: keyAt(id, nine + DAY), outcome: { type: "skipped", reason: "overlap" } },
      { key: keyAt(id, nine), outcome: { type: "started" } },
    ]);
    expect(await trigger.alarmAt()).toBe(nine + 2 * DAY);
  });

  describe("reads its definition again at each touch", () => {
    it("wipes itself once its Trigger is gone", async () => {
      const { id, registry, trigger } = await made();

      await trigger.setNow(nine);
      await runDurableObjectAlarm(trigger);
      await registry.removeTrigger(id);
      await trigger.setNow(nine + DAY);
      await runDurableObjectAlarm(trigger);

      expect(await trigger.sent()).toHaveLength(1);
      expect(await trigger.fireLog()).toEqual([]);
      expect(await trigger.state()).toEqual({
        definition: null,
        nextFireAt: null,
        lastFire: null,
        pending: 0,
        waiting: null,
      });
      expect(await trigger.alarmAt()).toBeNull();
    });

    it("disarms while paused, and takes up at the next Fire after its resume, without catching up", async () => {
      const { id, registry, trigger } = await made();

      await registry.setTriggerPaused(id, true, start + 1_000);

      expect(await trigger.sync()).toMatchObject({
        definition: { paused: true },
        nextFireAt: null,
      });
      expect(await trigger.alarmAt()).toBeNull();

      await registry.setTriggerPaused(id, false, nine + HOUR);
      await trigger.setNow(nine + HOUR);

      expect(await trigger.sync()).toMatchObject({ nextFireAt: nine + DAY });
      expect(await trigger.alarmAt()).toBe(nine + DAY);
      expect(await trigger.fireLog()).toEqual([]);
    });

    it("arms at a changed Schedule, even one it was not told of", async () => {
      const { id, registry, trigger } = await made();
      const noon = start + 4 * HOUR;

      // The change's message to the object was lost: the alarm at 9:00 reads the new Schedule and fires nothing.
      await registry.updateTrigger(
        id,
        { source: { type: "schedule", cron: "0 12 * * *", zone: "UTC" } },
        start + 1_000,
      );
      await trigger.setNow(nine);
      await runDurableObjectAlarm(trigger);

      expect(await trigger.sent()).toEqual([]);
      expect(await trigger.alarmAt()).toBe(noon);

      await trigger.setNow(noon);
      await runDurableObjectAlarm(trigger);

      expect(await trigger.sent()).toMatchObject([
        { request: { requestId: keyAt(id, noon), header: { scheduledAt: noon } } },
      ]);
    });

    it("takes up a definition that changed under a Fire, as admitFire answers it, and sends the Fire with it", async () => {
      const { id, registry, trigger } = await made();

      await trigger.freezeReads();
      await registry.updateTrigger(id, { message: "Triage the old issues too." }, start + 1_000);
      await trigger.setNow(nine);
      await runDurableObjectAlarm(trigger);

      expect(await trigger.sent()).toMatchObject([
        { request: { message: "Triage the old issues too." } },
      ]);
      // The stale admission registered no Session.
      expect(await registry.listSessions()).toHaveLength(1);
      expect(await trigger.state()).toMatchObject({
        definition: { revision: 2 },
        lastFire: { outcome: { type: "started" } },
      });
    });

    it("keeps its Fires and arms again soon while the Registry can't be reached", async () => {
      const { trigger } = await made();

      await trigger.setRegistryDown(true);
      await trigger.setNow(nine);
      await runDurableObjectAlarm(trigger);

      expect(await trigger.sent()).toEqual([]);
      expect(await trigger.alarmAt()).toBe(nine + RETRY_MS);

      await trigger.setRegistryDown(false);
      await trigger.setNow(nine + RETRY_MS);
      await runDurableObjectAlarm(trigger);

      expect(await trigger.sent()).toMatchObject([{ request: { header: { scheduledAt: nine } } }]);
    });
  });

  describe("a Fire already admitted", () => {
    it("is completed after its Trigger was paused, and its Session gets the message", async () => {
      const { id, registry, trigger } = await made();

      await trigger.scriptFires(["unreachable"]);
      await trigger.setNow(nine);
      await runDurableObjectAlarm(trigger);
      await registry.setTriggerPaused(id, true, nine + 1_000);
      await trigger.setNow(nine + 1_000);

      expect(await trigger.sync()).toMatchObject({
        definition: { paused: true },
        pending: 1,
        nextFireAt: nine + RETRY_MS,
      });
      expect(await trigger.alarmAt()).toBe(nine + RETRY_MS);

      await trigger.setNow(nine + RETRY_MS);
      await runDurableObjectAlarm(trigger);

      expect((await trigger.sent()).map((fire) => [fire.session, fire.request.requestId])).toEqual([
        ["s-1", keyAt(id, nine)],
        ["s-1", keyAt(id, nine)],
      ]);
      expect(await trigger.fireLog()).toMatchObject([
        { key: keyAt(id, nine), outcome: { type: "started", session: "s-1" } },
      ]);
      expect(await trigger.state()).toMatchObject({ pending: 0, nextFireAt: null });
      expect(await trigger.alarmAt()).toBeNull();
    });

    it("is completed before the object of a removed Trigger is wiped", async () => {
      const { id, registry, trigger } = await made();

      await trigger.scriptFires(["unreachable"]);
      await trigger.setNow(nine);
      await runDurableObjectAlarm(trigger);
      await registry.removeTrigger(id);
      await trigger.remove();

      expect((await trigger.sent()).map((fire) => fire.session)).toEqual(["s-1", "s-1"]);
      expect(await trigger.state()).toEqual({
        definition: null,
        nextFireAt: null,
        lastFire: null,
        pending: 0,
        waiting: null,
      });
    });
  });

  it("gives the Fires already admitted a last try when admitFire answers another removed", async () => {
    const { id, registry, trigger } = await made();

    await trigger.scriptFires(["unreachable"]);
    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);
    // The object reads the definition as it was: only `admitFire` sees the removal.
    await trigger.freezeReads();
    await trigger.setNow(nine + 1_000);
    await trigger.fireNow();
    await registry.removeTrigger(id);
    await runDurableObjectAlarm(trigger);

    expect((await trigger.sent()).map((fire) => [fire.session, fire.request.requestId])).toEqual([
      ["s-1", keyAt(id, nine)],
      ["s-1", keyAt(id, nine)],
    ]);
    expect(await trigger.state()).toMatchObject({ definition: null, pending: 0 });
    expect(await trigger.alarmAt()).toBeNull();
  });

  it("drops a Fire not yet admitted when its Trigger is removed, logging it and sending nothing", async () => {
    const { id, registry, trigger } = await made();

    await trigger.setNow(start + 1_000);
    await trigger.fireNow();
    await registry.removeTrigger(id);
    await trigger.remove();

    expect(await trigger.sent()).toEqual([]);
    expect(await trigger.logged()).toEqual([
      { level: "Warn", message: "A removed Trigger dropped a pending Fire" },
    ]);
    expect(await trigger.state()).toEqual({
      definition: null,
      nextFireAt: null,
      lastFire: null,
      pending: 0,
      waiting: null,
    });
  });

  it("records a Fire not yet admitted skipped when its Trigger is paused", async () => {
    const { id, registry, trigger } = await made();

    await trigger.setNow(start + 1_000);
    await trigger.fireNow();
    await registry.setTriggerPaused(id, true, start + 2_000);
    await trigger.setNow(start + 2_000);
    await trigger.sync();

    expect(await trigger.fireLog()).toMatchObject([
      {
        at: start + 2_000,
        source: { type: "manual" },
        outcome: { type: "skipped", reason: "paused" },
      },
    ]);
    expect(await trigger.state()).toMatchObject({ pending: 0, nextFireAt: null });
    expect(await trigger.sent()).toEqual([]);
  });

  it("answers reads of an object with no storage empty, and makes none", async () => {
    const { trigger } = await made();
    const never = env.TRIGGERS.getByName("trigger:never-synced");

    await trigger.remove();

    for (const object of [trigger, never]) {
      expect(await object.state()).toEqual({
        definition: null,
        nextFireAt: null,
        lastFire: null,
        pending: 0,
        waiting: null,
      });
      expect(await object.fireLog()).toEqual([]);

      const tables = await runInDurableObject(object, (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map((row) => row.name)
          .filter((name) => !name.startsWith("_cf_")),
      );

      expect(tables).toEqual([]);
    }
  });

  it("sends a Fire the owner asked for now, at once, recorded manual", async () => {
    const { id, trigger } = await made();

    await trigger.setNow(start + 1_000);

    const answer = await trigger.fireNow();

    expect(answer).toMatchObject({ status: "queued" });
    expect(answer.status === "queued" && answer.key.startsWith(`${id}:manual:`)).toBe(true);
    expect(await trigger.alarmAt()).toBe(start + 1_000);

    await runDurableObjectAlarm(trigger);

    const [sent] = await trigger.sent();

    expect(sent?.request.header).toEqual({
      name: "Daily triage",
      zone: "UTC",
      firedAt: start + 1_000,
    });
    expect(await trigger.fireLog()).toMatchObject([
      { source: { type: "manual" }, outcome: { type: "started", session: "s-1" } },
    ]);
    // The Schedule is untouched: its next Fire is still today's.
    expect(await trigger.alarmAt()).toBe(nine);
  });

  it("makes one Fire of a Fire now asked again with its key, pending or settled", async () => {
    const { id, trigger } = await made();

    await trigger.setNow(start + 1_000);

    expect(await trigger.fireNow("k1")).toEqual({ status: "queued", key: `${id}:manual:k1` });
    expect(await trigger.fireNow("k1")).toEqual({ status: "queued", key: `${id}:manual:k1` });

    await runDurableObjectAlarm(trigger);

    expect(await trigger.fireNow("k1")).toEqual({ status: "queued", key: `${id}:manual:k1` });
    expect(await trigger.sent()).toHaveLength(1);
    expect(await trigger.fireLog()).toHaveLength(1);
  });

  it("refuses a Fire now while paused", async () => {
    const { id, registry, trigger } = await made();

    await registry.setTriggerPaused(id, true, start + 1_000);

    expect(await trigger.fireNow()).toEqual({ status: "paused" });
    expect(await trigger.alarmAt()).toBeNull();
  });

  it("sends a Fire a replaced instance left pending again, to the same Session", async () => {
    const { id, registry, trigger } = await made();

    await trigger.replaceOnFire();
    await trigger.setNow(nine);
    // The Session took the Fire; the record of it was refused, and so was the alarm's re-arm.
    await trigger.runAlarm();
    await abortAllDurableObjects();

    const renewed = env.TRIGGERS.getByName(`trigger:${id}`);

    await renewed.use(registry.id.toString());
    await renewed.setNow(nine + RETRY_MS);

    expect(await renewed.state()).toMatchObject({ pending: 1, lastFire: null });

    await renewed.runAlarm();

    expect(await renewed.sent()).toMatchObject([
      { session: "s-1", request: { requestId: keyAt(id, nine) } },
    ]);
    // The Registry's stub was aborted with every object: its object is reached anew.
    const sessions = await env.REGISTRIES.get(registry.id).listSessions();

    expect(sessions.map((session) => session.id)).toEqual(["s-1"]);
    expect(await renewed.fireLog()).toMatchObject([
      { key: keyAt(id, nine), outcome: { type: "started", session: "s-1" } },
    ]);
  });

  it(`keeps the last ${String(MAX_FIRE_LOG)} records of its fire log`, async () => {
    const trigger = env.TRIGGERS.getByName("trigger:log");

    await runInDurableObject(trigger, (_instance, state) => {
      const store = openTriggerStore(state.storage);

      for (let n = 0; n < MAX_FIRE_LOG + 5; n++) {
        store.record({
          key: `k${String(n)}`,
          at: n,
          source: { type: "manual" },
          outcome: { type: "skipped", reason: "overlap" },
        });
      }
    });

    const log = await trigger.fireLog(MAX_FIRE_LOG + 10);

    expect(log).toHaveLength(MAX_FIRE_LOG);
    expect(log[0]?.key).toBe(`k${String(MAX_FIRE_LOG + 4)}`);
    expect(log.at(-1)?.key).toBe("k5");
  });
});

describe("a Workspace trigger's object", () => {
  const inWorkspace = (whenBusy?: WorkspaceTriggerInput["whenBusy"]): WorkspaceTriggerInput => ({
    kind: "workspace",
    workspace: "0f0f0f0f",
    name: "Nightly check",
    message: "Check the build.",
    source: { type: "schedule", cron: "0 9 * * *", zone: "UTC" },
    whenBusy,
  });

  /** A Workspace trigger in a new Registry, whose Workspace has a Session `s-0` running, and its object synced. */
  const kept = async (whenBusy?: WorkspaceTriggerInput["whenBusy"]) => {
    const id = `w${String(counter++)}`;
    const registry = env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

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
      start - HOUR,
    );
    await registry.setSessionStatus("s-0", "running", start - HOUR / 2);
    expect(await registry.createTrigger(id, inWorkspace(whenBusy), start)).toMatchObject({
      status: "ok",
    });

    const trigger = env.TRIGGERS.getByName(`trigger:${id}`);

    await trigger.use(registry.id.toString());
    await trigger.setNow(start);
    await trigger.sync();

    return { id, registry, trigger };
  };

  const pendingOf = (trigger: ReturnType<typeof env.TRIGGERS.getByName>) =>
    runInDurableObject(trigger, (_instance, state) => openTriggerStore(state.storage).pending());

  it("keeps a Fire pending while its Workspace is busy, tries again a minute later, and starts once it is idle", async () => {
    const { id, registry, trigger } = await kept();

    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);

    // Waiting is no failure: nothing is recorded, no attempt is counted, and it is tried again a minute later.
    expect(await trigger.fireLog()).toEqual([]);
    expect(await trigger.sent()).toEqual([]);
    expect(await pendingOf(trigger)).toMatchObject([
      { key: keyAt(id, nine), attempts: 0, nextTryAt: nine + RETRY_MS, waiting: { merged: 0 } },
    ]);
    expect(await trigger.alarmAt()).toBe(nine + RETRY_MS);

    await trigger.setNow(nine + RETRY_MS);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.fireLog()).toEqual([]);
    expect(await trigger.alarmAt()).toBe(nine + 2 * RETRY_MS);

    await registry.setSessionStatus("s-0", "idle", nine + RETRY_MS + 1_000);
    await trigger.setNow(nine + 2 * RETRY_MS);
    await runDurableObjectAlarm(trigger);

    // Each try drew a Session id (the fixture draws one per admission), so the one that started is the third.
    expect(await trigger.fireLog()).toMatchObject([
      { key: keyAt(id, nine), outcome: { type: "started", session: "s-3" } },
    ]);
    expect((await trigger.sent()).map((fire) => fire.session)).toEqual(["s-3"]);
    // No delivery came in while it waited, so the header says nothing of any.
    expect((await trigger.sent())[0]?.request.header).not.toHaveProperty("coalesced");
    expect(await registry.getSession("s-3")).toMatchObject({ workspace: "0f0f0f0f" });
    expect(await trigger.alarmAt()).toBe(nine + DAY);
  });

  it("waits as long as the Workspace is busy, never failing for it", async () => {
    const { id, trigger } = await kept();

    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);

    for (let minute = 1; minute <= MAX_FIRE_ATTEMPTS + 3; minute++) {
      await trigger.setNow(nine + minute * RETRY_MS);
      await runDurableObjectAlarm(trigger);
    }

    expect(await trigger.fireLog()).toEqual([]);
    expect(await trigger.failedNotices()).toEqual([]);
    expect(await pendingOf(trigger)).toMatchObject([{ key: keyAt(id, nine), attempts: 0 }]);
  });

  it("records a later Fire coalesced while one waits, and tells the Session that finally starts how many came in", async () => {
    const { id, registry, trigger } = await kept();

    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);

    for (const key of ["a", "b"]) {
      await trigger.setNow(nine + 10_000);
      expect(await trigger.fireNow(key)).toEqual({ status: "queued", key: `${id}:manual:${key}` });
      await runDurableObjectAlarm(trigger);
    }

    expect(await trigger.fireLog()).toMatchObject([
      { key: `${id}:manual:b`, outcome: { type: "skipped", reason: "coalesced" } },
      { key: `${id}:manual:a`, outcome: { type: "skipped", reason: "coalesced" } },
    ]);
    // Still one waiting, now with two merged into it.
    expect(await pendingOf(trigger)).toMatchObject([
      { key: keyAt(id, nine), waiting: { merged: 2 } },
    ]);

    await registry.setSessionStatus("s-0", "idle", nine + 20_000);
    await trigger.setNow(nine + RETRY_MS);
    await runDurableObjectAlarm(trigger);

    const sent = await trigger.sent();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.request.header).toMatchObject({ coalesced: 2, scheduledAt: nine });
    expect(await pendingOf(trigger)).toEqual([]);
  });

  it("says what it waits for: since when, and how many more Fires were merged into it", async () => {
    const { registry, trigger } = await kept();

    expect(await trigger.state()).toMatchObject({ waiting: null });

    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.state()).toMatchObject({
      pending: 1,
      waiting: { since: nine, merged: 0 },
    });

    await trigger.setNow(nine + 10_000);
    await trigger.fireNow("a");
    await runDurableObjectAlarm(trigger);

    expect(await trigger.state()).toMatchObject({ waiting: { since: nine, merged: 1 } });

    await registry.setSessionStatus("s-0", "idle", nine + 20_000);
    await trigger.setNow(nine + RETRY_MS);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.state()).toMatchObject({ pending: 0, waiting: null });
  });

  it("records how many Fires were merged into a waiting Fire that failed for good", async () => {
    const { id, registry, trigger } = await kept();

    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);

    for (const key of ["a", "b", "c"]) {
      await trigger.setNow(nine + 10_000);
      await trigger.fireNow(key);
      await runDurableObjectAlarm(trigger);
    }

    await trigger.scriptFires([
      { ok: false, error: { code: "session_archived", message: "Archived", retryable: false } },
    ]);
    await registry.setSessionStatus("s-0", "idle", nine + 20_000);
    await trigger.setNow(nine + RETRY_MS);
    await runDurableObjectAlarm(trigger);

    expect((await trigger.fireLog())[0]).toMatchObject({
      key: keyAt(id, nine),
      outcome: { type: "failed", reason: "Archived, 3 merged" },
    });
  });

  it("merges a later Fire into the waiting one even when the Workspace is idle by then", async () => {
    const { id, registry, trigger } = await kept();

    await trigger.setNow(nine);
    await runDurableObjectAlarm(trigger);
    await registry.setSessionStatus("s-0", "idle", nine + 1_000);
    await trigger.setNow(nine + 2_000);
    await trigger.fireNow("late");
    await runDurableObjectAlarm(trigger);

    // The waiting Fire goes first, in its order; the later one is folded into it.
    expect(await trigger.fireLog()).toMatchObject([
      { key: `${id}:manual:late`, outcome: { type: "skipped", reason: "coalesced" } },
    ]);
    expect(await pendingOf(trigger)).toMatchObject([
      { key: keyAt(id, nine), waiting: { merged: 1 } },
    ]);
  });

  it("records skipped: overlap with when_busy skip, and starts at once with start", async () => {
    const skipping = await kept("skip");

    await skipping.trigger.setNow(nine);
    await runDurableObjectAlarm(skipping.trigger);

    expect(await skipping.trigger.fireLog()).toMatchObject([
      { key: keyAt(skipping.id, nine), outcome: { type: "skipped", reason: "overlap" } },
    ]);
    expect(await pendingOf(skipping.trigger)).toEqual([]);

    const starting = await kept("start");

    await starting.trigger.setNow(nine);
    await runDurableObjectAlarm(starting.trigger);

    expect(await starting.trigger.fireLog()).toMatchObject([
      { key: keyAt(starting.id, nine), outcome: { type: "started", session: "s-1" } },
    ]);
  });
});
