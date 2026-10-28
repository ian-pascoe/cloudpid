// An owner's repos from the Skill directory over a fake skills.sh (ADR-0026, `docs/architecture/workspace.md` → _The Skill
// directory_): the Registry asks skills.sh's search for the owner's name, keeps the results whose source is `owner/…` (the
// owner matched without regard to case; forks and look-alikes the fuzzy search also finds are left out) and groups them
// by repo, with each repo's Skills and installs. The samples are what skills.sh answered for `mattpocock`, trimmed.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off missedPipeableOpportunity:off instanceOfSchema:off -- a fake of `fetch` over native arrays.
import { SkillDirectoryError } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { skillDirectoryOver } from "./skill-directory.ts";
import { skillOwnersOver } from "./skill-owner.ts";

const result = (source: string, skillId: string, installs: number) => ({
  id: `${source}/${skillId}`,
  source,
  skillId,
  name: skillId,
  installs,
});

const SAMPLE = {
  query: "mattpocock",
  searchType: "fuzzy",
  searchVersion: "algolia",
  skills: [
    result("mattpocock/skills", "grill-me", 1_449_577),
    // A fork the fuzzy search also finds.
    result("vinvcn/mattpocock-skills-zh-cn", "grill-me", 6_742),
    result("mattpocock/skills", "tdd", 900_000),
    result("MattPocock/ai-hero-cli", "ai-hero", 40),
    result("mattpocock/skills", "grill-with-docs", 1_241_146),
    // A source that is not a repo, and a repo of a look-alike owner.
    result("mattpocock.dev", "blog", 5),
    result("mattpocock-fork/skills", "tdd", 7),
    result("mattpocock/agent-browser", "agent-browser", 2_000),
    // The same Skill listed twice is counted once.
    result("mattpocock/skills", "tdd", 900_000),
  ],
};

const fakeSkillsSh = (answers: Record<string, () => Response>) => {
  const asked: string[] = [];

  // SAFETY: the code under test calls `fetch(url, init)` only, which this answers; a Request normalizes the URL.
  const fetch = ((input: RequestInfo | URL) => {
    const { url } = new Request(input);

    asked.push(url);

    return Promise.resolve(
      answers[url]?.() ?? new Response('{"error":"Not found"}', { status: 404 }),
    );
  }) as typeof globalThis.fetch;

  return { fetch, asked };
};

const json =
  (body: Schema.Json, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const owners = (answers: Record<string, () => Response>) => {
  const skillsSh = fakeSkillsSh(answers);

  const cache = {
    match: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  };

  return {
    ...skillsSh,
    owners: skillOwnersOver(skillDirectoryOver({ cache, fetch: skillsSh.fetch })),
  };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("an owner's repos", () => {
  it("are the repos of the results whose source is the owner's, grouped with their Skills and installs, the most installed first", async () => {
    const fake = owners({
      "https://skills.sh/api/search?q=mattpocock&limit=200": json(SAMPLE),
    });

    const listing = await run(fake.owners.list("mattpocock"));

    expect(fake.asked).toEqual(["https://skills.sh/api/search?q=mattpocock&limit=200"]);
    expect(listing).toEqual({
      owner: "mattpocock",
      repos: [
        { repo: "skills", skills: 3, installs: 1_449_577 + 900_000 + 1_241_146 },
        { repo: "agent-browser", skills: 1, installs: 2_000 },
        { repo: "ai-hero-cli", skills: 1, installs: 40 },
      ],
      capped: false,
    });
  });

  it("match the owner without regard to case, and keep a repo as skills.sh spells it", async () => {
    const fake = owners({
      "https://skills.sh/api/search?q=MATTPOCOCK&limit=200": json(SAMPLE),
    });

    const listing = await run(fake.owners.list(" MATTPOCOCK "));

    expect(listing.repos.map(({ repo }) => repo)).toEqual([
      "skills",
      "agent-browser",
      "ai-hero-cli",
    ]);
    // Spelt as the caller gave it.
    expect(listing.owner).toBe("MATTPOCOCK");
  });

  it("say the search was capped when it came back with all 200 results it can hold", async () => {
    const full = {
      skills: Array.from({ length: 200 }, (_, index) =>
        result("oo/big", `skill-${index}`, 200 - index),
      ),
    };

    const fake = owners({ "https://skills.sh/api/search?q=oo&limit=200": json(full) });
    const listing = await run(fake.owners.list("oo"));

    expect(listing.capped).toBe(true);
    expect(listing.repos).toEqual([{ repo: "big", skills: 200, installs: (200 * 201) / 2 }]);
  });

  it("are capped by how many entries skills.sh answered, not by how many were Skills", async () => {
    // 200 entries, 150 of which are not Skills (no install count): the search still came back full.
    const entries = [
      ...Array.from({ length: 50 }, (_, index) => result("oo/big", `skill-${index}`, 1)),
      ...Array.from({ length: 150 }, (_, index) => ({ source: "oo/big", skillId: `x-${index}` })),
    ];

    const fake = owners({
      "https://skills.sh/api/search?q=oo&limit=200": json({ skills: entries }),
    });

    const listing = await run(fake.owners.list("oo"));

    expect(listing.capped).toBe(true);
    expect(listing.repos).toEqual([{ repo: "big", skills: 50, installs: 50 }]);
  });

  it("are empty for an owner the directory lists nothing of, and for one too short to search for without asking", async () => {
    const fake = owners({
      "https://skills.sh/api/search?q=nobody&limit=200": json({ skills: [] }),
    });

    expect(await run(fake.owners.list("nobody"))).toEqual({
      owner: "nobody",
      repos: [],
      capped: false,
    });
    expect(await run(fake.owners.list("x"))).toEqual({ owner: "x", repos: [], capped: false });
    expect(fake.asked).toEqual(["https://skills.sh/api/search?q=nobody&limit=200"]);
  });

  it("fail with the Skill directory's error when skills.sh fails or answers something else", async () => {
    const down = owners({
      "https://skills.sh/api/search?q=mattpocock&limit=200": json({ error: "Boom" }, 503),
    });

    const odd = owners({
      "https://skills.sh/api/search?q=mattpocock&limit=200": json({ results: [] }),
    });

    const failed = await run(Effect.flip(down.owners.list("mattpocock")));

    expect(failed).toBeInstanceOf(SkillDirectoryError);
    expect(failed.message).toBe("skills.sh answered 503: Boom");
    expect(await run(Effect.flip(odd.owners.list("mattpocock")))).toBeInstanceOf(
      SkillDirectoryError,
    );
  });
});
