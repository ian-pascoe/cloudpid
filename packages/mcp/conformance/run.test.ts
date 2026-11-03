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

const empty = (): Record<
  string,
  { client: ReadonlyArray<unknown>; server: ReadonlyArray<unknown> }
> => Object.fromEntries(MODES.map((mode) => [mode, { client: [], server: [] }]));

describe("baseline.json", () => {
  it("is a baseline of every mode, with client and server entries in groups that each have a reason", () => {
    const baseline = parseBaseline(committed);

    expect(Object.keys(baseline)).toStrictEqual([...MODES]);
  });

  it("is read only with every mode and a reason for every group", () => {
    const { "2025-03-26": _dropped, ...missing } = empty();

    expect(() => parseBaseline(JSON.stringify(missing))).toThrow(/2025-03-26/);
    expect(() => parseBaseline(JSON.stringify({ ...empty(), "2024-11-05": [] }))).toThrow(
      /2024-11-05/,
    );
    expect(() =>
      parseBaseline(
        JSON.stringify({
          ...empty(),
          "2025-06-18": { client: [], server: [{ reason: "", entries: ["tools_call"] }] },
        }),
      ),
    ).toThrow(/reason/);
    expect(() =>
      parseBaseline(JSON.stringify({ ...empty(), "2025-06-18": { client: [] } })),
    ).toThrow(/server/);
    expect(() => parseBaseline(JSON.stringify([]))).toThrow();
  });
});

describe("the runner's baseline", () => {
  it("lists the entries of the mode alone, scenarios and single checks alike", () => {
    const baseline = parseBaseline(
      JSON.stringify({
        ...empty(),
        "2026-07-28": {
          client: [
            { reason: "no resume", entries: ["sep-2322-client-request-state"] },
            { reason: "no retry", entries: ["sse-retry:check", "sse-retry:other"] },
          ],
          server: [{ reason: "no prompts", entries: ["prompts-list", "caching:check"] }],
        },
        "2025-11-25": { client: [{ reason: "other mode", entries: ["initialize"] }], server: [] },
      }),
    );

    expect(JSON.parse(runnerBaseline(baseline, "2026-07-28"))).toStrictEqual({
      client: ["sep-2322-client-request-state", "sse-retry:check", "sse-retry:other"],
      server: ["prompts-list", "caching:check"],
    });
    expect(JSON.parse(runnerBaseline(baseline, "2025-06-18"))).toStrictEqual({
      client: [],
      server: [],
    });
  });
});
