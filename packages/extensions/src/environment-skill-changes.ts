// The cores of the tools that install, update and remove an Environment's own Skills (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions and the core/wrapper split, Retries: `request_id`;
// `docs/architecture/agent-changes.md` → The Environment's own Skills): `environment_skill_install`, `_update` and
// `_remove`. Each core makes the tool's checks (a text it keeps that holds a credential) and its one `EnvironmentSkills`
// call, and answers the text and the structured value the endpoint gives; an Environment's Skills only, since a change to
// those kept Global waits for the owner's Approval (S3b: the dispatcher answers `unsupported` before a core runs).
//
// The Session's wrappers (`./environment-skills.ts`, `./environment-skill-update.ts`) keep their own answers, which tell
// of the Workspace a change was handed to, of Global and of the Approval, and so are not these cores' to say; they make
// the same Registry calls. What an answer says of each Skill is read per Skill (`installed`, `refused`, `unchanged`,
// `listed`), never from the call's success: an install whose Skills were all refused still reports `installed` (the
// Registry's own aggregate), so the answer says nothing was kept. `SKILL_REPLAYED` builds each tool's answer from the
// Agent changes an earlier call with the same `request_id` recorded (#687 L17): one result per change, since a Skill's
// change is its own.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
import {
  type AgentChange,
  type InstalledSkill,
  shortSha,
  SKILLS_ROOT,
  fieldSkill,
  SkillChangeValue,
  skillField,
  type SkillSource,
  type SkillUpdateEntry,
} from "@cloudpid/protocol";
import {
  type HARNESS_TOOLS,
  SkillInstallEndpointOutput,
  SkillRemoveEndpointOutput,
  SkillUpdateEndpointOutput,
} from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { environmentTarget, refuseSecretsIn } from "./environment-change-parts.ts";
import {
  authorOf,
  endpointText,
  fittedChanges,
  type RecordedChange,
  type Replayed,
  replayedChanges,
  replayedScope,
  replayedText,
  type TextCheck,
} from "./environment-changes.ts";
import { EnvironmentsError, notFound } from "./environment-describe.ts";
import { boundedUnchanged, MAX_SKILL_LIST_BYTES } from "./environment-lifecycle-outputs.ts";
import { skillSourceOutput } from "./environment-outputs.ts";
import { type EnvironmentSkills, named } from "./environment-skill-results.ts";
import type { EnvironmentsService } from "./environment.ts";
import {
  type HarnessWrite,
  type HarnessWriteAnswer,
  INVALID_ARGUMENT,
  NOT_FOUND,
} from "./harness.ts";
import { asOutput, boundItems, changesOutput, scopeRef } from "./outputs.ts";

/** What the cores use: the Registry's Skills and Environments as the endpoint reaches them, and the text check. */
export type SkillChangeServices = {
  readonly environments: Pick<EnvironmentsService, "current"> &
    Pick<EnvironmentSkills, "installSkills" | "updateSkills" | "removeSkill">;
  readonly holdsSecret: TextCheck;
};

/** The arguments of tool `Name`, as the endpoint's call decodes them. */
type ArgsOf<Name extends keyof typeof HARNESS_TOOLS> =
  (typeof HARNESS_TOOLS)[Name]["endpoint"]["input"]["Type"];

/** A refusal the caller reads: nothing was done, and why. */
const refusal = (message: string) => EnvironmentsError.make({ message, code: INVALID_ARGUMENT });

/** A Skill as a line of text: its name, and its folder in the repo when it has one. */
export const skillLine = ({
  name,
  path,
}: {
  readonly name: string;
  readonly path: string;
}): string => (path === "" ? name : `${name} (${path})`);

/** The Agent change a call that recorded some tells the Run's Notification of: the first; none when none was recorded. */
const loggedOf = (
  tool: string,
  environmentName: string,
  changes: ReadonlyArray<AgentChange>,
): HarnessWriteAnswer["logged"] => {
  const [first] = changes;

  return first === undefined ? undefined : { tool, environmentName, field: first.field };
};

/** The Skills' names as a sentence part. */
export const namesOf = (skills: ReadonlyArray<{ readonly name: string }>): string =>
  Arr.join(
    Arr.map(skills, ({ name }) => name),
    ", ",
  );

/** Where each Workspace serves the Skills, and when it gets them: what an answer that kept some says. */
const SERVED = `Every Workspace of the Environment serves each at ${SKILLS_ROOT}/<name> (read-only) from its next readying.`;

/**
 * The cores of the Skill tools over `services`, by tool name. A change is refused when a text it keeps holds a credential
 * (`holdsSecret`); the Environment `id` names must be one (never `*`, which the dispatcher has answered `unsupported`).
 */
export const skillCores = ({ environments, holdsSecret }: SkillChangeServices) => {
  /** Fails, saving nothing, when a text holds a deploy-time credential. */
  const refuseSecrets = (texts: ReadonlyArray<{ readonly what: string; readonly text: string }>) =>
    refuseSecretsIn(holdsSecret)("endpoint", texts);

  const install: HarnessWrite<ArgsOf<"environment_skill_install">, EnvironmentsError> = (
    { id, source, skills, reason },
    _surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      yield* refuseSecrets([
        { what: "the reason", text: reason },
        { what: "the source", text: source },
        ...Arr.map(skills ?? [], (name) => ({ what: "a Skill name", text: name })),
      ]);

      const { environment } = yield* environmentTarget(environments, "endpoint")(id);

      const installed = yield* environments.installSkills({
        environment,
        source,
        skills,
        author: authorOf("environment_skill_install", reason, conversation),
      });

      switch (installed.status) {
        case "missing":
          return yield* notFound(environment);
        case "refused":
          return yield* refusal(`Nothing was installed: ${installed.message}`);
        case "listed": {
          const { available, repo, ref, commit } = installed;

          const text = Arr.join(
            [
              `Installed nothing: ${repo} (at ${shortSha(commit)}) holds ${available.length} Skills and none was named:`,
              ...Arr.map(available, (skill) => `- ${skillLine(skill)}: ${skill.description}`),
              'Choose, then call environment_skill_install again with the same id and source and skills set to their names (["*"] for all of them).',
            ],
            "\n",
          );

          return {
            text: endpointText(text),
            structured: installValue({
              scope: installed.environment,
              source: { repo, ref, commit },
              results: [],
              listed: available,
            }),
            details: null,
            logged: undefined,
          };
        }

        case "installed": {
          const { results, repo, ref, commit } = installed;
          const saved = Arr.filter(results, (result) => result.outcome === "installed");
          const same = Arr.filter(results, (result) => result.outcome === "unchanged");
          const rejected = Arr.filter(results, (result) => result.outcome === "rejected");

          const changes = Arr.flatMap(saved, (result) =>
            result.change === undefined ? [] : [result.change],
          );

          const text = Arr.join(
            [
              saved.length === 0
                ? `Installed nothing from ${repo} (at ${shortSha(commit)}).`
                : `Installed ${namesOf(saved)} for ${named(installed.environment)} from ${repo} (at ${shortSha(commit)}).`,
              ...(same.length === 0
                ? []
                : [
                    `${namesOf(same)} ${same.length === 1 ? "was" : "were"} installed from there already: nothing changed, and nothing was recorded for ${same.length === 1 ? "it" : "them"}.`,
                  ]),
              ...(rejected.length === 0
                ? []
                : [
                    `Refused${saved.length === 0 ? "" : " (the others were installed)"}:`,
                    ...Arr.map(
                      rejected,
                      (result) => `- ${skillLine(result)}: ${result.message ?? "refused"}`,
                    ),
                  ]),
              ...(saved.length === 0
                ? []
                : [
                    SERVED,
                    "Each change is recorded with your reason and the files before and after, and the owner can revert it on the Skills page.",
                  ]),
            ],
            " ",
          );

          return {
            text: endpointText(text),
            structured: installValue({
              scope: installed.environment,
              source: { repo, ref, commit },
              results,
              listed: [],
            }),
            details: null,
            logged: loggedOf("environment_skill_install", installed.environment.name, changes),
          };
        }
      }
    });

  const update: HarnessWrite<ArgsOf<"environment_skill_update">, EnvironmentsError> = (
    { id, names, overwrite, reason },
    _surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      yield* refuseSecrets([
        { what: "the reason", text: reason },
        ...Arr.map(names ?? [], (name) => ({ what: "a Skill name", text: name })),
      ]);

      const { environment } = yield* environmentTarget(environments, "endpoint")(id);

      const updated = yield* environments.updateSkills({
        environment,
        names,
        overwrite: overwrite === true,
        author: authorOf("environment_skill_update", reason, conversation),
      });

      switch (updated.status) {
        case "missing":
          return yield* notFound(environment);
        case "refused":
          return yield* refusal(`Nothing was updated: ${updated.message}`);
        case "nothing":
          return {
            text: endpointText(
              `No Skill kept for ${named(updated.environment)} is marked update available. The daily check marks a Skill when its folder changed at its Skill source on the ref it was installed from (environment_get shows the marks); name Skills in names to update them anyway.`,
            ),
            structured: updateValue({
              scope: updated.environment,
              results: [],
              nothingMarked: true,
            }),
            details: null,
            logged: undefined,
          };
        case "done": {
          const { results, environment: scope } = updated;
          const moved = Arr.filter(results, (result) => result.outcome === "updated");
          const same = Arr.filter(results, (result) => result.outcome === "unchanged");

          const left = Arr.filter(
            results,
            (result) => result.outcome !== "updated" && result.outcome !== "unchanged",
          );

          const changes = Arr.flatMap(moved, (result) =>
            result.change === undefined ? [] : [result.change],
          );

          const text = Arr.join(
            [
              moved.length === 0
                ? `Updated nothing for ${named(scope)}.`
                : `Updated ${namesOf(moved)} for ${named(scope)} to the latest commit of their refs.`,
              ...(same.length === 0
                ? []
                : [
                    `${namesOf(same)} ${same.length === 1 ? "was" : "were"} the same at the ref's latest commit: nothing changed, and nothing was recorded for ${same.length === 1 ? "it" : "them"}.`,
                  ]),
              ...(left.length === 0
                ? []
                : [
                    `Not updated${moved.length === 0 ? "" : " (the others were)"}:`,
                    ...Arr.map(
                      left,
                      (result) =>
                        `- ${result.name} (${result.outcome}): ${"message" in result ? result.message : ""}`,
                    ),
                  ]),
              ...(moved.length === 0
                ? []
                : [
                    SERVED,
                    "Each change is recorded with your reason and the files and Skill source before and after, and the owner can revert it on the Skills page.",
                  ]),
            ],
            " ",
          );

          return {
            text: endpointText(text),
            structured: updateValue({ scope, results, nothingMarked: false }),
            details: null,
            logged: loggedOf("environment_skill_update", scope.name, changes),
          };
        }
      }
    });

  const remove: HarnessWrite<ArgsOf<"environment_skill_remove">, EnvironmentsError> = (
    { id, name, reason },
    _surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      yield* refuseSecrets([
        { what: "the reason", text: reason },
        { what: "the name", text: name },
      ]);

      const { environment } = yield* environmentTarget(environments, "endpoint")(id);

      const removed = yield* environments.removeSkill({
        environment,
        name,
        author: authorOf("environment_skill_remove", reason, conversation),
      });

      switch (removed.status) {
        case "missing":
          return yield* notFound(environment);
        case "absent":
          return yield* EnvironmentsError.make({
            message: `Nothing was removed: ${named(removed.environment)} keeps no Skill named "${name}" (a Skill may be gone already). environment_get with id ${removed.environment.id} lists the Skills it keeps; those kept Global are not the Environment's.`,
            code: NOT_FOUND,
          });
        case "changed-since":
          return yield* refusal(
            `Nothing was removed: the Skill ${name} was saved again just now. Call again if it should still be removed.`,
          );
        case "rejected":
          return yield* refusal(`Nothing was removed:\n${removed.message}`);
        case "removed": {
          const { change, environment: scope } = removed;

          const text = Arr.join(
            [
              `Removed the Skill ${name} from ${named(scope)}.`,
              removed.inherited
                ? `The Skill of that name kept Global is served at ${SKILLS_ROOT}/${name} instead, from the next readying.`
                : `Nothing is served at ${SKILLS_ROOT}/${name} any more, from the next readying.`,
              "The change is recorded with your reason and the files the Skill had, and the owner can revert it on the Skills page.",
            ],
            " ",
          );

          return {
            text: endpointText(text),
            structured: asOutput(
              SkillRemoveEndpointOutput,
              fittedChanges({
                scope: scopeRef(scope),
                ...changesOutput([change]),
                unchanged: [],
                changed: true,
                skill: name,
                global_served: removed.inherited,
              }),
            ),
            details: null,
            logged: loggedOf("environment_skill_remove", scope.name, [change]),
          };
        }
      }
    });

  return {
    environment_skill_install: install,
    environment_skill_update: update,
    environment_skill_remove: remove,
  };
};

export type SkillCores = ReturnType<typeof skillCores>;

/** The tools these cores serve, by name. */
export type SkillToolName = keyof SkillCores;

// ─── The endpoint's values ───────────────────────────────────────────────────

/**
 * The value of `environment_skill_install`: what the Registry answered for each Skill, or the Skills it listed. The
 * approved install at Global (`./environment-skill-approvals.ts`) gives the same value.
 */
export const installValue = ({
  scope,
  source,
  results,
  listed,
}: {
  readonly scope: { readonly id: string; readonly name: string };
  /** What was read; null when nothing was (a declined request). */
  readonly source: {
    readonly repo: string;
    readonly ref: string | null;
    readonly commit: string;
  } | null;
  readonly results: ReadonlyArray<InstalledSkill>;
  readonly listed: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly path: string;
  }>;
}): JsonValue => {
  const saved = Arr.filter(results, (result) => result.outcome === "installed");

  const changes = Arr.flatMap(saved, (result) =>
    result.change === undefined ? [] : [result.change],
  );

  const installed = boundItems(
    Arr.map(saved, ({ name, path }) => ({ name, path })),
    MAX_SKILL_LIST_BYTES,
  );

  const refused = boundItems(
    Arr.flatMap(results, ({ name, path, outcome, message }) =>
      outcome === "rejected" ? [{ name, path, message: message ?? "refused" }] : [],
    ),
    MAX_SKILL_LIST_BYTES,
  );

  const shown = boundItems(
    Arr.map(listed, ({ name, description, path }) => ({ name, description, path })),
    MAX_SKILL_LIST_BYTES,
  );

  return asOutput(
    SkillInstallEndpointOutput,
    fittedChanges({
      scope: scopeRef(scope),
      ...changesOutput(changes),
      ...boundedUnchanged(
        Arr.flatMap(results, (result) =>
          result.outcome === "unchanged" ? [skillField(result.name)] : [],
        ),
      ),
      changed: saved.length > 0,
      source,
      installed: installed.items,
      installed_truncated: installed.truncated,
      refused: refused.items,
      refused_truncated: refused.truncated,
      listed: shown.items,
      listed_truncated: shown.truncated,
    }),
  );
};

/** The value of `environment_skill_update`, for an Environment's own Skills and an approved update at Global alike. */
export const updateValue = ({
  scope,
  results,
  nothingMarked,
}: {
  readonly scope: { readonly id: string; readonly name: string };
  readonly results: ReadonlyArray<SkillUpdateEntry>;
  /** No Skill was named and none is marked update available: nothing was read. */
  readonly nothingMarked: boolean;
}): JsonValue => {
  const moved = Arr.flatMap(results, (result) => (result.outcome === "updated" ? [result] : []));

  const changes = Arr.flatMap(moved, (result) =>
    result.change === undefined ? [] : [result.change],
  );

  const updated = boundItems(
    Arr.map(moved, ({ name, from, to, overwrote }) => ({
      name,
      from: skillSourceOutput(from),
      to: skillSourceOutput(to),
      overwrote,
    })),
    MAX_SKILL_LIST_BYTES,
  );

  const refused = boundItems(
    Arr.flatMap(results, (result) =>
      result.outcome === "modified" ||
      result.outcome === "rejected" ||
      result.outcome === "changed-since"
        ? [{ name: result.name, outcome: result.outcome, message: result.message }]
        : [],
    ),
    MAX_SKILL_LIST_BYTES,
  );

  return asOutput(
    SkillUpdateEndpointOutput,
    fittedChanges({
      scope: scopeRef(scope),
      ...changesOutput(changes),
      ...boundedUnchanged(
        Arr.flatMap(results, (result) =>
          result.outcome === "unchanged" ? [skillField(result.name)] : [],
        ),
      ),
      changed: moved.length > 0,
      updated: updated.items,
      updated_truncated: updated.truncated,
      refused: refused.items,
      refused_truncated: refused.truncated,
      nothing_marked: nothingMarked,
    }),
  );
};

// ─── Replayed answers ────────────────────────────────────────────────────────

/** Where a Skill was installed from, as a recorded value holds it: none for a Skill that was not installed, or no Skill. */
const sourceOf = (value: RecordedChange["before"]): Option.Option<SkillSource> =>
  Option.flatMap(Schema.decodeUnknownOption(SkillChangeValue)(value), ({ source }) =>
    Option.fromNullishOr(source),
  );

/** The Skill a recorded change names, with where it was installed from before and after (none for a Skill not installed). */
const skillOf = (change: RecordedChange) => ({
  name: fieldSkill(change.field) ?? change.field,
  before: sourceOf(change.before),
  after: sourceOf(change.after),
});

/**
 * An install's replayed answer: one result per change recorded, each Skill named by its change's field and its folder and
 * commit read from the Skill source the change holds after it. The Skills refused or found installed already left no
 * change, so they are not in it: `environment_get` shows what the Environment keeps.
 */
const replayedInstall: Replayed = (changes, id) => {
  const skills = Arr.map(changes, skillOf);

  const source = Option.flatMap(Arr.head(skills), ({ after }) => after);

  const installed = Arr.map(skills, ({ name, after }) => ({
    name,
    path: Option.match(after, { onNone: () => "", onSome: (from) => from.path }),
  }));

  return {
    text: replayedText(changes),
    structured: asOutput(
      SkillInstallEndpointOutput,
      fittedChanges({
        scope: replayedScope(changes, id),
        ...replayedChanges(changes),
        unchanged: [],
        unchanged_truncated: false,
        changed: changes.length > 0,
        source: Option.match(source, {
          onNone: () => null,
          onSome: ({ repo, ref, commit }) => ({ repo, ref: ref ?? null, commit }),
        }),
        installed,
        installed_truncated: false,
        refused: [],
        refused_truncated: false,
        listed: [],
        listed_truncated: false,
        replayed: true as const,
      }),
    ),
    details: null,
  };
};

/** An update's replayed answer: one result per change recorded, from the Skill source before and after; what was refused is not kept. */
const replayedUpdate: Replayed = (changes, id) => {
  const moved = Arr.flatMap(changes, (change) => {
    const { name, before, after } = skillOf(change);

    return Option.match(Option.all({ from: before, to: after }), {
      onNone: () => [],
      onSome: ({ from, to }) => [
        { name, from: skillSourceOutput(from), to: skillSourceOutput(to), overwrote: false },
      ],
    });
  });

  return {
    text: replayedText(changes),
    structured: asOutput(
      SkillUpdateEndpointOutput,
      fittedChanges({
        scope: replayedScope(changes, id),
        ...replayedChanges(changes),
        unchanged: [],
        unchanged_truncated: false,
        changed: changes.length > 0,
        updated: moved,
        updated_truncated: false,
        refused: [],
        refused_truncated: false,
        nothing_marked: false,
        replayed: true as const,
      }),
    ),
    details: null,
  };
};

/** A removal's replayed answer: the Skill's name is in the change's field. */
const replayedRemove: Replayed = (changes, id) => {
  const [first] = changes;
  const skill = first === undefined ? null : fieldSkill(first.field);

  return {
    text: replayedText(changes),
    structured: asOutput(
      SkillRemoveEndpointOutput,
      fittedChanges({
        scope: replayedScope(changes, id),
        ...replayedChanges(changes),
        unchanged: [],
        changed: changes.length > 0,
        skill: skill ?? "",
        global_served: false,
        replayed: true as const,
      }),
    ),
    details: null,
  };
};

/** Each Skill tool's replayed answer, by name (#687 L17): the shared fields from the records, the rest neutral. */
export const SKILL_REPLAYED: Readonly<Record<SkillToolName, Replayed>> = {
  environment_skill_install: replayedInstall,
  environment_skill_update: replayedUpdate,
  environment_skill_remove: replayedRemove,
};
