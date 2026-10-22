// The Container's early start on a message, through the Workspace DO (docs/spec.md → Backends). The test Worker has no
// Container, so every start fails: what is checked is that the request answers at once and never fails, that the
// Workspace works on, and that the attempt counts as use for the idle stop.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { sessionWorkspace } from "../session/workspace.ts";
import "./session.workerd.helpers.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

it("answers a Session's request at once, and a start that fails fails nothing", async () => {
  const slug = "warm-1";

  const workspace = sessionWorkspace({
    namespace: env.WORKSPACES,
    placement: () => Promise.resolve({ slug, repo: null }),
  });

  await expect(workspace.warm()).resolves.toBeUndefined();
  // Asked again while the first is under way or after it failed: still nothing to fail.
  await expect(workspace.warm()).resolves.toBeUndefined();

  // The Workspace is still there for the message's tools.
  expect(await workspace.files.readdir("/workspace")).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: ".agents" })]),
  );
});

it("counts the start as use of the Container: the idle stop's alarm is armed", async () => {
  const stub = env.WORKSPACES.getByName("warm-2");

  expect(
    await runInDurableObject(stub, (_: TestWorkspace, state) => state.storage.getAlarm()),
  ).toBeNull();

  await stub.warmContainer();

  await vi.waitFor(
    async () =>
      expect(
        await runInDurableObject(stub, (_: TestWorkspace, state) => state.storage.getAlarm()),
      ).not.toBeNull(),
    { timeout: 10_000, interval: 50 },
  );
});

it("is asked of the Session's own Workspace", async () => {
  const workspace = sessionWorkspace({
    namespace: {
      getByName: (slug) => {
        expect(slug).toBe(DEFAULT_WORKSPACE);

        return env.WORKSPACES.getByName(slug);
      },
    },
    placement: () => Promise.resolve({ slug: DEFAULT_WORKSPACE, repo: "pi" }),
  });

  await expect(workspace.warm()).resolves.toBeUndefined();
});
