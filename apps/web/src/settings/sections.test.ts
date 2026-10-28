// @effect-diagnostics preferEffectArray:off -- expected lists are native arrays.

import { describe, expect, it } from "vitest";
import {
  defaultSection,
  leadOnPath,
  scopeSwitchPath,
  sectionLabel,
  sectionsAt,
} from "./sections.ts";

const GLOBAL = "*";

describe("the Settings sections of a Scope", () => {
  it("are, at Global, the Settings, the Environments, Skills, Variables, Secrets, Notifications and Agent changes", () => {
    expect(sectionsAt(GLOBAL).map((slug) => sectionLabel(slug, GLOBAL))).toEqual([
      "General",
      "Instructions",
      "Models",
      "Tools",
      "Limits",
      "Environments",
      "Workspaces",
      "Skills",
      "Variables",
      "Secrets",
      "Notifications",
      "Agent changes",
    ]);
  });

  it("are, at an Environment, the Environment first, then what it keeps of its own", () => {
    expect(sectionsAt("1a2b3c4d").map((slug) => sectionLabel(slug, "1a2b3c4d"))).toEqual([
      "Environment",
      "Container",
      "Setup",
      "Limits",
      "Workspaces",
      "Skills",
      "Variables",
      "Secrets",
      "Agent changes",
    ]);
    expect(sectionsAt("1a2b3c4d")[0]).toBe("environments");
  });

  it("open on General at Global and on the Environment at an Environment", () => {
    expect(defaultSection(GLOBAL)).toBe("general");
    expect(defaultSection("default")).toBe("environments");
  });
});

describe("where the page leads on", () => {
  it("leads the list of sections to the Scope's first section on a wide screen, and keeps it on a narrow one", () => {
    expect(leadOnPath(GLOBAL, { kind: "index" }, true)).toBe("/settings/all/general");
    expect(leadOnPath("work", { kind: "index" }, true)).toBe("/settings/work/environments");
    expect(leadOnPath("work", { kind: "index" }, false)).toBeNull();
  });

  it("leads a section the Scope lacks to its first section, whatever the screen", () => {
    expect(leadOnPath("work", { kind: "section", section: "models" }, false)).toBe(
      "/settings/work/environments",
    );
    expect(leadOnPath(GLOBAL, { kind: "section", section: "container" }, true)).toBe(
      "/settings/all/general",
    );
    expect(leadOnPath(GLOBAL, { kind: "section", section: "nonsense" }, false)).toBe(
      "/settings/all/general",
    );
  });

  it("stays on a section the Scope has, and on a Skill directory page", () => {
    expect(leadOnPath("work", { kind: "section", section: "container" }, true)).toBeNull();
    expect(leadOnPath(GLOBAL, { kind: "section", section: "models" }, false)).toBeNull();
    expect(leadOnPath("work", { kind: "skillRepo", owner: "o", repo: "r" }, true)).toBeNull();
  });
});

describe("switching the Scope", () => {
  it("keeps the section when the new Scope has it", () => {
    expect(scopeSwitchPath({ kind: "section", section: "limits" }, "", "work")).toBe(
      "/settings/work/limits",
    );
    expect(scopeSwitchPath({ kind: "section", section: "environments" }, "", GLOBAL)).toBe(
      "/settings/all/environments",
    );
  });

  it("opens the new Scope's first section when it lacks the section", () => {
    expect(scopeSwitchPath({ kind: "section", section: "models" }, "", "work")).toBe(
      "/settings/work/environments",
    );
    expect(scopeSwitchPath({ kind: "section", section: "container" }, "", GLOBAL)).toBe(
      "/settings/all/general",
    );
    expect(scopeSwitchPath({ kind: "index" }, "", "work")).toBe("/settings/work");
  });

  it("keeps the Skills section's tab and search, and the Skill directory's page with its ref", () => {
    expect(scopeSwitchPath({ kind: "section", section: "skills" }, "?tab=hot&q=tdd", "work")).toBe(
      "/settings/work/skills?tab=hot&q=tdd",
    );
    expect(scopeSwitchPath({ kind: "skillRepo", owner: "o", repo: "r" }, "?ref=v1", GLOBAL)).toBe(
      "/settings/all/skills/o/r?ref=v1",
    );
    expect(
      scopeSwitchPath(
        { kind: "skill", owner: "o", repo: "r", skill: "tdd" },
        "?path=skills%2Ftdd",
        "work",
      ),
    ).toBe("/settings/work/skills/o/r/tdd?path=skills%2Ftdd");
    expect(scopeSwitchPath({ kind: "skillOwner", owner: "o" }, "", "work")).toBe(
      "/settings/work/skills/o",
    );
  });

  it("drops the query of a section that has none", () => {
    expect(scopeSwitchPath({ kind: "section", section: "limits" }, "?tab=hot", "work")).toBe(
      "/settings/work/limits",
    );
  });
});
