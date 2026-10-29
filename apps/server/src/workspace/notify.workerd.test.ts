// The file-change signal on a real Workspace DO (docs/architecture/container.md → File-change signals): the model's
// file tools' writes and the Worker Shell's are read from computer's change log, pushed to a running Container soon after
// they stop, and then signalled, each path where its watchers see it. The Container is the test Worker's fake
// (`TestWorkspace.fakeContainer`): its push moves computer's push cursor as a push does, and its helper records the paths.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off globalDate:off newPromise:off
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

  /** What the signal did so far, the harness's own files (a command's spill) left out of each `notify`. */
  const events = async () =>
    (await stub.signalEvents()).map((event) =>
      event
        .split(" ")
        .filter((word) => !word.startsWith("/workspace/.cloudpid"))
        .join(" "),
    );

  /**
   * Wait until the signal, from its `from`th event on, has signalled every path of `expected` (in one batch or in
   * several: how a stream of writes is batched depends on how fast they come, which a slow runner changes), then a
   * little more, so a later event would show. Answers those events, and every path they signalled, sorted.
   */
  const signalled = async (from: number, expected: ReadonlyArray<string>) => {
    const paths = (all: ReadonlyArray<string>) =>
      [
        ...new Set(
          all.flatMap((event) => (event.startsWith("notify") ? event.split(" ").slice(1) : [])),
        ),
      ].toSorted();

    await vi.waitFor(
      async () =>
        expect(paths((await events()).slice(from))).toEqual(expect.arrayContaining([...expected])),
      { timeout: 10_000, interval: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 2));

    const since = (await events()).slice(from);

    return { events: since, paths: paths(since) };
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

  return { stub, write, shell, events, signalled };
};

const app = (path: string) => `/workspace/app/${path}`;

/** Whether each `notify` of `events` comes after a push. */
const pushedFirst = (events: ReadonlyArray<string>) =>
  events.every(
    (event, index) => !event.startsWith("notify") || events.slice(0, index).includes("push"),
  );

// The debounce and the longest wait are FileNotifier's own, held to the millisecond with fake timers in
// `notify.test.ts`. Here the real Workspace DO's wiring is checked without timing: what is pushed and signalled, never
// how the writes were batched.
describe("the file-change signal", { timeout: 30_000 }, () => {
  it("pushes the file tools' writes to the running Container, then signals each where it is", async () => {
    const { write, events, signalled } = await workspace(true);

    // The first push sends what the Workspace held before it too (its root, the Skills' mount).
    await write("README.md", "#");
    await signalled(0, [app("README.md")]);

    const from = (await events()).length;

    await write("src/a.ts", "a");
    await write("src/nested/deep/b.ts", "b");

    // The push first; the new directories themselves, so a watcher of their parent finds the new tree, and each file.
    const expected = [
      "src",
      "src/a.ts",
      "src/nested",
      "src/nested/deep",
      "src/nested/deep/b.ts",
    ].map(app);

    const after = await signalled(from, expected);

    expect(after.events[0]).toBe("push");
    expect(pushedFirst(after.events)).toBe(true);
    expect(after.paths).toEqual(expected);
  });

  it("signals an edited file itself, and a removed or renamed-away one at its parent", async () => {
    const { stub, write, events, signalled } = await workspace(true);

    await write("src/a.ts", "a");
    await write("src/old.ts", "old");
    await write("src/from.ts", "from");
    await signalled(0, ["src/a.ts", "src/old.ts", "src/from.ts"].map(app));

    const from = (await events()).length;

    const files = new ComputerExecutionEnv({
      workspace: stub,
      id: "computer:notify",
      cwd: "/workspace/app",
    });

    await write("src/a.ts", "edited");
    expect((await files.remove("src/old.ts", {}, context)).ok).toBe(true);
    expect((await files.createDir("lib", { recursive: true }, context)).ok).toBe(true);
    expect((await files.renameFile("src/from.ts", "lib/to.ts", context)).ok).toBe(true);

    const expected = ["lib", "lib/to.ts", "src", "src/a.ts"].map(app);

    const after = await signalled(from, expected);

    expect(after.events[0]).toBe("push");
    expect(pushedFirst(after.events)).toBe(true);
    expect(after.paths).toEqual(expected);
  });

  it("collects the Worker Shell's writes: a redirect, sed -i, rm, mkdir -p and mv", async () => {
    const { write, shell, events, signalled } = await workspace(true);

    await write("src/a.ts", "alpha\n");
    await write("src/old.ts", "old\n");
    await write("src/from.ts", "from\n");
    await signalled(0, ["src/a.ts", "src/old.ts", "src/from.ts"].map(app));

    const from = (await events()).length;

    await shell("echo hi > src/new.ts");
    await shell("sed -i 's/alpha/beta/' src/a.ts");
    await shell("rm src/old.ts");
    await shell("mkdir -p made/inner");
    await shell("mv src/from.ts made/to.ts");

    const after = await signalled(
      from,
      [
        "src/new.ts",
        "src/a.ts",
        // `old.ts` and `from.ts` gone from `src`: at `src`.
        "src",
        "made",
        "made/inner",
        "made/to.ts",
      ].map(app),
    );

    expect(after.events[0]).toBe("push");
    expect(pushedFirst(after.events)).toBe(true);
    expect(after.paths).not.toContain(app("src/old.ts"));
    expect(after.paths).not.toContain(app("src/from.ts"));
  });

  it("keeps no running Container up by its own push, where a command's push is a use", async () => {
    const { stub, write, signalled } = await workspace(true);

    await write("README.md", "#");
    await write("src/a.ts", "a");

    // The signal pushed (its span reported as computer's is) and signalled: no use of the Container recorded.
    const after = await signalled(0, ["README.md", "src/a.ts"].map(app));

    expect(after.events[0]).toBe("push");
    expect(await stub.containerLastUse()).toBeUndefined();

    // A command's push before it runs is a use, as ever.
    await stub.commandPush();

    await vi.waitFor(async () => expect(await stub.containerLastUse()).toBeTypeOf("number"), {
      timeout: 5_000,
      interval: 20,
    });
  });

  it("refuses the launch its own push would cause once the Container stopped, and gives no signal", async () => {
    const { stub, write, events, signalled } = await workspace(true);

    await write("src/a.ts", "a");
    await signalled(0, [app("src/a.ts")]);

    const from = (await events()).length;

    // The Container stops after the signal found it running: computer's push, reconnecting, would start it again.
    await stub.stopDuringNextPush();
    await write("src/b.ts", "b");

    await vi.waitFor(async () => expect((await events()).slice(from)).toContain("push refused"), {
      timeout: 10_000,
      interval: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 2));

    expect((await events()).slice(from)).toEqual(["push refused"]);
    expect(await stub.fakeContainerState()).toEqual({ running: false, scripts: [] });
    expect((await stub.liveStubs()).container).toBe(0);
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
