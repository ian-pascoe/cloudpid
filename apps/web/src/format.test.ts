import { describe, expect, it } from "vitest";
import { duration, relativeTime } from "./format.ts";

const NOW = 1_700_000_000_000;

describe("relativeTime", () => {
  it("says how long ago a time was", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe("yesterday");
    expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe("4 days ago");
  });
});

describe("duration", () => {
  it("shows milliseconds under a second, then seconds, then minutes", () => {
    expect(duration(12)).toBe("12 ms");
    expect(duration(999.6)).toBe("1000 ms");
    expect(duration(1500)).toBe("1.5 s");
    expect(duration(59_000)).toBe("59 s");
    expect(duration(125_000)).toBe("2 min 5 s");
  });
});
