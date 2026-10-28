// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// The Skill directory's lists for the Skills page (ADR-0026, GLOSSARY.md → Skill directory,
// `docs/architecture/workspace.md` → _The Skill directory_): skills.sh's leaderboards
// (/api/skills/{all-time|trending|hot}/{page}, 200 rows a page from page 0, no auth) and its search, asked by the main
// Worker since skills.sh does not answer a browser's cross-origin request. Both APIs are undocumented (and its robots.txt
// disallows /api/ for crawlers: ADR-0026's accepted risk), so a leaderboard page is kept about an hour in the Worker's
// Cache API and a failure is a typed error the page shows. Nothing here scrapes skills.sh's HTML pages, records anything,
// or is needed to install: an install fetches from GitHub.
//
// Why the Cache API: the answers are public, expendable and read-through, so they need no migration or storage of their
// own (a Durable Object's SQLite would hold them for ever and need a sweep), and expiry is the cache's own (max-age). It is
// per data centre, which is fine for one owner. fetch's cf.cacheTtl would cache too, but cannot be seen or tested. Only an
// answer that passed the checks below is put, so a failure is never kept.
// @effect-diagnostics asyncFunction:off globalFetch:off globalFetchInEffect:off -- skills.sh is asked with fetch, a Promise API.
import {
  MAX_DIRECTORY_LIMIT,
  SEARCH_HEADERS,
  SEARCH_TIMEOUT_MS,
} from "@cloudpid/extensions/skill-search";
import {
  type DirectorySkill,
  SkillDirectoryError,
  type SkillDirectoryPage,
  type SkillDirectoryView,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { skillSearcher } from "./skill-search.ts";

/** skills.sh's leaderboard API: <base>/{view}/{page}. */
export const SKILLS_LEADERBOARD_URL = "https://skills.sh/api/skills";

/** How long a leaderboard page is kept: the max-age of what is put in the cache. */
export const LEADERBOARD_TTL_SECONDS = 3_600;

/** A row of the Skill directory as skills.sh answers it: a `DirectorySkill` with no word of where it is installed. */
export type DirectoryRow = Omit<DirectorySkill, "installed">;

/** One page of a leaderboard as skills.sh answers it. */
export type DirectoryRows = Omit<SkillDirectoryPage, "skills"> & {
  readonly skills: ReadonlyArray<DirectoryRow>;
};

/** The Skill directory as the Registry's RPCs read it. Both fail with a `SkillDirectoryError` the page shows plainly. */
export type SkillDirectory = {
  /** One page (from 0) of a leaderboard, from the cache when it holds one that is not an hour old. */
  readonly leaderboard: (
    view: SkillDirectoryView,
    page: number,
  ) => Effect.Effect<DirectoryRows, SkillDirectoryError>;
  /** What a search finds, at most 200, fuzzy. Not cached. */
  readonly search: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<DirectoryRow>, SkillDirectoryError>;
  /** The same search with how many entries skills.sh answered, counting those left out as not Skills (the owner page's limit). */
  readonly searchListed: (
    query: string,
  ) => Effect.Effect<
    { readonly rows: ReadonlyArray<DirectoryRow>; readonly listed: number },
    SkillDirectoryError
  >;
};

/** The part of the Cache API the leaderboard uses: `caches.default`'s match and put. */
export type LeaderboardCache = {
  readonly match: (url: string) => Promise<Response | undefined>;
  readonly put: (url: string, response: Response) => Promise<void>;
};

const Row = Schema.Struct({
  source: Schema.String,
  skillId: Schema.String,
  name: Schema.String,
  installs: Schema.Finite,
  installsYesterday: Schema.optionalKey(Schema.Finite),
  change: Schema.optionalKey(Schema.Finite),
});

const Answer = Schema.Struct({
  skills: Schema.Array(Schema.Unknown),
  total: Schema.Finite,
  hasMore: Schema.Boolean,
});

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));
const decodeRow = Schema.decodeUnknownOption(Row);

const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
);

/** The request URL, and the cache's key, of page `page` of `view`. */
export const leaderboardUrl = (view: SkillDirectoryView, page: number): string =>
  `${SKILLS_LEADERBOARD_URL}/${view}/${page}`;

type Read =
  | { readonly ok: true; readonly rows: DirectoryRows }
  | { readonly ok: false; readonly message: string };

/**
 * skills.sh's answer to a leaderboard request, read: its rows (one that is not a Skill with a source, ID and install count
 * is left out), or why it is no answer: its own error, an unexpected status, or a body (the JSON ` + "`text`" + ` holds) that
 * is not what it answers.
 */
export const readLeaderboard = (status: number, text: string): Read => {
  if (status < 200 || status > 299) {
    const said = Option.getOrUndefined(decodeError(text));

    return {
      ok: false,
      message: `skills.sh answered ${status}${said === undefined ? "" : `: ${said.error}`}`,
    };
  }

  const answer = decodeAnswer(text);

  if (Option.isNone(answer)) {
    return {
      ok: false,
      message:
        "skills.sh's answer was not a list of Skills (its leaderboard is undocumented and may have changed)",
    };
  }

  const { skills, total, hasMore } = answer.value;

  return {
    ok: true,
    rows: {
      total,
      hasMore,
      skills: Arr.flatMap(skills, (entry) =>
        Option.match(decodeRow(entry), { onNone: () => [], onSome: (row) => [row] }),
      ),
    },
  };
};

/** The Skill directory over skills.sh, asked with `fetch`, its leaderboard pages kept in `cache`. */
export const skillDirectoryOver = ({
  cache,
  fetch: ask = fetch,
}: {
  readonly cache: LeaderboardCache;
  readonly fetch?: typeof fetch;
}): SkillDirectory => {
  /** The cached page at `url`, if the cache holds one that reads as an answer. */
  const cached = async (url: string): Promise<DirectoryRows | undefined> => {
    try {
      const hit = await cache.match(url);

      if (hit === undefined) return undefined;

      const read = readLeaderboard(hit.status, await hit.text());

      return read.ok ? read.rows : undefined;
    } catch {
      // A cache that cannot answer is no cache: skills.sh is asked.
      return undefined;
    }
  };

  const asked = async (view: SkillDirectoryView, page: number): Promise<Read> => {
    const url = leaderboardUrl(view, page);
    const hit = await cached(url);

    if (hit !== undefined) return { ok: true, rows: hit };

    try {
      const response = await ask(url, {
        headers: SEARCH_HEADERS,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      const text = await response.text();
      const read = readLeaderboard(response.status, text);

      if (read.ok) {
        // Only an answer that read as one is kept; a cache that cannot be written to costs only the next request.
        await cache
          .put(
            url,
            new Response(text, {
              headers: {
                "content-type": "application/json",
                "cache-control": `public, max-age=${LEADERBOARD_TTL_SECONDS}`,
              },
            }),
          )
          .catch(() => undefined);
      }

      return read;
    } catch (cause) {
      return {
        ok: false,
        message: `skills.sh could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  };

  const searcher = skillSearcher({ ask, limit: MAX_DIRECTORY_LIMIT, max: MAX_DIRECTORY_LIMIT });

  const searchListed: SkillDirectory["searchListed"] = (query) =>
    searcher(query).pipe(
      Effect.flatMap((found) =>
        found.ok
          ? Effect.succeed({
              listed: found.listed,
              rows: Arr.map(found.results, ({ source, skillId, name, installs }) => ({
                source,
                skillId,
                name,
                installs,
              })),
            })
          : Effect.fail(SkillDirectoryError.make({ message: found.message })),
      ),
    );

  return {
    leaderboard: (view, page) =>
      Effect.promise(async () => asked(view, page)).pipe(
        Effect.flatMap((read) =>
          read.ok
            ? Effect.succeed(read.rows)
            : Effect.fail(SkillDirectoryError.make({ message: read.message })),
        ),
      ),
    searchListed,
    search: (query) => Effect.map(searchListed(query), ({ rows }) => rows),
  };
};
