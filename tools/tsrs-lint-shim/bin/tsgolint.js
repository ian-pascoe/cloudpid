#!/usr/bin/env node
// Vite+'s type-aware lint backend, run as tsrs's own linter (`tsrs-lint`, tsrs's port of tsgolint's headless mode and
// rules) instead of tsgolint (docs/adr/0055-vite-plus-and-pnpm.md → Consequences). `vp lint` and `vp check` run the
// `bin/tsgolint` of the `oxlint-tsgolint` they resolve, from the working directory first and then from `vite-plus`, and
// set `OXLINT_TSGOLINT_PATH` to it themselves, so `pnpm-workspace.yaml`'s overrides make this directory that package (no
// workspace package declares `oxlint-tsgolint`, which would take its place). It has no `package.json` on purpose:
// `effect-tsgo patch` (the root `prepare`) looks for Vite+'s `oxlint-tsgolint` by its `package.json`, and would then fail
// the install looking for tsgolint's platform binary, which this replaces.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// `tsrs`'s `tsrs-lint` command (its `bin/tsrs-lint`) loads this launcher, which reads `process.argv` from its third
// entry on, as this script's are.
const tsrs = dirname(createRequire(import.meta.url).resolve("tsrs/package.json"));

await import(pathToFileURL(join(tsrs, "lib", "tsrs-lint.js")).href);
