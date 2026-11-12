#!/usr/bin/env node
// Vite+'s type-aware lint backend, run as tsrslint (tsgolint's rules ported to Rust on tsrs) instead of tsgolint
// (docs/adr/0055-vite-plus-and-pnpm.md → Consequences). `vp lint` and `vp check` run the `bin/tsgolint` of the
// `oxlint-tsgolint` they resolve, from the working directory first and then from `vite-plus`, and set
// `OXLINT_TSGOLINT_PATH` to it themselves, so `pnpm-workspace.yaml`'s overrides make this directory that package (no
// workspace package declares `oxlint-tsgolint`, which would take its place). It has no `package.json` on purpose:
// `effect-tsgo patch` (the root `prepare`) looks for Vite+'s `oxlint-tsgolint` by its `package.json`, and would then fail
// the install looking for tsgolint's platform binary, which this replaces.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const { binaryPath } = createRequire(import.meta.url)("@maschwenk/tsrslint");
const tsrslint = binaryPath();
const args = process.argv.slice(2);

// Node 22.15 and 23.11 and later replace this process with tsrslint; an older Node runs it as a child, with oxlint's
// pipes, and exits as it does.
if ("execve" in process) process.execve(tsrslint, [tsrslint, ...args]);

const child = spawn(tsrslint, args, { stdio: "inherit" });

child.on("exit", (code, signal) =>
  signal ? process.kill(process.pid, signal) : process.exit(code ?? 1),
);
