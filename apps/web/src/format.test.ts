import { describe, expect, it } from "vitest";
import {
  byteSize,
  compactCount,
  dollars,
  duration,
  relativeTime,
  spendLevel,
  tokenCount,
} from "./format.ts";

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
  it("shows milliseconds under a second, then seconds, then minutes, then hours", () => {
    expect(duration(12)).toBe("12 ms");
    expect(duration(999.6)).toBe("1000 ms");
    expect(duration(1500)).toBe("1.5 s");
    expect(duration(59_000)).toBe("59 s");
    expect(duration(125_000)).toBe("2 min 5 s");
    expect(duration(119_600)).toBe("1 min 59 s");
    expect(duration(4_330_000)).toBe("1 h 12 min");
  });
});

describe("byteSize", () => {
  it("shows bytes, then powers of 1000 to one decimal", () => {
    expect(byteSize(950)).toBe("950 B");
    expect(byteSize(12_345)).toBe("12.3 kB");
    expect(byteSize(4_500_000_000)).toBe("4.5 GB");
  });
});

describe("dollars", () => {
  it("shows cents, and the first digit of an amount under a cent", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(0.004)).toBe("$0.004");
    expect(dollars(0.42)).toBe("$0.42");
    expect(dollars(12.5)).toBe("$12.50");
    expect(dollars(1234.567)).toBe("$1234.57");
  });
});

describe("tokenCount", () => {
  it("shortens thousands and millions to one decimal", () => {
    expect(tokenCount(950)).toBe("950");
    expect(tokenCount(12_345)).toBe("12.3k");
    expect(tokenCount(1_250_000)).toBe("1.3M");
  });
});

describe("compactCount", () => {
  it("shortens a Skill's installs like skills.sh does", () => {
    expect(compactCount(4_088_520)).toBe("4.1M");
    expect(compactCount(22_670)).toBe("22.7k");
    expect(compactCount(5)).toBe("5");
  });
});

describe("spendLevel", () => {
  it("is none without a limit, then ok, near from four fifths, and over at the limit", () => {
    expect(spendLevel(100, null)).toBe("none");
    expect(spendLevel(1, 5)).toBe("ok");
    expect(spendLevel(4, 5)).toBe("near");
    expect(spendLevel(5, 5)).toBe("over");
    expect(spendLevel(6, 5)).toBe("over");
  });
});
