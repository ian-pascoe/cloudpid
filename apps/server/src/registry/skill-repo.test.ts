// What the repo page joins to the Skills GitHub lists (`docs/architecture/workspace.md` → _The Skill directory_): installs
// from the Skill directory's search, badges from the Skills the Registry keeps, matched exactly by repo and folder.
// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import type { InstalledSkillRef } from "./skill-badges.ts";
import { joinRepoSkills, skillIdOf, type SkillRepoRows } from "./skill-repo.ts";

const rows = (skills: SkillRepoRows["skills"]): SkillRepoRows => ({
  repo: "Acme/Skills",
  ref: null,
  commit: "c".repeat(40),
  skills,
  unreadable: [],
  omitted: 0,
});

const tdd = { name: "tdd", description: "Test first.", path: "skills/tdd", skillId: "tdd" };

const grill = {
  name: "Grill Me",
  description: "Ask.",
  path: "skills/grill-me",
  skillId: "grill-me",
};

describe("skillIdOf", () => {
  it("is the folder's name, or the name of a Skill at the repo's root", () => {
    expect(skillIdOf({ path: "skills/engineering/tdd", name: "TDD" })).toBe("tdd");
    expect(skillIdOf({ path: "", name: "only-one" })).toBe("only-one");
  });
});

describe("joinRepoSkills", () => {
  it("gives installs from the directory's rows of the same repo, whatever its case, and lists those first", () => {
    const joined = joinRepoSkills(
      rows([grill, tdd]),
      [],
      [
        { source: "acme/skills", skillId: "tdd", name: "tdd", installs: 50 },
        { source: "other/skills", skillId: "grill-me", name: "grill-me", installs: 9_999 },
      ],
    );

    expect(joined.skills.map(({ name, installs }) => [name, installs])).toEqual([
      ["tdd", 50],
      ["Grill Me", undefined],
    ]);
  });

  it("matches a Skill the directory names by its name when its folder is not named so", () => {
    const root = { name: "only-one", description: "One.", path: "", skillId: "only-one" };
    const named = { name: "Grill Me", description: "Ask.", path: "x/y", skillId: "y" };

    const joined = joinRepoSkills(
      rows([root, named]),
      [],
      [
        { source: "acme/skills", skillId: "only-one", name: "only-one", installs: 7 },
        { source: "acme/skills", skillId: "grill-me", name: "Grill Me", installs: 3 },
      ],
    );

    expect(joined.skills.map(({ installs }) => installs)).toEqual([7, 3]);
  });

  it("leaves installs blank for Skills whose ID another Skill of the repo shares: the directory cannot say which it counts", () => {
    const joined = joinRepoSkills(
      rows([
        { ...tdd, path: "a/tdd" },
        { ...tdd, path: "b/tdd" },
      ]),
      [],
      [{ source: "acme/skills", skillId: "tdd", name: "tdd", installs: 50 }],
    );

    expect(joined.skills.map(({ installs }) => installs)).toEqual([undefined, undefined]);
  });

  it("says where each Skill is installed by its folder, not by its name", () => {
    const installed: InstalledSkillRef[] = [
      { scope: "*", name: "tdd", repo: "acme/skills", path: "skills/tdd", updateAvailable: true },
      {
        scope: "work",
        name: "tdd",
        repo: "acme/skills",
        path: "elsewhere/tdd",
        updateAvailable: false,
      },
      {
        scope: "work",
        name: "tdd",
        repo: "other/skills",
        path: "skills/tdd",
        updateAvailable: false,
      },
    ];

    const joined = joinRepoSkills(rows([tdd, grill]), installed, []);

    expect(joined.skills[0]?.installed).toEqual({
      everyEnvironment: true,
      environments: [],
      updateAvailable: true,
    });
    expect(joined.skills[1]?.installed).toBeUndefined();
  });
});
