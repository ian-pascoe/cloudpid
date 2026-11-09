// The Session's `fire` and a Session trigger's `fireSession` (`docs/architecture/triggers.md` → Pending Fires; Fire
// records, origin marks and notifications), against real Durable Object storage: the header, the Trigger's mark, the
// Run's Notification and the Fire's key; for `fireSession`, `queue`, `steer` and `skip` and coalescing, and the refusals.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ApiResult,
  type FireRequest,
  type FireResult,
  renderFireHeader,
  type SessionFireRequest,
  type SessionWhenBusy,
} from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { poll, pollFor } from "../poll.fixture.ts";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { REQUEST_COST, type TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

let counter = 0;

/** A Session registered in a fresh Registry, with its Session object reporting to it (so its settings come from it). */
const registered = async (prefix: string) => {
  const sessionId = `${prefix}-${(counter += 1)}`;
  const registryName = `fire-registry-${counter}`;
  const registry = env.REGISTRIES.getByName(registryName);
  const stub = env.SESSIONS.getByName(sessionId);

  await registry.createSession(
    {
      id: sessionId,
      title: null,
      workspace: {
        kind: "new",
        id: "0a1b2c3d",
        environment: "default",
        branch: "cloudpid/0a1b2c3d",
        base: null,
      },
    },
    1,
  );
  await runInDurableObject(stub, (instance: TestSession) => instance.reportTo(registryName));

  return { stub, registry };
};

const script = (stub: DurableObjectStub<TestSession>, ...responses: string[]) =>
  runInDurableObject(stub, (instance: TestSession) => instance.script(responses));

const okValue = <T>(result: ApiResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  return result.value;
};

/** How a Fire met its Session: the delivery, or `skipped`. */
const outcomeOf = (result: ApiResult<FireResult>): string => {
  const value = okValue(result);

  return "skipped" in value ? `skipped: ${value.skipped}` : value.delivery;
};

const header = {
  name: "Weekly report",
  zone: "America/Chicago",
  scheduledAt: Date.parse("2026-11-09T15:00:00Z"),
  firedAt: Date.parse("2026-11-09T15:00:04Z"),
};

const fireOf = (request: Partial<FireRequest> = {}): FireRequest => ({
  trigger: { id: "t1", name: "Weekly report" },
  requestId: "t1:2026-11-09T15:00:00.000Z",
  message: "Summarize last week's PRs.",
  header,
  ...request,
});

describe("fire", () => {
  it("sends the Trigger message under cloudpid's header, marked as the Trigger's", async () => {
    const stub = fresh();

    await script(stub, "Summary sent");

    expect(outcomeOf(await stub.fire(fireOf()))).toBe("started");

    const page = await pollFor(
      async () => {
        const read = okValue(await stub.mcpTranscript({}));

        return read.entries.some((entry) => entry.role === "assistant") ? read : undefined;
      },
      () => "the Fire's Run never answered",
    );

    const input = page.entries.find((entry) => entry.role === "user");

    expect(input?.text).toMatch(/^### user · \d\d:\d\d · via Weekly report \(Trigger\)\n/);
    expect(input?.text).toContain(`${renderFireHeader(header)}\n\nSummarize last week's PRs.`);
  });

  it("tells the owner how the Fire's Run ended", async () => {
    const stub = fresh();

    await script(stub, "Summary sent");
    await stub.fire(fireOf());

    await poll(
      async () => (await stub.notified()).length > 0,
      () => "the Run's end was never notified",
    );
    expect(await stub.notified()).toEqual([{ kind: "finished" }]);
  });

  it("finds the first input again for the same Fire, and sends nothing twice", async () => {
    const stub = fresh();

    await script(stub, "once");
    await stub.fire(fireOf());
    await poll(
      async () => okValue(await stub.mcpStatus()).status === "idle",
      () => "the Fire's Run never ended",
    );

    expect(outcomeOf(await stub.fire(fireOf()))).toBe("started");

    const page = okValue(await stub.mcpTranscript({}));

    expect(page.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("refuses a message no Trigger could hold, sending nothing", async () => {
    const stub = fresh();

    expect(await stub.fire(fireOf({ message: " " }))).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(okValue(await stub.mcpTranscript({})).entries).toEqual([]);
  });
});

describe("a Session trigger's fire", () => {
  /** A Fire of Trigger `trigger`, number `n`, with the Session trigger's `when_busy`. */
  const sessionFire = (
    whenBusy: SessionWhenBusy,
    n: number,
    trigger = "t1",
  ): SessionFireRequest => ({
    trigger: { id: trigger, name: "Check CI" },
    requestId: `${trigger}:fire-${String(n)}`,
    message: "Check the current state of CI.",
    header,
    whenBusy,
  });

  /** The Session with a Run going on (it hangs until stopped). */
  const busy = async (...later: string[]) => {
    const stub = fresh();

    await script(stub, "hang", ...later);
    await stub.mcpSubmit({ input: "Work", via: { auth: "oauth" } });
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    return stub;
  };

  const userTexts = async (stub: DurableObjectStub<TestSession>) =>
    okValue(await stub.mcpTranscript({})).entries.flatMap((entry) =>
      entry.role === "user" ? [entry.text] : [],
    );

  const stopped = (stub: DurableObjectStub<TestSession>) =>
    stub.mcpStop({ via: { auth: "oauth" } });

  it("starts a Run in an idle Session, whatever its when_busy", async () => {
    for (const whenBusy of ["queue", "steer", "skip"] as const) {
      const stub = fresh();

      await script(stub, "Checked");

      expect(outcomeOf(await stub.fireSession(sessionFire(whenBusy, 1)))).toBe("started");
    }
  });

  it("queues behind a Run going on with queue, and steers it with steer", async () => {
    const stub = await busy("queued answer", "steered answer");

    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1, "t1")))).toBe("queued");
    expect(outcomeOf(await stub.fireSession(sessionFire("steer", 1, "t2")))).toBe("steered");

    await stopped(stub);
  });

  it("skips a Fire with skip while a Run goes on, sending nothing", async () => {
    const stub = await busy();

    expect(outcomeOf(await stub.fireSession(sessionFire("skip", 1)))).toBe("skipped: overlap");
    expect(await userTexts(stub)).toHaveLength(1);

    await stopped(stub);
  });

  it("counts a Run waiting for the owner's Approval as going on: queue waits behind it, skip skips", async () => {
    const { stub } = await registered("settings-approval");

    await script(
      stub,
      `call:settings_spend_limit_set:${JSON.stringify({ scope: "*", per_session: 25, reason: "More requests" })}`,
      "Raised.",
      "queued answer",
    );
    await stub.mcpSubmit({ input: "Raise the limit", via: { auth: "oauth" } });
    await poll(
      async () => okValue(await stub.mcpStatus()).status === "waiting_for_owner",
      () => "the Run never waited for the owner",
    );

    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("queued");
    expect(outcomeOf(await stub.fireSession(sessionFire("skip", 1, "t2")))).toBe(
      "skipped: overlap",
    );

    await stopped(stub);
  });

  it("sends none of a burst while an earlier Fire of the Trigger is still queued, coalescing the others", async () => {
    const stub = fresh();

    await script(stub, "gate:first", "first fire", "second trigger's fire");
    await stub.mcpSubmit({ input: "Work", via: { auth: "oauth" } });
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);

    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("queued");
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 2)))).toBe("skipped: coalesced");
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 3)))).toBe("skipped: coalesced");

    // Another Trigger's Fire is its own.
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1, "t2")))).toBe("queued");

    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await poll(
      async () =>
        okValue(await stub.mcpStatus()).status === "idle" &&
        (await userTexts(stub)).filter((text) => text.includes("Check the current")).length === 2,
      () => "the queued Fires never ran",
    );
    expect(
      (await userTexts(stub)).filter((text) => text.includes("Check the current")),
    ).toHaveLength(2);
  });

  it("answers a Fire sent again as it was first, not coalesced", async () => {
    const stub = await busy("answer");

    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("queued");
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("queued");

    await stopped(stub);
  });

  it("sends the next Fire once the earlier one is placed", async () => {
    const stub = fresh();

    await script(stub, "gate:first", "second");
    await stub.mcpSubmit({ input: "Work", via: { auth: "oauth" } });
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);

    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("queued");

    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await poll(
      async () => okValue(await stub.mcpStatus()).status === "idle",
      () => "the Runs never ended",
    );

    // Its Run ended, so the Fire was placed: the next one is sent, and starts a Run.
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 2)))).toBe("started");
  });

  it("refuses a Fire to an archived Session, and to one that is importing, sending nothing", async () => {
    const archived = fresh();

    await runInDurableObject(archived, (_instance, state) => {
      state.storage.kv.put("archived", true);
    });
    expect(await archived.fireSession(sessionFire("queue", 1))).toMatchObject({
      ok: false,
      error: { code: "session_archived", retryable: false },
    });

    const importing = fresh();

    await importing.importStart();
    expect(await importing.fireSession(sessionFire("queue", 1))).toMatchObject({
      ok: false,
      error: { code: "session_importing", retryable: false },
    });
    expect(okValue(await importing.mcpTranscript({})).entries).toEqual([]);
  });

  it("refuses a Fire to an importing Session as importing, whatever the Registry says of it", async () => {
    const stub = fresh();

    await stub.importStart();
    await stub.unregister();
    expect(await stub.fireSession(sessionFire("skip", 1))).toMatchObject({
      ok: false,
      error: { code: "session_importing", retryable: false },
    });
  });

  it("fails for good, sending nothing, once the Registry no longer lists the Session", async () => {
    const stub = fresh();

    await script(stub, "never sent");
    await stub.unregister();

    expect(await stub.fireSession(sessionFire("queue", 1))).toMatchObject({
      ok: false,
      error: { code: "not_found", retryable: false },
    });
    expect(okValue(await stub.mcpTranscript({})).entries).toEqual([]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.requests()),
    ).toHaveLength(0);
  });

  it("answers a Fire it sent before the Session was forgotten as it was first", async () => {
    const stub = await busy("answer");

    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("queued");
    await stub.unregister();
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("queued");

    await stopped(stub);
  });

  it("takes up where it was once the Session is unarchived", async () => {
    const stub = fresh();

    await script(stub, "Checked");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put("archived", true);
    });
    expect((await stub.fireSession(sessionFire("queue", 1))).ok).toBe(false);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put("archived", false);
    });

    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 2)))).toBe("started");
  });

  it("goes to the active branch, wherever the Session tree moved", async () => {
    const stub = fresh();

    await script(stub, "first answer", "second answer");
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("started");
    await poll(
      async () => okValue(await stub.mcpStatus()).status === "idle",
      () => "the first Run never ended",
    );

    const moved = await runInDurableObject(stub, async (instance: TestSession) => {
      const tree = await instance.tree();
      const first = tree.nodes.find((node) => node.role === "user");

      return instance.navigate({ entryId: first?.id ?? 0, position: "before" });
    });

    expect(moved).toHaveProperty("navigated");
    expect(await userTexts(stub)).toEqual([]);
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 2)))).toBe("started");
    expect(await userTexts(stub)).toHaveLength(1);
  });

  it("fails at no cost once the Session is at its spend limit, sending nothing", async () => {
    const { stub, registry } = await registered("session");

    await registry.updateSettings({ spendLimit: { perSession: REQUEST_COST } }, 1);
    await script(stub, "first answer", "never sent");
    expect(outcomeOf(await stub.fireSession(sessionFire("queue", 1)))).toBe("started");
    await poll(
      async () => okValue(await stub.mcpStatus()).status === "idle",
      () => "the first Run never ended",
    );

    const before = await userTexts(stub);

    expect(await stub.fireSession(sessionFire("queue", 2))).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    expect(await userTexts(stub)).toEqual(before);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.requests()),
    ).toHaveLength(1);
  });

  it("tells the owner how the Fire's Run ended, as for a Fire that started a Session", async () => {
    const stub = fresh();

    await script(stub, "Checked");
    await stub.fireSession(sessionFire("queue", 1));
    await poll(
      async () => (await stub.notified()).length > 0,
      () => "the Run's end was never notified",
    );
    expect(await stub.notified()).toEqual([{ kind: "finished" }]);
  });
});
