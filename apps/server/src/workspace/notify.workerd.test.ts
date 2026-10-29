// The file-change notify on a real Workspace DO (docs/architecture/container.md → File-change notifications): the model's
// file tools' writes and the Worker Shell's are read from computer's change log, pushed to a running Container soon after
// they stop, and then notified, each path where its watchers see it. The Container is the test Worker's fake
// (`TestWorkspace.fakeContainer`): its push moves computer's push cursor as a push does, and its helper records the paths.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off newPromise:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, MAX_WAIT_MS } from "./notify.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
    }
  }
}

const context = BACKGROUND_CONTEXT;

let objects = 0;

/** A Workspace DO of its own, its fake Container running or not, and the model's file tools over it in `/workspace/app`. */
const workspace = async (running: boolean) => {
  objects += 1;

  const stub = env.WORKSPACES.getByName(`notify-${objects}`);

  await stub.fakeContainer({ running });

  const files = new ComputerExecutionEnv({
    workspace: stub,
    id: "computer:notify",
    cwd: "/workspace/app",
  });

  /** What the notify did so far, the harness's own files (a command's spill) left out of each notify. */
  const events = async () =>
    (await stub.notifyEvents()).map((event) =>
      event
        .split(" ")
        .filter((word) => !word.startsWith("/workspace/.cloudpid"))
        .join(" "),
    );

  /** Wait until the notify has done `count` things, then a little more, so a later one would show. */
  const settled = async (count: number) => {
    await vi.waitFor(
      async () => expect((await stub.notifyEvents()).length).toBeGreaterThanOrEqual(count),
      {
        timeout: 5_000,
        interval: 50,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 2));

    return events();
  };

  const write = async (path: string, content: string) => {
    const written = await files.writeFile(path, content, context);

    expect(written.ok, path).toBe(true);
  };

  /** Run `command` on the Worker Shell, in `/workspace/app`. */
  const shell = async (command: string) => {
    const result = await files
      .onBackend("worker")
      .exec(command, { cwd: "/workspace/app" }, context);

    expect(result.ok && result.value.exitCode, command).toBe(0);
  };

  return { stub, write, shell, events, settled };
};

describe("the file-change notify", { timeout: 30_000 }, () => {
  it("pushes the file tools' writes to the running Container once they stop, then notifies each where it is", async () => {
    const { write, events, settled } = await workspace(true);

    // The first push sends what the Workspace held before it too (its root, the Skills' mount).
    await write("README.md", "#");
    await settled(2);

    await write("src/a.ts", "a");
    await write("src/nested/deep/b.ts", "b");

    // Nothing before the writes have been quiet for a moment.
    expect(await events()).toHaveLength(2);

    // One push and one notify for both, the push first: the new directories themselves, so a watcher of their parent
    // finds the new tree, and each file.
    expect((await settled(4)).slice(2)).toEqual([
      "push",
      "notify /workspace/app/src /workspace/app/src/a.ts /workspace/app/src/nested /workspace/app/src/nested/deep /workspace/app/src/nested/deep/b.ts",
    ]);
  });

  it("notifies an edited file itself, and a removed or renamed-away one at its parent", async () => {
    const { stub, write, events, settled } = await workspace(true);

    await write("src/a.ts", "a");
    await write("src/old.ts", "old");
    await write("src/from.ts", "from");
    await settled(2);

    const files = new ComputerExecutionEnv({
      workspace: stub,
      id: "computer:notify",
      cwd: "/workspace/app",
    });

    await write("src/a.ts", "edited");
    expect((await files.remove("src/old.ts", {}, context)).ok).toBe(true);
    expect((await files.createDir("lib", { recursive: true }, context)).ok).toBe(true);
    expect((await files.renameFile("src/from.ts", "lib/to.ts", context)).ok).toBe(true);

    const all = await settled(4);

    expect(all.slice(2)).toEqual([
      "push",
      "notify /workspace/app/lib /workspace/app/lib/to.ts /workspace/app/src /workspace/app/src/a.ts",
    ]);
    expect(await events()).toHaveLength(4);
  });

  it("collects the Worker Shell's writes: a redirect, sed -i, rm, mkdir -p and mv", async () => {
    const { write, shell, settled } = await workspace(true);

    await write("src/a.ts", "alpha\n");
    await write("src/old.ts", "old\n");
    await write("src/from.ts", "from\n");
    await settled(2);

    await shell("echo hi > src/new.ts");
    await shell("sed -i 's/alpha/beta/' src/a.ts");
    await shell("rm src/old.ts");
    await shell("mkdir -p made/inner");
    await shell("mv src/from.ts made/to.ts");

    const all = await settled(4);
    const notified = (all[3] ?? "").split(" ").slice(1);

    expect(all[2]).toBe("push");
    expect(notified).toEqual(
      expect.arrayContaining([
        "/workspace/app/src/new.ts",
        "/workspace/app/src/a.ts",
        // `old.ts` and `from.ts` gone from `src`: at `src`.
        "/workspace/app/src",
        "/workspace/app/made",
        "/workspace/app/made/inner",
        "/workspace/app/made/to.ts",
      ]),
    );
    expect(notified).not.toContain("/workspace/app/src/old.ts");
    expect(notified).not.toContain("/workspace/app/src/from.ts");
  });

  it("keeps a stream of writes waiting no longer than its longest wait", async () => {
    const { write, events } = await workspace(true);

    for (let index = 0; index < 14; index++) {
      await write(`src/f${index}.ts`, String(index));
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS / 2));
    }

    // Fourteen writes 100 ms apart, never quiet for the debounce: a notify already, at the longest wait.
    expect(MAX_WAIT_MS).toBeLessThan(14 * (DEBOUNCE_MS / 2));
    expect((await events()).filter((event) => event === "push").length).toBeGreaterThanOrEqual(1);
  });

  it("neither pushes nor notifies while the Container is stopped, and never starts one", async () => {
    const { stub, write, shell, events } = await workspace(false);

    await write("src/a.ts", "a");
    await shell("echo hi > src/b.ts");
    await new Promise((resolve) => setTimeout(resolve, MAX_WAIT_MS + DEBOUNCE_MS * 2));

    expect(await events()).toEqual([]);
    expect(await stub.fakeContainerState()).toEqual({ running: false, scripts: [] });
    expect((await stub.liveStubs()).container).toBe(0);
  });
});
