// The base64 helpers the preview shares (`./base64.ts`).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import { describe, expect, it } from "vitest";
import { base64Bytes, base64FromBytes, bytesFromBase64, isBase64 } from "./base64.ts";

describe("base64", () => {
  it("writes what btoa writes, for every length around a piece", () => {
    for (const length of [0, 1, 2, 3, 4, 24_575, 24_576, 24_577, 50_000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 256);

      expect(base64FromBytes(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
    }
  });

  it("reads back what it writes, and counts the bytes of it without decoding", () => {
    const bytes = Uint8Array.from({ length: 100_001 }, (_, index) => (index * 17) % 256);
    const text = base64FromBytes(bytes);

    expect(bytesFromBase64(text)).toEqual(bytes);
    expect(base64Bytes(text)).toBe(bytes.length);
    expect(base64Bytes("AA==")).toBe(1);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("")).toBe(0);
  });

  it("is undefined for text that is not base64, and the alphabet check refuses a quote or a URL", () => {
    expect(bytesFromBase64("not base64!")).toBeUndefined();
    expect(isBase64('AAAA" onerror="x()')).toBe(false);
    expect(isBase64("https://evil.test/x.png")).toBe(false);
    expect(isBase64("iVBORw0K")).toBe(true);
  });
});
