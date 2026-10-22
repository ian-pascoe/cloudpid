// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.

import { MAX_IGNORE_PATTERNS } from "@cloudpid/config";
import type { SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  deleteConfirmed,
  groupByWorkspace,
  idleMinutesProblem,
  ignorePatternsFrom,
  ignoreProblem,
  slugProblem,
  sourceProblem,
  splitArchived,
  workspaceNameProblem,
} from "./workspaces.ts";

const session = (id: string, workspace: string, repo: string | null = null): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  workspace,
  repo,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
});

describe("groupByWorkspace", () => {
  it("groups Sessions by Workspace, the newest Session's Workspace first", () => {
    const groups = groupByWorkspace([
      session("c", "pi"),
      session("b", "cloudpid", "web"),
      session("a", "pi", "docs"),
    ]);

    expect(groups.map((group) => [group.workspace, group.sessions.map((s) => s.id)])).toEqual([
      ["pi", ["c", "a"]],
      ["cloudpid", ["b"]],
    ]);
  });

  it("is empty without Sessions", () => {
    expect(groupByWorkspace([])).toEqual([]);
  });
});

describe("groupByWorkspace with names", () => {
  it("labels each group with its Workspace's name, and with the slug for a Workspace it does not know", () => {
    const groups = groupByWorkspace([session("a", "pi"), session("b", "gone")], {
      pi: "Pi on Cloudflare",
    });

    expect(groups.map((group) => [group.workspace, group.name])).toEqual([
      ["pi", "Pi on Cloudflare"],
      ["gone", "gone"],
    ]);
  });
});

describe("splitArchived", () => {
  it("separates archived Sessions from the rest, keeping their order", () => {
    const archived = { ...session("b", "pi"), archivedAt: 5 };

    const { active, archived: put } = splitArchived([
      session("a", "pi"),
      archived,
      session("c", "x"),
    ]);

    expect(active.map((s) => s.id)).toEqual(["a", "c"]);
    expect(put.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("workspaceNameProblem", () => {
  it("accepts a name another Workspace does not have, in any case, and says what is wrong otherwise", () => {
    const others = ["Pi on Cloudflare"];

    expect(workspaceNameProblem("  Docs ", others)).toBeNull();
    expect(workspaceNameProblem("   ", others)).toBe("Give the workspace a name");
    expect(workspaceNameProblem("a".repeat(81), others)).toBe("Use at most 80 characters");
    expect(workspaceNameProblem("pi on cloudflare", others)).toBe(
      "Another workspace is already named that",
    );
  });
});

describe("deleteConfirmed", () => {
  it("holds only when the slug is typed exactly", () => {
    expect(deleteConfirmed("cloudpid", "cloudpid")).toBe(true);
    expect(deleteConfirmed("cloudpid", " cloudpid ")).toBe(true);
    expect(deleteConfirmed("cloudpid", "CloudPid")).toBe(false);
    expect(deleteConfirmed("cloudpid", "")).toBe(false);
  });
});

describe("slugProblem", () => {
  it("accepts a slug and says what is wrong with anything else", () => {
    expect(slugProblem("cloudpid")).toBeNull();
    expect(slugProblem("my-repo-2")).toBeNull();
    expect(slugProblem("")).not.toBeNull();
    expect(slugProblem("Has Space")).not.toBeNull();
    expect(slugProblem("-lead")).not.toBeNull();
    expect(slugProblem("a/b")).not.toBeNull();
  });
});

describe("sourceProblem", () => {
  it("accepts owner/repo and https URLs, and says what is wrong with anything else", () => {
    expect(sourceProblem("octocat/Hello-World")).toBeNull();
    expect(sourceProblem("https://github.com/octocat/Hello-World.git")).toBeNull();
    expect(sourceProblem("file:///etc/passwd")).toContain("https");
    expect(sourceProblem("")).not.toBeNull();
  });
});

describe("idleMinutesProblem", () => {
  it("accepts a whole number of minutes from 1 to a day and says what is wrong with anything else", () => {
    expect(idleMinutesProblem("15")).toBeNull();
    expect(idleMinutesProblem("1")).toBeNull();
    expect(idleMinutesProblem("1440")).toBeNull();
    expect(idleMinutesProblem("")).not.toBeNull();
    expect(idleMinutesProblem("0")).not.toBeNull();
    expect(idleMinutesProblem("1441")).not.toBeNull();
    expect(idleMinutesProblem("2.5")).not.toBeNull();
    expect(idleMinutesProblem("soon")).not.toBeNull();
  });
});

describe("ignorePatternsFrom", () => {
  it("takes one pattern per line, without the spaces around it or the blank lines", () => {
    expect(ignorePatternsFrom("  /data \n\n**/.gradle-cache\n")).toEqual([
      "/data",
      "**/.gradle-cache",
    ]);
    expect(ignorePatternsFrom("")).toEqual([]);
  });
});

describe("ignoreProblem", () => {
  it("accepts computer's ignore patterns, one per line, and names the line of one it would refuse", () => {
    expect(ignoreProblem("")).toBeNull();
    expect(ignoreProblem("/data\n**/.gradle-cache\n!/repo/node_modules")).toBeNull();
    expect(ignoreProblem("/data\ndata")).toContain("data");
    expect(ignoreProblem("/a/{b,c}")).not.toBeNull();
  });

  it("refuses more patterns than a Workspace may have", () => {
    const many = Array.from({ length: MAX_IGNORE_PATTERNS + 1 }, (_, i) => `/data-${i}`);

    expect(ignoreProblem(many.join("\n"))).toContain(String(MAX_IGNORE_PATTERNS));
  });
});
