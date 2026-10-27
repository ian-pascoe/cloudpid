// @effect-diagnostics preferEffectArray:off -- tests of plain functions over values.
import type { Comparison, PullRequest } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  branchSourceOf,
  comparisonHeading,
  comparisonRepos,
  commitsLabel,
  errorText,
  pullLabel,
  pullSourceOf,
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

const pull = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `Pull ${number}`,
  author: "dev",
  draft: false,
  additions: 12,
  deletions: 3,
  changedFiles: 4,
  head: HEAD,
  headRef: "topic",
  base: "main",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("the source picker's pull requests", () => {
  it("round-trips a pull request through its value, repo names with a # included", () => {
    expect(sourceOfValue(sourceValue({ kind: "pull", repo: "web", number: 7 }))).toEqual({
      kind: "pull",
      repo: "web",
      number: 7,
    });
    expect(sourceOfValue(sourceValue({ kind: "pull", repo: "c#", number: 12 }))).toEqual({
      kind: "pull",
      repo: "c#",
      number: 12,
    });
    expect(sourceOfValue("pull:web#0")).toEqual({ kind: "changes" });
    expect(sourceOfValue("pull:web#x")).toEqual({ kind: "changes" });
    expect(sourceOfValue("pull:web")).toEqual({ kind: "changes" });
  });

  it("names each by number, title, author, draft and counts, and pins this branch's first", () => {
    expect(pullLabel(pull(7, { draft: true }))).toBe("#7 Pull 7 · dev · draft · +12 −3");
    expect(pullLabel(pull(8, { additions: null, thisBranch: true }))).toBe(
      "#8 Pull 8 · dev · this branch",
    );

    const head = { commit: HEAD, branch: "feat" };

    expect(
      sourceOptions({
        repos: [
          {
            repo: "app",
            head,
            pulls: {
              status: "ok",
              fetchedAt: 1,
              pulls: [pull(9), pull(7, { thisBranch: true }), pull(5)],
            },
          },
        ],
      })[0]?.options.map((option) => option.value),
    ).toEqual(["changes", "branch:app", "pull:app#7", "pull:app#9", "pull:app#5"]);
  });

  it("filters them by number, title, author and head branch, keeping this branch's and the one on show", () => {
    const head = { commit: HEAD, branch: "feat" };

    const sources = {
      repos: [
        {
          repo: "app",
          head,
          pulls: {
            status: "ok" as const,
            fetchedAt: 1,
            pulls: [
              pull(9, { title: "Fix the login", author: "sam" }),
              pull(7, { thisBranch: true, title: "Unrelated" }),
              pull(5, { title: "Docs", headRef: "docs/login-page" }),
              pull(3, { title: "Refactor", draft: true }),
            ],
          },
        },
      ],
    };

    const values = (text: string, keep = "") =>
      sourceOptions(sources, { text, keep })[0]
        ?.options.map((option) => option.value)
        .filter((value) => value.startsWith("pull"));

    expect(values("")).toEqual(["pull:app#7", "pull:app#9", "pull:app#5", "pull:app#3"]);
    expect(values("LOGIN")).toEqual(["pull:app#7", "pull:app#9", "pull:app#5"]);
    expect(values("login sam")).toEqual(["pull:app#7", "pull:app#9"]);
    expect(values("#5")).toEqual(["pull:app#7", "pull:app#5"]);
    expect(values("draft")).toEqual(["pull:app#7", "pull:app#3"]);
    expect(values("login", "pull:app#3")).toEqual([
      "pull:app#7",
      "pull:app#9",
      "pull:app#5",
      "pull:app#3",
    ]);
    expect(values("nothing like it")).toEqual(["pull:app#7", "pulls-none:app"]);
  });

  it("lists them in the repo's group when there are several, and says why there are none", () => {
    const head = { commit: HEAD, branch: "feat" };

    const groups = sourceOptions({
      repos: [
        { repo: "api", head, pulls: { status: "ok", fetchedAt: 1, pulls: [] } },
        {
          repo: "web",
          head,
          pulls: { status: "error", kind: "refused", message: "GitHub refused the token" },
        },
        {
          repo: "lib",
          head,
          pulls: {
            status: "error",
            kind: "no_github",
            message: "Pull requests need a GitHub remote",
          },
        },
        { repo: "old", head },
      ],
    });

    expect(groups.find(({ label }) => label === "api")?.options.at(-1)).toEqual({
      value: "pulls-none:api",
      label: "No open pull requests",
      disabled: true,
    });
    expect(groups.find(({ label }) => label === "web")?.options.at(-1)).toEqual({
      value: "pulls-error:web",
      label: "Pull requests: GitHub refused the token",
      disabled: true,
    });
    // A remote that is not GitHub's, or pull requests not asked for yet, list nothing.
    expect(groups.find(({ label }) => label === "lib")?.options).toHaveLength(2);
    expect(groups.find(({ label }) => label === "old")?.options).toHaveLength(2);
  });

  it("anchors drafts on the pull request, its title cut to the limit, and names the Comparison by it", () => {
    const pulled = comparison({
      branch: "topic",
      pull: { number: 7, title: "x".repeat(600), author: "dev", draft: false, state: "open" },
    });

    expect(pullSourceOf(pulled)).toEqual({
      kind: "pull",
      repo: "app",
      number: 7,
      title: "x".repeat(512),
      mergeBase: MERGE_BASE,
      head: HEAD,
    });
    expect(pullSourceOf(comparison())).toBeUndefined();
    expect(
      comparisonHeading(
        comparison({
          branch: "topic",
          pull: { number: 7, title: "Fix it", author: "dev", draft: false, state: "open" },
        }),
      ),
    ).toBe("#7 Fix it: topic against main at abcdef0");
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
      errorText({ kind: "no_github", message: "" }),
      errorText({ kind: "github_refused", message: "" }),
      errorText({ kind: "pull_closed", message: "" }),
      errorText({ kind: "pull_merged", message: "" }),
      errorText({ kind: "failed", message: "boom" }),
    ];

    expect(new Set(texts).size).toBe(texts.length);
    expect(texts[2]).toContain("main");
    expect(texts[3]).toContain("main");
    expect(texts.at(-1)).toContain("boom");
  });
});
