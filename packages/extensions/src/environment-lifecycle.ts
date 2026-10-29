// The `environment` extension's tools for an Environment's own record (`docs/architecture/agent-changes.md`): the agent makes
// an Environment, renames it, adds Repos to it and takes them out, and asks for its Build or a Test Build of proposed
// changes. Each change is applied as the owner's RPC is and recorded as an Agent change, like the tools for its Container
// settings; they are the same extension's, built next to those (`EnvironmentTools`) over the same `Environments`. A Test
// Build saves and records nothing. Each tool also gives a program its outcome (`./environment-lifecycle-outputs.ts`): the
// Environment, whether anything changed and the Agent change recorded, and for a Build whether a new one was asked for
// (`docs/architecture/agent-capabilities.md` → Values for programs).
// @effect-diagnostics missingPipeableSignature:off
import { ChordContext, defineEffectTool } from "@cloudpid/effect-durable";
import {
  type AgentChange,
  BUILD_FIELD,
  type EnvironmentRepo,
  fieldRepo,
  NAME_FIELD,
  parseRepoSource,
  repoField,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type ChangeAuthor,
  type ChangedEnvironment,
  type EnvironmentTarget,
  EnvironmentsError,
  type EnvironmentsService,
  Id,
  MAX_CHANGE_REASON,
  type RunChange,
} from "./environment.ts";
import {
  createdOutput,
  EnvironmentCreateOutput,
  RebuildOutput,
  RecordChangeOutput,
  rebuildOutput,
  recordOutput,
} from "./environment-lifecycle-outputs.ts";
import { asOutput, outputSchema } from "./outputs.ts";

/** An Agent change made to an Environment's record, as the Session reports it. */
export type RecordMade = {
  readonly status: "changed";
  readonly environment: ChangedEnvironment;
  /** The change as the Registry recorded it, with the values before and after. */
  readonly change: AgentChange;
};

/** The record already was as asked: nothing was saved or recorded. */
export type RecordUnchanged = {
  readonly status: "unchanged";
  readonly environment: ChangedEnvironment;
};

/** How an Agent change to an Environment's record went: `A` where it was allowed, else why not. */
export type RecordOutcome<A> =
  | A
  /** Not allowed, said as the owner's save says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** How a rename or an add of a Repo went. */
export type RecordChanged = RecordOutcome<RecordMade | RecordUnchanged>;

/** How the agent's making an Environment went. */
export type EnvironmentMade =
  | {
      readonly status: "made";
      readonly environment: ChangedEnvironment;
      readonly repos: ReadonlyArray<EnvironmentRepo>;
      readonly change: AgentChange;
    }
  | { readonly status: "rejected"; readonly message: string };

/**
 * What the Session does for an Environment's record, over the Registry: each applies the change as the owner's RPC
 * does, records it as an Agent change, and runs the spares' and Builds' upkeep the owner's RPC runs. A Repo is
 * given as the owner enters one (`owner/repo` or an `https` URL), checked as theirs is. None of them touches a
 * Workspace a Session has.
 */
export type EnvironmentLifecycle = {
  readonly create: (input: {
    readonly name: string;
    readonly repos: ReadonlyArray<string>;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<EnvironmentMade, EnvironmentsError>;
  readonly rename: (input: {
    readonly environment: string;
    readonly name: string;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<RecordChanged, EnvironmentsError>;
  readonly addRepo: (input: {
    readonly environment: string;
    readonly source: string;
    /** The directory to clone into; the Repo's own name when undefined. */
    readonly name: string | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<RecordChanged, EnvironmentsError>;
  readonly removeRepo: (input: {
    readonly environment: string;
    readonly name: string;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<RecordOutcome<RecordMade>, EnvironmentsError>;
  /**
   * Ask for a new Build now, as the owner's Rebuild does, and record it once it is under way; "unchanged" when a Build
   * of the same Repos and settings was under way already, which records nothing.
   */
  readonly rebuild: (input: {
    readonly environment: string;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<RecordChanged, EnvironmentsError>;
  /**
   * Ask for a Test Build of `environment`'s saved Repos and settings with `proposed` replacing theirs, checked as the
   * saving tools check them, by `call` (the asking call's task: asked again, the same Test Build is found). Nothing is
   * saved or recorded. Refused while another Test Build of the Environment is under way.
   */
  readonly startTestBuild: (input: {
    readonly environment: string;
    readonly call: string;
    readonly proposed: ProposedChanges;
  }) => Effect.Effect<RecordOutcome<TestBuildStarted>, EnvironmentsError>;
  /** One round of waiting for Test Build `call`: how it stands at the round's end, or as soon as it ended. */
  readonly testBuildRound: (input: {
    readonly environment: string;
    readonly call: string;
  }) => Effect.Effect<TestBuildProgress, EnvironmentsError>;
  /** Stop Test Build `call`, if it is under way (its call was stopped). */
  readonly cancelTestBuild: (input: {
    readonly environment: string;
    readonly call: string;
  }) => Effect.Effect<void, EnvironmentsError>;
};

/**
 * What a Test Build tries: any of the inputs to a Build's key, each replacing the Environment's saved one whole (the full
 * list of Repos, as the owner enters one; the full map of variables).
 */
export type ProposedChanges = {
  readonly repos?:
    | ReadonlyArray<{ readonly url: string; readonly name?: string | undefined }>
    | undefined;
  readonly variables?: Readonly<Record<string, string>> | undefined;
  readonly setupScript?: string | undefined;
  readonly toolchains?: string | undefined;
  readonly ignore?: ReadonlyArray<string> | undefined;
};

/** How a Test Build stands. Times are epoch milliseconds. */
export type TestBuildProgress =
  | { readonly status: "building"; readonly startedAt: number }
  | { readonly status: "succeeded"; readonly startedAt: number; readonly finishedAt: number }
  | {
      readonly status: "failed";
      readonly startedAt: number;
      readonly finishedAt: number;
      /** The failing step with the end of its output, redacted as a Build's failure reason is. */
      readonly reason: string;
    }
  | { readonly status: "cancelled"; readonly startedAt: number; readonly finishedAt: number }
  /** Its object no longer holds it: another Test Build took its place, or the object was wiped with its Environment. */
  | { readonly status: "gone" };

/** A Test Build asked for (or found again, for a call asked again), with how it stands. */
export type TestBuildStarted = {
  readonly status: "started";
  readonly environment: ChangedEnvironment;
  readonly progress: TestBuildProgress;
};

const RepoSource = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The repo to clone: owner/repo (a GitHub repo) or a plain https URL. Never put a credential in it",
});

const RepoDirectory = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The directory below /workspace the repo is cloned into (default: the repo's own name): letters, digits, dots, underscores and dashes, starting with a letter or digit",
});

/** A name or address a change holds before or after, as text; none for a change that had none. */
const shown = (value: AgentChange["before"]): string => (Predicate.isString(value) ? value : "");

/** An Environment as a result names it: its name in quotes, then its id. */
const named = ({ id, name }: ChangedEnvironment): string =>
  `Environment ${JSON.stringify(name)} (${id})`;

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json | null): JsonValue | null => value as JsonValue | null;

/** A duration as a result says it: seconds, or minutes and seconds. */
const durationWords = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));

  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

/** The fields `environment_rebuild` takes in `proposed`, by name, and the tools that save each. */
const SAVING_TOOLS = {
  repos: "environment_repo_add and environment_repo_remove",
  variables: "environment_variable_set and environment_variable_unset",
  setup_script: "environment_setup_script_set",
  toolchains: "environment_toolchains_set",
  ignore: "environment_ignore_set",
} as const;

/** What a Test Build's call keeps in its memo: that a Build of the saved settings was asked for once. */
const REBUILD_ASKED = "environment-rebuild-asked";

/** What a Test Build's call keeps in its memo once it asked for one: the Environment, by id and name. */
const TEST_BUILD_ASKED = "environment-test-build-asked";

/** Consecutive failed rounds of waiting before the wait for a Test Build gives up (the Test Build goes on). */
const MAX_ROUND_FAILURES = 5;

/** The Environment a call's memo kept (`TEST_BUILD_ASKED`), or undefined when it kept none. */
const rememberedEnvironment = (value: JsonValue | undefined): ChangedEnvironment | undefined =>
  Predicate.isObject(value) &&
  !Arr.isArray(value) &&
  Predicate.isString(value["id"]) &&
  Predicate.isString(value["name"])
    ? { id: value["id"], name: value["name"] }
    : undefined;

/** Read (no `candidate`) or keep the call's memo `name` through the call's pi-durable API. */
const memo = (api: ToolExecutionApi, name: string, candidate?: JsonValue) =>
  Effect.gen(function* () {
    const chord = yield* ChordContext;

    return yield* Effect.tryPromise({
      try: (signal) => {
        const context = withAbortSignal(signal, chord);

        return candidate === undefined
          ? api.memo<JsonValue>(name, context)
          : api.memo(name, candidate, context);
      },
      catch: (cause) =>
        EnvironmentsError.make({
          message: `Keeping the call's progress failed: ${String(cause)}. Try again.`,
        }),
    });
  });

const WORKSPACES_UNTOUCHED =
  "Only the Environment's record and its spare Workspace change: no Workspace a Session has gets a clone or loses one, this Session's included.";

/** What the tools of this file need of `EnvironmentTools`: what it builds them over, and its refusals. */
export type LifecycleDeps = {
  readonly environments: EnvironmentsService;
  /** Where the Run's Agent changes are kept for the Notification of its end. */
  readonly log: { readonly record: (change: RunChange) => Effect.Effect<void> };
  /**
   * Fails when any of `texts` holds the value of a Secret the Session holds or of a deploy-time credential, saying
   * `outcome` (by default that nothing was saved).
   */
  readonly refuseSecrets: (
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
    outcome?: string,
  ) => Effect.Effect<void, EnvironmentsError>;
  readonly target: EnvironmentTarget;
  readonly notFound: (id: string) => EnvironmentsError;
};

/**
 * The tools that change an Environment's record: `environment_create`, `environment_rename`, `environment_repo_add`,
 * `environment_repo_remove` and `environment_rebuild`. All run alone and are not replayed after an eviction, which would
 * record the change again.
 */
export const lifecycleTools = ({
  environments,
  log,
  refuseSecrets,
  target,
  notFound,
}: LifecycleDeps) => {
  // Built here, not at the module's top: `environment.ts` imports this file, so its exports are not there yet then.
  const Reason = Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CHANGE_REASON),
  ).annotate({
    description:
      "Why you make the change, for the user to read in the Environment's Agent changes, such as 'the API lives in a second repo'",
  });

  /** Say `message` as a refusal: nothing was saved. */
  const refused = (message: string) =>
    EnvironmentsError.make({ message: `Nothing was saved: ${message}` });

  /** The result of a change that was recorded: its text, what the card shows, and the value a program gets. */
  const recordedResult = (
    tool: string,
    environment: ChangedEnvironment,
    change: AgentChange,
    text: string,
    structuredOutput: JsonValue,
  ) =>
    log.record({ tool, environmentName: environment.name, field: change.field }).pipe(
      Effect.as({
        output: [{ type: "text" as const, text }],
        structuredOutput,
        details: {
          agentChange: {
            id: change.id,
            environment,
            field: change.field,
            before: asJsonValue(change.before),
            after: asJsonValue(change.after),
          },
        },
      }),
    );

  /** The result of a change that found the record as asked already. */
  const unchangedResult = (
    text: string,
    environment: ChangedEnvironment,
    structuredOutput: JsonValue,
  ) => ({
    output: [{ type: "text" as const, text }],
    structuredOutput,
    details: { unchanged: { environment } },
  });

  /** The value of a change to the record of `environment`: `change` is null for one that was as asked already. */
  const recordValue = (
    environment: ChangedEnvironment,
    change: AgentChange | null,
    field: string,
  ) => asOutput(RecordChangeOutput, recordOutput({ environment, change, unchanged: [field] }));

  /** The Environment `environment` names, by id and name: the id again when the Registry does not show it. */
  const environmentNamed = (environment: string) =>
    environments.get(environment).pipe(
      Effect.map((details) => ({ id: environment, name: details?.name ?? environment })),
      Effect.orElseSucceed(() => ({ id: environment, name: environment })),
    );

  /** Apply `change` to the Environment `id` names; what it answers for each outcome but a recorded change. */
  const applied = <A extends RecordMade | RecordUnchanged>(
    id: string,
    change: (environment: string) => Effect.Effect<RecordOutcome<A>, EnvironmentsError>,
  ) =>
    Effect.gen(function* () {
      const { environment } = yield* target(id);
      const answer = yield* change(environment);

      switch (answer.status) {
        case "missing":
          return yield* notFound(environment);
        case "rejected":
          return yield* refused(answer.message);
        default:
          return answer;
      }
    });

  const create = defineEffectTool({
    name: "environment_create",
    description: Arr.join(
      [
        "Make an Environment with a name and Repos, and the default Container settings: the same name rules as the user's (1 to 80 characters, free among the Environments whatever the case). Its Repos are given as owner/repo or plain https URLs, each cloned into a directory of its own below /workspace by the Workspaces made from it. A spare Workspace and a Build are made for it as for one the user makes.",
        "It answers the new Environment's id. The new Environment is not this Session's: this Session stays in its own Workspace, and you cannot start a Session in another Environment. Set it up by passing its id as id to the other environment_* tools; the user starts a Session in it from the Environments page.",
        "The change is recorded with your reason, and the user can see it on the Environments page. Making an Environment cannot be reverted, since deleting one needs the user's approval.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      name: Schema.String.annotate({
        description: "The Environment's name, such as 'Billing API'",
      }),
      repos: RepoSource.pipe(Schema.Array, Schema.optionalKey),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(EnvironmentCreateOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ name, repos, reason }, api) =>
      Effect.gen(function* () {
        const sources = repos ?? [];

        yield* refuseSecrets([
          { what: "the name", text: name },
          { what: "a repo", text: Arr.join(sources, " ") },
          { what: "the reason", text: reason },
        ]);

        const made = yield* environments.create({
          name,
          repos: sources,
          author: { conversation: api.conversationId, tool: "environment_create", reason },
        });

        if (made.status === "rejected") return yield* refused(made.message);

        const { environment, repos: held } = made;

        return yield* recordedResult(
          "environment_create",
          environment,
          made.change,
          Arr.join(
            [
              `Made ${named(environment)} with ${
                held.length === 0
                  ? "no repos"
                  : `the repos ${Arr.join(
                      Arr.map(held, (repo) => `${repo.name} (${repo.url})`),
                      ", ",
                    )}`
              } and the default Container settings. Its id is ${environment.id}: pass it as id to the other environment_* tools to set it up.`,
              "It is not this Session's Environment, and you cannot start a Session in it: the user can, from the Environments page. Its spare Workspace and its Build are made as for an Environment the user makes (environment_get shows the Build).",
            ],
            " ",
          ),
          createdOutput({
            environment,
            repos: held,
            change: made.change,
          }),
        );
      }),
  });

  const rename = defineEffectTool({
    name: "environment_rename",
    description:
      "Rename an Environment (the one id names): the same name rules as the user's (1 to 80 characters, free among the Environments whatever the case). Its id never changes. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
    parameters: Schema.Struct({
      id: Id,
      name: Schema.String.annotate({ description: "The new name" }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(RecordChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the name", text: name },
          { what: "the reason", text: reason },
        ]);

        const answer = yield* applied(id, (environment) =>
          environments.rename({
            environment,
            name,
            author: { conversation: api.conversationId, tool: "environment_rename", reason },
          }),
        );

        if (answer.status === "unchanged") {
          return unchangedResult(
            `${named(answer.environment)} already has that name: nothing changed, and nothing was recorded.`,
            answer.environment,
            recordValue(answer.environment, null, NAME_FIELD),
          );
        }

        const { environment, change } = answer;

        return yield* recordedResult(
          "environment_rename",
          environment,
          change,
          `Renamed "${shown(change.before)}" to "${shown(change.after)}": ${named(environment)}. Its id is the same.`,
          recordValue(environment, change, change.field),
        );
      }),
  });

  const repoAdd = defineEffectTool({
    name: "environment_repo_add",
    description: Arr.join(
      [
        "Add a Repo to an Environment (the one id names), for the Workspaces made from then on: the same rules as the user's. It is cloned into /workspace/<name> by a Workspace's first use. The Environment's spare Workspace is made again, and its Build is made with the Repo.",
        "Only the Environment's record and its spare Workspace change: no Workspace a Session has gets the clone, this Session's included. A new Workspace gets it. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Id,
      url: RepoSource,
      name: Schema.optionalKey(RepoDirectory),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(RecordChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, url, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the repo", text: url },
          { what: "the directory", text: name ?? "" },
          { what: "the reason", text: reason },
        ]);

        const answer = yield* applied(id, (environment) =>
          environments.addRepo({
            environment,
            source: url,
            name,
            author: { conversation: api.conversationId, tool: "environment_repo_add", reason },
          }),
        );

        if (answer.status === "unchanged") {
          return unchangedResult(
            `${named(answer.environment)} has that repo already: nothing changed, and nothing was recorded.`,
            answer.environment,
            recordValue(
              answer.environment,
              null,
              // The directory it is cloned into: the one named, else the Repo's own name.
              repoField(
                name ??
                  Result.match(parseRepoSource(url), {
                    onSuccess: (repo) => repo.name,
                    onFailure: () => url,
                  }),
              ),
            ),
          );
        }

        const { environment, change } = answer;

        return yield* recordedResult(
          "environment_repo_add",
          environment,
          change,
          `Added the repo ${fieldRepo(change.field) ?? ""} (${shown(change.after)}) to ${named(environment)}. ${WORKSPACES_UNTOUCHED} A new Workspace made from the Environment gets the clone.`,
          recordValue(environment, change, change.field),
        );
      }),
  });

  const repoRemove = defineEffectTool({
    name: "environment_repo_remove",
    description: Arr.join(
      [
        "Take a Repo out of an Environment (the one id names), by its directory name as environment_get shows it: the same rules as the user's. The Environment's spare Workspace is made again, and its Build is made without the Repo.",
        "Only the Environment's record and its spare Workspace change: no Workspace a Session has loses its clone, this Session's included. A new Workspace does not get one. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Id,
      name: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The repo's directory name below /workspace, as environment_get shows it",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(RecordChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the name", text: name },
          { what: "the reason", text: reason },
        ]);

        const answer = yield* applied(id, (environment) =>
          environments.removeRepo({
            environment,
            name,
            author: { conversation: api.conversationId, tool: "environment_repo_remove", reason },
          }),
        );

        const { environment, change } = answer;

        return yield* recordedResult(
          "environment_repo_remove",
          environment,
          change,
          `Took the repo ${name} (${shown(change.before)}) out of ${named(environment)}. ${WORKSPACES_UNTOUCHED} A new Workspace made from the Environment does not get the clone.`,
          recordValue(environment, change, change.field),
        );
      }),
  });

  const Proposed = Schema.Struct({
    repos: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ url: RepoSource, name: Schema.optionalKey(RepoDirectory) }),
      ).annotate({
        description:
          "The whole list of Repos, replacing the Environment's: each as environment_repo_add takes one",
      }),
    ),
    variables: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String).annotate({
        description:
          "The whole map of the Environment's own variables (NAME to value), replacing them; plain, under the same rules as environment_variable_set. The variables kept Global still apply under it, and the 50 counts both",
      }),
    ),
    setup_script: Schema.optionalKey(
      Schema.String.annotate({
        description: "The Environment's whole Setup Script (bash); empty: none",
      }),
    ),
    toolchains: Schema.optionalKey(
      Schema.String.annotate({
        description: "The whole mise.toml of the Toolchains; empty: the image's base Toolchains",
      }),
    ),
    ignore: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description: "The whole list of extra Container-only paths",
      }),
    ),
  }).annotate({
    description:
      "Make a Test Build of these proposed changes instead of a Build of the saved settings: each field given replaces the saved one whole, the others stay as saved. Nothing is saved.",
  });

  type Proposal = typeof Proposed.Type;

  /** Ask for a Build of the saved settings, recorded as an Agent change: once, though the call is run again. */
  const rebuildSaved = (id: string, reason: string, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      yield* refuseSecrets([{ what: "the reason", text: reason }]);

      // A rerun after an eviction asks for nothing: the first run may have asked and recorded already.
      if ((yield* memo(api, REBUILD_ASKED)) !== undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: `This call was cut off after it began asking for the Build, so it asks for nothing again (that would record the request twice). environment_get with id ${id} shows whether the Build is under way; call environment_rebuild again with the same id if it is not.`,
            },
          ],
          structuredOutput: rebuildOutput({
            environment: yield* environmentNamed(id),
            change: null,
            unchanged: [],
            rerun: true,
          }),
          details: { rerun: true },
        };
      }

      yield* memo(api, REBUILD_ASKED, true);

      const answer = yield* applied(id, (environment) =>
        environments.rebuild({
          environment,
          author: { conversation: api.conversationId, tool: "environment_rebuild", reason },
        }),
      );

      if (answer.status === "unchanged") {
        return unchangedResult(
          `A Build of ${named(answer.environment)} for its current Repos and settings is already under way: nothing was asked for, and nothing was recorded. environment_get with id ${answer.environment.id} shows how it goes.`,
          answer.environment,
          rebuildOutput({
            environment: answer.environment,
            change: null,
            unchanged: [BUILD_FIELD],
          }),
        );
      }

      const { environment, change } = answer;

      return yield* recordedResult(
        "environment_rebuild",
        environment,
        change,
        `Asked for a new Build of ${named(environment)}: the Build is under way. environment_get with id ${environment.id} shows its state and, when it fails, the end of its reason.`,
        rebuildOutput({ environment, change, unchanged: [] }),
      );
    });

  /** Wait in rounds until the Test Build `call` of `environment` ends; how it ended. */
  const waitForTest = (environment: string, call: string, first: TestBuildProgress) =>
    Effect.gen(function* () {
      let progress = first;
      let failures = 0;

      while (progress.status === "building") {
        const round = yield* Effect.result(environments.testBuildRound({ environment, call }));

        if (Result.isFailure(round)) {
          failures += 1;

          if (failures >= MAX_ROUND_FAILURES) {
            return yield* EnvironmentsError.make({
              message: `Waiting for the Test Build failed: ${round.failure.message} It may still be running, and another is refused until it ends.`,
            });
          }

          yield* Effect.sleep("5 seconds");
          continue;
        }

        failures = 0;
        progress = round.success;
      }

      return progress;
    });

  /**
   * Make a Test Build of `proposed` and wait for it: nothing is saved or recorded. The call's task names it, and its
   * memo keeps that it was asked for, so a rerun after an eviction waits for the same one without asking again; a call
   * that is stopped (Stop) cancels it.
   */
  const testBuild = (id: string, reason: string, proposed: Proposal, api: ToolExecutionApi) =>
    Effect.gen(function* () {
      const fields = Arr.filter(
        Record.keys(SAVING_TOOLS),
        (field) => proposed[field] !== undefined,
      );

      yield* refuseSecrets(
        [
          ...Arr.flatMap(proposed.repos ?? [], (repo) => [
            { what: "a repo", text: repo.url },
            { what: "a repo's directory", text: repo.name ?? "" },
          ]),
          ...Arr.flatMap(Record.toEntries(proposed.variables ?? {}), ([name, value]) => [
            { what: "a variable's name", text: name },
            { what: `the value of ${name}`, text: value },
          ]),
          { what: "the Setup Script", text: proposed.setup_script ?? "" },
          { what: "the Toolchains", text: proposed.toolchains ?? "" },
          ...Arr.map(proposed.ignore ?? [], (text) => ({ what: "a Container-only path", text })),
          { what: "the reason", text: reason },
        ],
        "Nothing was built",
      );

      const { environment } = yield* target(id);
      const call = String(api.taskId);

      const cancel = environments
        .cancelTestBuild({ environment, call })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Stopping the Test Build of a stopped call failed", cause),
          ),
        );

      const { asked, ended } = yield* Effect.gen(function* () {
        const known = rememberedEnvironment(yield* memo(api, TEST_BUILD_ASKED));

        // Asked for by this call already (the rerun after an eviction): the first round says how it stands.
        if (known !== undefined) {
          return {
            asked: known,
            ended: yield* waitForTest(environment, call, { status: "building", startedAt: 0 }),
          };
        }

        const answer = yield* environments.startTestBuild({
          environment,
          call,
          proposed: {
            repos: proposed.repos,
            variables: proposed.variables,
            setupScript: proposed.setup_script,
            toolchains: proposed.toolchains,
            ignore: proposed.ignore,
          },
        });

        switch (answer.status) {
          case "missing":
            return yield* notFound(environment);
          case "rejected":
            return yield* EnvironmentsError.make({
              message: `Nothing was built: ${answer.message}`,
            });
          case "started":
            yield* memo(api, TEST_BUILD_ASKED, { ...answer.environment });

            return {
              asked: answer.environment,
              ended: yield* waitForTest(environment, call, answer.progress),
            };
        }
      }).pipe(
        // Stopped before it ended: the Test Build goes with it. An eviction runs no finalizer, and the rerun waits for
        // the same one; a wait that failed leaves it to end on its own.
        Effect.onInterrupt(() => cancel),
      );

      const where = named(asked);
      const proposal = fields.length === 0 ? "its saved settings" : Arr.join(fields, ", ");

      switch (ended.status) {
        case "succeeded": {
          const tookMs = ended.finishedAt - ended.startedAt;

          return {
            output: [
              {
                type: "text" as const,
                text: Arr.join(
                  [
                    `The Test Build of ${where} with the proposed ${proposal} succeeded in ${durationWords(tookMs)}: every step of a Build passed (the clones, the Toolchains, the Setup Scripts and the clean-up; a Test Build takes no snapshot).`,
                    "Nothing was saved or recorded, and no Workspace starts from it.",
                    fields.length === 0
                      ? ""
                      : `To keep the change, save the proposed fields with the setting tools (${Arr.join(
                          Arr.map(fields, (field) => `${field}: ${SAVING_TOOLS[field]}`),
                          "; ",
                        )}); a Build of the saved settings then follows.`,
                  ],
                  " ",
                ).trim(),
              },
            ],
            structuredOutput: rebuildOutput({
              environment: asked,
              change: null,
              unchanged: [],
              testBuild: { proposed: fields, tookMs },
            }),
            details: {
              testBuild: {
                environment: asked,
                status: "succeeded",
                tookMs,
                proposed: [...fields],
              },
            },
          };
        }

        case "failed":
          return yield* EnvironmentsError.make({
            message: `The Test Build of ${where} with the proposed ${proposal} failed after ${durationWords(ended.finishedAt - ended.startedAt)}: ${ended.reason}\n\nNothing was saved: the Environment's settings and its last good Build are as they were. Change the proposal and call environment_rebuild with it again.`,
          });
        case "cancelled":
          return yield* EnvironmentsError.make({
            message: `The Test Build of ${where} was stopped before it ended. Nothing was saved.`,
          });
        case "gone":
          return yield* EnvironmentsError.make({
            message: `The Test Build of ${where} is no longer known: it ended and another Test Build took its place, or the Environment was deleted. Nothing was saved; call environment_rebuild with the same id and the proposal again to try it.`,
          });
      }
    });

  const rebuild = defineEffectTool({
    name: "environment_rebuild",
    description: Arr.join(
      [
        "Ask for a new Build of an Environment now (the one id names), as the user's Rebuild does: its Repos cloned and its Toolchains and Setup Script run on a fresh Container, then snapshotted, for the Workspaces made from then on to start from. A Build already under way for the same Repos and settings is left to finish. An Environment with no Repos, no Setup Script and no Toolchains has nothing to build.",
        "Without proposed it answers at once, with the Build under way: environment_get shows how it goes and, when it fails, the end of its reason. The request is recorded with your reason. It cannot be reverted.",
        "With proposed it makes a Test Build instead, to check a change before saving it: a Build of the Environment's saved Repos and settings with the proposed fields replaced (repos, the full list; variables, the full map; setup_script; toolchains; ignore), made as a Build is, on a Container of its own. The same rules and Secret refusal as the saving tools apply. Nothing is saved or recorded, no Workspace starts from it, and a Build under way goes on beside it. The call waits until it ends, which can take many minutes, then answers the time it took, or the failing step with the end of its output. If it succeeded, save the fields with the setting tools. One Test Build runs per Environment at a time; Stop cancels it.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Id,
      reason: Reason,
      proposed: Schema.optionalKey(Proposed),
    }),
    structuredOutputSchema: outputSchema(RebuildOutput),
    executionMode: "sequential",
    // A rerun after an eviction waits for the same Test Build, and asks for a Build of the saved settings only once.
    replay: "safe",
    execute: ({ id, reason, proposed }, api) =>
      proposed === undefined ? rebuildSaved(id, reason, api) : testBuild(id, reason, proposed, api),
  });

  return Effect.all([create, rename, repoAdd, repoRemove, rebuild]);
};
