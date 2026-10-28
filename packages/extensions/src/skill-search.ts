// @effect-diagnostics missingPipeableSignature:off asyncFunction:off
// Searching skills.sh for Skills (ADR-0026, `docs/architecture/workspace.md` → _Installing from GitHub_): the request to its undocumented
// `/api/search` and a reading of its answer, in plain TypeScript so the `skill_search` tool (in the Session DO, through the
// web transport) and the Skills page (through the main Worker) share them. skills.sh is used for search only: what
// is installed is fetched from GitHub, and nothing here records anything.
import { SkillSearchResult } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** skills.sh's search endpoint. */
export const SKILLS_SEARCH_URL = "https://skills.sh/api/search";

/** The fewest characters skills.sh searches for. */
export const MIN_QUERY_LENGTH = 2;

/** The longest query asked of it. */
export const MAX_QUERY_LENGTH = 200;

/** How many results are asked for, and the most that can be. */
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 20;

/** How long a search is waited for. */
export const SEARCH_TIMEOUT_MS = 15_000;

/** The headers of a search. */
export const SEARCH_HEADERS = { accept: "application/json", "user-agent": "cloudpid" };

/** The request URL for `query`. */
export const skillSearchUrl = (query: string, limit = DEFAULT_LIMIT): string =>
  `${SKILLS_SEARCH_URL}?${new URLSearchParams({ q: query, limit: String(Math.min(limit, MAX_LIMIT)) }).toString()}`;

/** Why `query` is not searched for, or undefined. */
export const queryProblem = (query: string): string | undefined => {
  const trimmed = query.trim();

  if (trimmed.length < MIN_QUERY_LENGTH) {
    return `skills.sh searches for at least ${MIN_QUERY_LENGTH} characters`;
  }

  return trimmed.length > MAX_QUERY_LENGTH
    ? `a search is at most ${MAX_QUERY_LENGTH} characters`
    : undefined;
};

const Answer = Schema.Struct({ skills: Schema.Array(Schema.Unknown) });

const decodeAnswer = Schema.decodeUnknownOption(Answer);
const decodeResult = Schema.decodeUnknownOption(SkillSearchResult);
const decodeError = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

/** What a search found, or why it did not. */
export type SkillSearch =
  | { readonly ok: true; readonly results: ReadonlyArray<SkillSearchResult> }
  | { readonly ok: false; readonly message: string };

/**
 * skills.sh's answer to a search, read: its `skills` (an entry that is not a Skill with an ID, source and install count is
 * left out), or why it is no answer: its own error, an unexpected status, or a body that is not what it answers.
 */
export const readSkillSearch = async (response: Response): Promise<SkillSearch> => {
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const said = Option.getOrUndefined(decodeError(body));

    return {
      ok: false,
      message: `skills.sh answered ${response.status}${said === undefined ? "" : `: ${said.error}`}`,
    };
  }

  const answer = decodeAnswer(body);

  if (Option.isNone(answer)) {
    return {
      ok: false,
      message:
        "skills.sh's answer was not a list of Skills (its search is undocumented and may have changed)",
    };
  }

  return {
    ok: true,
    results: Arr.flatMap(answer.value.skills, (entry) =>
      Option.match(decodeResult(entry), { onNone: () => [], onSome: (result) => [result] }),
    ),
  };
};

/** A search that could not be made at all (skills.sh unreachable), as a result. */
export const skillSearchUnreachable = (cause: unknown): SkillSearch => ({
  ok: false,
  message: `skills.sh could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
});
