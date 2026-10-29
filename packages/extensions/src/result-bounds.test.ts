// The parts of one tool result that are not its text or images, held to caps that keep the result within its one SQLite
// row: the diagnostics a tool reports, a nested call's structured output, and the details.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { MAX_ADDED_BYTES } from "./agents-md.ts";
import { MAX_RESULT_IMAGE_CHARACTERS } from "./images.ts";
import {
  boundToolResult,
  MAX_CODEMODE_DETAILS_BYTES,
  MAX_CODEMODE_TEXT_CHARACTERS,
  MAX_ROW_BYTES,
  MAX_NESTED_STRUCTURED_OUTPUT_BYTES,
  MAX_RESULT_DETAILS_BYTES,
  MAX_RESULT_DIAGNOSTICS_BYTES,
} from "./result-bounds.ts";
import { ResultBounds } from "./result-bounds.ts";
import { call, openSecretsHarness } from "./secrets/harness.fixture.ts";
import { storedBytes } from "./stored-bytes.ts";

const model = { tool: "bash", nested: false } as const;

describe("boundToolResult", () => {
  it("keeps a result within every cap as it is", () => {
    const result = {
      output: [{ type: "text" as const, text: "ok" }],
      details: { exitCode: 0 },
      diagnostics: [{ severity: "warn" as const, message: "slow" }],
      structuredOutput: { value: 1 },
    };

    expect(boundToolResult(result, { tool: "bash", nested: true })).toBe(result);
  });

  it("cuts the diagnostics a tool reports to their cap, ending with a note on what was cut", () => {
    const diagnostics = Array.from({ length: 40 }, (_, index) => ({
      severity: "error" as const,
      message: `${index}: ${"x".repeat(1000)}`,
      code: "lint",
    }));

    const bounded = boundToolResult({ output: [], diagnostics }, model);
    const kept = bounded.diagnostics ?? [];

    expect(storedBytes(kept)).toBeLessThanOrEqual(MAX_RESULT_DIAGNOSTICS_BYTES);
    // Whole ones in order, then the last that fits, shortened to the room left.
    const whole = kept.length - 2;
    const last = kept[whole];

    expect(kept.slice(0, whole)).toEqual(diagnostics.slice(0, whole));
    expect(last?.code).toBe("lint");
    expect(last?.message.endsWith("… [cut]")).toBe(true);
    expect(diagnostics[whole]?.message.startsWith(last?.message.slice(0, -7) ?? "")).toBe(true);
    expect(kept.at(-1)).toEqual({
      severity: "warn",
      code: "diagnostics_truncated",
      message: `Diagnostics were cut to fit one tool result (16 KiB at most): 1 shortened and ${39 - whole} left out, of 40.`,
    });
  });

  it("turns a nested call whose structured output passes its cap into an error without it", () => {
    const structuredOutput = { content: "z".repeat(MAX_NESTED_STRUCTURED_OUTPUT_BYTES) };
    const size = MAX_NESTED_STRUCTURED_OUTPUT_BYTES + 14;

    const bounded = boundToolResult(
      {
        output: [{ type: "text", text: "page" }],
        structuredOutput,
        details: { url: "https://example.com" },
        diagnostics: [{ severity: "info", message: "fetched" }],
      },
      { tool: "web_fetch", nested: true },
    );

    expect(storedBytes(structuredOutput)).toBe(size);
    expect(bounded).toEqual({
      output: [{ type: "text", text: "page" }],
      isError: true,
      details: { url: "https://example.com" },
      diagnostics: [
        { severity: "info", message: "fetched" },
        {
          severity: "error",
          code: "structured_output_too_large",
          message: `web_fetch returned structured output of ${size.toLocaleString("en-US")} bytes, over the 1536 KiB one nested call's result holds, so it was left out. Ask for less at once.`,
        },
      ],
    });
  });

  it("keeps the diagnostics to their cap with the one saying the structured output was left out", () => {
    const diagnostics = Array.from({ length: 40 }, (_, index) => ({
      severity: "warn" as const,
      message: `${index}: ${"w".repeat(1000)}`,
    }));

    const bounded = boundToolResult(
      {
        output: [],
        structuredOutput: "z".repeat(MAX_NESTED_STRUCTURED_OUTPUT_BYTES),
        diagnostics,
      },
      { tool: "web_fetch", nested: true },
    );

    expect(storedBytes(bounded.diagnostics)).toBeLessThanOrEqual(MAX_RESULT_DIAGNOSTICS_BYTES);
    expect(bounded.diagnostics?.at(-2)?.code).toBe("diagnostics_truncated");
    expect(bounded.diagnostics?.at(-1)?.code).toBe("structured_output_too_large");
  });

  it("leaves a model-issued call's structured output, which is never stored", () => {
    const result = {
      output: [],
      structuredOutput: "z".repeat(MAX_NESTED_STRUCTURED_OUTPUT_BYTES + 1),
    };

    expect(boundToolResult(result, { tool: "web_fetch", nested: false })).toBe(result);
  });

  it("replaces details past their cap with a note of their size", () => {
    const details = { rows: "r".repeat(MAX_RESULT_DETAILS_BYTES) };
    const size = storedBytes(details);

    expect(boundToolResult({ output: [], details }, model)).toEqual({
      output: [],
      details: {
        omitted: `Details of ${size.toLocaleString("en-US")} bytes were left out: one bash result holds at most 64 KiB of them.`,
      },
    });
  });

  it("gives codemode's details the room of its call list and Call diffs", () => {
    const fits = { calls: [], diffs: { 1: { patch: "p".repeat(MAX_RESULT_DETAILS_BYTES * 4) } } };
    const result = { output: [], details: fits };

    expect(MAX_CODEMODE_DETAILS_BYTES).toBe(292 * 1024);
    expect(boundToolResult(result, { tool: "codemode", nested: false })).toBe(result);

    const over = { calls: [], diffs: { 1: { patch: "p".repeat(MAX_CODEMODE_DETAILS_BYTES) } } };

    expect(
      boundToolResult({ output: [], details: over }, { tool: "codemode", nested: false }).details,
    ).toEqual({
      omitted: `Details of ${storedBytes(over).toLocaleString("en-US")} bytes were left out: one codemode result holds at most 292 KiB of them.`,
    });
  });

  it("cuts one diagnostic too long for the cap on its own, saying so", () => {
    const message = `${"y".repeat(MAX_RESULT_DIAGNOSTICS_BYTES)}tail`;

    const bounded = boundToolResult(
      { output: [], diagnostics: [{ severity: "error", message }] },
      model,
    );

    const [first, note] = bounded.diagnostics ?? [];

    expect(storedBytes(bounded.diagnostics)).toBeLessThanOrEqual(MAX_RESULT_DIAGNOSTICS_BYTES);
    expect(first?.severity).toBe("error");
    expect(first?.message.startsWith("yyyy")).toBe(true);
    expect(first?.message.endsWith("… [cut]")).toBe(true);
    expect(note?.message).toBe(
      "Diagnostics were cut to fit one tool result (16 KiB at most): 1 shortened and 0 left out, of 1.",
    );
  });
});

describe("ResultBounds", () => {
  const VALUE = "ghp_live0123456789abcdef";

  // A diagnostic whose message is cut 4,085 characters in, a few characters into the Secret's value.
  const lint = defineExtension({
    name: "lint",
    tools: [
      defineTool({
        name: "lint",
        description: "Lint",
        parameters: Type.Object({}),
        execute: async () => ({
          output: [{ type: "text", text: "linted" }],
          diagnostics: [
            { severity: "error", message: `${"d".repeat(4080)}${VALUE} ${"e".repeat(20_000)}` },
          ],
        }),
      }),
    ],
  });

  it("cuts a result after the Secrets are redacted, so no part of one is stored", async () => {
    const session = await openSecretsHarness([lint], undefined, undefined, [ResultBounds]);

    await session.hold({ API_KEY: VALUE });
    await session.prompt("Go", call("lint", {}));

    const stored = await session.transcript();

    expect((await session.lastResult())?.text).toContain("1 shortened and 0 left out, of 1.");
    expect(stored).toContain(`${"d".repeat(4080)}{{sec`);
    expect(stored).not.toContain(`${"d".repeat(4080)}${VALUE.slice(0, 5)}`);
  });
});

// What each part can weigh at most in one stored row, beside 16 KiB for the rest: the entry's fields, the Harness's own
// diagnostics, and a script's output header. Text escapes to at most twice its UTF-8 bytes (a quote, backslash or
// newline), and a character of `codemode`'s, which is counted in UTF-16 units, to at most three bytes; other control
// characters, six bytes escaped, are not counted.
describe("one stored row", () => {
  const ENVELOPE = 16 * 1024;
  const DEFAULT_TEXT_BYTES = 50 * 1024;

  it("holds a model-issued codemode result at every cap", () => {
    const parts =
      MAX_RESULT_IMAGE_CHARACTERS +
      MAX_CODEMODE_TEXT_CHARACTERS * 3 +
      MAX_CODEMODE_DETAILS_BYTES +
      MAX_RESULT_DIAGNOSTICS_BYTES * 2;

    expect(parts).toBe(1_951_776);
    expect(parts + ENVELOPE).toBeLessThanOrEqual(MAX_ROW_BYTES);
  });

  it("holds another model-issued result at every cap, a read with its AGENTS.md files included", () => {
    const parts =
      MAX_RESULT_IMAGE_CHARACTERS +
      (DEFAULT_TEXT_BYTES + MAX_ADDED_BYTES) * 2 +
      MAX_RESULT_DETAILS_BYTES +
      MAX_RESULT_DIAGNOSTICS_BYTES * 2;

    expect(parts + ENVELOPE).toBeLessThanOrEqual(MAX_ROW_BYTES);
  });

  it("holds a nested call's result at every cap, with the Harness's error text of a schema tool", () => {
    // A nested result keeps no output; a schema tool's error text becomes a diagnostic, within the tool's text limit.
    const parts =
      MAX_NESTED_STRUCTURED_OUTPUT_BYTES +
      MAX_RESULT_DETAILS_BYTES +
      MAX_RESULT_DIAGNOSTICS_BYTES +
      DEFAULT_TEXT_BYTES * 2;

    expect(parts + ENVELOPE).toBeLessThanOrEqual(MAX_ROW_BYTES);
  });
});
