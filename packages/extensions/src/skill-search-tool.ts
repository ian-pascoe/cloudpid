// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// The `skill-search` extension (ADR-0026, `docs/architecture/workspace.md` → _Installing from GitHub_): `skill_search` searches skills.sh
// (its undocumented `/api/search`) for Skills and returns each one's ID, source and install count. It records nothing and
// needs no GitHub token, so it runs in the Session DO; installing does not depend on it, and a failure of the search is
// the tool's error result and breaks nothing else. Root conversation only (`PARENT_ONLY_TOOLS`), and deferred unless the
// settings offer it. It declares an output schema (`docs/architecture/agent-capabilities.md` → Values for programs): the
// results as data, each with its ID, source, Skill name and install count.
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
import { asOutput, boundItems, outputSchema } from "./outputs.ts";
import { WebTransport } from "./web/transport.ts";

export const extensionName = "skill-search";

export const SKILL_SEARCH_TOOL = "skill_search";

/** `skill_search` could not search, and says why: the model sees `message` as the tool's error result. */
export class SkillSearchError extends Schema.TaggedError<
  SkillSearchError,
  { readonly brand: unique symbol }
>()("SkillSearchError", { message: Schema.String }) {}

/** `skill_search`: what skills.sh found, in its order. */
export const SkillSearchOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The Skill's ID, owner/repo/skill" }),
      source: Schema.String.annotate({
        description: "owner/repo: what environment_skill_install takes as source",
      }),
      skill_id: Schema.String.annotate({
        description:
          "The last part of its ID: the Skill's name for environment_skill_install's skills",
      }),
      name: Schema.String.annotate({ description: "The Skill's name" }),
      installs: Schema.Finite.annotate({ description: "How many times it was installed" }),
    }).annotate({ description: "A Skill skills.sh found" }),
  ).annotate({ description: "The Skills found, in skills.sh's order; empty when it found none" }),
  results_truncated: Schema.Boolean.annotate({
    description: "The list was cut to stay within the size bound of a value",
  }),
});

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
  structuredOutputSchema: outputSchema(SkillSearchOutput),
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

    const listed = boundItems(
      Arr.map(found.results, ({ id, source, skillId, name, installs }) => ({
        id,
        source,
        skill_id: skillId,
        name,
        installs,
      })),
    );

    return {
      output: [{ type: "text" as const, text }],
      details: { query, found: found.results.length },
      structuredOutput: asOutput(SkillSearchOutput, {
        results: listed.items,
        results_truncated: listed.truncated,
      }),
    };
  }),
});

/** The `skill-search` extension, with `skill_search`. Needs the network (`WebTransport`). */
export const SkillSearchTools = Effect.map(search, (tool) =>
  defineExtension({ name: extensionName, tools: [tool] }),
);
