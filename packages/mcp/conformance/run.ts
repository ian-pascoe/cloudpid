#!/usr/bin/env node
/**
 * Runs the official conformance suite in one mode (a spec version), against `baseline.json`: the `client` scenarios
 * against `client.ts` (the core's scenario client), then the `server` scenarios against `server.ts` (cloudpid's own MCP
 * endpoint, `serveMcp` over `node:http`) (`docs/architecture/mcp.md` → Testing and tracing → Conformance;
 * `docs/architecture/mcp-endpoint.md` → Telemetry and testing; The MCP core #394 D25).
 *
 *   bun run --cwd packages/mcp conformance <2026-07-28 | 2025-11-25 | 2025-06-18 | 2025-03-26>
 *
 * The runner's own baseline is a file of scenario names, which fails the run on a failure outside it (a regression)
 * and on a scenario in it that now passes (stale: remove the entry), so the baseline only shrinks. Its entries are
 * keyed by scenario name alone, and one scenario can pass at one version and fail at another, so `baseline.json` has
 * a section per mode, each with its `client` and `server` entries grouped by the reason they fail, and this writes the
 * runner's file for the mode. The run fails when either side does, and when either side ran no scenario, so a run
 * that tests nothing cannot pass. It ends with a summary line of what ran, which CI's step asserts, so a command that
 * never reaches this script fails the job too (#619).
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off schemaSync:off newPromise:off asyncFunction:off -- a Node script that spawns the runner: plain functions over values.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";

export const MODES = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

const Mode = Schema.Literals(MODES);

export type Mode = typeof Mode.Type;

/** Entries that fail for one reason: a scenario, or `<scenario>:<check-id>` for one check of it. */
const Group = Schema.Struct({
  reason: Schema.NonEmptyString,
  entries: Schema.NonEmptyArray(Schema.String),
});

const Groups = Schema.Array(Group);

/** What fails in a mode: the scenario client's, and the endpoint's. */
const Section = Schema.Struct({ client: Groups, server: Groups });

/** `baseline.json`: a section for every mode, and no other. */
const Baseline = Schema.Record(Mode, Section);

export type Baseline = typeof Baseline.Type;

const decodeBaseline = Schema.decodeUnknownSync(Baseline, { onExcessProperty: "error" });

const isMode = Schema.is(Mode);

/** `baseline.json` as read, or why it is not a baseline. */
export const parseBaseline = (text: string): Baseline => decodeBaseline(JSON.parse(text));

/** The file the runner reads for `mode`: its client and server entries, as the JSON subset of YAML. */
export const runnerBaseline = (baseline: Baseline, mode: Mode) =>
  JSON.stringify({
    client: baseline[mode].client.flatMap((group) => group.entries),
    server: baseline[mode].server.flatMap((group) => group.entries),
  });

/** How many scenarios the runner ran into `dir`: it leaves a `checks.json` in each scenario's directory. */
export const scenariosRan = (dir: string): number =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
        (path) => basename(path) === "checks.json",
      ).length
    : 0;

/** One side of a run: the runner's exit status (`null` when it did not exit), and how many scenarios it ran. */
export interface Side {
  readonly status: number | null;
  readonly scenarios: number;
}

/**
 * A run's exit code and the line it ends with: it passes only when both sides passed against the baseline and each ran
 * a scenario.
 */
export const outcome = (mode: Mode, sides: { readonly client: Side; readonly server: Side }) => {
  const emptySides = (["client", "server"] as const).filter((side) => sides[side].scenarios === 0);
  const ran = `Conformance (${mode}): ${sides.client.scenarios} client and ${sides.server.scenarios} server scenarios ran`;

  return {
    exitCode:
      sides.client.status === 0 && sides.server.status === 0 && emptySides.length === 0 ? 0 : 1,
    summary: emptySides.length === 0 ? ran : `${ran}: the ${emptySides.join(" and the ")} ran none`,
  };
};

const here = dirname(fileURLToPath(import.meta.url));

/** Starts `server.ts`, and its URL once it listens. */
const startServer = () =>
  new Promise<{ readonly url: string; readonly stop: () => void }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, "server.ts")], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    let seen = "";

    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`server.ts exited (${code}) before it listened`)));
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();

      const found = /listening (\S+)/.exec(seen);

      if (found?.[1] !== undefined) {
        child.removeAllListeners("exit");
        resolve({ url: found[1], stop: () => void child.kill() });
      }
    });
  });

const main = async () => {
  const mode = process.argv[2];

  if (!isMode(mode)) {
    console.error(`Usage: run.ts <${MODES.join(" | ")}>`);

    return 2;
  }

  const baseline = parseBaseline(readFileSync(join(here, "baseline.json"), "utf8"));
  const out = join(here, "results", mode);

  // Only this run's results: the runner adds a directory per scenario run.
  rmSync(out, { recursive: true, force: true });
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

  const common = ["--suite", "all", "--spec-version", mode, "--expected-failures", file];

  /** Where each side's runner writes its scenarios' results, which are also what counts the scenarios it ran. */
  const results = { client: join(out, "client"), server: join(out, "server") } as const;

  console.log(`\n=== client scenarios (${mode}) ===`);

  const client = spawnSync(
    process.execPath,
    [
      runner,
      "client",
      "--command",
      `${process.execPath} ${join(here, "client.ts")}`,
      ...common,
      "--output-dir",
      results.client,
    ],
    { stdio: "inherit" },
  );

  console.log(`\n=== server scenarios (${mode}) ===`);

  const server = await startServer();

  try {
    const run = spawnSync(
      process.execPath,
      [runner, "server", "--url", server.url, ...common, "--output-dir", results.server],
      { stdio: "inherit" },
    );

    const { exitCode, summary } = outcome(mode, {
      client: { status: client.status, scenarios: scenariosRan(results.client) },
      server: { status: run.status, scenarios: scenariosRan(results.server) },
    });

    console.log(`\n${summary}`);

    return exitCode;
  } finally {
    server.stop();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
