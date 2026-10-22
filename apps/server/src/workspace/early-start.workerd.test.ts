// The Container's early start (docs/spec.md → Backends), from a Session's message to the Workspace DO. The Session is
// wired as the Session DO is (`earlyStartOnSubmit` as its `onSubmit`). The test Worker has no Container, so every start
// fails: what is checked is that a message asks for one, that the request answers at once and never fails the message,
// and that the attempt counts as use for the idle stop.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { sessionWorkspace } from "../session/workspace.ts";
import type { TestWorkspaceSession } from "./session.fixture.ts";
import "./session.workerd.helpers.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

const waits = { timeout: 10_000, interval: 50 };

const earlyStarts = (slug: string) =>
  runInDurableObject(env.WORKSPACES.getByName(slug), (instance: TestWorkspace) =>
    instance.earlyStarts(),
  );

/** Send one message, as the owner does, to `session` (a new Session by default) on Workspace `slug`: its submission ID. */
const send = (
  slug: string,
  session = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId()),
) =>
  runInDurableObject(session, async (instance: TestWorkspaceSession) => {
    instance.bindWorkspace(slug);
    instance.script(["done"]);

    return instance.submit({ requestId: crypto.randomUUID(), text: "go" });
  });

it("asks the Session's Workspace for one early start per message the owner sends", async () => {
  const slug = "early-start-1";

  expect(await send(slug)).toEqual(expect.any(Number));
  await vi.waitFor(async () => expect(await earlyStarts(slug)).toBe(1), waits);

  await send(slug);
  await vi.waitFor(async () => expect(await earlyStarts(slug)).toBe(2), waits);
});

it("admits the message when the request for the early start fails", async () => {
  const slug = "early-start-unreachable-1";
  const session = env.WORKSPACE_SESSIONS.get(env.WORKSPACE_SESSIONS.newUniqueId());

  expect(await send(slug, session)).toEqual(expect.any(Number));
  await vi.waitFor(
    async () =>
      expect(
        await runInDurableObject(session, (instance: TestWorkspaceSession) =>
          instance.unreachableEarlyStarts(),
        ),
      ).toBe(1),
    waits,
  );
  expect(await earlyStarts(slug)).toBe(0);
});

it("answers at once, and a start that fails leaves the Workspace working and counts as use", async () => {
  const stub = env.WORKSPACES.getByName("early-start-2");

  expect(
    await runInDurableObject(stub, (_: TestWorkspace, state) => state.storage.getAlarm()),
  ).toBeNull();

  await stub.startContainerEarly();
  // Asked again while the first is under way or after it failed: still nothing to fail.
  await stub.startContainerEarly();

  // The idle stop's alarm is armed.
  await vi.waitFor(
    async () =>
      expect(
        await runInDurableObject(stub, (_: TestWorkspace, state) => state.storage.getAlarm()),
      ).not.toBeNull(),
    waits,
  );

  const files = sessionWorkspace({
    namespace: env.WORKSPACES,
    placement: () => Promise.resolve({ machine: "early-start-2", repo: null, worktree: null }),
    prepare: () => Promise.reject(new Error("no worktree to make")),
  }).files;

  expect(await files.readdir("/workspace")).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: ".agents" })]),
  );
});
