// The Environments page's search of skills.sh (ADR-0026): asked by the main Worker, since skills.sh does not answer a
// browser's cross-origin request, with the request and the reading of its answer the `skill_search` tool shares
// (`@cloudpid/extensions/skill-search`). Records nothing, and installing does not depend on it.
// @effect-diagnostics asyncFunction:off globalFetch:off globalFetchInEffect:off -- skills.sh is asked with `fetch`, a Promise API.
import {
  queryProblem,
  readSkillSearch,
  SEARCH_HEADERS,
  SEARCH_TIMEOUT_MS,
  type SkillSearch,
  skillSearchUnreachable,
  skillSearchUrl,
} from "@cloudpid/extensions/skill-search";
import * as Effect from "effect/Effect";

/** How the page searches for Skills: what it found, or why it could not. Never fails. */
export type SkillSearcher = (query: string) => Effect.Effect<SkillSearch>;

/** `SkillSearcher` over skills.sh. */
export const searchSkillsSh: SkillSearcher = (query) =>
  Effect.promise(async (): Promise<SkillSearch> => {
    const problem = queryProblem(query);

    if (problem !== undefined) return { ok: false, message: problem };

    try {
      const response = await fetch(skillSearchUrl(query.trim()), {
        headers: SEARCH_HEADERS,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      return await readSkillSearch(response);
    } catch (cause) {
      return skillSearchUnreachable(cause);
    }
  });
