#!/usr/bin/env node
/**
 * Runs the official conformance suite against `client.ts` in one mode (a spec version), against `baseline.json`
 * (`docs/architecture/mcp.md` → Testing and tracing → Conformance; The MCP core #394 D25).
 *
 *   bun --cwd packages/mcp run conformance <2026-07-28 | 2025-11-25 | 2025-06-18 | 2025-03-26>
 *
 * The runner's own baseline is a file of scenario names, which fails the run on a failure outside it (a regression)
 * and on a scenario in it that now passes (stale: remove the entry), so the baseline only shrinks. Its entries are
 * keyed by scenario name alone, and one scenario can pass at one version and fail at another, so `baseline.json` has
 * a section per mode, each entry with the reason it fails, and this writes the runner's file for the mode.
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off schemaSync:off -- a Node script that spawns the runner: plain functions over values.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";

export const MODES = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

const Mode = Schema.Literals(MODES);

export type Mode = typeof Mode.Type;

/** A mode's entries: a scenario, or `<scenario>:<check-id>` for one check of it, each with the reason it fails. */
const Section = Schema.Record(Schema.String, Schema.NonEmptyString);

/** `baseline.json`: every mode, and no other. */
const Baseline = Schema.Struct({
  "2026-07-28": Section,
  "2025-11-25": Section,
  "2025-06-18": Section,
  "2025-03-26": Section,
});

export type Baseline = typeof Baseline.Type;

const decodeBaseline = Schema.decodeUnknownSync(Baseline, { onExcessProperty: "error" });

const isMode = Schema.is(Mode);

/** `baseline.json` as read, or why it is not a baseline. */
export const parseBaseline = (text: string): Baseline => decodeBaseline(JSON.parse(text));

/** The file the runner reads for `mode`: its client scenarios, as the JSON subset of YAML. */
export const runnerBaseline = (baseline: Baseline, mode: Mode) =>
  JSON.stringify({ client: Object.keys(baseline[mode]) });

const here = dirname(fileURLToPath(import.meta.url));

const main = () => {
  const mode = process.argv[2];

  if (!isMode(mode)) {
    console.error(`Usage: run.ts <${MODES.join(" | ")}>`);

    return 2;
  }

  const baseline = parseBaseline(readFileSync(join(here, "baseline.json"), "utf8"));
  const out = join(here, "results", mode);

  mkdirSync(out, { recursive: true });

  const file = join(out, "expected-failures.yaml");

  writeFileSync(file, runnerBaseline(baseline, mode));

  // The package's own copy of the runner, not whatever `npx` would fetch: the pin is in package.json.
  const runner = join(
    here,
    "..",
    "node_modules",
    "@modelcontextprotocol",
    "conformance",
    "dist",
    "index.js",
  );

  const run = spawnSync(
    process.execPath,
    [
      runner,
      "client",
      "--command",
      `${process.execPath} ${join(here, "client.ts")}`,
      "--suite",
      "all",
      "--spec-version",
      mode,
      "--expected-failures",
      file,
      "--output-dir",
      out,
    ],
    { stdio: "inherit" },
  );

  return run.status ?? 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
