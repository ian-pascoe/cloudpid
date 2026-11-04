// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off -- the real build, run on a copy of the app in a temporary directory.
// The build's bytes decide whether a deploy updates the Server: CI builds the app before the plan, and the Server's
// WebBuild step plans a noop only when its inputs and its `dist` hash as the last deploy's did
// (`apps/server/src/web-build.ts`, docs/development/infra.md → CI). Tailwind scans every file of the app for class
// names, so `styles.css` leaves out the files the step's inputs leave out.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL("..", import.meta.url));

/**
 * A class no file of the app names, this one included: it is put together here, so that the copy's own copy of this
 * test does not name it.
 */
const unusedClass = (em: string) => `<div className="${["tracking", `[${em}em]`].join("-")}" />`;

const copy = mkdtempSync(join(tmpdir(), "web-build-"));

// The app as checked in, beside its installed packages: never the app's own files, which a test must not edit.
beforeAll(() => {
  cpSync(APP, copy, {
    recursive: true,
    filter: (source) =>
      !["node_modules", "dist", ".turbo"].includes(relative(APP, source).split("/")[0] ?? ""),
  });
  symlinkSync(join(APP, "node_modules"), join(copy, "node_modules"));
});

afterAll(() => rmSync(copy, { recursive: true, force: true }));

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();

/** Builds the copy as the WebBuild step does (`vite build`) and hashes every file of its `dist`. */
const build = () => {
  const dist = join(copy, "dist");

  rmSync(dist, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [join(APP, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"],
    {
      cwd: copy,
      stdio: "pipe",
    },
  );

  const hash = createHash("sha256");

  for (const file of filesUnder(dist)) hash.update(file).update(readFileSync(join(dist, file)));

  return hash.digest("hex");
};

const name = (file: string, em: string) =>
  appendFileSync(join(copy, file), `\n// ${unusedClass(em)}\n`);

describe("the web app's build", { timeout: 120_000 }, () => {
  it("is the same when only tests, Markdown or the typecheck's build info name a new class", () => {
    const before = build();

    name("src/app-state.test.ts", "0.1234");
    name("src/chat/mcp-elicitation-card.test.tsx", "0.1234");
    name("DESIGN.md", "0.1234");
    name("tsconfig.tsbuildinfo", "0.1234");

    expect(build()).toBe(before);
  });

  it("changes when the app's own source names a new class", () => {
    const before = build();

    name("src/app.tsx", "0.4321");

    expect(build()).not.toBe(before);
  });
});
