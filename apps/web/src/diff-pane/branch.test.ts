// @effect-diagnostics preferEffectArray:off -- tests of plain functions over values.
import type { Comparison } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  branchSourceOf,
  comparisonHeading,
  comparisonRepos,
  commitsLabel,
  errorText,
  sourceOfValue,
  sourceOptions,
  sourceValue,
} from "./branch.ts";

const MERGE_BASE = "abcdef0123456789abcdef0123456789abcdef01";
const HEAD = "1234567890123456789012345678901234567890";

const comparison = (overrides: Partial<Comparison> = {}): Comparison => ({
  repo: "app",
  base: "main",
  branch: "feat",
  mergeBase: MERGE_BASE,
  head: HEAD,
  commits: 3,
  files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
  more: 2,
  ...overrides,
});

describe("the source picker", () => {
  it("round-trips a source through its value, and reads anything else as the Changes", () => {
    expect(sourceOfValue(sourceValue({ kind: "branch", repo: "web" }))).toEqual({
      kind: "branch",
      repo: "web",
    });
    expect(sourceOfValue(sourceValue({ kind: "changes" }))).toEqual({ kind: "changes" });
    expect(sourceOfValue(sourceValue({ kind: "changes", repo: "web" }))).toEqual({
      kind: "changes",
      repo: "web",
    });
    expect(sourceOfValue("branch:")).toEqual({ kind: "changes" });
    expect(sourceOfValue("nonsense")).toEqual({ kind: "changes" });
  });

  it("lists the Changes, then This branch under its name", () => {
    expect(
      sourceOptions({ repos: [{ repo: "app", head: { commit: HEAD, branch: "feat" } }] }),
    ).toEqual([
      {
        label: null,
        options: [
          { value: "changes", label: "Changes" },
          { value: "branch:app", label: "This branch (feat)" },
        ],
      },
    ]);
  });

  it("groups by repo when there are several, names a detached HEAD, and skips This branch of a repo with no commit", () => {
    expect(
      sourceOptions({
        repos: [
          { repo: "api", head: { commit: HEAD, branch: null } },
          { repo: "web", head: { commit: MERGE_BASE, branch: "feat" } },
          { repo: "new", head: { commit: null, branch: null } },
        ],
      }),
    ).toEqual([
      { label: null, options: [{ value: "changes", label: "Changes (every repo)" }] },
      {
        label: "api",
        options: [
          { value: "changes:api", label: "Changes" },
          { value: "branch:api", label: "This branch (detached at 1234567)" },
        ],
      },
      {
        label: "web",
        options: [
          { value: "changes:web", label: "Changes" },
          { value: "branch:web", label: "This branch (feat)" },
        ],
      },
      { label: "new", options: [{ value: "changes:new", label: "Changes" }] },
    ]);
    expect(sourceOptions(null)).toEqual([
      { label: null, options: [{ value: "changes", label: "Changes" }] },
    ]);
  });
});

describe("a Comparison in the Pane", () => {
  it("is one repo's list, with the files and how many more there are", () => {
    expect(comparisonRepos(comparison())).toEqual([
      {
        repo: "app",
        head: { commit: HEAD, branch: "feat" },
        files: comparison().files,
        more: 2,
        stale: false,
      },
    ]);
  });

  it("is the source a draft is written against", () => {
    expect(branchSourceOf(comparison())).toEqual({
      kind: "branch",
      repo: "app",
      branch: "feat",
      base: "main",
      mergeBase: MERGE_BASE,
      head: HEAD,
    });
  });

  it("is named by its branch, base and merge-base, with its commits counted", () => {
    expect(comparisonHeading(comparison())).toBe("feat against main at abcdef0");
    expect(comparisonHeading(comparison({ branch: null }))).toBe(
      "Detached at 1234567 against main at abcdef0",
    );
    expect(commitsLabel(1)).toBe("1 commit");
    expect(commitsLabel(3)).toBe("3 commits");
  });
});

describe("errorText", () => {
  it("says something of its own for each error state", () => {
    const texts = [
      errorText({ kind: "needs_container", message: "" }),
      errorText({ kind: "no_remote", message: "" }),
      errorText({ kind: "no_base", message: "", base: "main" }),
      errorText({ kind: "no_common_ancestor", message: "", base: "main" }),
      errorText({ kind: "shallow", message: "" }),
      errorText({ kind: "too_big", message: "" }),
      errorText({ kind: "failed", message: "boom" }),
    ];

    expect(new Set(texts).size).toBe(texts.length);
    expect(texts[2]).toContain("main");
    expect(texts[3]).toContain("main");
    expect(texts[6]).toContain("boom");
  });
});
