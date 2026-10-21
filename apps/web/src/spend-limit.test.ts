import { describe, expect, it } from "vitest";
import { spendLimitFromText, spendLimitToText } from "./spend-limit.ts";

describe("spendLimitFromText", () => {
  it("reads nothing as no limit, and a positive amount, with or without a dollar sign, as the limit", () => {
    expect(spendLimitFromText("")).toBeNull();
    expect(spendLimitFromText("   ")).toBeNull();
    expect(spendLimitFromText("5")).toBe(5);
    expect(spendLimitFromText("$12.50")).toBe(12.5);
    expect(spendLimitFromText(" $ 0.25 ")).toBe(0.25);
    expect(spendLimitFromText(".5")).toBe(0.5);
  });

  it("refuses anything else, so a typo is not saved as a limit", () => {
    for (const text of ["0", "0.00", "-3", "abc", "5 dollars", "1e3", "1,000", "Infinity", "$"]) {
      expect(spendLimitFromText(text), text).toBeUndefined();
    }
  });
});

describe("spendLimitToText", () => {
  it("shows no limit as an empty box, and a limit as its amount", () => {
    expect(spendLimitToText(null)).toBe("");
    expect(spendLimitToText(12.5)).toBe("12.5");
  });
});
