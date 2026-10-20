// Taking the GitHub token out of a command's output, however its bytes arrive (docs/spec.md → Git).
// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** What comes out of `chunks` pushed through a redactor, in order, and flushed. */
const through = (secret: string, chunks: readonly string[]): string => {
  const redactor = new Redactor(secret);
  let out = "";

  for (const chunk of chunks) {
    out += decode(redactor.push(encode(chunk)));
  }

  return out + decode(redactor.flush());
};

describe("redacting a secret from output", () => {
  it("replaces it where it appears", () => {
    expect(through("ghp_secret", ["token: ghp_secret\n"])).toBe("token: ***\n");
  });

  it("replaces each occurrence", () => {
    expect(through("ghp_secret", ["ghp_secretghp_secret x ghp_secret"])).toBe("****** x ***");
  });

  it("leaves output without it as it was", () => {
    expect(through("ghp_secret", ["hello ", "world\n"])).toBe("hello world\n");
  });

  it("catches it split across chunks, wherever the split falls", () => {
    const text = "a ghp_secret b";

    for (let at = 1; at < text.length; at++) {
      expect(through("ghp_secret", [text.slice(0, at), text.slice(at)])).toBe("a *** b");
    }
  });

  it("catches it split across many one-byte chunks", () => {
    expect(through("ghp_secret", "x ghp_secret y".split(""))).toBe("x *** y");
  });

  it("releases what it held back when the output ends in a start of the secret", () => {
    expect(through("ghp_secret", ["loading", " ghp_se"])).toBe("loading ghp_se");
  });

  it("does not hold back more than the secret's own start, so output keeps streaming", () => {
    const redactor = new Redactor("ghp_secret");

    expect(decode(redactor.push(encode("hello gh")))).toBe("hello ");
    expect(decode(redactor.flush())).toBe("gh");
  });

  it("passes bytes that are not UTF-8 through untouched", () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const out = new Redactor("ghp_secret").push(binary);

    expect([...out]).toEqual([...binary]);
  });
});
