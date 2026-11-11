/**
 * `conformance/run.ts`: the baseline it reads, the file it hands the runner, the scenarios each side ran, and the run's
 * outcome and summary line, which `ci.yml`'s `Conformance (<mode>)` step asserts (`docs/architecture/mcp.md` → Testing
 * and tracing → Conformance).
 */
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { MODES, outcome, parseBaseline, runnerBaseline, scenariosRan } from "./run.ts";

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

describe("the scenarios a side ran", () => {
  it("are the scenario directories the runner left a `checks.json` in, auth ones nested a level down", () => {
    const out = mkdtempSync(join(tmpdir(), "conformance-"));

    onTestFinished(() => rmSync(out, { recursive: true, force: true }));

    for (const scenario of [
      "tools_call-2026",
      "auth/metadata-default-2026",
      "auth/iss-supported-2026",
    ]) {
      mkdirSync(join(out, scenario), { recursive: true });
      writeFileSync(join(out, scenario, "checks.json"), "[]");
    }

    mkdirSync(join(out, "initialize-2026"));
    writeFileSync(join(out, "initialize-2026", "stdout.txt"), "");

    expect(scenariosRan(out)).toBe(3);
  });

  it("are none when the runner wrote nothing", () => {
    expect(scenariosRan(join(tmpdir(), "conformance-never-written"))).toBe(0);
  });
});

describe("a run's outcome", () => {
  it("passes when both sides passed against the baseline and each ran a scenario", () => {
    expect(
      outcome("2025-06-18", {
        client: { status: 0, scenarios: 5 },
        server: { status: 0, scenarios: 27 },
      }),
    ).toStrictEqual({
      exitCode: 0,
      summary: "Conformance (2025-06-18): 5 client and 27 server scenarios ran",
    });
  });

  it("fails when either side failed against the baseline, or did not exit", () => {
    expect(
      outcome("2025-06-18", {
        client: { status: 0, scenarios: 5 },
        server: { status: 1, scenarios: 27 },
      }).exitCode,
    ).toBe(1);
    expect(
      outcome("2025-06-18", {
        client: { status: null, scenarios: 5 },
        server: { status: 0, scenarios: 27 },
      }).exitCode,
    ).toBe(1);
  });

  it("fails when a side ran no scenario, though its runner passed", () => {
    expect(
      outcome("2025-03-26", {
        client: { status: 0, scenarios: 2 },
        server: { status: 0, scenarios: 0 },
      }),
    ).toStrictEqual({
      exitCode: 1,
      summary: "Conformance (2025-03-26): 2 client and 0 server scenarios ran: the server ran none",
    });
  });
});

describe("the summary line `ci.yml` asserts", () => {
  const workflow = readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );

  /** The `Conformance (<mode>)` step's `grep` pattern for `mode`, from basic regex (literal parentheses) to a RegExp. */
  const asserted = (mode: string) => {
    const pattern = /grep -q "(\^Conformance \(\$MODE\): .*\$)"/.exec(workflow)?.[1];

    expect(pattern).toBeDefined();

    return new RegExp(
      (pattern ?? "")
        .replace("$MODE", mode)
        .replaceAll(".", "\\.")
        .replaceAll("(", "\\(")
        .replaceAll(")", "\\)"),
    );
  };

  it("matches a run whose sides each ran a scenario", () => {
    expect(
      outcome("2025-06-18", {
        client: { status: 0, scenarios: 5 },
        server: { status: 0, scenarios: 27 },
      }).summary,
    ).toMatch(asserted("2025-06-18"));
  });

  it("matches no run where a side ran none, nor another mode's", () => {
    expect(
      outcome("2025-03-26", {
        client: { status: 0, scenarios: 2 },
        server: { status: 0, scenarios: 0 },
      }).summary,
    ).not.toMatch(asserted("2025-03-26"));
    expect(
      outcome("2025-06-18", {
        client: { status: 0, scenarios: 5 },
        server: { status: 0, scenarios: 27 },
      }).summary,
    ).not.toMatch(asserted("2025-11-25"));
  });
});
