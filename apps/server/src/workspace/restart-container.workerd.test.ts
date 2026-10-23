// `restart_container` end to end: a Session's scripted model loads it with `tool_search` and calls it, and the Session
// stops its own Workspace's Container through the Workspace DO, without readying the Workspace (the test Worker readies
// none, and runs no Container). workerd's APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, sessionOn, uniqueWorkspace } from "./session.workerd.helpers.ts";

const SNAPSHOT_KEY = "cloudpid:container-snapshot";

const snapshot = { id: "snap-agent", size: 1, takenAt: 1, refreshedAt: 1 };

/** The snapshot record Workspace `slug` holds. */
const snapshotOf = (slug: string) =>
  runInDurableObject(env.WORKSPACES.getByName(slug), (_instance, state) =>
    state.storage.get(SNAPSHOT_KEY),
  );

/** Workspace `slug`'s snapshot record set to `snapshot`. */
const withSnapshot = (slug: string) =>
  runInDurableObject(env.WORKSPACES.getByName(slug), async (_instance, state) => {
    await state.storage.put(SNAPSHOT_KEY, snapshot);
  });

const load = call("tool_search", { query: "restart container" });

describe("restart_container in a Session", () => {
  it("stops the Session's own Workspace's Container without readying it, and keeps the snapshot", async () => {
    const slug = uniqueWorkspace();

    await withSnapshot(slug);

    const results = await sessionOn(slug).run([
      load,
      call("restart_container", { reason: "echo hung for minutes" }),
    ]);

    expect(results.at(-1)).toMatch(/^No container was running, so none was stopped\. /);
    expect(results.at(-1)).toMatch(/last snapshot/);
    expect(await snapshotOf(slug)).toEqual(snapshot);
  });

  it("forgets the snapshot when the model asks to start fresh", async () => {
    const slug = uniqueWorkspace();

    await withSnapshot(slug);

    const results = await sessionOn(slug).run([
      load,
      call("restart_container", { reason: "the snapshot's node_modules is broken", fresh: true }),
    ]);

    expect(results.at(-1)).toMatch(/The snapshot is forgotten\./);
    expect(await snapshotOf(slug)).toBeUndefined();
  });
});
