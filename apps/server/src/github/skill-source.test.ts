import { describe, expect, it } from "vitest";
import { parseSkillSource } from "./skill-source.ts";

const parsed = (input: string) => {
  const result = parseSkillSource(input);

  if (!result.ok) throw new Error(result.message);

  return result.source;
};

describe("parseSkillSource", () => {
  it("reads owner/repo", () => {
    expect(parsed("mattpocock/skills")).toEqual({
      owner: "mattpocock",
      name: "skills",
      repo: "mattpocock/skills",
      ref: null,
      path: "",
      skill: null,
    });
  });

  it("reads owner/repo@skill, and trims the input", () => {
    expect(parsed("  mattpocock/skills@grill-me ")).toMatchObject({
      repo: "mattpocock/skills",
      skill: "grill-me",
      ref: null,
      path: "",
    });
  });

  it("reads a repo URL, with or without .git, a scheme or a trailing slash", () => {
    for (const url of [
      "https://github.com/mattpocock/skills",
      "https://github.com/mattpocock/skills.git",
      "https://github.com/mattpocock/skills/",
      "github.com/mattpocock/skills",
      "http://www.github.com/mattpocock/skills#readme",
    ]) {
      expect(parsed(url)).toMatchObject({ repo: "mattpocock/skills", ref: null, path: "" });
    }
  });

  it("reads a tree URL: the ref, and the folder below it", () => {
    expect(parsed("https://github.com/o/r/tree/v1.2/skills/grill-me")).toMatchObject({
      repo: "o/r",
      ref: "v1.2",
      path: "skills/grill-me",
    });

    expect(parsed("https://github.com/o/r/tree/main")).toMatchObject({
      ref: "main",
      path: "",
    });

    expect(parsed("https://github.com/o/r/tree/main/skills/")).toMatchObject({
      path: "skills",
    });
  });

  it("decodes percent-escapes in the ref and the path", () => {
    expect(parsed("https://github.com/o/r/tree/feature%2Ffoo/a%20b")).toMatchObject({
      ref: "feature/foo",
      path: "a b",
    });
  });

  it("refuses what is not a GitHub source, saying what the forms are", () => {
    for (const input of [
      "",
      "owner",
      "gitlab.com/o/r",
      "https://gitlab.com/o/r",
      "./local/path",
      "o/r/extra/path",
      "https://github.com/o",
      "https://github.com/o/r/blob/main/SKILL.md",
      "https://github.com/o/r/tree/",
      "https://github.com/o/r/tree/main/../x",
      "o/r@",
      "github.com/foo",
    ]) {
      const result = parseSkillSource(input);

      expect(result.ok, input).toBe(false);

      if (!result.ok) expect(result.message).toContain("owner/repo@skill");
    }
  });
});
