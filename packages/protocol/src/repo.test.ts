import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
  branchProblem,
  isWorkspaceId,
  parseRepoSource,
  REPO_NAME,
  workspaceDirectory,
} from "./repo.ts";

const parsed = (input: string) => {
  const result = parseRepoSource(input);

  return Result.isSuccess(result) ? result.success : undefined;
};

describe("parseRepoSource", () => {
  it("reads owner/repo as a GitHub repo", () => {
    expect(parsed("ian-pascoe/cloudpid")).toEqual({
      url: "https://github.com/ian-pascoe/cloudpid.git",
      name: "cloudpid",
    });
    expect(parsed("  octocat/Hello-World.git ")).toEqual({
      url: "https://github.com/octocat/Hello-World.git",
      name: "Hello-World",
    });
  });

  it("reads an https URL, dropping .git and a trailing slash from the name", () => {
    expect(parsed("https://github.com/octocat/Hello-World")).toEqual({
      url: "https://github.com/octocat/Hello-World",
      name: "Hello-World",
    });
    expect(parsed("https://github.com/octocat/Hello-World.git/")).toEqual({
      url: "https://github.com/octocat/Hello-World.git",
      name: "Hello-World",
    });
    expect(parsed("https://gitlab.com/group/sub/project.git")).toEqual({
      url: "https://gitlab.com/group/sub/project.git",
      name: "project",
    });
  });

  it.each([
    "",
    "   ",
    "http://github.com/a/b",
    "git://github.com/a/b",
    "ssh://git@github.com/a/b",
    "git@github.com:a/b.git",
    "file:///etc/passwd",
    "ext::sh -c touch /tmp/x",
    "/etc/passwd",
    "../repo",
    "-oProxyCommand=x/y",
    "--upload-pack=x/y",
    "a/b/c",
    "https://user:pass@github.com/a/b",
    "https://token@github.com/a/b",
    "https://github.com:8443/a/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b#frag",
    "https://github.com/a",
    "https://github.com/a/../b",
    "https://github.com/a/%2e%2e",
    "https://github.com/a/b c",
    "https://github.com/a/b;rm -rf",
    "https://github.com/a/$(id)",
    "https://github.com/a/`id`",
    "https://localhost/a/b",
    "https://intranet/a/b",
    "https://10.0.0.1/a/b",
    "https://169.254.169.254/a/b",
    "https://127.0.0.1/a/b",
    "https://[::1]/a/b",
    "https://metadata.google.internal/a/b",
    "https://printer.local/a/b",
    "https://github.com/a/.git",
    "https://github.com/a/-x",
    `https://github.com/a/${"x".repeat(300)}`,
    "https://github.com/a/b\nhttps://evil.example/c/d",
  ])("rejects %j", (input) => {
    expect(parsed(input)).toBeUndefined();
  });

  it("says why", () => {
    expect(parseRepoSource("file:///etc/passwd")).toEqual(
      Result.fail("Enter a repo as owner/repo or a plain https URL"),
    );
  });
});

describe("REPO_NAME", () => {
  it.each(["pi", "cloudpid", "a.b_c-d", "9lives", "Hello-World"])("accepts %j", (name) => {
    expect(REPO_NAME.test(name)).toBe(true);
  });

  it.each(["", ".", "..", ".git", "-x", "a/b", "a b", "a\nb", "~"])("rejects %j", (name) => {
    expect(REPO_NAME.test(name)).toBe(false);
  });
});

describe("workspaceDirectory", () => {
  it("is the one repo's clone, or the root when there are none or several", () => {
    expect(workspaceDirectory(["app"])).toBe("/workspace/app");
    expect(workspaceDirectory([])).toBe("/workspace");
    expect(workspaceDirectory(["app", "api"])).toBe("/workspace");
  });
});

describe("isWorkspaceId", () => {
  it.each(["1a2b3c4d", "00000000", "ffffffff"])("takes %s", (id) => {
    expect(isWorkspaceId(id)).toBe(true);
  });

  it.each(["new", "1A2B3C4D", "1a2b3c4", "1a2b3c4d5", "../a2b3c", ""])("refuses %s", (id) => {
    expect(isWorkspaceId(id)).toBe(false);
  });
});

describe("branchProblem", () => {
  it.each(["main", "feat/workspaces", "cloudpid/1a2b3c4d", "fix-1.2_x", "a/b/c"])(
    "takes %s",
    (name) => {
      expect(branchProblem(name)).toBeUndefined();
    },
  );

  it.each([
    ["", "empty"],
    ["-x", "an option"],
    ["a..b", "a range"],
    ["a b", "a space"],
    ["a//b", "an empty segment"],
    ["a/", "a trailing slash"],
    ["/a", "a leading slash"],
    ["a/.b", "a hidden segment"],
    ["a.lock", "a lock file"],
    ["a.", "a trailing dot"],
    ["a@{1}", "a reflog"],
    ["HEAD", "HEAD"],
    ["a~1", "an ancestor"],
    ["a:b", "a colon"],
    ["x".repeat(201), "too long"],
  ])("refuses %s (%s)", (name) => {
    expect(branchProblem(name)).toBeTypeOf("string");
  });
});
