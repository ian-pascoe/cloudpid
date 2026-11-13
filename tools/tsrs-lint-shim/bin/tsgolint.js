#!/usr/bin/env node
// Vite+'s type-aware lint backend, run as tsrs's own linter (`tsrs-lint`, tsrs's port of tsgolint's headless mode and
// rules) instead of tsgolint (docs/adr/0055-vite-plus-and-pnpm.md → Consequences). `vp lint` and `vp check` run the
// `bin/tsgolint` of the `oxlint-tsgolint` they resolve, from the working directory first and then from `vite-plus`, so
// `pnpm-workspace.yaml`'s overrides make this directory that package (no workspace package declares `oxlint-tsgolint`,
// which would take its place). They set `OXLINT_TSGOLINT_PATH` to it only when it is unset, so the root
// `vite.config.ts` assigns it to this file first. It has no `package.json` on purpose:
// `effect-tsgo patch` (the root `prepare`) looks for Vite+'s `oxlint-tsgolint` by its `package.json`, and would then fail
// the install looking for tsgolint's platform binary, which this replaces.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The `tsrs` package's `tsrs-lint` command, by its `bin` entry, run in this process: it reads `process.argv` from its
// third entry on, as this script's are.
const manifest = createRequire(import.meta.url).resolve("tsrs/package.json");
const { bin } = JSON.parse(readFileSync(manifest, "utf8"));

await import(pathToFileURL(join(dirname(manifest), bin["tsrs-lint"])).href);
