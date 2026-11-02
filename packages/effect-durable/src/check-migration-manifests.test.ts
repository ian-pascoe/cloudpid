// The script under test is a real `git` and `bash` run, so the tests are too.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = new URL("../../../scripts/check-migration-manifests.sh", import.meta.url).pathname;
const manifest = "apps/server/src/registry/migrations.manifest.ts";

const file = (digests: ReadonlyArray<string>) =>
  `// header\nexport const SHIPPED_MIGRATIONS: ReadonlyArray<string> = [\n${digests.map((digest) => `  "${digest}",\n`).join("")}];\n`;

describe("scripts/check-migration-manifests.sh", () => {
  let repo = "";

  const git = (...args: ReadonlyArray<string>) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: repo,
        encoding: "utf8",
      },
    ).trim();

  const commit = (message: string, digests?: ReadonlyArray<string>) => {
    if (digests !== undefined) writeFileSync(join(repo, manifest), file(digests));

    git("add", "-A");
    git("commit", "-q", "-m", message);

    return git("rev-parse", "HEAD");
  };

  const check = (base: string) =>
    spawnSync("bash", [script, base], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "manifests-"));
    git("init", "-q");
    mkdirSync(join(repo, "apps/server/src/registry"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const a = "aaaaaaaaaaaaaaaa";
  const b = "bbbbbbbbbbbbbbbb";
  const c = "cccccccccccccccc";

  it("passes an appended digest, and a change that leaves the manifest alone", () => {
    const base = commit("base", [a, b]);

    commit("append", [a, b, c]);

    expect(check(base).status).toBe(0);
    expect(check(git("rev-parse", "HEAD")).status).toBe(0);
  });

  it("fails a plain git revert of the change that added a migration", () => {
    commit("base", [a]);

    const added = commit("add", [a, b]);

    git("revert", "--no-edit", added);

    // The revert's tree no longer has b, though main (the base) does.
    const result = check(added);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(manifest);
  });

  it("fails a digest that changed, was inserted before one that shipped, or moved", () => {
    const base = commit("base", [a, b]);

    commit("change", [a, c]);
    expect(check(base).status).toBe(1);

    commit("insert", [a, c, b]);
    expect(check(base).status).toBe(1);

    commit("swap", [b, a]);
    expect(check(base).status).toBe(1);
  });

  it("fails a manifest that was deleted, and ignores edits to its header", () => {
    const base = commit("base", [a]);

    writeFileSync(
      join(repo, manifest),
      readFileSync(join(repo, manifest), "utf8").replace("// header", "// a new header"),
    );
    commit("header");
    expect(check(base).status).toBe(0);

    git("rm", "-q", manifest);
    commit("delete");
    expect(check(base).status).toBe(1);
  });

  it("passes when the base has no manifest yet", () => {
    writeFileSync(join(repo, "README"), "x");

    const base = commit("base");

    commit("first manifest", [a]);

    expect(check(base).status).toBe(0);
  });
});
