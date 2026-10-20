// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import { Redactions } from "./redaction.ts";
import { secretReference } from "./references.ts";

const ref = secretReference;

/** `text` as base64, as a program prints it. */
const base64 = (text: string) => btoa(text);

describe("Redactions.redact", () => {
  it("replaces a held value wherever it occurs in nested strings, and keeps the rest", () => {
    const redactions = new Redactions();

    redactions.hold("API_KEY", "sk-live-abcdef123456");

    const result = {
      content: [{ type: "text", text: "key is sk-live-abcdef123456." }],
      details: { argv: ["--key", "sk-live-abcdef123456"], exitCode: 0 },
    };

    expect(redactions.redact(result)).toEqual({
      content: [{ type: "text", text: `key is ${ref("API_KEY")}.` }],
      details: { argv: ["--key", ref("API_KEY")], exitCode: 0 },
    });
  });

  it("returns the very same value when nothing was redacted", () => {
    const redactions = new Redactions();

    redactions.hold("API_KEY", "sk-live-abcdef123456");

    const result = { content: [{ type: "text", text: "nothing here" }] };

    expect(redactions.redact(result)).toBe(result);
  });

  it.each([
    ["JSON string escaping", 'pa"ss\\word-1234', JSON.stringify({ p: 'pa"ss\\word-1234' })],
    [
      "percent-encoding",
      "p@ss w0rd/+?&",
      `https://x.test/?p=${encodeURIComponent("p@ss w0rd/+?&")}`,
    ],
    ["lowercase hex", "hunter2-hunter2", "6875_" + "68756e746572322d68756e74657232"],
    ["uppercase hex", "hunter2-hunter2", "68756E746572322D68756E74657232"],
    ["base64 at the start", "correct-horse-battery", base64("correct-horse-battery")],
    [
      "base64 inside a Basic Authorization header",
      "correct-horse-battery",
      `Authorization: Basic ${base64("admin:correct-horse-battery")}`,
    ],
    [
      "base64 at the third alignment",
      "correct-horse-battery",
      base64("ab:correct-horse-battery!!"),
    ],
    ["base64url", "??>>??>>??>>", base64("??>>??>>??>>").replaceAll("+", "-").replaceAll("/", "_")],
  ])("redacts a value printed in %s", (_form, value, printed) => {
    const redactions = new Redactions();

    redactions.hold("SECRET", value);

    const redacted = redactions.redact(printed);

    expect(redacted).toContain(ref("SECRET"));
    expect(redacted).not.toContain(value);
  });

  it("redacts a value shorter than 8 characters only as written", () => {
    const redactions = new Redactions();

    redactions.hold("PIN", "4321");

    expect(redactions.redact("pin 4321")).toBe(`pin ${ref("PIN")}`);
    expect(redactions.redact(`hex ${"34333231"}`)).toBe("hex 34333231");
  });

  it("names the Secret entered last when one value is held under two names", () => {
    const redactions = new Redactions();

    redactions.hold("OLD_NAME", "shared-value-123");
    redactions.hold("NEW_NAME", "shared-value-123");

    expect(redactions.redact("shared-value-123")).toBe(ref("NEW_NAME"));
  });

  it("redacts at an earlier generation with only the values held by then", () => {
    const redactions = new Redactions();

    redactions.hold("FIRST", "first-value-1234");

    const generation = redactions.generation;

    redactions.hold("SECOND", "second-value-5678");

    const text = "first-value-1234 second-value-5678";

    expect(redactions.redact(text, generation)).toBe(`${ref("FIRST")} second-value-5678`);
    expect(redactions.redact(text)).toBe(`${ref("FIRST")} ${ref("SECOND")}`);
  });

  it("keeps redacting a value after it is no longer held", () => {
    const redactions = new Redactions();

    redactions.hold("TOKEN", "ghp_abcdefghijklmnop");

    expect(redactions.redact("ghp_abcdefghijklmnop")).toBe(ref("TOKEN"));
  });
});

describe("Redactions.stream", () => {
  const VALUE = "ghp_abcdefghijklmnop";

  /** Push `chunks` through a stream, then flush it; the parts it emitted, in order. */
  const run = (redactions: Redactions, chunks: readonly string[]) => {
    const stream = redactions.stream();
    const parts = chunks.map((chunk) => stream.push(chunk));

    parts.push(stream.flush());

    return parts;
  };

  it("redacts a value split across chunks", () => {
    const redactions = new Redactions();

    redactions.hold("TOKEN", VALUE);

    const output = run(redactions, ["token: ghp_abc", "defghij", "klmnop\nnext line\n"]).join("");

    expect(output).toBe(`token: ${ref("TOKEN")}\nnext line\n`);
  });

  it("redacts every chunking of a text the same as the whole text", () => {
    const redactions = new Redactions();

    redactions.hold("TOKEN", VALUE);

    const text = `a ${VALUE} b ${base64(`x:${VALUE}`)} c ${VALUE}${VALUE}`;

    for (let size = 1; size <= text.length; size += 3) {
      const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
        text.slice(index * size, (index + 1) * size),
      );

      expect(run(redactions, chunks).join("")).toBe(redactions.redact(text));
    }
  });

  it("emits text that cannot start a value without waiting for the end", () => {
    const redactions = new Redactions();

    redactions.hold("TOKEN", VALUE);

    const stream = redactions.stream();
    const long = "x".repeat(200);

    expect(stream.push(long).length).toBeGreaterThan(100);
  });

  it("passes text through unchanged while nothing is held", () => {
    const stream = new Redactions().stream();

    expect(stream.push("hello ")).toBe("hello ");
    expect(stream.flush()).toBe("");
  });
});
