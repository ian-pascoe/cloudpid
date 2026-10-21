// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseSkill } from "@cloudpid/extensions/skills";
import { describe, expect, it } from "vitest";
import { MAX_TOTAL_BYTES, problemsIn } from "../../../../scripts/skills-checks.ts";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";

const skillsDirectory = decodeURIComponent(new URL("../../../../skills", import.meta.url).pathname);

/** The files below `directory`, as `skill/path` keys relative to `skills/`. */
const filesBelow = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    return statSync(path).isDirectory()
      ? filesBelow(path)
      : [relative(skillsDirectory, path).split(sep).join("/")];
  });

/** The skill directories: every directory of `skills/` but the licence texts. */
const skillDirectories = readdirSync(skillsDirectory).filter(
  (name) => name !== "LICENSES" && statSync(join(skillsDirectory, name)).isDirectory(),
);

const onDisk = skillDirectories.flatMap((name) => filesBelow(join(skillsDirectory, name)));

const bundled = BUNDLED_SKILLS.files;

describe("the bundled skills", () => {
  it("are every file of the skill directories in `skills/`, as `node scripts/sync-skills.mjs` generates them", () => {
    expect(Object.keys(bundled).toSorted()).toEqual(onDisk.toSorted());

    for (const key of onDisk) {
      expect(bundled[key]).toBe(readFileSync(join(skillsDirectory, key), "utf8"));
    }
  });

  it("carry the version that makes computer copy them into Workspaces again when they change", () => {
    // `?raw` reads the files at build time, so only the version can fall behind a hand edit of `skills/`: computer
    // copies the mount into a Workspace that has an older version again, and into none that has this one.
    const hash = createHash("sha256");

    for (const [key, text] of Object.entries(bundled)) hash.update(`${key}\0${String(text)}\0`);

    expect(BUNDLED_SKILLS.version).toBe(`sha256:${hash.digest("hex")}`);
  });

  it("point at no script or file of the skill that is not bundled", () => {
    // Backticked `scripts/...` and `references/...` paths in a SKILL.md are relative to its skill directory.
    for (const key of onDisk.filter((path) => path.endsWith("SKILL.md"))) {
      const skill = key.split("/")[0] ?? "";

      for (const [, path] of String(bundled[key]).matchAll(
        /`((?:scripts|references)\/[\w./-]+)`/g,
      )) {
        expect(bundled[`${skill}/${path}`], `${key} points at ${path}`).toBeDefined();
      }
    }
  });

  it("each declare a name and a description in their SKILL.md", () => {
    expect(skillDirectories.length).toBeGreaterThan(0);

    for (const name of skillDirectories) {
      const text = bundled[`${name}/SKILL.md`];

      expect(text, `${name}/SKILL.md`).toEqual(expect.any(String));

      expect(parseSkill(`/workspace/.agents/skills/${name}/SKILL.md`, String(text))).toMatchObject({
        name,
      });
    }
  });

  it("are small text with no credential or local path, as the sync requires", () => {
    const problems = onDisk.flatMap((key) =>
      problemsIn(key, readFileSync(join(skillsDirectory, key))),
    );

    expect(problems).toEqual([]);

    const total = onDisk.reduce((sum, key) => sum + statSync(join(skillsDirectory, key)).size, 0);

    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it("are each named in NOTICE.md, whose licence texts exist", () => {
    const notice = readFileSync(join(skillsDirectory, "NOTICE.md"), "utf8");

    for (const name of skillDirectories) expect(notice, name).toContain(`\`${name}\``);

    const licences = [...notice.matchAll(/\]\((LICENSES\/[^)]+)\)/g)].map((match) => match[1]);

    expect(licences.length).toBeGreaterThan(0);

    for (const licence of licences) {
      expect(existsSync(join(skillsDirectory, String(licence))), String(licence)).toBe(true);
    }
  });
});
