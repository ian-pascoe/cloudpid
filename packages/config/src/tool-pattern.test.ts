import { describe, expect, it } from "vitest";
import { matchesToolPattern } from "./tool-pattern.ts";

describe("matchesToolPattern", () => {
  it.each([
    ["get_user", "get_user", true],
    ["get_user", "get_users", false],
    ["*", "", true],
    ["*", "anything", true],
    ["get_*", "get_user", true],
    ["get_*", "get_", true],
    ["get_*", "set_user", false],
    ["*_user", "get_user", true],
    ["*_user", "get_users", false],
    ["a*b*c", "abc", true],
    ["a*b*c", "a--b--c", true],
    ["a*b*c", "a--c--b", false],
    ["a*a", "a", false],
    ["a*a", "aa", true],
    ["a*b*b", "ab", false],
    ["a*b*b", "abb", true],
    ["*a*", "bab", true],
    ["a.c", "abc", false],
    ["a.c", "a.c", true],
    ["a?", "ab", false],
    ["get*User", "getUser", true],
    ["get*User", "getuser", false],
  ])("matches %s against %s: %s", (pattern, name, matches) => {
    expect(matchesToolPattern(pattern, name)).toBe(matches);
  });
});
