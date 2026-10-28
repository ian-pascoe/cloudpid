// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// The `skill-search` extension (ADR-0026, `docs/architecture/workspace.md` → _Installing from GitHub_): `skill_search` searches skills.sh
// (its undocumented `/api/search`) for Skills and returns each one's ID, source and install count. It records nothing and
// needs no GitHub token, so it runs in the Session DO; installing does not depend on it, and a failure of the search is
// the tool's error result and breaks nothing else. Root conversation only (`PARENT_ONLY_TOOLS`), and deferred unless the
// settings offer it.
import { defineEffectTool } from "@cloudpid/effect-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  queryProblem,
  readSkillSearch,
  SEARCH_HEADERS,
  SEARCH_TIMEOUT_MS,
  skillSearchUrl,
} from "./skill-search.ts";
import { WebTransport } from "./web/transport.ts";

export const extensionName = "skill-search";

export const SKILL_SEARCH_TOOL = "skill_search";

/** `skill_search` could not search, and says why: the model sees `message` as the tool's error result. */
export class SkillSearchError extends Schema.TaggedError<
  SkillSearchError,
  { readonly brand: unique symbol }
>()("SkillSearchError", { message: Schema.String }) {}

const unable = (why: string) =>
  SkillSearchError.make({ message: `Could not search skills.sh: ${why}` });

const search = defineEffectTool({
  name: SKILL_SEARCH_TOOL,
  description:
    "Search skills.sh for Skills to install: each result gives the Skill's ID, its source (owner/repo, which environment_skill_install takes as source) and how many times it was installed. Records nothing. Fails plainly when skills.sh cannot be reached; a source can be installed without searching.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({
      description: "What the Skill does, or part of its name (at least 2 characters)",
    }),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })).annotate({
        description: `How many results (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`,
      }),
    ),
  }),
  execute: Effect.fnUntraced(function* ({ query, limit }) {
    const transport = yield* WebTransport;
    const problem = queryProblem(query);

    if (problem !== undefined) return yield* unable(problem);

    const response = yield* transport
      .fetch({
        url: skillSearchUrl(query.trim(), limit),
        headers: SEARCH_HEADERS,
      })
      .pipe(
        Effect.timeoutOrElse({
          duration: SEARCH_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(unable(`it did not answer within ${SEARCH_TIMEOUT_MS / 1_000} seconds`)),
        }),
        Effect.catchTag("WebToolError", (error) =>
          Effect.fail(unable(`skills.sh could not be reached (${error.message})`)),
        ),
      );

    const found = yield* Effect.promise(() => readSkillSearch(response));

    if (!found.ok) return yield* unable(found.message);

    const text =
      found.results.length === 0
        ? `skills.sh found no Skill for \u201c${query}\u201d.`
        : Arr.join(
            [
              `skills.sh found ${found.results.length} Skill${found.results.length === 1 ? "" : "s"} for \u201c${query}\u201d, in its order:`,
              ...Arr.map(
                found.results,
                (result) =>
                  `- ${result.id}: source ${result.source}, ${result.installs} install${result.installs === 1 ? "" : "s"}`,
              ),
              "Install one with environment_skill_install: source is the owner/repo, skills is [the Skill's name, the last part of its ID].",
            ],
            "\n",
          );

    return {
      output: [{ type: "text" as const, text }],
      details: { query, found: found.results.length },
    };
  }),
});

/** The `skill-search` extension, with `skill_search`. Needs the network (`WebTransport`). */
export const SkillSearchTools = Effect.map(search, (tool) =>
  defineExtension({ name: extensionName, tools: [tool] }),
);
