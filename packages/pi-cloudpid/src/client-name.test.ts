// @effect-diagnostics nodeBuiltinImport:off -- runs on node, on the owner's machine.
/**
 * The client's name (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Its commit): the commit of the git
 * checkout the extension runs from, as `pi install git:github.com/ian-pascoe/cloudpid` makes it, else `dev`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientName, sourceCommit } from "./client-name.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-cloudpid-commit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the commit the extension runs from", () => {
  it("is the HEAD of the git checkout it was installed as", () => {
    const git = (...args: ReadonlyArray<string>) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: root,
        encoding: "utf8",
      }).trim();

    git("init", "--quiet");
    git("commit", "--quiet", "--allow-empty", "-m", "first");

    expect(sourceCommit(root)).toBe(git("rev-parse", "HEAD"));
  });

  it("is dev outside a git checkout", () => {
    expect(sourceCommit(root)).toBe("dev");
  });
});

describe("the client's name", () => {
  it("is the extension and the commit's first 12 characters", () => {
    expect(clientName("0123456789abcdef0123456789abcdef01234567")).toBe("pi-cloudpid/0123456789ab");
  });
});
