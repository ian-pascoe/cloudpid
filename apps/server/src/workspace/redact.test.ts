// Taking the GitHub token out of a command's output, however its bytes arrive (docs/spec.md → Git).
// @effect-diagnostics preferEffectArray:off
import { secretReference } from "@cloudpid/extensions/secrets/core";
import { describe, expect, it } from "vitest";
import { type Redaction, Redactor, redactText } from "./redact.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** What comes out of `chunks` pushed through a redactor of `secrets`, in order, and flushed. */
const throughAll = (secrets: ReadonlyArray<Redaction>, chunks: readonly string[]): string => {
  const redactor = new Redactor(secrets);
  let out = "";

  for (const chunk of chunks) {
    out += decode(redactor.push(encode(chunk)));
  }

  return out + decode(redactor.flush());
};

/** `throughAll` of one secret, replaced by `***`. */
const through = (secret: string, chunks: readonly string[]): string =>
  throughAll([{ value: secret, mask: "***" }], chunks);

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
    const redactor = new Redactor([{ value: "ghp_secret", mask: "***" }]);

    expect(decode(redactor.push(encode("hello gh")))).toBe("hello ");
    expect(decode(redactor.flush())).toBe("gh");
  });

  it("passes bytes that are not UTF-8 through untouched", () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const out = new Redactor([{ value: "ghp_secret", mask: "***" }]).push(binary);

    expect([...out]).toEqual([...binary]);
  });

  it("takes several secrets out, each for its own mask, wherever the chunks split them", () => {
    const secrets = [
      { value: "ghp_secret", mask: "***" },
      { value: "sk-live-key", mask: "<API_KEY>" },
    ];

    const text = "a ghp_secret b sk-live-key c";

    for (let at = 1; at < text.length; at++) {
      expect(throughAll(secrets, [text.slice(0, at), text.slice(at)])).toBe("a *** b <API_KEY> c");
    }

    expect(throughAll(secrets, ["end sk-live"])).toBe("end sk-live");
  });
});

describe("redacting text", () => {
  it("takes the token out as *** and each kept Secret as its reference", () => {
    const kept = { name: "API_KEY", value: "sk-live-key", scope: "every" as const, build: false };

    expect(redactText("ghp_secret and sk-live-key", "ghp_secret", [kept])).toBe(
      `*** and ${secretReference("API_KEY")}`,
    );
    expect(redactText("as it was", undefined, [])).toBe("as it was");
  });
});
