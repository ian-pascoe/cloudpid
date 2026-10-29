// The file-change notify's rules (docs/architecture/container.md → File-change notifications): where each changed path
// is notified, the cap, and the notifier's timing and order over a fake change log and Container. The change log's
// reads of computer's tables, and the Workspace DO's wiring, are `notify.workerd.test.ts`.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off newPromise:off
import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import type { WorkspaceObserver, WorkspaceSpan } from "@cloudflare/computer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedPath, RevisionRange } from "./change-log.ts";
import {
  DEBOUNCE_MS,
  FileNotifier,
  type FileNotifierDeps,
  foldToCap,
  MAX_WAIT_MS,
  notifyTargets,
  withNoNotifyStart,
} from "./notify.ts";

const synced = () => false;

describe("notifyTargets", () => {
  it("notifies a path still there on itself, and a gone one at its parent", () => {
    expect(
      notifyTargets(
        [
          { path: "/workspace/app/src/a.ts", state: "present" },
          { path: "/workspace/app/src/new", state: "present" },
          { path: "/workspace/app/old.ts", state: "gone" },
        ],
        { containerOnly: synced },
      ),
    ).toEqual(["/workspace/app", "/workspace/app/src/a.ts", "/workspace/app/src/new"]);
  });

  it("notifies a symlink at its parent, where the attribute does not land on its target", () => {
    expect(
      notifyTargets([{ path: "/workspace/app/link", state: "symlink" }], {
        containerOnly: synced,
      }),
    ).toEqual(["/workspace/app"]);
  });

  it("notifies a renamed path at its old parent and on its new name", () => {
    expect(
      notifyTargets(
        [
          { path: "/workspace/app/a/x.ts", state: "gone" },
          { path: "/workspace/app/b/x.ts", state: "present" },
        ],
        { containerOnly: synced },
      ),
    ).toEqual(["/workspace/app/a", "/workspace/app/b/x.ts"]);
  });

  it("notifies each target once", () => {
    expect(
      notifyTargets(
        [
          { path: "/workspace/app/a.ts", state: "gone" },
          { path: "/workspace/app/b.ts", state: "gone" },
          { path: "/workspace/app", state: "present" },
        ],
        { containerOnly: synced },
      ),
    ).toEqual(["/workspace/app"]);
  });

  it("leaves out what is outside the Workspace and what only the Container has", () => {
    expect(
      notifyTargets(
        [
          { path: "/.computer/readers/1", state: "present" },
          { path: "/workspaces/x", state: "present" },
          { path: "/workspace/app/node_modules/x/index.js", state: "present" },
          { path: "/workspace/app/index.ts", state: "present" },
        ],
        { containerOnly: (path) => path.includes("/node_modules") },
      ),
    ).toEqual(["/workspace/app/index.ts"]);
  });

  it("notifies the root itself, removed or not, on the root", () => {
    expect(
      notifyTargets(
        [
          { path: "/workspace", state: "present" },
          { path: "/workspace/x", state: "gone" },
        ],
        { containerOnly: synced },
      ),
    ).toEqual(["/workspace"]);
  });
});

describe("foldToCap", () => {
  const paths = [
    "/workspace/a/x/1.ts",
    "/workspace/a/x/2.ts",
    "/workspace/a/y/3.ts",
    "/workspace/b/4.ts",
    "/workspace/b/5.ts",
  ];

  it("leaves a batch within the cap as it is", () => {
    expect(foldToCap(paths, 5)).toEqual(paths);
  });

  it("folds a batch over the cap into the deepest ancestors that fit", () => {
    expect(foldToCap(paths, 4)).toEqual([
      "/workspace/a/x",
      "/workspace/a/y",
      "/workspace/b/4.ts",
      "/workspace/b/5.ts",
    ]);
    expect(foldToCap(paths, 3)).toEqual(["/workspace/a", "/workspace/b"]);
    expect(foldToCap(paths, 2)).toEqual(["/workspace/a", "/workspace/b"]);
  });

  it("folds into the root when nothing narrower fits", () => {
    expect(foldToCap(paths, 1)).toEqual(["/workspace"]);
  });

  it("keeps 5,000 targets apart and folds 5,001", () => {
    const many = Array.from(
      { length: 5_001 },
      (_, index) => `/workspace/d${index % 3}/f${index}.ts`,
    );

    expect(
      notifyTargets(
        many.slice(0, 5_000).map((path) => ({ path, state: "present" as const })),
        { containerOnly: synced },
      ),
    ).toHaveLength(5_000);
    expect(
      notifyTargets(
        many.map((path) => ({ path, state: "present" as const })),
        { containerOnly: synced },
      ),
    ).toEqual(["/workspace/d0", "/workspace/d1", "/workspace/d2"]);
  });
});

/** A change log of `revisions`, each a path written at that revision, and a Container that runs or not. */
class Fake {
  running = true;
  pushedThrough = 0;
  current = 0;
  readonly writes = new Map<number, ChangedPath>();
  readonly events: string[] = [];
  readonly windows: Array<{ after: number; through: number; skip: RevisionRange[] }> = [];
  pushFails = false;

  write(path: string, state: ChangedPath["state"] = "present") {
    this.current += 1;
    this.writes.set(this.current, { path, state });
  }

  deps(overrides: Partial<FileNotifierDeps> = {}): FileNotifierDeps {
    return {
      running: () => this.running,
      log: {
        pushedThrough: () => this.pushedThrough,
        unpushed: () => this.current > this.pushedThrough,
        changedBetween: (after, through, skip) => {
          this.windows.push({ after, through, skip: [...skip] });

          return [...this.writes].flatMap(([rev, change]) =>
            rev > after && rev <= through && !skip.some(([from, to]) => rev > from && rev <= to)
              ? [change]
              : [],
          );
        },
      },
      push: async () => {
        this.events.push("push");

        if (this.pushFails) throw new Error("socket closed");

        this.pushedThrough = this.current;
      },
      notify: async (paths) => {
        this.events.push(`notify ${paths.join(" ")}`);
      },
      containerOnly: async () => synced,
      warn: (message) => this.events.push(`warn ${message}`),
      ...overrides,
    };
  }
}

/** A span with nothing to record. */
const span: WorkspaceSpan = { setAttribute: () => {} };

/** computer's `noopObserver`, as the Workspace DO passes it. */
const noop: WorkspaceObserver = { span: (_name, _attributes, run) => run(span) };

describe("FileNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes, then notifies, once the writes have stopped for a moment", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());

    notifier.changed();
    fake.write("/workspace/a.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    notifier.changed();
    fake.write("/workspace/b.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);

    expect(fake.events).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);

    expect(fake.events).toEqual(["push", "notify /workspace/a.ts /workspace/b.ts"]);
  });

  it("does not wait past its longest wait for a stream of writes", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());

    for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += 100) {
      fake.write(`/workspace/f${elapsed}.ts`);
      notifier.changed();
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(fake.events[0]).toBe("push");
    expect(fake.events[1]).toMatch(/^notify \/workspace\/f0\.ts /);
  });

  it("neither pushes nor notifies while the Container is stopped", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());

    fake.running = false;
    notifier.changed();
    fake.write("/workspace/a.ts");
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);

    expect(fake.events).toEqual([]);
  });

  it("notifies what a command's own push sent, with no push of its own", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());
    const observer = notifier.observer("container-shell", noop);

    fake.write("/workspace/a.ts");
    await observer.span(
      "workspace.sync.push",
      { "workspace.sync.backend": "container-shell" },
      async () => {
        fake.pushedThrough = fake.current;
      },
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(fake.events).toEqual(["notify /workspace/a.ts"]);
  });

  it("skips what a pull's acknowledgement moved the cursor over: the Container's own writes", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());
    const observer = notifier.observer("container-shell", noop);

    notifier.changed();
    fake.write("/workspace/mine.ts");
    await observer.span(
      "workspace.sync.push",
      { "workspace.sync.backend": "container-shell" },
      async () => {
        fake.pushedThrough = fake.current;
      },
    );
    await observer.span(
      "workspace.sync.pull",
      { "workspace.sync.backend": "container-shell" },
      async () => {
        fake.write("/workspace/theirs.ts");
        fake.pushedThrough = fake.current;
      },
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(fake.events).toEqual(["notify /workspace/mine.ts"]);
  });

  it("hears of the Worker Shell's writes from their spans, and ignores another backend's syncs", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());
    const observer = notifier.observer("container-shell", noop);

    await observer.span(
      "workspace.fs.writeFile",
      { "workspace.fs.path": "/workspace/a.ts" },
      async () => {
        fake.write("/workspace/a.ts");
      },
    );
    await observer.span(
      "workspace.sync.push",
      { "workspace.sync.backend": "other" },
      async () => {},
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(fake.events).toEqual(["push", "notify /workspace/a.ts"]);
  });

  it("notifies what was sent before a push failed, and logs the failure", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());

    notifier.changed();
    fake.write("/workspace/a.ts");
    fake.pushedThrough = 1;
    fake.write("/workspace/b.ts");
    fake.pushFails = true;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(fake.events).toEqual([
      "push",
      "warn file notify: the push to the Container failed: socket closed",
      "notify /workspace/a.ts",
    ]);
  });

  it("logs a failed notify and goes on with the next", async () => {
    const fake = new Fake();
    let fail = true;

    const notifier = new FileNotifier(
      fake.deps({
        notify: async (paths) => {
          fake.events.push(`notify ${paths.join(" ")}`);

          if (fail) throw new Error("exec refused");
        },
      }),
    );

    notifier.changed();
    fake.write("/workspace/a.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    fail = false;
    notifier.changed();
    fake.write("/workspace/b.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(fake.events).toEqual([
      "push",
      "notify /workspace/a.ts",
      "warn file notify: exec refused",
      "push",
      "notify /workspace/b.ts",
    ]);
  });

  it("runs one notify at a time, and another for what was written during it", async () => {
    const fake = new Fake();
    let release: () => void = () => {};

    const notifier = new FileNotifier(
      fake.deps({
        notify: (paths) => {
          fake.events.push(`notify ${paths.join(" ")}`);

          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      }),
    );

    notifier.changed();
    fake.write("/workspace/a.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    notifier.changed();
    fake.write("/workspace/b.ts");
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);

    expect(fake.events).toEqual(["push", "notify /workspace/a.ts"]);

    release();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(fake.events).toEqual([
      "push",
      "notify /workspace/a.ts",
      "push",
      "notify /workspace/b.ts",
    ]);
  });

  it("forgets what it counted from once the Container is found stopped", async () => {
    const fake = new Fake();
    const notifier = new FileNotifier(fake.deps());

    fake.running = false;
    notifier.changed();
    fake.write("/workspace/old.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // The next command's push sends it to a new Container, then a write follows.
    fake.pushedThrough = fake.current;
    fake.running = true;
    notifier.changed();
    fake.write("/workspace/new.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(fake.events).toEqual(["push", "notify /workspace/new.ts"]);
  });
});

describe("withNoNotifyStart", () => {
  type Spec = Parameters<IWorkspaceContainerAPI["start"]>[0];

  const spec: Spec = { env: {}, enableInternet: true };

  const platform = (calls: string[]): IWorkspaceContainerAPI => ({
    start: async () => {
      calls.push("start");

      return { runtimeId: "r", clientSecret: "s", outcome: "adopted" as const };
    },
    restart: async () => {
      calls.push("restart");

      return { runtimeId: "r2", clientSecret: "s", outcome: "launched" as const };
    },
    interceptOutboundHttp: async () => undefined,
    interceptAllOutboundHttp: async () => undefined,
    status: async () => ({ running: true, exit: null }),
    exitInfo: async () => null,
    setInactivityTimeout: async () => undefined,
    fetchPort: async () => new Response("ok"),
    port: () => {
      throw new Error("not used");
    },
  });

  it("refuses to start a stopped Container for the notify's push alone", async () => {
    const calls: string[] = [];

    const guarded = withNoNotifyStart(platform(calls), {
      notifying: () => true,
      running: () => false,
    });

    await expect(guarded.start(spec)).rejects.toThrow("never starts a Container");
    await expect(guarded.restart(spec)).rejects.toThrow("never starts a Container");
    expect(calls).toEqual([]);
  });

  it("reconnects to a running Container, and starts one for anything else", async () => {
    const calls: string[] = [];
    let notifying = true;

    const guarded = withNoNotifyStart(platform(calls), {
      notifying: () => notifying,
      running: () => notifying,
    });

    await guarded.start(spec);
    notifying = false;
    await guarded.start(spec);
    await guarded.restart(spec);

    expect(calls).toEqual(["start", "start", "restart"]);
  });
});
