import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { parseRepoSource, REPO_NAME } from "./repo.ts";

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
