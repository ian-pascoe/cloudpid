#!/usr/bin/env node
// Vite+'s type-aware lint backend, run as tsrslint (tsgolint's rules ported to Rust on tsrs) instead of tsgolint
// (docs/adr/0055-vite-plus-and-pnpm.md → Consequences). `vp lint` and `vp check` run the `bin/tsgolint` of their own
// `oxlint-tsgolint`, whatever `OXLINT_TSGOLINT_PATH` or `node_modules/.bin` say, so `pnpm-workspace.yaml`'s overrides
// make this directory that package. It has no `package.json` on purpose: `effect-tsgo patch` (the root `prepare`) looks
// for Vite+'s `oxlint-tsgolint` by its `package.json`, and would then fail the install looking for tsgolint's platform
// binary, which this replaces.
import { createRequire } from "node:module";

const { binaryPath } = createRequire(import.meta.url)("@maschwenk/tsrslint");
const exe = binaryPath();

process.execve(exe, [exe, ...process.argv.slice(2)]);
