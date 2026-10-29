// The file-change signal's helper (docs/architecture/container.md → File-change signals): `image/cloudpid-notify.c`
// keeps the values `notify.ts` gives the Workspace DO, and the image builds it where the Workspace DO runs it. On Linux
// with a C compiler the program is built and run for real against a temporary root (where its file system takes user
// extended attributes); elsewhere (macOS has another `setxattr`) those cases are skipped. Its effect on computerd's
// FUSE mount was checked by hand in Docker (the doc section).
// @effect-diagnostics nodeBuiltinImport:off processEnv:off preferEffectArray:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";
import {
  NOTIFY_ATTRIBUTE,
  NOTIFY_PROGRAM,
  NOTIFY_ROOT_VARIABLE,
} from "@cloudpid/sandbox-image/notify";

const image = (name: string) => readFileSync(join(sandboxImageContext, name), "utf8");

const dockerfile = image("Dockerfile");
const source = image("cloudpid-notify.c");

it("sets the attribute the Workspace DO names, under the root variable it names", () => {
  expect(source).toContain(`#define NOTIFY_ATTRIBUTE "${NOTIFY_ATTRIBUTE}"`);
  expect(source).toContain(`getenv("${NOTIFY_ROOT_VARIABLE}")`);
  expect(source).toContain('#define DEFAULT_ROOT "/workspace"');
});

it("is built into the image where the Workspace DO runs it", () => {
  expect(dockerfile).toMatch(
    new RegExp(`cc [^\\n]*-o ${NOTIFY_PROGRAM.replaceAll("/", "\\/")} [^\\n]*cloudpid-notify\\.c`),
  );
  // Its source is bound for the build only: no layer of the image keeps it.
  expect(dockerfile).toContain(
    "RUN --mount=type=bind,source=cloudpid-notify.c,target=/tmp/cloudpid-notify.c",
  );
  expect(dockerfile).not.toMatch(/^COPY .*cloudpid-notify\.c/m);
});

/** The helper built from the image's source, when this machine can build and run it (Linux, with `cc`). */
const built = ((): string | undefined => {
  if (process.platform !== "linux") return undefined;

  const program = join(mkdtempSync(join(tmpdir(), "cloudpid-notify-")), "cloudpid-notify");

  const compiled = spawnSync(
    "cc",
    [
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-o",
      program,
      join(sandboxImageContext, "cloudpid-notify.c"),
    ],
    { encoding: "utf8" },
  );

  return compiled.status === 0 ? program : undefined;
})();

/** A root for the helper with `src/a.js` and `keep/`, and whether its file system takes user extended attributes. */
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-root-"));

  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "keep"));
  writeFileSync(join(dir, "src", "a.js"), "a");

  return dir;
};

/** Run the helper over `input` with `dir` as its root. */
const run = (program: string, dir: string, input: string) =>
  spawnSync(program, [], {
    input,
    encoding: "utf8",
    env: { ...process.env, [NOTIFY_ROOT_VARIABLE]: dir },
  });

/** The helper's attribute on `path`, read with getfattr when it is installed; undefined when it cannot be read. */
const attribute = (path: string): string | undefined => {
  const read = spawnSync("getfattr", ["--only-values", "-n", NOTIFY_ATTRIBUTE, path], {
    encoding: "utf8",
  });

  return read.status === 0 ? read.stdout : undefined;
};

describe.skipIf(built === undefined)("cloudpid-notify, built and run", () => {
  const program = built ?? "";

  it("signals each NUL-ended path, and a gone one at its nearest existing ancestor", (context) => {
    const dir = root();
    const result = run(program, dir, `${dir}/src/a.js\0${dir}/keep/gone/deep.js\0${dir}/keep`);

    // A file system without user extended attributes (some tmpfs) answers EOPNOTSUPP: nothing to check here.
    if (result.stderr.includes("not supported")) context.skip();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const values = [join(dir, "src", "a.js"), join(dir, "keep")].map(attribute);

    if (values.includes(undefined)) return;

    expect(values).toEqual(["1", "1"]);
  });

  it("takes a newline as part of a file name, not as a separator", (context) => {
    const dir = root();

    writeFileSync(join(dir, "src", "two\nlines.js"), "x");

    const result = run(program, dir, `${dir}/src/two\nlines.js\0`);

    if (result.stderr.includes("not supported")) context.skip();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const value = attribute(join(dir, "src", "two\nlines.js"));

    if (value !== undefined) expect(value).toBe("1");
  });

  it("never climbs above its root, and says nothing of a path that is gone", () => {
    const dir = root();
    const result = run(program, `${dir}/src`, `${dir}/src/gone/x.js\0`);

    expect(result.status).toBe(0);
    expect(result.stderr.includes("gone")).toBe(false);
  });

  it("skips a path with an empty, . or .. segment, which could lead out of its root", () => {
    const dir = root();

    const result = run(
      program,
      dir,
      [`${dir}/../etc/hostname`, `${dir}/./src/a.js`, `${dir}//src/a.js`, `${dir}/keep/`]
        .map((path) => `${path}\0`)
        .join(""),
    );

    expect(result.status).toBe(0);
    expect(result.stderr.match(/segment, skipped/g)).toHaveLength(4);
  });

  it("skips a path outside its root, and fails on one that is not absolute after signalling the rest", () => {
    const dir = root();
    const result = run(program, dir, `relative/x\0/etc/hostname\0${dir}/src/a.js\0`);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("relative/x: not an absolute path");
    expect(result.stderr).toContain("/etc/hostname: outside");
  });
});
