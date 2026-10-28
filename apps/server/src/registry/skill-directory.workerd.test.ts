// The Skill directory over a fake skills.sh and the Worker's real Cache API (ADR-0026, `docs/architecture/workspace.md` → _The Skill
// directory_): a leaderboard page is asked once and then kept, each page and view apart; a failure is a typed error and
// is never kept; search is asked every time, up to 200 results. The samples are what skills.sh really answered.
// workerd's Cache API is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off missedPipeableOpportunity:off instanceOfSchema:off -- a fake of `fetch` over native arrays.
import { SkillDirectoryError } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { leaderboardUrl, type LeaderboardCache, skillDirectoryOver } from "./skill-directory.ts";
import { LEADERBOARD_SAMPLES, SEARCH_SAMPLE } from "./skill-directory.fixture.ts";

/** A fake skills.sh: answers each URL with `answers` in turn (the last one repeats), and records the URLs asked. */
const fakeSkillsSh = (answers: Record<string, ReadonlyArray<() => Response>>) => {
  const asked: string[] = [];
  const turns = new Map<string, number>();

  // SAFETY: the code under test calls `fetch(url, init)` only, which this answers; a Request normalizes the URL.
  const fetch = ((input: RequestInfo | URL) => {
    const { url } = new Request(input);

    asked.push(url);

    const list = answers[url];

    if (list === undefined)
      return Promise.resolve(new Response('{"error":"Not found"}', { status: 404 }));

    const turn = turns.get(url) ?? 0;

    turns.set(url, turn + 1);

    const answer = list[Math.min(turn, list.length - 1)];

    return Promise.resolve(answer === undefined ? new Response(null, { status: 500 }) : answer());
  }) as typeof globalThis.fetch;

  return { fetch, asked };
};

const json =
  (body: Schema.Json, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let cacheNumber = 0;

/** The real Cache API under a name of this test's own, so tests do not share pages. */
const realCache = async (): Promise<LeaderboardCache> => {
  const cache = await caches.open(`skill-directory-${(cacheNumber += 1)}`);

  return {
    match: (url) => cache.match(url),
    put: (url, response) => cache.put(url, response),
  };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("a leaderboard page", () => {
  it("is read from skills.sh with its rank order, install counts and the Hot tab's change", async () => {
    const skillsSh = fakeSkillsSh({
      [leaderboardUrl("all-time", 0)]: [json(LEADERBOARD_SAMPLES["all-time"])],
      [leaderboardUrl("hot", 0)]: [json(LEADERBOARD_SAMPLES.hot)],
    });

    const directory = skillDirectoryOver({ cache: await realCache(), fetch: skillsSh.fetch });
    const allTime = await run(directory.leaderboard("all-time", 0));
    const hot = await run(directory.leaderboard("hot", 0));

    expect(allTime).toMatchObject({ total: 9911, hasMore: true });
    // Only what the page shows: the sparkline and the official mark are left out.
    expect(allTime.skills[0]).toEqual({
      source: "vercel-labs/skills",
      skillId: "find-skills",
      name: "find-skills",
      installs: 4_088_520,
    });
    expect(allTime.skills.map(({ skillId }) => skillId)).toEqual([
      "find-skills",
      "grill-me",
      "hyperframes-cli",
    ]);
    expect(hot.skills[0]).toEqual({
      source: "okx/onchainos-skills",
      skillId: "okx-dapp-discovery",
      name: "okx-dapp-discovery",
      installs: 5,
      installsYesterday: 1,
      change: 4,
    });
  });

  it("is asked of skills.sh once, then kept: the same page again is the cache's", async () => {
    const skillsSh = fakeSkillsSh({
      [leaderboardUrl("trending", 0)]: [json(LEADERBOARD_SAMPLES.trending)],
    });

    const directory = skillDirectoryOver({ cache: await realCache(), fetch: skillsSh.fetch });
    const first = await run(directory.leaderboard("trending", 0));
    const again = await run(directory.leaderboard("trending", 0));

    expect(again).toEqual(first);
    expect(skillsSh.asked).toEqual([leaderboardUrl("trending", 0)]);
  });

  it("is kept by view and page: another page, or another view, is asked", async () => {
    const skillsSh = fakeSkillsSh({
      [leaderboardUrl("all-time", 0)]: [json(LEADERBOARD_SAMPLES["all-time"])],
      [leaderboardUrl("all-time", 1)]: [
        json({ ...LEADERBOARD_SAMPLES["all-time"], hasMore: false, page: 1 }),
      ],
      [leaderboardUrl("trending", 0)]: [json(LEADERBOARD_SAMPLES.trending)],
    });

    const directory = skillDirectoryOver({ cache: await realCache(), fetch: skillsSh.fetch });

    await run(directory.leaderboard("all-time", 0));

    const second = await run(directory.leaderboard("all-time", 1));

    await run(directory.leaderboard("trending", 0));
    await run(directory.leaderboard("all-time", 1));

    expect(second.hasMore).toBe(false);
    expect(skillsSh.asked).toEqual([
      leaderboardUrl("all-time", 0),
      leaderboardUrl("all-time", 1),
      leaderboardUrl("trending", 0),
    ]);
  });

  it("is asked again once the cache no longer holds it", async () => {
    const skillsSh = fakeSkillsSh({
      [leaderboardUrl("hot", 0)]: [json(LEADERBOARD_SAMPLES.hot)],
    });

    const kept = new Map<string, Response>();

    // A cache whose entries are gone by the next request, as after the hour.
    const expired: LeaderboardCache = {
      match: async () => undefined,
      put: async (url, response) => {
        kept.set(url, response);
      },
    };

    const directory = skillDirectoryOver({ cache: expired, fetch: skillsSh.fetch });

    await run(directory.leaderboard("hot", 0));
    await run(directory.leaderboard("hot", 0));

    expect(skillsSh.asked).toHaveLength(2);
    // What is put says how long it is kept: about an hour.
    expect(kept.get(leaderboardUrl("hot", 0))?.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
  });

  it("is a typed error when skills.sh answers otherwise, and the failure is not kept", async () => {
    const skillsSh = fakeSkillsSh({
      [leaderboardUrl("all-time", 0)]: [
        json({ error: "Slow down" }, 503),
        json({ nope: true }),
        () => new Response("<html>", { status: 200 }),
        json(LEADERBOARD_SAMPLES["all-time"]),
      ],
    });

    const directory = skillDirectoryOver({ cache: await realCache(), fetch: skillsSh.fetch });
    const failures = [];

    for (let turn = 0; turn < 3; turn++) {
      failures.push(await run(Effect.flip(directory.leaderboard("all-time", 0))));
    }

    const recovered = await run(directory.leaderboard("all-time", 0));

    expect(failures.every((failure) => failure instanceof SkillDirectoryError)).toBe(true);
    expect(failures.map(({ message }) => message)).toEqual([
      "skills.sh answered 503: Slow down",
      "skills.sh's answer was not a list of Skills (its leaderboard is undocumented and may have changed)",
      "skills.sh's answer was not a list of Skills (its leaderboard is undocumented and may have changed)",
    ]);
    expect(recovered.skills).toHaveLength(3);
  });

  it("is a typed error when skills.sh cannot be reached", async () => {
    const directory = skillDirectoryOver({
      cache: await realCache(),
      // SAFETY: only called as `fetch(url, init)`, which this fails.
      fetch: (() => Promise.reject(new Error("connection refused"))) as typeof globalThis.fetch,
    });

    const failure = await run(Effect.flip(directory.leaderboard("trending", 2)));

    expect(failure).toBeInstanceOf(SkillDirectoryError);
    expect(failure.message).toBe("skills.sh could not be reached: connection refused");
  });

  it("leaves out a row that is not a Skill with a source, an ID and an install count", async () => {
    const skillsSh = fakeSkillsSh({
      [leaderboardUrl("all-time", 0)]: [
        json({
          skills: [
            { source: "o/skills", skillId: "tdd", name: "tdd", installs: 7 },
            { source: "o/skills", name: "no id", installs: 1 },
            "junk",
          ],
          total: 3,
          hasMore: false,
        }),
      ],
    });

    const directory = skillDirectoryOver({ cache: await realCache(), fetch: skillsSh.fetch });
    const page = await run(directory.leaderboard("all-time", 0));

    expect(page.skills).toEqual([{ source: "o/skills", skillId: "tdd", name: "tdd", installs: 7 }]);
  });

  it("still answers when the cache cannot", async () => {
    const skillsSh = fakeSkillsSh({
      [leaderboardUrl("all-time", 0)]: [json(LEADERBOARD_SAMPLES["all-time"])],
    });

    const broken: LeaderboardCache = {
      match: () => Promise.reject(new Error("no cache")),
      put: () => Promise.reject(new Error("no cache")),
    };

    const directory = skillDirectoryOver({ cache: broken, fetch: skillsSh.fetch });

    expect((await run(directory.leaderboard("all-time", 0))).skills).toHaveLength(3);
  });
});

describe("a search", () => {
  it("asks skills.sh for up to 200 results and keeps each one's source, ID and installs", async () => {
    const skillsSh = fakeSkillsSh({
      "https://skills.sh/api/search?q=grill&limit=200": [json(SEARCH_SAMPLE)],
    });

    const directory = skillDirectoryOver({ cache: await realCache(), fetch: skillsSh.fetch });
    const found = await run(directory.search(" grill "));

    expect(found).toEqual([
      { source: "mattpocock/skills", skillId: "grill-me", name: "grill-me", installs: 1_449_577 },
      {
        source: "mattpocock/skills",
        skillId: "grill-with-docs",
        name: "grill-with-docs",
        installs: 1_241_146,
      },
      { source: "mattpocock/skills", skillId: "grilling", name: "grilling", installs: 1_003_569 },
    ]);
  });

  it("is asked every time, and refuses a query skills.sh does not search for without asking", async () => {
    const skillsSh = fakeSkillsSh({
      "https://skills.sh/api/search?q=grill&limit=200": [json(SEARCH_SAMPLE)],
    });

    const directory = skillDirectoryOver({ cache: await realCache(), fetch: skillsSh.fetch });

    await run(directory.search("grill"));
    await run(directory.search("grill"));

    const tooShort = await run(Effect.flip(directory.search("g")));

    expect(skillsSh.asked).toHaveLength(2);
    expect(tooShort).toBeInstanceOf(SkillDirectoryError);
    expect(tooShort.message).toBe("skills.sh searches for at least 2 characters");
  });

  it("is a typed error when skills.sh fails or cannot be reached", async () => {
    const down = skillDirectoryOver({
      cache: await realCache(),
      fetch: fakeSkillsSh({
        "https://skills.sh/api/search?q=grill&limit=200": [json({ error: "Boom" }, 500)],
      }).fetch,
    });

    const gone = skillDirectoryOver({
      cache: await realCache(),
      // SAFETY: only called as `fetch(url, init)`, which this fails.
      fetch: (() => Promise.reject(new Error("offline"))) as typeof globalThis.fetch,
    });

    expect((await run(Effect.flip(down.search("grill")))).message).toBe(
      "skills.sh answered 500: Boom",
    );
    expect((await run(Effect.flip(gone.search("grill")))).message).toBe(
      "skills.sh could not be reached: offline",
    );
  });
});
