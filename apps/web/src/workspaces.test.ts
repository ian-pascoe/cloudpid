// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime.
import type { SessionRecord } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { groupByWorkspace, idleMinutesProblem, slugProblem, sourceProblem } from "./workspaces.ts";

const session = (id: string, workspace: string, repo: string | null = null): SessionRecord => ({
  id,
  title: null,
  titleSource: null,
  workspace,
  repo,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
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
