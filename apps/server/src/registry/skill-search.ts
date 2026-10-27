// The Environments page's search of skills.sh (ADR-0026): asked by the main Worker, since skills.sh does not answer a
// browser's cross-origin request, with the request and the reading of its answer the `skill_search` tool shares
// (`@cloudpid/extensions/skill-search`). Records nothing, and installing does not depend on it.
// @effect-diagnostics asyncFunction:off globalFetch:off globalFetchInEffect:off -- GitHub is read with `fetch`, a Promise API, and the reads and the checks run over native arrays.
import {
  queryProblem,
  readSkillSearch,
  type SkillSearch,
  skillSearchUnreachable,
  skillSearchUrl,
} from "@cloudpid/extensions/skill-search";
import * as Effect from "effect/Effect";

/** How the page searches for Skills: what it found, or why it could not. Never fails. */
export type SkillSearcher = (query: string) => Effect.Effect<SkillSearch>;

/** How long a search is waited for. */
const SEARCH_TIMEOUT_MS = 15_000;

/** `SkillSearcher` over skills.sh. */
export const searchSkillsSh: SkillSearcher = (query) =>
  Effect.promise(async (): Promise<SkillSearch> => {
    const problem = queryProblem(query);

    if (problem !== undefined) return { ok: false, message: problem };

    try {
      const response = await fetch(skillSearchUrl(query.trim()), {
        headers: { accept: "application/json", "user-agent": "cloudpid" },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      return await readSkillSearch(response);
    } catch (cause) {
      return skillSearchUnreachable(cause);
    }
  });
