// docs/architecture/visuals.md → The check. The queue of a Session's checks: one at a time, in order, however the one ahead
// ends, and no more than it holds.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { describe, expect, it } from "vite-plus/test";
import { CheckQueue } from "./check-queue.ts";

const busy = (held: number) => `busy ${held}` as const;

/** A task that ends when `release` is called, noting when it starts. */
const held = (log: string[], name: string) => {
  let release: (value: string) => void = () => undefined;

  const task = () => {
    log.push(`start ${name}`);

    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };

  return { task, release: (value: string) => release(value) };
};

describe("the queue of checks", () => {
  it("runs one at a time, in order", async () => {
    const queue = new CheckQueue(4);
    const log: string[] = [];
    const first = held(log, "a");
    const second = held(log, "b");

    const a = queue.run(first.task, busy);
    const b = queue.run(second.task, busy);

    await Promise.resolve();

    expect(log).toEqual(["start a"]);

    first.release("x");
    await a;
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.release("y");

    expect(await a).toBe("x");
    expect(await b).toBe("y");
    expect(log).toEqual(["start a", "start b"]);
    expect(queue.pending).toBe(0);
  });

  it("runs the next after a rejected one", async () => {
    const queue = new CheckQueue(2);

    const a = queue.run(() => Promise.reject(new Error("no")), busy);
    const b = queue.run(() => Promise.resolve("yes"), busy);

    await expect(a).rejects.toThrow("no");
    await expect(b).resolves.toBe("yes");
  });

  it("holds at most `max`, answers one more as busy without running it, and takes another once one ends", async () => {
    const queue = new CheckQueue(2);
    const log: string[] = [];
    const first = held(log, "a");
    const second = held(log, "b");

    const a = queue.run(first.task, busy);
    const b = queue.run(second.task, busy);

    let ran = false;

    await expect(
      queue.run(() => {
        ran = true;

        return Promise.resolve("c");
      }, busy),
    ).resolves.toBe("busy 2");
    expect(ran).toBe(false);
    expect(queue.pending).toBe(2);

    first.release("a");
    await a;
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.release("b");
    await b;

    expect(queue.pending).toBe(0);
    await expect(queue.run(() => Promise.resolve("d"), busy)).resolves.toBe("d");
  });
});
