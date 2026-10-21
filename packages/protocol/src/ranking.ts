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
    const name = key(candidate).toLowerCase();
    const base = name.slice(name.replace(/\/$/, "").lastIndexOf("/") + 1);
    const inBase = base === name ? null : tier(lower, base);
    const whole = inBase === null ? tier(lower, name) : null;
    const score = inBase ?? (whole === null ? null : whole + (base === name ? 0 : 5));

    if (score !== null) scored.push({ candidate, score, index });
  });

  return scored
    .toSorted((a, b) => a.score - b.score || a.index - b.index)
    .map(({ candidate }) => candidate);
};
