// The `environment` extension's tools for an Environment's own record (`docs/architecture/agent-changes.md`): the agent makes
// an Environment, renames it, adds Repos to it and takes them out, and asks for its Build or a Test Build of proposed
// changes. Each change is applied as the owner's RPC is and recorded as an Agent change, like the tools for its Container
// settings; they are the same extension's, built next to those (`EnvironmentTools`) over the same `Environments`. A Test
// Build saves and records nothing. Each tool also gives a program its outcome (`./environment-lifecycle-outputs.ts`): the
// Environment, whether anything changed and the Agent change recorded, and for a Build whether a new one was asked for
// (`docs/architecture/agent-capabilities.md` → Values for programs).
// @effect-diagnostics missingPipeableSignature:off
import { ChordContext, defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange, EnvironmentRepo } from "@cloudpid/protocol";
import { HARNESS_TOOLS } from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import {
  type ChangeAuthor,
  type ChangedEnvironment,
  type EnvironmentTarget,
  EnvironmentsError,
  type EnvironmentsService,
  type RunChange,
} from "./environment.ts";
import type { LifecycleCores } from "./environment-lifecycle-changes.ts";
import { rebuildOutput } from "./environment-lifecycle-outputs.ts";
import { type HarnessWriteAnswer, loggedOf, toolResult } from "./harness.ts";
import { outputSchema } from "./outputs.ts";

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

/** An Environment as a result names it: its name in quotes, then its id. */
const named = ({ id, name }: ChangedEnvironment): string =>
  `Environment ${JSON.stringify(name)} (${id})`;

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
export const lifecycleTools = (
  { environments, log, refuseSecrets, target, notFound }: LifecycleDeps,
  cores: LifecycleCores,
) => {
  /** A core's answer as the Session's tool returns it, once the Run's Notification is told of the change it made. */
  const inSession = (answer: Effect.Effect<HarnessWriteAnswer, EnvironmentsError>) =>
    answer.pipe(
      Effect.tap(({ logged }) => Effect.forEach(loggedOf(logged), log.record, { discard: true })),
      Effect.map(toolResult),
    );

  /** The Environment `environment` names, by id and name: the id again when the Registry does not show it. */
  const environmentNamed = (environment: string) =>
    environments.get(environment).pipe(
      Effect.map((details) => ({ id: environment, name: details?.name ?? environment })),
      Effect.orElseSucceed(() => ({ id: environment, name: environment })),
    );

  const create = defineEffectTool({
    name: HARNESS_TOOLS.environment_create.name,
    description: HARNESS_TOOLS.environment_create.session.description,
    parameters: HARNESS_TOOLS.environment_create.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_create.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_create(args, "session", api.conversationId)),
  });

  const rename = defineEffectTool({
    name: HARNESS_TOOLS.environment_rename.name,
    description: HARNESS_TOOLS.environment_rename.session.description,
    parameters: HARNESS_TOOLS.environment_rename.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_rename.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_rename(args, "session", api.conversationId)),
  });

  const repoAdd = defineEffectTool({
    name: HARNESS_TOOLS.environment_repo_add.name,
    description: HARNESS_TOOLS.environment_repo_add.session.description,
    parameters: HARNESS_TOOLS.environment_repo_add.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_repo_add.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_repo_add(args, "session", api.conversationId)),
  });

  const repoRemove = defineEffectTool({
    name: HARNESS_TOOLS.environment_repo_remove.name,
    description: HARNESS_TOOLS.environment_repo_remove.session.description,
    parameters: HARNESS_TOOLS.environment_repo_remove.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_repo_remove.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.environment_repo_remove(args, "session", api.conversationId)),
  });

  type Proposal = NonNullable<
    (typeof HARNESS_TOOLS.environment_rebuild.session.input.Type)["proposed"]
  >;

  /**
   * Ask for a Build of the saved settings, recorded as an Agent change: once, though the call is run again. The memo is the
   * Session's own (on the endpoint a repeat's `request_id` finds the claim), so it stays here and the core asks.
   */
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

      return yield* inSession(
        cores.environment_rebuild({ id, reason }, "session", api.conversationId),
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
    name: HARNESS_TOOLS.environment_rebuild.name,
    description: HARNESS_TOOLS.environment_rebuild.session.description,
    parameters: HARNESS_TOOLS.environment_rebuild.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_rebuild.session.output),
    executionMode: "sequential",
    // A rerun after an eviction waits for the same Test Build, and asks for a Build of the saved settings only once.
    replay: "safe",
    execute: ({ id, reason, proposed }, api) =>
      proposed === undefined ? rebuildSaved(id, reason, api) : testBuild(id, reason, proposed, api),
  });

  return Effect.all([create, rename, repoAdd, repoRemove, rebuild]);
};
