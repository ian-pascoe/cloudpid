// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- fakes of `fetch` and the Registry over native arrays.
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { fetchSkills, fetchSkillsAt, GithubReadError, type RepoReader } from "./skill-fetch.ts";
import { parseSkillSource } from "./skill-source.ts";

const COMMIT = "c0ffee0000000000000000000000000000000001";

const skillMd = (name: string, description = `${name} does a thing`, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

type Repo = Readonly<Record<string, string | Uint8Array>>;

/** A reader over `files`: the repo's tree at `COMMIT`, each blob's sha its path. Counts the blobs it reads. */
const readerOf = (files: Repo, options: { truncated?: boolean } = {}) => {
  const reads: string[] = [];
  const asked: Array<string | null> = [];

  const bytesOf = (value: string | Uint8Array) =>
    Predicate.isString(value) ? new TextEncoder().encode(value) : value;

  const listing = () => ({
    truncated: options.truncated ?? false,
    entries: Object.entries(files).map(([path, value]) => ({
      path,
      type: "blob" as const,
      sha: path,
      size: bytesOf(value).length,
    })),
  });

  const reader: RepoReader = {
    commit: async (_repo, ref) => {
      asked.push(ref);

      return COMMIT;
    },
    tree: async () => listing(),
    headTree: async () => listing(),
    blob: async (_repo, sha) => {
      reads.push(sha);

      const value = files[sha];

      if (value === undefined) throw GithubReadError.of("failed", `no blob ${sha}`);

      return bytesOf(value);
    },
  };

  return { reader, reads, asked };
};

const source = (input: string) => {
  const parsed = parseSkillSource(input);

  if (!parsed.ok) throw new Error(parsed.message);

  return parsed.source;
};

const REPO = {
  "README.md": "# skills",
  "skills/grill-me/SKILL.md": skillMd("grill-me", "Interview me relentlessly"),
  "skills/grill-me/references/questions.md": "- why?",
  "skills/grill-me/metadata.json": "{}",
  "skills/tdd/SKILL.md": skillMd("tdd"),
  "skills/tdd/tests.md": "tests",
} satisfies Repo;

describe("fetchSkills", () => {
  it("installs the Skill a source names with @, pinned to the commit its ref resolved to", async () => {
    const { reader, reads, asked } = readerOf(REPO);

    const result = await fetchSkills(reader, { source: source("o/skills@grill-me") });

    expect(result).toEqual({
      status: "fetched",
      repo: "o/skills",
      ref: null,
      commit: COMMIT,
      skills: [
        {
          name: "grill-me",
          description: "Interview me relentlessly",
          path: "skills/grill-me",
          files: {
            "SKILL.md": REPO["skills/grill-me/SKILL.md"],
            "references/questions.md": "- why?",
          },
          folderHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
      skipped: [],
    });

    // The default branch was asked for, and only the named Skill's files were read: not tdd's.
    expect(asked).toEqual([null]);
    expect(reads.sort()).toEqual([
      "skills/grill-me/SKILL.md",
      "skills/grill-me/references/questions.md",
    ]);
  });

  it("names the ref the source gave, and reads that ref's commit", async () => {
    const { reader, asked } = readerOf(REPO);

    const result = await fetchSkills(reader, {
      source: source("https://github.com/o/skills/tree/v2/skills"),
      skills: ["tdd"],
    });

    expect(asked).toEqual(["v2"]);
    expect(result).toMatchObject({ status: "fetched", ref: "v2", commit: COMMIT });
  });

  it("lists the Skills of a repo that holds several when none is named, reading no file but their SKILL.md", async () => {
    const { reader, reads } = readerOf(REPO);

    const result = await fetchSkills(reader, { source: source("o/skills") });

    expect(result).toEqual({
      status: "listed",
      repo: "o/skills",
      ref: null,
      commit: COMMIT,
      available: [
        { name: "grill-me", description: "Interview me relentlessly", path: "skills/grill-me" },
        { name: "tdd", description: "tdd does a thing", path: "skills/tdd" },
      ],
    });

    expect(reads.sort()).toEqual(["skills/grill-me/SKILL.md", "skills/tdd/SKILL.md"]);
  });

  it("installs the only Skill of a repo that holds one", async () => {
    const { reader } = readerOf({
      "skills/only/SKILL.md": skillMd("only"),
    });

    const result = await fetchSkills(reader, { source: source("o/one") });

    expect(result).toMatchObject({ status: "fetched", skills: [{ name: "only" }] });
  });

  it('installs every Skill for ["*"], and the ones named in skills and after @ together', async () => {
    const everything = await fetchSkills(readerOf(REPO).reader, {
      source: source("o/skills"),
      skills: ["*"],
    });

    expect(everything).toMatchObject({
      status: "fetched",
      skills: [{ name: "grill-me" }, { name: "tdd" }],
    });

    const both = await fetchSkills(readerOf(REPO).reader, {
      source: source("o/skills@tdd"),
      skills: ["grill-me"],
    });

    expect(both).toMatchObject({
      status: "fetched",
      skills: [{ name: "grill-me" }, { name: "tdd" }],
    });
  });

  it("matches a name by the SKILL.md's name, its folder, or their slug, in any case", async () => {
    const files = {
      "skills/the-folder/SKILL.md": skillMd("declared-name"),
      "skills/other/SKILL.md": skillMd("other"),
    } satisfies Repo;

    for (const asked of ["declared-name", "Declared-Name", "the_folder", "The Folder"]) {
      const result = await fetchSkills(readerOf(files).reader, {
        source: source("o/r"),
        skills: [asked],
      });

      expect(result, asked).toMatchObject({
        status: "fetched",
        skills: [{ name: "declared-name" }],
      });
    }
  });

  it("fails naming the Skills the repo holds when one asked for is not in it, installing none", async () => {
    const result = await fetchSkills(readerOf(REPO).reader, {
      source: source("o/skills"),
      skills: ["tdd", "nope"],
    });

    expect(result).toEqual({
      status: "failed",
      kind: "no_match",
      message: 'o/skills has no Skill named "nope". It holds: grill-me, tdd.',
    });
  });

  it("fails when the repo, or the path in it, holds no SKILL.md", async () => {
    const none = await fetchSkills(readerOf({ "README.md": "x" }).reader, {
      source: source("o/r"),
    });

    expect(none).toMatchObject({ status: "failed", kind: "no_skills" });

    const below = await fetchSkills(readerOf(REPO).reader, {
      source: source("https://github.com/o/skills/tree/main/docs"),
    });

    expect(below).toMatchObject({
      status: "failed",
      kind: "no_skills",
      message: expect.stringContaining("o/skills under docs"),
    });
  });

  it("looks only under the folder a tree URL names", async () => {
    const result = await fetchSkills(readerOf(REPO).reader, {
      source: source("https://github.com/o/skills/tree/main/skills/tdd"),
    });

    expect(result).toMatchObject({
      status: "fetched",
      skills: [{ name: "tdd", path: "skills/tdd" }],
    });
  });

  it("takes only the SKILL.md of a Skill at the repo's root, and a skill.md in another case as SKILL.md", async () => {
    const result = await fetchSkills(
      readerOf({
        "skill.md": skillMd("eve"),
        "packages/eve/src/index.ts": "export {}",
        "docs/intro.mdx": "# intro",
      }).reader,
      { source: source("o/eve") },
    );

    expect(result).toMatchObject({
      status: "fetched",
      skills: [{ name: "eve", path: "", files: { "SKILL.md": skillMd("eve") } }],
    });

    if (result.status === "fetched")
      expect(Object.keys(result.skills[0]?.files ?? {})).toEqual(["SKILL.md"]);
  });

  it("leaves out a Skill a repo marks internal unless it is named, as the CLI does", async () => {
    const files = {
      "skills/public/SKILL.md": skillMd("public"),
      "skills/hidden/SKILL.md": skillMd("hidden", "internal", "metadata:\n  internal: true\n"),
    } satisfies Repo;

    const listed = await fetchSkills(readerOf(files).reader, { source: source("o/r") });

    expect(listed).toMatchObject({ status: "fetched", skills: [{ name: "public" }] });

    const everything = await fetchSkills(readerOf(files).reader, {
      source: source("o/r"),
      skills: ["*"],
    });

    expect(everything).toMatchObject({ status: "fetched", skills: [{ name: "public" }] });

    const named = await fetchSkills(readerOf(files).reader, {
      source: source("o/r@hidden"),
    });

    expect(named).toMatchObject({ status: "fetched", skills: [{ name: "hidden" }] });
  });

  it("skips a SKILL.md that declares no name or description, and says so", async () => {
    const files = {
      "skills/good/SKILL.md": skillMd("good"),
      "skills/bad/SKILL.md": "no frontmatter at all",
    } satisfies Repo;

    const result = await fetchSkills(readerOf(files).reader, {
      source: source("o/r"),
      skills: ["*"],
    });

    expect(result).toMatchObject({
      status: "fetched",
      skills: [{ name: "good" }],
      skipped: [
        { path: "skills/bad", message: expect.stringContaining("no name or no description") },
      ],
    });
  });

  it("reports a SKILL.md that cannot be read only when every Skill was asked for or the named one is it", async () => {
    const files = {
      "skills/good/SKILL.md": skillMd("good"),
      "skills/other/SKILL.md": skillMd("other"),
      "skills/bad/SKILL.md": "no frontmatter at all",
    } satisfies Repo;

    const { reader } = readerOf(files);

    // A Skill named is installed alone: the unreadable one is not its business.
    expect(await fetchSkills(reader, { source: source("o/r@good") })).toMatchObject({
      status: "fetched",
      skills: [{ name: "good" }],
      skipped: [],
    });

    const named = await fetchSkills(reader, { source: source("o/r@bad") });

    expect(named).toMatchObject({ status: "failed", kind: "no_match" });
    expect(named.status === "failed" ? named.message : "").toContain("Not readable as Skills");

    // The list of a repo's Skills holds those that can be installed.
    expect(await fetchSkills(reader, { source: source("o/r") })).toMatchObject({
      status: "listed",
      available: [{ name: "good" }, { name: "other" }],
    });
  });

  it("skips a Skill with a file the checks refuse, before reading it when its size is in the tree", async () => {
    const big = "x".repeat(128 * 1024 + 1);

    const files = {
      "skills/big/SKILL.md": skillMd("big"),
      "skills/big/huge.md": big,
      "skills/binary/SKILL.md": skillMd("binary"),
      "skills/binary/logo.png": new Uint8Array([137, 80, 78, 71, 0, 1, 2]),
      "skills/fine/SKILL.md": skillMd("fine"),
    } satisfies Repo;

    const { reader, reads } = readerOf(files);
    const result = await fetchSkills(reader, { source: source("o/r"), skills: ["*"] });

    expect(result).toMatchObject({
      status: "fetched",
      skills: [{ name: "fine" }],
      skipped: [
        { name: "big", message: expect.stringContaining("huge.md: 131073 bytes") },
        { name: "binary", message: expect.stringContaining("a binary file") },
      ],
    });

    expect(reads).not.toContain("skills/big/huge.md");
  });

  it("skips a Skill whose files together are over 1 MB", async () => {
    const chunk = "y".repeat(100 * 1024);

    const files = {
      "skills/many/SKILL.md": skillMd("many"),
      ...Object.fromEntries(
        Array.from({ length: 11 }, (_, at) => [`skills/many/part-${at}.md`, chunk]),
      ),
    };

    const result = await fetchSkills(readerOf(files).reader, { source: source("o/r") });

    expect(result).toMatchObject({
      status: "fetched",
      skills: [],
      skipped: [
        { name: "many", message: expect.stringContaining("together, more than the 1048576") },
      ],
    });
  });

  it("takes the first of two folders that declare one name", async () => {
    const files = {
      "skills/a/SKILL.md": skillMd("same"),
      "skills/b/SKILL.md": skillMd("same"),
    } satisfies Repo;

    const result = await fetchSkills(readerOf(files).reader, {
      source: source("o/r"),
      skills: ["*"],
    });

    expect(result).toMatchObject({
      status: "fetched",
      skills: [{ name: "same", path: "skills/a" }],
      skipped: [
        { path: "skills/b", message: expect.stringContaining("taken from the repo already") },
      ],
    });
  });

  it("fails clearly when GitHub truncated the tree, and passes a reader's failure on", async () => {
    const truncated = await fetchSkills(readerOf(REPO, { truncated: true }).reader, {
      source: source("o/big"),
    });

    expect(truncated).toMatchObject({
      status: "failed",
      kind: "truncated",
      message: expect.stringContaining("only part of o/big's files"),
    });

    const notFound = await fetchSkills(
      {
        commit: async () => {
          throw GithubReadError.of("not_found", "GitHub has no repo o/gone");
        },
        tree: async () => ({ entries: [], truncated: false }),
        headTree: async () => ({ entries: [], truncated: false }),
        blob: async () => new Uint8Array(),
      },
      { source: source("o/gone") },
    );

    expect(notFound).toEqual({
      status: "failed",
      kind: "not_found",
      message: "GitHub has no repo o/gone",
    });
  });

  it("lets a failure that is no GitHub's, a bug, surface instead of reporting it as one", async () => {
    const bug = fetchSkills(
      {
        commit: async () => {
          throw new TypeError("boom");
        },
        tree: async () => ({ entries: [], truncated: false }),
        headTree: async () => ({ entries: [], truncated: false }),
        blob: async () => new Uint8Array(),
      },
      { source: source("o/r") },
    );

    await expect(bug).rejects.toThrow("boom");
  });
});

describe("fetchSkillsAt", () => {
  const repo = { owner: "o", name: "skills" };

  it("reads installed Skills again at one commit, with one commit and one tree for all of them", async () => {
    const { reader, reads, asked } = readerOf(REPO);

    const result = await fetchSkillsAt(reader, {
      repo,
      ref: "v2",
      folders: ["skills/grill-me", "skills/tdd"],
    });

    expect(asked).toEqual(["v2"]);
    expect(result).toEqual({
      status: "fetched",
      commit: COMMIT,
      skills: [
        {
          ok: true,
          name: "grill-me",
          description: "Interview me relentlessly",
          files: {
            "SKILL.md": REPO["skills/grill-me/SKILL.md"],
            "references/questions.md": "- why?",
          },
          folderHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        expect.objectContaining({ ok: true, name: "tdd", files: expect.any(Object) }),
      ],
    });

    // metadata.json is left out, as an install leaves it.
    expect(reads).not.toContain("skills/grill-me/metadata.json");
  });

  it("tells, for a Skill, that its folder lost its SKILL.md or its name, and still reads the others", async () => {
    const { reader } = readerOf({
      "skills/gone/notes.md": "x",
      "skills/nameless/SKILL.md": "---\ndescription: d\n---\n",
      "skills/fine/SKILL.md": skillMd("fine"),
    });

    const result = await fetchSkillsAt(reader, {
      repo,
      ref: null,
      folders: ["skills/gone", "skills/nameless", "skills/fine"],
    });

    expect(result).toMatchObject({
      status: "fetched",
      skills: [
        { ok: false, message: expect.stringContaining("holds no SKILL.md") },
        { ok: false, message: expect.stringContaining("sets no name or no description") },
        { ok: true, name: "fine" },
      ],
    });
  });

  it("fails when GitHub lists only part of the repo, or cannot be read", async () => {
    const cut = readerOf(REPO, { truncated: true });

    expect(
      await fetchSkillsAt(cut.reader, { repo, ref: null, folders: ["skills/tdd"] }),
    ).toMatchObject({
      status: "failed",
      kind: "truncated",
    });

    const { reader } = readerOf(REPO);

    const limited: RepoReader = {
      ...reader,
      commit: async () => {
        throw GithubReadError.of("rate_limited", "GitHub's rate limit is used up.");
      },
    };

    expect(await fetchSkillsAt(limited, { repo, ref: null, folders: ["skills/tdd"] })).toEqual({
      status: "failed",
      kind: "rate_limited",
      message: "GitHub's rate limit is used up.",
    });
  });
});
