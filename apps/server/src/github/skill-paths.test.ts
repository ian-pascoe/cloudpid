// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- fakes of `fetch` and the Registry over native arrays.
// The `SKILL.md` path rules, held to the `skills` CLI's own cases: the `findSkillMdPaths` tests of vercel-labs/skills'
// `tests/nested-container-discovery.test.ts` (MIT, Copyright (c) 2026 Vercel, Inc.; the licence is in `skill-paths.ts`),
// then cases for the rest of the function as `skills@1.7.4` runs it.
import { describe, expect, it } from "vitest";
import {
  findSkillMdPaths,
  folderHashOf,
  isInstallablePath,
  PRIORITY_PREFIXES,
  skillFilesIn,
  skillFolderOf,
  skillMdIn,
  type TreeEntry,
} from "./skill-paths.ts";

/** A tree whose entries are blobs (SKILL.md files) or trees, as the CLI's test makes it. */
const makeTree = (paths: string[]) => ({
  tree: paths.map((path): TreeEntry => ({
    path,
    type: path.toLowerCase().endsWith("skill.md") ? "blob" : "tree",
    sha: `sha-${path.replace(/[^a-z0-9]/gi, "_")}`,
  })),
});

describe("findSkillMdPaths — bounded depth-3 inside skill container prefixes (the CLI's cases)", () => {
  it("returns nested SKILL.md paths under skills/<category>/<skill>/", () => {
    const tree = makeTree([
      "skills/product-a/skill-one/SKILL.md",
      "skills/product-a/skill-two/SKILL.md",
      "skills/product-b/skill-three/SKILL.md",
    ]);

    expect(findSkillMdPaths(tree).sort()).toEqual([
      "skills/product-a/skill-one/SKILL.md",
      "skills/product-a/skill-two/SKILL.md",
      "skills/product-b/skill-three/SKILL.md",
    ]);
  });

  it("returns mixed flat and nested paths from the same container", () => {
    const tree = makeTree(["skills/flat-skill/SKILL.md", "skills/category/nested-skill/SKILL.md"]);

    expect(findSkillMdPaths(tree).sort()).toEqual([
      "skills/category/nested-skill/SKILL.md",
      "skills/flat-skill/SKILL.md",
    ]);
  });

  it("returns skills nested under two category levels", () => {
    const tree = makeTree([
      "skills/core-skills/amazon-bedrock/SKILL.md",
      "skills/specialized-skills/database-skills/amazon-dynamodb/SKILL.md",
    ]);

    expect(findSkillMdPaths(tree).sort()).toEqual([
      "skills/core-skills/amazon-bedrock/SKILL.md",
      "skills/specialized-skills/database-skills/amazon-dynamodb/SKILL.md",
    ]);
  });

  it("does not descend past a SKILL.md found at depth 1", () => {
    const tree = makeTree(["skills/foo/SKILL.md", "skills/foo/inner/SKILL.md"]);

    expect(findSkillMdPaths(tree)).toEqual(["skills/foo/SKILL.md"]);
  });

  it("is case-insensitive about the parent SKILL.md when checking for shadowing", () => {
    const tree = makeTree(["skills/foo/skill.md", "skills/foo/inner/SKILL.md"]);

    expect(findSkillMdPaths(tree)).toEqual(["skills/foo/skill.md"]);
  });

  it("skips depth-2 entries whose intermediate dir is an ignored directory", () => {
    const tree = makeTree([
      "skills/node_modules/pkg-skill/SKILL.md",
      "skills/real-category/real-skill/SKILL.md",
    ]);

    expect(findSkillMdPaths(tree)).toEqual(["skills/real-category/real-skill/SKILL.md"]);
  });

  it("does not surface depth-2 entries under the root prefix", () => {
    const tree = makeTree([
      "examples/category/example-skill/SKILL.md",
      "skills/real-skill/SKILL.md",
    ]);

    expect(findSkillMdPaths(tree)).toEqual(["skills/real-skill/SKILL.md"]);
  });

  it("respects the subpath filter while applying depth-2 discovery", () => {
    const tree = makeTree([
      "skills/category/in-scope/SKILL.md",
      "other/category/out-of-scope/SKILL.md",
    ]);

    expect(findSkillMdPaths(tree, "skills")).toEqual(["skills/category/in-scope/SKILL.md"]);
  });
});

describe("findSkillMdPaths — the rest of the function", () => {
  it("takes a SKILL.md at the repo's root, then the priority directories in order", () => {
    const tree = makeTree([
      ".claude/skills/claude-one/SKILL.md",
      "skills/one/SKILL.md",
      "SKILL.md",
      "skills/.curated/curated/SKILL.md",
    ]);

    expect(findSkillMdPaths(tree)).toEqual([
      "SKILL.md",
      "skills/one/SKILL.md",
      "skills/.curated/curated/SKILL.md",
      ".claude/skills/claude-one/SKILL.md",
    ]);
  });

  it("takes a Skill one folder below the repo's root", () => {
    expect(findSkillMdPaths(makeTree(["grill-me/SKILL.md", "docs/readme.md"]))).toEqual([
      "grill-me/SKILL.md",
    ]);
  });

  it("falls back to every SKILL.md at most six segments deep when no priority directory has one", () => {
    const tree = makeTree([
      "a/b/c/SKILL.md",
      "a/b/c/d/e/SKILL.md",
      "a/b/c/d/e/f/SKILL.md",
      "plugins/x/y/z/w/v/SKILL.md",
    ]);

    expect(findSkillMdPaths(tree)).toEqual(["a/b/c/SKILL.md", "a/b/c/d/e/SKILL.md"]);
  });

  it("takes a Skill directly in the folder a subpath names, and the subpath's trailing slash is optional", () => {
    const tree = makeTree(["skills/foo/SKILL.md", "skills/bar/SKILL.md"]);

    expect(findSkillMdPaths(tree, "skills/foo")).toEqual(["skills/foo/SKILL.md"]);
    expect(findSkillMdPaths(tree, "skills/foo/")).toEqual(["skills/foo/SKILL.md"]);
    expect(findSkillMdPaths(tree, "nothing")).toEqual([]);
  });

  it("ignores blobs that are not a SKILL.md and entries that are not blobs", () => {
    const tree = {
      tree: [
        { path: "skills/a/SKILL.md", type: "tree" as const, sha: "1" },
        { path: "skills/b/README.md", type: "blob" as const, sha: "2" },
      ],
    };

    expect(findSkillMdPaths(tree)).toEqual([]);
  });

  it("lists the directories the CLI looks in, root first", () => {
    expect(PRIORITY_PREFIXES[0]).toBe("");
    expect(PRIORITY_PREFIXES).toContain("skills/");
    expect(PRIORITY_PREFIXES).toContain(".agents/skills/");
    expect(PRIORITY_PREFIXES).toHaveLength(35);
  });
});

describe("a Skill's folder and files", () => {
  it("names the folder a SKILL.md is in, in any case", () => {
    expect(skillFolderOf("skills/foo/SKILL.md")).toBe("skills/foo");
    expect(skillFolderOf("skills/foo/skill.md")).toBe("skills/foo");
    expect(skillFolderOf("SKILL.md")).toBe("");
    expect(skillFolderOf("skill.md")).toBe("");
  });

  it("leaves out metadata.json and files below .git, __pycache__ and __pypackages__", () => {
    expect(isInstallablePath("SKILL.md")).toBe(true);
    expect(isInstallablePath("references/a.md")).toBe(true);
    expect(isInstallablePath("metadata.json")).toBe(false);
    expect(isInstallablePath("sub/metadata.json")).toBe(false);
    expect(isInstallablePath(".git/config")).toBe(false);
    expect(isInstallablePath("scripts/__pycache__/x.pyc")).toBe(false);
    expect(isInstallablePath("__pypackages__/x/y.py")).toBe(false);
  });

  const blob = (path: string): TreeEntry => ({ path, type: "blob", sha: `sha-${path}`, size: 1 });

  it("takes the files below the Skill's folder, by their path in it", () => {
    const tree = {
      tree: [
        blob("skills/foo/SKILL.md"),
        blob("skills/foo/references/a.md"),
        blob("skills/foo/metadata.json"),
        blob("skills/foo/.git/HEAD"),
        blob("skills/foobar/SKILL.md"),
        { path: "skills/foo/references", type: "tree" as const, sha: "t" },
      ],
    };

    expect(skillFilesIn(tree, "skills/foo/SKILL.md").map((entry) => entry.relative)).toEqual([
      "SKILL.md",
      "references/a.md",
    ]);
  });

  it("finds the SKILL.md of a folder in any case, and of the repo's root, preferring SKILL.md", () => {
    const tree = {
      tree: [
        blob("skill.md"),
        blob("skills/foo/skill.md"),
        blob("skills/bar/SKILL.md"),
        blob("skills/bar/skill.md"),
        blob("skills/baz/notes.md"),
      ],
    };

    expect(skillMdIn(tree, "")).toBe("skill.md");
    expect(skillMdIn(tree, "skills/foo")).toBe("skills/foo/skill.md");
    expect(skillMdIn(tree, "skills/bar")).toBe("skills/bar/SKILL.md");
    expect(skillMdIn(tree, "skills/baz")).toBeUndefined();
    expect(skillMdIn(tree, "skills")).toBeUndefined();
  });

  it("digests the files a Skill installs and nothing else, whatever the order of the tree", async () => {
    const files = [
      blob("skills/foo/SKILL.md"),
      blob("skills/foo/references/a.md"),
      blob("skills/foo/metadata.json"),
    ];

    const hash = await folderHashOf({ tree: files }, "skills/foo/SKILL.md");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await folderHashOf({ tree: files.toReversed() }, "skills/foo/SKILL.md")).toBe(hash);
    // Another file of the repo, or one an install leaves out, does not move it.
    expect(
      await folderHashOf(
        {
          tree: [
            ...files,
            blob("README.md"),
            blob("skills/foo/.git/HEAD"),
            { ...blob("skills/foo/metadata.json"), sha: "other" },
          ],
        },
        "skills/foo/SKILL.md",
      ),
    ).toBe(hash);
    // A file of the Skill that changed, or one it gained, does.

    const changed = files.map((entry) =>
      entry.path.endsWith("a.md") ? { ...entry, sha: "new" } : entry,
    );

    expect(await folderHashOf({ tree: changed }, "skills/foo/SKILL.md")).not.toBe(hash);
    expect(
      await folderHashOf({ tree: [...files, blob("skills/foo/more.md")] }, "skills/foo/SKILL.md"),
    ).not.toBe(hash);
  });

  it("takes only the SKILL.md of a Skill at the repo's root (the CLI's root-level rule)", () => {
    const tree = {
      tree: [blob("SKILL.md"), blob("packages/eve/src/index.ts"), blob("docs/introduction.mdx")],
    };

    expect(skillFilesIn(tree, "SKILL.md").map((entry) => entry.relative)).toEqual(["SKILL.md"]);
  });
});
