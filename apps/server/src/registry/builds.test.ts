// What the Build upkeep asks a Build object for (docs/architecture/container.md → Builds): the daily look and its retry.
import { describe, expect, it } from "vitest";
import type { BuildState } from "../workspace/build-record.ts";
import { BUILD_LOOK_INTERVAL_MS, buildDue } from "./builds.ts";

const NOW = 100 * BUILD_LOOK_INTERVAL_MS;

const last = {
  key: "k",
  snapshot: { id: "s", size: 1 },
  image: "i",
  ignore: null,
  commits: {},
  finishedAt: 0,
};

const state = (overrides: Partial<BuildState> = {}): BuildState => ({
  image: "i",
  last,
  progress: null,
  attemptedAt: NOW,
  ...overrides,
});

describe("the daily look", () => {
  it("is due a day after the last attempt, not before", () => {
    expect(
      buildDue({ key: "k", state: state(), now: NOW + BUILD_LOOK_INTERVAL_MS - 1 }),
    ).toBeUndefined();
    expect(buildDue({ key: "k", state: state(), now: NOW + BUILD_LOOK_INTERVAL_MS })).toBe("check");
  });

  it("is tried again a day after one that failed (a remote that could not be asked), the last Build kept", () => {
    const failed = state({
      progress: { status: "failed", key: "k", reason: "GitHub answered 502", at: NOW },
    });

    expect(buildDue({ key: "k", state: failed, now: NOW + 60_000 })).toBeUndefined();
    expect(buildDue({ key: "k", state: failed, now: NOW + BUILD_LOOK_INTERVAL_MS })).toBe("check");
  });
});
