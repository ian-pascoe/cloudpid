// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off
// A Trigger's GitHub-managed hook, made by its object over real storage and alarms (`docs/architecture/triggers.md` →
// GitHub-managed hooks, `hook-sync.ts`): made on the repo at its first sync; updated in the same call as New URL and New
// signing secret; deleted when the Trigger goes, a failed delete tried again for up to a day; made again on a reverted
// removal; the orphan sweep before it is made; a failure kept, shown and tried again, at once on a sync; kept when a
// definition read from an older Registry names none, moved when one names another repo; and made by the alarm when an
// older object left none. GitHub is a fake (`github.fixture.ts`) behind the real hooks client; the token's permissions,
// how each of GitHub's refusals reads and which hooks the sweep picks are `github-hook.test.ts`'s.
import { DEFAULT_ENVIRONMENT, type EnvironmentTriggerInput } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { FakeHook } from "./github.fixture.ts";
import type { TestTrigger } from "./object.fixture.ts";
import { HOOK_DELETE_MS } from "./hook-sync.ts";
import { RETRY_MS } from "./object.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
      readonly TRIGGERS: DurableObjectNamespace<TestTrigger>;
    }
  }
}

const DAY = 24 * 60 * 60_000;

/**
 * 8:00 UTC on a day a week after the real clock, as `object.workerd.test.ts` has it: workerd runs an alarm set in the
 * past at once.
 */
const start = (() => {
  const day = new Date(Date.now() + 7 * DAY);

  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8);
})();

const ORIGIN = "https://pi.example";

let counter = 0;

const hooked = (repo = "o/r"): EnvironmentTriggerInput => ({
  kind: "environment",
  environment: DEFAULT_ENVIRONMENT,
  name: "CI failed",
  message: "Fix CI on main.",
  source: {
    type: "webhook",
    format: "github",
    repo,
    events: ["workflow_run"],
    match: { action: ["completed"], "workflow_run.conclusion": ["failure"] },
  },
});

/**
 * A GitHub-managed hook's Trigger made in a new Registry at `start`, and its object, set up by `arrange` (the fake
 * GitHub, the origin) before its first sync.
 */
const made = async (
  options: {
    readonly repo?: string;
    readonly arrange?: (
      trigger: DurableObjectStub<TestTrigger>,
      registry: DurableObjectStub<TestRegistry>,
    ) => Promise<void>;
  } = {},
) => {
  const id = `g${String(counter++)}`;
  const registry = env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

  expect(await registry.createTrigger(id, hooked(options.repo), start)).toMatchObject({
    status: "ok",
  });

  const trigger = env.TRIGGERS.getByName(`trigger:${id}`);

  await trigger.use(registry.id.toString());
  await trigger.setNow(start);
  await options.arrange?.(trigger, registry);

  const state = await trigger.sync();

  return { id, registry, trigger, state };
};

/** The Trigger's URL and Signing secret, as the owner reveals them. */
const secrets = async (trigger: DurableObjectStub<TestTrigger>) => {
  const answer = await trigger.reveal();

  if (answer.status !== "ok") throw new Error("A webhook Trigger has no secrets");

  return answer.secrets;
};

const hooksOf = async (trigger: DurableObjectStub<TestTrigger>, repo = "o/r") =>
  (await trigger.githubState()).hooks[repo] ?? [];

/** How many rows each of the object's tables that has any holds, by name. */
const filledTables = (trigger: DurableObjectStub<TestTrigger>) =>
  runInDurableObject(trigger, (_instance, state) =>
    Object.fromEntries(
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'trigger\\_%' ESCAPE '\\'",
        )
        .toArray()
        .map(({ name }) => [
          name,
          state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${name}`).one().n,
        ])
        .filter(([, rows]) => rows !== 0),
    ),
  );

const hook = (id: number, url: string): FakeHook => ({
  id,
  url,
  secret: "",
  events: ["push"],
  contentType: "json",
});

describe("a GitHub-managed hook", () => {
  it("is made on its repo at the Trigger's first sync, sent only its events, at its URL, with its Signing secret", async () => {
    const { id, trigger, state } = await made();
    const { token, secret } = await secrets(trigger);

    expect(await hooksOf(trigger)).toEqual([
      {
        id: 1,
        url: `${ORIGIN}/hooks/${id}/${token}`,
        secret,
        events: ["workflow_run"],
        contentType: "json",
      },
    ]);
    expect(state.github).toEqual({ repo: "o/r", state: "ready" });
  });

  it("is updated in the same call as New URL and as New signing secret", async () => {
    const { id, trigger } = await made();

    const url = await trigger.rotate("url");

    expect(url).toMatchObject({ status: "ok", github: { state: "ready" } });
    expect(await hooksOf(trigger)).toMatchObject([
      { id: 1, url: `${ORIGIN}/hooks/${id}/${url.status === "ok" ? url.secrets.token : ""}` },
    ]);

    const secret = await trigger.rotate("secret");

    expect(await hooksOf(trigger)).toMatchObject([
      { id: 1, secret: secret.status === "ok" ? secret.secrets.secret : "" },
    ]);
  });

  it("is deleted when its Trigger goes, and made again, with the new URL, when the removal is reverted", async () => {
    const { trigger } = await made();
    const before = await secrets(trigger);

    await trigger.remove();

    expect(await hooksOf(trigger)).toEqual([]);
    expect(await trigger.alarmAt()).toBeNull();

    // A reverted removal wipes the object and wakes it: the Trigger comes back with new secrets, and a hook for them.
    await trigger.sync();

    const after = await secrets(trigger);

    expect(after.token).not.toBe(before.token);
    expect(await hooksOf(trigger)).toMatchObject([{ url: expect.stringContaining(after.token) }]);
  });

  it("is deleted later when GitHub can't take the delete, with backoff, and given up with a warning after a day", async () => {
    const { id, registry, trigger } = await made();

    // The Trigger goes from the Registry, then its object is told (`removals`).
    await registry.removeTrigger(id);
    await trigger.setGitHub({ down: true });
    await trigger.remove();

    // The wipe kept the delete, and its alarm, and nothing else.
    expect(await trigger.state()).toMatchObject({ definition: null });
    expect(await filledTables(trigger)).toEqual({ trigger_github_deletes: 1 });
    expect(await trigger.alarmAt()).toBe(start + RETRY_MS);

    await trigger.setNow(start + RETRY_MS);
    await trigger.runAlarm();

    expect(await trigger.alarmAt()).toBe(start + 3 * RETRY_MS);

    // Within the day, GitHub answers again: the hook goes, and nothing is left to try.
    await trigger.setGitHub({ down: false });
    await trigger.setNow(start + 3 * RETRY_MS);
    await trigger.runAlarm();

    expect(await hooksOf(trigger)).toEqual([]);
    expect(await trigger.alarmAt()).toBeNull();

    const { id: otherId, registry: otherRegistry, trigger: other } = await made();

    await otherRegistry.removeTrigger(otherId);
    await other.setGitHub({ down: true });
    await other.remove();
    await other.setNow(start + HOOK_DELETE_MS);
    await other.runAlarm();

    expect(await other.alarmAt()).toBeNull();
    expect(await other.logged()).toContainEqual({
      level: "Warn",
      message: expect.stringContaining("gave up deleting its GitHub hook"),
    });
    expect(await hooksOf(other)).toHaveLength(1);
  });

  it("sweeps the repo first: this stage's hooks of Triggers the Registry doesn't know go, and its own old one", async () => {
    const { id, trigger } = await made({
      arrange: async (stub, registry) => {
        await registry.createTrigger("known", hooked(), start);
        await stub.setGitHub({
          hooks: {
            "o/r": [hook(101, `${ORIGIN}/hooks/known/t`), hook(102, `${ORIGIN}/hooks/forgotten/t`)],
          },
        });
      },
    });

    expect((await hooksOf(trigger)).map(({ id: hookId }) => hookId)).toEqual([101, 1]);

    // A hook of its own it lost track of (as after a wipe whose delete was lost) goes too, before it makes another.
    await trigger.setGitHub({ hooks: { "o/r": [hook(201, `${ORIGIN}/hooks/${id}/old-token`)] } });
    await trigger.remove();
    await trigger.sync();

    expect((await hooksOf(trigger)).map(({ url }) => url)).toEqual([
      expect.not.stringContaining("old-token"),
    ]);
  });

  it("deletes no other Trigger's hook when the Registry can't say which it knows", async () => {
    const { trigger } = await made({
      arrange: async (stub) => {
        await stub.setKnownDown(true);
        await stub.setGitHub({ hooks: { "o/r": [hook(101, `${ORIGIN}/hooks/forgotten/t`)] } });
      },
    });

    expect((await hooksOf(trigger)).map(({ id }) => id)).toEqual([101, 1]);
  });

  it("keeps a failure to show, and tries again with backoff", async () => {
    const { trigger, state } = await made({
      arrange: async (stub) => {
        await stub.setGitHub({ accepted: [] });
      },
    });

    expect(state.github).toMatchObject({ state: "failed", problem: { code: "permission" } });
    expect(await trigger.alarmAt()).toBe(start + RETRY_MS);

    // The owner accepts Webhooks: write on the installation; the alarm makes the hook.
    await trigger.setGitHub({ accepted: ["o"] });
    await trigger.setNow(start + 2 * 60 * 60_000);
    await trigger.runAlarm();

    expect(await trigger.state()).toMatchObject({ github: { state: "ready" } });
    expect(await hooksOf(trigger)).toHaveLength(1);
    expect(await trigger.alarmAt()).toBeNull();
  });

  it("is tried again at once by a sync, whatever its backoff", async () => {
    const { trigger } = await made({
      arrange: async (stub) => {
        // GitHub's limit of hooks per event, reached: the repo has room again once one goes.
        await stub.setGitHub({ limit: 0 });
      },
    });

    expect(await trigger.state()).toMatchObject({ github: { problem: { code: "refused" } } });

    await trigger.setGitHub({ limit: 20 });

    expect(await trigger.sync()).toMatchObject({ github: { state: "ready" } });
  });

  it("is made at once by a sync after the owner accepts the permission, the App's last failure not told again", async () => {
    const { trigger, state } = await made({
      arrange: async (stub) => {
        await stub.setGitHub({ accepted: [] });
      },
    });

    expect(state.github).toMatchObject({ state: "failed", problem: { code: "permission" } });

    // Accepted, then resumed at the same moment: well within the App's wait after a failed mint.
    await trigger.setGitHub({ accepted: ["o"] });

    expect(await trigger.sync()).toMatchObject({ github: { state: "ready" } });
  });

  it("is kept when a definition from an older Registry names no repo, and still in place once it does again", async () => {
    const { trigger } = await made();

    // The hooks GitHub was asked to make.
    const posts = async () =>
      (await trigger.githubState()).seen.filter(
        ({ method, path }) => method === "POST" && path.endsWith("/hooks"),
      ).length;

    const before = await posts();

    await trigger.freezeReadsWithRepo(undefined);
    await trigger.sync();
    await trigger.runAlarm();

    expect(await hooksOf(trigger)).toHaveLength(1);
    expect((await trigger.githubState()).seen.filter(({ method }) => method === "DELETE")).toEqual(
      [],
    );
    expect(await trigger.logged()).toContainEqual(expect.objectContaining({ level: "Warn" }));

    // The Registry names the repo again: the kept hook is the one, neither made again nor moved.
    await trigger.unfreezeReads();

    expect(await trigger.sync()).toMatchObject({ github: { state: "ready" } });
    expect(await hooksOf(trigger)).toHaveLength(1);
    expect(await posts()).toBe(before);
  });

  it("moves to the repo a definition names when it names another, deleting the old one", async () => {
    const { trigger } = await made();

    await trigger.freezeReadsWithRepo("o/s");

    expect(await trigger.sync()).toMatchObject({ github: { repo: "o/s", state: "ready" } });
    expect(await hooksOf(trigger, "o/s")).toHaveLength(1);

    // The old hook's delete is the alarm's, due at once.
    await trigger.runAlarm();

    expect(await hooksOf(trigger, "o/r")).toEqual([]);
    expect(await hooksOf(trigger, "o/s")).toHaveLength(1);
  });

  it("is made by the alarm when an older object left the hook it names untried", async () => {
    const { trigger } = await made();

    await trigger.setGitHub({ hooks: { "o/r": [] } });
    await trigger.forgetHookRow();

    // Its next touch arms the alarm at once, and the alarm makes the hook.
    expect((await trigger.state()).nextFireAt).toBe(start);

    await trigger.runAlarm();

    expect(await hooksOf(trigger)).toHaveLength(1);
    expect(await trigger.state()).toMatchObject({ github: { state: "ready" } });
  });

  it("is not made on a stage with no public origin, and says so", async () => {
    const { trigger, state } = await made({
      arrange: async (stub) => {
        await stub.setOrigin(undefined);
      },
    });

    expect(state.github).toMatchObject({ state: "failed", problem: { code: "no_origin" } });
    expect(await hooksOf(trigger)).toEqual([]);
  });
});
