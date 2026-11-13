// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, type FileChange } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vite-plus/test";
import { caller } from "./client.ts";
import { PollingWatcher } from "./watch.ts";
import type { Snapshot } from "./wire.ts";

const target = { path: "/workspace", recursive: true, hidden: true, names: [] };

/** A Workspace DO stand-in that answers each scan with the next step: a snapshot, or a thrown RPC failure. */
const scripted = (steps: ReadonlyArray<Snapshot | "unreachable">) => {
  let index = 0;

  return caller({
    fileOperation: async () => {
      const step = steps[Math.min(index++, steps.length - 1)];

      if (step === "unreachable")
        throw new Error("Durable Object reset because its code was updated.");

      return { ok: true, value: step };
    },
  });
};

const changes = async (steps: ReadonlyArray<Snapshot | "unreachable">) => {
  const seen: FileChange[] = [];

  const watcher = getOrThrow(
    await PollingWatcher.open(
      scripted(steps),
      [target],
      (change) => seen.push(change),
      { pollIntervalMs: 5 },
      BACKGROUND_CONTEXT,
    ),
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  await watcher.stop(BACKGROUND_CONTEXT);

  return seen;
};

describe("PollingWatcher", () => {
  it("reports the paths that differ between snapshots", async () => {
    const before: Snapshot = [["/workspace/a", "1"]];
    const after: Snapshot = [["/workspace/a", "2"]];

    expect(await changes([before, after])).toEqual([{ kind: "paths", paths: ["/workspace/a"] }]);
  });

  it("keeps polling through an unreachable Workspace DO and reports overflow once it answers", async () => {
    const snapshot: Snapshot = [["/workspace/a", "1"]];

    expect(await changes([snapshot, "unreachable", "unreachable", snapshot])).toEqual([
      { kind: "overflow" },
    ]);
  });
});
