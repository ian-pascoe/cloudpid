// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.

import { describe, expect, it } from "vitest";
import {
  draftBaseProblem,
  draftBranchProblem,
  draftPlace,
  draftSendable,
  effectiveWorkspace,
  type DraftInput,
} from "./draft.ts";

const draft = (changes: Partial<DraftInput> = {}): DraftInput => ({
  text: "Fix the build",
  environment: "default",
  workspace: "new",
  branch: "",
  base: "",
  ...changes,
});

describe("the Workspace a draft uses", () => {
  const workspaces = [{ id: "0a1b2c3d" }, { id: "deadbeef" }];

  it("is the one picked when the Environment has it", () => {
    expect(effectiveWorkspace("deadbeef", workspaces)).toBe("deadbeef");
  });

  it("is a new one when none is picked, or the one picked is gone", () => {
    expect(effectiveWorkspace("new", workspaces)).toBe("new");
    expect(effectiveWorkspace("ffffffff", workspaces)).toBe("new");
    expect(effectiveWorkspace("0a1b2c3d", [])).toBe("new");
  });
});

describe("what a draft is told to create", () => {
  it("is the Environment and a new Workspace, with no branch or base left empty", () => {
    expect(draftPlace(draft())).toEqual({ environment: "default", workspace: "new" });
  });

  it("carries the base and branch of a new Workspace, trimmed", () => {
    expect(draftPlace(draft({ environment: "work", branch: " fix/build ", base: "main" }))).toEqual(
      { environment: "work", workspace: "new", branch: "fix/build", base: "main" },
    );
  });

  it("names an existing Workspace and carries no branch or base", () => {
    expect(draftPlace(draft({ workspace: "0a1b2c3d", branch: "x", base: "y" }))).toEqual({
      environment: "default",
      workspace: "0a1b2c3d",
    });
  });
});

describe("whether a draft can be sent", () => {
  it("needs a message", () => {
    expect(draftSendable(draft())).toBe(true);
    expect(draftSendable(draft({ text: "  \n" }))).toBe(false);
  });

  it("checks the branch and base of a new Workspace as they are typed", () => {
    expect(draftBranchProblem(draft({ branch: "a..b" }))).not.toBeNull();
    expect(draftBaseProblem(draft({ base: "has space" }))).not.toBeNull();
    expect(draftSendable(draft({ branch: "a..b" }))).toBe(false);
    expect(draftSendable(draft({ base: "has space" }))).toBe(false);
    expect(draftBranchProblem(draft({ branch: "feature/x" }))).toBeNull();
  });

  it("ignores the branch and base fields of an existing Workspace", () => {
    expect(draftSendable(draft({ workspace: "0a1b2c3d", branch: "a..b" }))).toBe(true);
  });
});
