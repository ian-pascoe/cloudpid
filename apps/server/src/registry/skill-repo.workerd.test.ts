// The repo page's listing over a fake GitHub and the Worker's real Cache API (ADR-0026, `docs/architecture/workspace.md` →
// _The Skill directory_): every Skill the install's walk finds with the name and description of its SKILL.md, at the default
// branch or a ref; each SKILL.md read from GitHub once per blob; a private repo the GitHub App can read, and the ways a repo
// cannot be listed told apart. workerd's Cache API is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off preferEffectRecord:off missedPipeableOpportunity:off instanceOfSchema:off -- a fake of GitHub over native arrays.
import { SkillRepoError } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { githubContents } from "../github/contents.ts";
import { fakeGithub, skillMd } from "../github/skill-repo.fixture.ts";
import { fetchSkills, GithubReadError } from "../github/skill-fetch.ts";
import type { LeaderboardCache } from "./skill-directory.ts";
import { skillMdKey, skillReposOver } from "./skill-repo.ts";

let cacheNumber = 0;

/** The real Cache API under a name of this test's own, with the keys put in it. */
const realCache = async () => {
  const cache = await caches.open(`skill-repo-${(cacheNumber += 1)}`);
  const puts: string[] = [];

  const store: LeaderboardCache = {
    match: (url) => cache.match(url),
    put: (url, response) => {
      puts.push(url);

      return cache.put(url, response);
    },
  };

  return { store, puts };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = <A>(effect: Effect.Effect<A, SkillRepoError>) => run(Effect.flip(effect));

const REPO = {
  "skills/grill-me/SKILL.md": skillMd("grill-me"),
  "skills/grill-me/references/questions.md": "- why?\n",
  "skills/tdd/SKILL.md": skillMd("tdd"),
  // Not a Skill: no name or description.
  "skills/draft/SKILL.md": "---\ndescription: unnamed\n---\n",
  // The repo marks it internal: an install leaves it out unless it is named.
  "skills/secret/SKILL.md":
    "---\nname: secret\ndescription: Hidden.\nmetadata:\n  internal: true\n---\n",
};

const blobsAsked = (requests: ReadonlyArray<string>) =>
  requests.filter((request) => request.startsWith("blob "));

describe("a repo's Skills", () => {
  it("are every Skill the install's walk finds, each with its description, in a folder of its own", async () => {
    const github = fakeGithub();
    const commit = github.push("o/skills", REPO);
    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });
    const listing = await run(repos.list({ owner: "o", repo: "skills" }));

    expect(listing).toEqual({
      repo: "o/skills",
      ref: null,
      commit,
      skills: [
        {
          name: "grill-me",
          description: "What grill-me does.",
          path: "skills/grill-me",
          skillId: "grill-me",
        },
        { name: "tdd", description: "What tdd does.", path: "skills/tdd", skillId: "tdd" },
      ],
      // The one that is no Skill is said, so a page can explain a repo that looks empty.
      unreadable: [
        {
          path: "skills/draft",
          message: "SKILL.md's frontmatter sets no name or no description, so it is not a Skill",
        },
      ],
      internal: 1,
      omitted: 0,
    });
  });

  it("name a Skill at the repo's root by its own name", async () => {
    const github = fakeGithub();

    github.push("o/one", { "SKILL.md": skillMd("only-one"), "README.md": "hi" });

    const { store } = await realCache();

    const listing = await run(
      skillReposOver({ reader: github.reader, cache: store }).list({ owner: "o", repo: "one" }),
    );

    expect(listing.skills).toEqual([
      { name: "only-one", description: "What only-one does.", path: "", skillId: "only-one" },
    ]);
  });

  it("are none for a repo with no SKILL.md, which is a listing and not a failure", async () => {
    const github = fakeGithub();

    github.push("o/docs", { "README.md": "hi" });

    const { store } = await realCache();

    const listing = await run(
      skillReposOver({ reader: github.reader, cache: store }).list({ owner: "o", repo: "docs" }),
    );

    expect(listing).toMatchObject({ skills: [], unreadable: [], omitted: 0 });
  });

  it("are the first 200 of a repo with more SKILL.md files, the rest counted as unread", async () => {
    const github = fakeGithub();

    github.push(
      "o/many",
      Object.fromEntries(
        Array.from({ length: 205 }, (_, at) => [`skills/s${at}/SKILL.md`, skillMd(`s${at}`)]),
      ),
    );

    const { store } = await realCache();

    github.reset();

    const listing = await run(
      skillReposOver({ reader: github.reader, cache: store }).list({ owner: "o", repo: "many" }),
    );

    expect(listing.skills).toHaveLength(200);
    expect(listing.omitted).toBe(5);
    // Only 200 were read from GitHub.
    expect(blobsAsked(github.requests)).toHaveLength(200);
  });

  it("are read at the ref named: a branch, a tag or a commit", async () => {
    const github = fakeGithub();
    const first = github.push("o/skills", { "skills/a/SKILL.md": skillMd("a") });

    github.push("o/skills", {
      "skills/a/SKILL.md": skillMd("a"),
      "skills/b/SKILL.md": skillMd("b"),
    });
    github.push("o/skills", { "skills/c/SKILL.md": skillMd("c") }, "v1.0");

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    const names = async (ref?: string) =>
      (await run(repos.list({ owner: "o", repo: "skills", ref }))).skills.map(({ name }) => name);

    expect(await names()).toEqual(["a", "b"]);
    expect(await names("v1.0")).toEqual(["c"]);
    expect(await names(first)).toEqual(["a"]);

    const atCommit = await run(repos.list({ owner: "o", repo: "skills", ref: first }));

    expect(atCommit).toMatchObject({ ref: first, commit: first });
    // An empty ref is the default branch.
    expect(await names("")).toEqual(["a", "b"]);
  });
});

describe("a SKILL.md", () => {
  it("is read from GitHub once per blob: another listing, at another ref too, asks for none of them", async () => {
    const github = fakeGithub();

    github.push("o/skills", REPO);
    github.push("o/skills", REPO, "next");

    const { store, puts } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    await run(repos.list({ owner: "o", repo: "skills" }));

    // Four SKILL.md files, the internal and the unreadable ones too: what they say is kept, so nothing is asked again.
    expect(blobsAsked(github.requests)).toHaveLength(4);
    expect(puts).toHaveLength(4);

    github.reset();

    await run(repos.list({ owner: "o", repo: "skills" }));
    await run(repos.list({ owner: "o", repo: "skills", ref: "next" }));

    expect(blobsAsked(github.requests)).toEqual([]);
    // Each listing still asks which commit and tree it reads, which is what says the repo is readable now.
    expect(github.requests.map((request) => request.split(" ")[0])).toEqual([
      "commit",
      "tree",
      "commit",
      "tree",
    ]);
  });

  it("is read again only when its blob changed", async () => {
    const github = fakeGithub();

    github.push("o/skills", REPO);

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    await run(repos.list({ owner: "o", repo: "skills" }));
    github.push("o/skills", { ...REPO, "skills/tdd/SKILL.md": skillMd("tdd", "A new body.") });
    github.reset();

    const listing = await run(repos.list({ owner: "o", repo: "skills" }));

    expect(blobsAsked(github.requests)).toHaveLength(1);
    expect(listing.skills.map(({ name }) => name)).toEqual(["grill-me", "tdd"]);
  });

  it("is kept by repo and blob, with only what it says of its Skill", async () => {
    const github = fakeGithub();

    github.push("O/Skills", { "skills/a/SKILL.md": skillMd("a") });

    const { store, puts } = await realCache();

    await run(
      skillReposOver({ reader: github.reader, cache: store }).list({ owner: "O", repo: "Skills" }),
    );

    expect(puts).toHaveLength(1);
    expect(puts[0]).toBe(
      skillMdKey({ owner: "o", name: "skills" }, puts[0]?.split("/").at(-1) ?? ""),
    );

    const hit = await store.match(puts[0] ?? "");

    expect(await hit?.json()).toEqual({
      ok: true,
      name: "a",
      description: "What a does.",
      internal: false,
    });
    expect(hit?.headers.get("cache-control")).toBe("public, max-age=2592000");
  });

  it("is read from GitHub when the cache cannot be read or written to", async () => {
    const github = fakeGithub();

    github.push("o/skills", { "skills/a/SKILL.md": skillMd("a") });

    const broken: LeaderboardCache = {
      match: () => Promise.reject(new Error("cache is down")),
      put: () => Promise.reject(new Error("cache is down")),
    };

    const listing = await run(
      skillReposOver({ reader: github.reader, cache: broken }).list({ owner: "o", repo: "skills" }),
    );

    expect(listing.skills.map(({ name }) => name)).toEqual(["a"]);
  });

  it("of a repo is not served to a listing the GitHub App cannot make", async () => {
    const github = fakeGithub();

    github.push("o/skills", { "skills/a/SKILL.md": skillMd("a") });

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    await run(repos.list({ owner: "o", repo: "skills" }));
    github.fail("o/skills", GithubReadError.of("not_found", "GitHub has no repo o/skills"));

    expect(await failure(repos.list({ owner: "o", repo: "skills" }))).toMatchObject({
      kind: "not_found",
    });
  });
});

describe("a repo that cannot be listed", () => {
  it("is told as not found when GitHub has none or the app cannot read it", async () => {
    const github = fakeGithub();
    const { store } = await realCache();

    const error = await failure(
      skillReposOver({ reader: github.reader, cache: store }).list({ owner: "o", repo: "nope" }),
    );

    expect(error).toBeInstanceOf(SkillRepoError);
    expect(error.kind).toBe("not_found");
  });

  it("is told as a ref the repo does not have when its default branch can be read", async () => {
    const github = fakeGithub();

    github.push("o/skills", { "skills/a/SKILL.md": skillMd("a") });

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });
    const error = await failure(repos.list({ owner: "o", repo: "skills", ref: "nope" }));

    expect(error.kind).toBe("bad_ref");
    expect(error.message).toBe('o/skills has no ref "nope" (a branch, a tag or a commit).');
    // A ref of a repo that is not there is the repo's failure, not the ref's.
    expect((await failure(repos.list({ owner: "o", repo: "nope", ref: "nope" }))).kind).toBe(
      "not_found",
    );
  });

  it("is told by what GitHub says: the rate limit, a refused token, a failure, a tree too large", async () => {
    const github = fakeGithub();
    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    github.push("o/skills", REPO);

    for (const kind of ["rate_limited", "refused", "failed"] as const) {
      github.fail("o/skills", GithubReadError.of(kind, `GitHub said ${kind}`));

      expect(await failure(repos.list({ owner: "o", repo: "skills" }))).toMatchObject({
        kind,
        message: `GitHub said ${kind}`,
      });
    }

    github.fail("o/skills", undefined);

    const truncated = skillReposOver({
      reader: { ...github.reader, tree: async () => ({ entries: [], truncated: true }) },
      cache: store,
    });

    expect(await failure(truncated.list({ owner: "o", repo: "skills" }))).toMatchObject({
      kind: "truncated",
    });
  });

  it("is refused before GitHub is asked when its owner, repo or ref cannot be GitHub's", async () => {
    const github = fakeGithub();
    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    for (const ask of [
      { owner: "o", repo: ".." },
      { owner: "o", repo: "skills@tdd" },
      { owner: "a/b", repo: "skills" },
      { owner: "o", repo: "skills", ref: ".." },
      { owner: "o", repo: "skills", ref: "a//b" },
      { owner: "", repo: "skills" },
    ]) {
      expect((await failure(repos.list(ask))).kind, JSON.stringify(ask)).toBe("invalid");
    }

    expect(github.requests).toEqual([]);
  });
});

/**
 * GitHub's REST API for one private repo of `acme`: it answers a request that carries the GitHub App's token for `acme`, and
 * a 404 (as GitHub answers a private repo to anyone else) any other.
 */
const privateGithub = (files: Record<string, string>) => {
  const commit = "c".repeat(40);
  const names = Object.keys(files);
  const shaOf = (at: number) => at.toString(16).padStart(40, "a");
  const seen: Array<{ path: string; authorization: string | null }> = [];

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    const authorization = new Headers(init.headers).get("authorization");

    seen.push({ path: pathname, authorization });

    if (authorization !== "Bearer token-for-acme") {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }

    if (pathname === "/repos/acme/secret-skills/commits/HEAD") return new Response(commit);

    if (pathname === `/repos/acme/secret-skills/git/trees/${commit}`) {
      return new Response(
        JSON.stringify({
          sha: commit,
          truncated: false,
          tree: names.map((path, at) => ({
            path,
            type: "blob",
            sha: shaOf(at),
            size: files[path]?.length ?? 0,
          })),
        }),
      );
    }

    const blob = names.findIndex((_, at) => pathname.endsWith(`/git/blobs/${shaOf(at)}`));
    const name = names[blob];

    return name === undefined ? new Response("{}", { status: 404 }) : new Response(files[name]);
  };

  return { fetch, seen };
};

describe("a private repo", () => {
  /** The listing as the GitHub App with `installed` owners' installations makes it. */
  const listingAs = async (
    installed: ReadonlyArray<string>,
    github: ReturnType<typeof privateGithub>,
  ) => {
    const { store } = await realCache();

    const reader = githubContents({
      fetch: github.fetch,
      github: {
        token: async (account) => {
          if (account === undefined) return "token-for-the-app-owner";

          if (!installed.includes(account)) {
            throw new Error(`The GitHub App is not installed on ${account}`);
          }

          return `token-for-${account}`;
        },
        invalidate: () => undefined,
      },
    });

    return skillReposOver({ reader, cache: store }).list({ owner: "acme", repo: "secret-skills" });
  };

  it("is listed when the GitHub App is installed on its owner, with a read-only token that stays in the Worker", async () => {
    const github = privateGithub({ "skills/ours/SKILL.md": skillMd("ours") });

    const listing = await run(
      Effect.promise(() => listingAs(["acme"], github)).pipe(Effect.flatMap((effect) => effect)),
    );

    expect(listing.skills.map(({ name }) => name)).toEqual(["ours"]);
    expect(
      github.seen.every(({ authorization }) => authorization === "Bearer token-for-acme"),
    ).toBe(true);
  });

  it("is not found, as a repo that does not exist is, when the app cannot read it: GitHub answers both with a 404", async () => {
    const github = privateGithub({ "skills/ours/SKILL.md": skillMd("ours") });

    const error = await failure(
      Effect.promise(() => listingAs([], github)).pipe(Effect.flatMap((effect) => effect)),
    );

    expect(error.kind).toBe("not_found");
    expect(error.message).toContain("private and the GitHub App is not installed on acme");
  });
});

describe("a Skill's page", () => {
  const found = <A extends { readonly status: string }>(viewed: A) => {
    if (viewed.status !== "found") throw new Error(`not found: ${viewed.status}`);

    // SAFETY: the status was just checked to be `found`.
    return viewed as Extract<A, { status: "found" }>;
  };

  const viewIn = async (
    github: ReturnType<typeof fakeGithub>,
    ask: { skill: string; path?: string; ref?: string | undefined; repo?: string },
  ) => {
    const { store } = await realCache();
    const { repo = "skills", ...rest } = ask;

    return run(
      skillReposOver({ reader: github.reader, cache: store }).view({ owner: "o", repo, ...rest }),
    );
  };

  it("has its SKILL.md as it is at the commit and the files an install takes, SKILL.md first", async () => {
    const github = fakeGithub();

    const commit = github.push("o/skills", {
      ...REPO,
      "skills/grill-me/scripts/run.sh": "echo hi\n",
      // What an install leaves out of a Skill's folder.
      "skills/grill-me/metadata.json": "{}",
      "skills/grill-me/.git/config": "x",
      "skills/grill-me/__pycache__/a.pyc": "x",
    });

    const { skill } = found(await viewIn(github, { skill: "grill-me" }));

    expect(skill).toEqual({
      repo: "o/skills",
      ref: null,
      commit,
      name: "grill-me",
      description: "What grill-me does.",
      path: "skills/grill-me",
      skillId: "grill-me",
      skillMd: skillMd("grill-me"),
      skillMdFile: "SKILL.md",
      files: [
        { path: "SKILL.md", size: skillMd("grill-me").length },
        { path: "references/questions.md", size: 7 },
        { path: "scripts/run.sh", size: 8 },
      ],
    });
  });

  it("lists the very files an install of the Skill takes", async () => {
    const github = fakeGithub();

    github.push("o/skills", {
      ...REPO,
      "skills/tdd/a/b.md": "b",
      "skills/tdd/metadata.json": "{}",
      "skills/tdd/.git/HEAD": "x",
    });

    const fetched = await fetchSkills(github.reader, {
      source: { owner: "o", name: "skills", repo: "o/skills", ref: null, path: "", skill: null },
      skills: ["tdd"],
    });

    const { skill } = found(await viewIn(github, { skill: "tdd" }));

    if (fetched.status !== "fetched") throw new Error("not fetched");

    expect(skill.files.map(({ path }) => path).toSorted()).toEqual(
      Object.keys(fetched.skills[0]?.files ?? {}).toSorted(),
    );
    expect(skill.skillMd).toBe(fetched.skills[0]?.files["SKILL.md"]);
    expect(skill.commit).toBe(fetched.commit);
  });

  it("is a Skill at the repo's root by its own name, with its SKILL.md alone (the rest of the repo is not the Skill's), in any case of file name", async () => {
    const github = fakeGithub();

    github.push("o/one", { "skill.md": skillMd("only-one"), "README.md": "hi", "src/a.ts": "x" });

    const { skill } = found(await viewIn(github, { repo: "one", skill: "only-one" }));

    expect(skill).toMatchObject({
      name: "only-one",
      path: "",
      skillId: "only-one",
      // The file is `skill.md` on GitHub, and the page links it by that name.
      skillMdFile: "skill.md",
    });
    expect(skill.files).toEqual([{ path: "SKILL.md", size: skillMd("only-one").length }]);
  });

  it("is found by the name its SKILL.md gives in any case, else by its folder's name, and by its folder with a path", async () => {
    const github = fakeGithub();

    github.push("o/skills", {
      "skills/grill/SKILL.md": skillMd("Grill Me"),
      "skills/other/SKILL.md": skillMd("other"),
    });

    expect(found(await viewIn(github, { skill: "grill me" })).skill.path).toBe("skills/grill");
    expect(found(await viewIn(github, { skill: "Grill-Me" })).skill.path).toBe("skills/grill");
    // No Skill is named grill, but a folder is.
    expect(found(await viewIn(github, { skill: "grill" })).skill.name).toBe("Grill Me");
    expect(found(await viewIn(github, { skill: "x", path: "skills/other" })).skill.name).toBe(
      "other",
    );
  });

  it("is an internal Skill too, as an install by name takes it, but is not in the listing", async () => {
    const github = fakeGithub();

    github.push("o/skills", REPO);

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    expect(
      found(await run(repos.view({ owner: "o", repo: "skills", skill: "secret" }))).skill.name,
    ).toBe("secret");
    expect(
      (await run(repos.list({ owner: "o", repo: "skills" }))).skills.map((s) => s.name),
    ).toEqual(["grill-me", "tdd"]);
  });

  it("is told apart when several Skills answer to a name, until a folder names one", async () => {
    const github = fakeGithub();

    github.push("o/skills", {
      "skills/a/twin/SKILL.md": skillMd("twin", "One."),
      "skills/b/twin/SKILL.md": skillMd("twin", "Two."),
      "skills/c/SKILL.md": skillMd("c"),
    });

    const twins = await viewIn(github, { skill: "twin" });

    expect(twins).toMatchObject({
      status: "ambiguous",
      repo: "o/skills",
      candidates: [
        { name: "twin", path: "skills/a/twin" },
        { name: "twin", path: "skills/b/twin" },
      ],
    });

    const second = found(await viewIn(github, { skill: "twin", path: "skills/b/twin" }));

    expect(second.skill.skillMd).toContain("Two.");
  });

  it("is read at the ref named, with the commit it was read at", async () => {
    const github = fakeGithub();
    const first = github.push("o/skills", { "skills/a/SKILL.md": skillMd("a", "Old.") });

    github.push("o/skills", { "skills/a/SKILL.md": skillMd("a", "New.") });
    github.push("o/skills", { "skills/a/SKILL.md": skillMd("a", "Tagged.") }, "v1.0");

    const read = async (ref?: string) => found(await viewIn(github, { skill: "a", ref })).skill;

    expect((await read()).skillMd).toContain("New.");
    expect((await read("v1.0")).skillMd).toContain("Tagged.");
    expect(await read(first)).toMatchObject({ commit: first, ref: first });
    expect((await read(first)).skillMd).toContain("Old.");
  });

  it("reads, as an install does, the SKILL.md of the folders named so alone when there are any, and none of the Skill's other files", async () => {
    const github = fakeGithub();

    github.push("o/skills", REPO);
    github.reset();

    const { store, puts } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    await run(repos.view({ owner: "o", repo: "skills", skill: "tdd" }));

    // Only the SKILL.md of the folder named tdd: it is read to tell what it says (kept by blob), and is the text shown.
    expect(blobsAsked(github.requests)).toHaveLength(1);
    expect(puts).toHaveLength(1);

    github.reset();
    await run(repos.view({ owner: "o", repo: "skills", skill: "tdd" }));

    // Only the text of the SKILL.md shown is read again.
    expect(blobsAsked(github.requests)).toHaveLength(1);
  });

  it("reads each SKILL.md once to tell what it says when no folder is named as the Skill is", async () => {
    const github = fakeGithub();

    github.push("o/skills", { ...REPO, "skills/zz/SKILL.md": skillMd("Zed") });
    github.reset();

    const { store, puts } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    await run(repos.view({ owner: "o", repo: "skills", skill: "zed" }));

    // Five SKILL.md files, each read once (kept by blob); the one shown is among them.
    expect(blobsAsked(github.requests)).toHaveLength(5);
    expect(puts).toHaveLength(5);
  });

  it("is the Skill an install by the same name takes, whichever of several answers: the folder named so first", async () => {
    const github = fakeGithub();

    // `tdd` is the folder of one Skill and the name of another.
    github.push("o/skills", {
      "a/tdd/SKILL.md": skillMd("test-driven"),
      "b/x/SKILL.md": skillMd("tdd"),
    });

    const fetched = await fetchSkills(github.reader, {
      source: { owner: "o", name: "skills", repo: "o/skills", ref: null, path: "", skill: null },
      skills: ["tdd"],
    });

    const viewed = found(await viewIn(github, { skill: "tdd" })).skill;

    if (fetched.status !== "fetched") throw new Error("not fetched");

    expect(fetched.skills.map(({ path }) => path)).toEqual(["a/tdd"]);
    expect(viewed.path).toBe("a/tdd");
    expect(viewed.name).toBe("test-driven");
  });

  it("is told apart from the others of its name by the page where an install takes the first", async () => {
    const github = fakeGithub();

    // No folder is called `dup`, so the walk is read, and two Skills are named so.
    github.push("o/skills", {
      "a/one/SKILL.md": skillMd("dup"),
      "b/two/SKILL.md": skillMd("Dup"),
    });

    const fetched = await fetchSkills(github.reader, {
      source: { owner: "o", name: "skills", repo: "o/skills", ref: null, path: "", skill: null },
      skills: ["dup"],
    });

    if (fetched.status !== "fetched") throw new Error("not fetched");

    expect(fetched.skills.map(({ path }) => path)).toEqual(["a/one"]);
    expect(await viewIn(github, { skill: "dup" })).toMatchObject({
      status: "ambiguous",
      candidates: [{ path: "a/one" }, { path: "b/two" }],
    });
  });

  it("is refused as too many when a name could be any of more than 200 SKILL.md files and no folder is named so, as an install is", async () => {
    const github = fakeGithub();

    github.push(
      "o/many",
      Object.fromEntries(
        Array.from({ length: 201 }, (_, at) => [`skills/s${at}/SKILL.md`, skillMd(`s${at}`)]),
      ),
    );
    github.reset();

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });
    const refused = await failure(repos.view({ owner: "o", repo: "many", skill: "other" }));

    expect(refused.kind).toBe("too_many");
    expect(refused.message).toContain("201 SKILL.md files");
    // Nothing was read to say so.
    expect(blobsAsked(github.requests)).toHaveLength(0);
  });

  it("is found in a repo of more than 200 SKILL.md files when its folder is named so, or when a folder says which", async () => {
    const github = fakeGithub();

    github.push("o/many", {
      ...Object.fromEntries(
        Array.from({ length: 250 }, (_, at) => [`skills/s${at}/SKILL.md`, skillMd(`s${at}`)]),
      ),
      // Past the first 200 of the walk.
      "skills/zlast/SKILL.md": skillMd("last-one"),
    });

    expect(found(await viewIn(github, { repo: "many", skill: "zlast" })).skill.name).toBe(
      "last-one",
    );

    expect(
      found(await viewIn(github, { repo: "many", skill: "anything", path: "skills/s240" })).skill
        .name,
    ).toBe("s240");
  });

  it("is told when an install would refuse it for its size, with its files still listed", async () => {
    const github = fakeGithub();

    github.push("o/big", {
      "skills/big/SKILL.md": skillMd("big"),
      "skills/big/huge.txt": "x".repeat(1536 * 1024 + 1),
    });

    const { skill } = found(await viewIn(github, { repo: "big", skill: "big" }));

    expect(skill.refused).toContain("huge.txt");
    expect(skill.files.map(({ path }) => path)).toEqual(["SKILL.md", "huge.txt"]);
  });

  it("is not found when the repo is readable and holds no such Skill, nor a Skill in the folder", async () => {
    const github = fakeGithub();

    github.push("o/skills", REPO);

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    const none = await failure(repos.view({ owner: "o", repo: "skills", skill: "nope" }));

    const noFolder = await failure(
      repos.view({ owner: "o", repo: "skills", skill: "tdd", path: "docs" }),
    );

    const noSkill = await failure(
      repos.view({ owner: "o", repo: "skills", skill: "draft", path: "skills/draft" }),
    );

    expect(none).toBeInstanceOf(SkillRepoError);
    expect(none.kind).toBe("no_skill");
    expect(none.message).toContain('no Skill named "nope"');
    expect(noFolder.kind).toBe("no_skill");
    expect(noSkill.kind).toBe("no_skill");
    expect(noSkill.message).toContain("is no Skill");
  });

  it("fails as a listing does: not found, a ref the repo lacks, GitHub's own failures, names GitHub cannot have", async () => {
    const github = fakeGithub();

    github.push("o/skills", REPO);

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    expect((await failure(repos.view({ owner: "o", repo: "nope", skill: "tdd" }))).kind).toBe(
      "not_found",
    );
    expect(
      (await failure(repos.view({ owner: "o", repo: "skills", skill: "tdd", ref: "nope" }))).kind,
    ).toBe("bad_ref");

    github.fail("o/skills", GithubReadError.of("rate_limited", "GitHub said rate_limited"));

    expect(await failure(repos.view({ owner: "o", repo: "skills", skill: "tdd" }))).toMatchObject({
      kind: "rate_limited",
      message: "GitHub said rate_limited",
    });

    github.fail("o/skills", undefined);
    github.reset();

    expect((await failure(repos.view({ owner: "o", repo: "..", skill: "tdd" }))).kind).toBe(
      "invalid",
    );
    expect(github.requests).toEqual([]);

    const truncated = skillReposOver({
      reader: { ...github.reader, tree: async () => ({ entries: [], truncated: true }) },
      cache: store,
    });

    expect((await failure(truncated.view({ owner: "o", repo: "skills", skill: "tdd" }))).kind).toBe(
      "truncated",
    );
  });

  it("is not served when the GitHub App loses access to the repo", async () => {
    const github = fakeGithub();

    github.push("o/skills", REPO);

    const { store } = await realCache();
    const repos = skillReposOver({ reader: github.reader, cache: store });

    await run(repos.view({ owner: "o", repo: "skills", skill: "tdd" }));
    github.fail("o/skills", GithubReadError.of("not_found", "GitHub has no repo o/skills"));

    expect((await failure(repos.view({ owner: "o", repo: "skills", skill: "tdd" }))).kind).toBe(
      "not_found",
    );
  });
});
