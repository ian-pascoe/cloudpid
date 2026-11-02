// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- assertions over native arrays and records.
import { describe, expect, it } from "vitest";
import { FIXED_HEADERS, sandboxHeaders } from "./headers.ts";

describe("sandboxHeaders", () => {
  it("carries the fixed headers and the content type, and no CSP unless one is given", () => {
    const headers = sandboxHeaders("text/plain");

    expect(Object.fromEntries(headers)).toEqual({ ...FIXED_HEADERS, "content-type": "text/plain" });
    expect(headers.get("content-security-policy")).toBeNull();
  });

  it("adds the CSP it is given", () => {
    expect(sandboxHeaders("text/html", "default-src 'none'").get("content-security-policy")).toBe(
      "default-src 'none'",
    );
  });

  it("never caches, never sends a referrer, never lets a type be sniffed, and sets no cookie", () => {
    expect(FIXED_HEADERS).toEqual({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    expect(sandboxHeaders("text/html", "x").get("set-cookie")).toBeNull();
  });
});
