/**
 * `conformance/run.ts`: the baseline it reads and the file it hands the runner (`docs/architecture/mcp.md` → Testing and
 * tracing → Conformance).
 */
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MODES, parseBaseline, runnerBaseline } from "./run.ts";

const committed = readFileSync(resolve(import.meta.dirname, "baseline.json"), "utf8");

const empty = (): Record<string, Record<string, string>> =>
  Object.fromEntries(MODES.map((mode) => [mode, {}]));

describe("baseline.json", () => {
  it("is a baseline of every mode, each entry with a reason", () => {
    const baseline = parseBaseline(committed);

    expect(Object.keys(baseline)).toStrictEqual([...MODES]);
  });

  it("is read only with every mode and a reason for every entry", () => {
    const { "2025-03-26": _dropped, ...missing } = empty();

    expect(() => parseBaseline(JSON.stringify(missing))).toThrow(/2025-03-26/);
    expect(() => parseBaseline(JSON.stringify({ ...empty(), "2024-11-05": {} }))).toThrow(
      /2024-11-05/,
    );
    expect(() =>
      parseBaseline(JSON.stringify({ ...empty(), "2025-06-18": { tools_call: "" } })),
    ).toThrow(/tools_call/);
    expect(() => parseBaseline(JSON.stringify([]))).toThrow();
  });
});

describe("the runner's baseline", () => {
  it("lists the entries of the mode alone, scenarios and single checks alike", () => {
    const baseline = parseBaseline(
      JSON.stringify({
        ...empty(),
        "2026-07-28": {
          "sep-2322-client-request-state": "no resume",
          "sse-retry:check": "no retry",
        },
        "2025-11-25": { initialize: "other mode" },
      }),
    );

    expect(JSON.parse(runnerBaseline(baseline, "2026-07-28"))).toStrictEqual({
      client: ["sep-2322-client-request-state", "sse-retry:check"],
    });
    expect(JSON.parse(runnerBaseline(baseline, "2025-06-18"))).toStrictEqual({ client: [] });
  });
});
