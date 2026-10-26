// `container_restart` and `container_resize` end to end: a Session's scripted model loads them with `tool_search` and
// calls them, and the Session acts on its own Workspace's Container through the Workspace DO, without readying the
// Workspace (the test Worker readies none, and runs no Container). workerd's APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, sessionOn, uniqueWorkspace } from "./session.workerd.helpers.ts";

const SNAPSHOT_KEY = "cloudpid:container-snapshot";
const RESIZE_KEY = "cloudpid:container-resize";

const snapshot = { id: "snap-agent", size: 1, takenAt: 1, refreshedAt: 1 };

/** What Workspace `slug` holds at `key`. */
const stored = (slug: string, key: string) =>
  runInDurableObject(env.WORKSPACES.getByName(slug), (_instance, state) => state.storage.get(key));

/** Workspace `slug`'s snapshot record set to `snapshot`. */
const withSnapshot = (slug: string) =>
  runInDurableObject(env.WORKSPACES.getByName(slug), async (_instance, state) => {
    await state.storage.put(SNAPSHOT_KEY, snapshot);
  });

const loadRestart = call("tool_search", { query: "restart container" });
const loadResize = call("tool_search", { query: "container resize size" });

describe("container_restart in a Session", () => {
  it("stops the Session's own Workspace's Container without readying it, and keeps the snapshot", async () => {
    const slug = uniqueWorkspace();

    await withSnapshot(slug);

    const results = await sessionOn(slug).run([
      loadRestart,
      call("container_restart", { reason: "echo hung for minutes" }),
    ]);

    expect(results.at(-1)).toMatch(/^No container was running, so none was stopped\. /);
    expect(results.at(-1)).toMatch(/last snapshot/);
    expect(await stored(slug, SNAPSHOT_KEY)).toEqual(snapshot);
  });

  it("forgets the snapshot when the model asks to start fresh", async () => {
    const slug = uniqueWorkspace();

    await withSnapshot(slug);

    const results = await sessionOn(slug).run([
      loadRestart,
      call("container_restart", { reason: "the snapshot's node_modules is broken", fresh: true }),
    ]);

    expect(results.at(-1)).toMatch(/The snapshot is forgotten\./);
    expect(await stored(slug, SNAPSHOT_KEY)).toBeUndefined();
  });
});

describe("container_resize in a Session", () => {
  it("records the size for the Session's own Workspace's next Container, and refuses one above the size limit", async () => {
    const slug = uniqueWorkspace();

    const results = await sessionOn(slug).run([
      loadResize,
      call("container_resize", { size: "cpu-2", reason: "tsc was stopped at 2.6 GB" }),
      call("container_resize", { size: "standard-4", reason: "more still" }),
    ]);

    expect(results.at(-2)).toMatch(
      /^No container was running, so none was stopped\. The next container command starts a new container on cpu-2/,
    );
    expect(results.at(-1)).toMatch(/standard-4 is above this Environment's size limit, cpu-2/);
    expect(await stored(slug, RESIZE_KEY)).toBe("cpu-2");
  });
});
