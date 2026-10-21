// How a query typed in the composer's menu ranks what it may complete: Slash commands, Skills, and the paths of the
// `files` request. The web app ranks its menu and the Session ranks a directory's paths with the same function, so the
// files the Session answers come in the order the menu would put them in.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain string functions, run per candidate over tens of thousands of paths.

/** Word separators: a match right after one starts a word. */
const SEPARATOR = /[\s\-_/:.]/;

/** How well `query` matches `candidate` (both lower case): lower is better, null is no match. */
const tier = (query: string, candidate: string): number | null => {
  if (candidate === query) return 0;

  if (candidate.startsWith(query)) return 1;

  const at = candidate.indexOf(query);

  if (at > 0) {
    // Any occurrence may start a word, not only the first: `install` holds `all` in its middle and after its dash.
    for (let from = at; from >= 0; from = candidate.indexOf(query, from + 1)) {
      if (SEPARATOR.test(candidate[from - 1] ?? "")) return 2;
    }

    return 3;
  }

  let from = 0;

  for (const char of query) {
    const found = candidate.indexOf(char, from);

    if (found < 0) return null;

    from = found + 1;
  }

  return 4;
};

/** A name made ready to rank many times: lower-cased, with its last segment apart. */
export type RankCandidate = {
  readonly name: string;
  readonly lower: string;
  /** The lower-cased last segment (a folder's keeps its trailing `/`); `lower` itself when it has no other. */
  readonly base: string;
};

/** `name` made ready to rank: done once per name, so ranking a long list again for each query costs only the matching. */
export const rankCandidate = (name: string): RankCandidate => {
  const lower = name.toLowerCase();
  const trimmed = lower.endsWith("/") ? lower.slice(0, -1) : lower;

  return { name, lower, base: lower.slice(trimmed.lastIndexOf("/") + 1) };
};

/** How well the lower-cased `query` matches `candidate`: lower is better, null is no match. */
const score = (query: string, { lower, base }: RankCandidate): number | null => {
  if (base === lower) return tier(query, lower);

  const inBase = tier(query, base);

  if (inBase !== null) return inBase;

  const whole = tier(query, lower);

  return whole === null ? null : whole + 5;
};

/**
 * `candidates` that match `query`, best first: an exact match, then a prefix, a word start, a substring, and the
 * query's letters in order. For a path, a match in its last segment (a folder's name, before its trailing `/`) beats
 * one only elsewhere. Ties keep their order, and an empty query keeps every candidate in order.
 */
export const rank = <A>(
  query: string,
  candidates: readonly A[],
  key: (candidate: A) => string,
): A[] => {
  if (query === "") return [...candidates];

  const lower = query.toLowerCase();
  const scored: { candidate: A; score: number; index: number }[] = [];

  candidates.forEach((candidate, index) => {
    const found = score(lower, rankCandidate(key(candidate)));

    if (found !== null) scored.push({ candidate, score: found, index });
  });

  return scored
    .toSorted((a, b) => a.score - b.score || a.index - b.index)
    .map(({ candidate }) => candidate);
};

/**
 * The names of the best `limit` of `candidates` for `query`, in `rank`'s order, kept as they are found: it holds no more
 * than `limit` at a time, however many match.
 */
export const bestMatches = (
  query: string,
  candidates: readonly RankCandidate[],
  limit: number,
): string[] => {
  if (query === "") return candidates.slice(0, limit).map(({ name }) => name);

  const lower = query.toLowerCase();
  // Best first; among equals, earlier first, so a later equal never displaces one already held.
  const best: { name: string; score: number }[] = [];

  for (const candidate of candidates) {
    const found = score(lower, candidate);

    if (found === null || (best.length === limit && found >= (best.at(-1)?.score ?? 0))) continue;

    let at = best.length;

    while (at > 0 && (best[at - 1]?.score ?? 0) > found) at -= 1;

    best.splice(at, 0, { name: candidate.name, score: found });

    if (best.length > limit) best.pop();
  }

  return best.map(({ name }) => name);
};
