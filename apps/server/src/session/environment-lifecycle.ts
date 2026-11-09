// The Session's lifecycle operations on Environments (`@cloudpid/extensions/environment`, `docs/architecture/agent-changes.md`):
// the agent makes, renames, adds Repos to and takes Repos out of an Environment, and asks for its Build. Each
// is applied and recorded by the Registry (`agentCreateEnvironment` and the rest), as the owner's RPC applies it; then
// the Session runs the upkeep the main Worker runs after the owner's RPC: the spare Workspace and the Build. No
// Workspace a Session has is touched, so there is no handover to a Workspace DO as for a Container setting.
import type {
  EnvironmentLifecycle,
  RecordChanged,
  RecordMade,
  RecordOutcome,
  TestBuildProgress,
} from "@cloudpid/extensions/environment-lifecycle";
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import {
  type EnvironmentRepo,
  isRepoName,
  MAX_REPO_NAME_LENGTH,
  parseRepoSource,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Builds } from "../registry/builds.ts";
import type { TestBuildState } from "../workspace/build-record.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { Spares } from "../registry/rpc.ts";
import type {
  LifecycleChange,
  LifecycleChanged,
  LifecycleOutcome,
} from "../registry/environment-lifecycle.ts";
import type { EnvironmentRecord } from "../registry/store.ts";
import { type AuthorSource, authored, sessionOf, unlistedSession } from "./change-author.ts";

/** What a Test Build asked for on the endpoint is refused with: one is started from a Session only. */
const TEST_BUILD_FROM_A_SESSION = "A Test Build is started from a Session only.";

/** What the lifecycle operations use of the Registry. */
export type LifecycleRegistry = Pick<
  RegistryMethods,
  | "agentCreateEnvironment"
  | "agentRenameEnvironment"
  | "agentAddRepo"
  | "agentRemoveRepo"
  | "recordRebuild"
  | "getEnvironment"
>;

export type SessionLifecycleOptions = {
  readonly registry: LifecycleRegistry;
  /**
   * Who the changes are made by: the Session (its id in the Registry; undefined when unknown, for a Session that then
   * changes no Environment), or the endpoint's caller.
   */
  readonly author: AuthorSource;
  /**
   * The upkeep of the Builds: kept current after a change, and asked for a Build by `rebuild`; and a Session's Test
   * Builds (none on the endpoint).
   */
  readonly builds: Pick<Builds, "of" | "rebuild"> & { readonly test?: Builds["test"] };
  /** The upkeep of the spare Workspaces, run after the Repos change. */
  readonly spares: Pick<Spares, "of">;
  /**
   * What runs after the Repos of an Environment changed (made with some, one added or one taken out), as the main Worker
   * runs it after the owner's `addRepo` and `removeRepo`: the Repo's `.pi/mcp.json` is looked at (`look`; `repo` is the
   * one added, none for every Repo of a new Environment), and the Environment's MCP server set pushed. Absent in a
   * Session, whose Repos' files are looked at by the owner's own changes only.
   */
  readonly afterRepos?:
    | ((change: {
        readonly environment: string;
        readonly repo?: string | undefined;
        readonly look: boolean;
      }) => Effect.Effect<void>)
    | undefined;
  /** How long one round of waiting for a Test Build lasts at most, and how often it looks; for tests. */
  readonly rounds?: { readonly roundMs: number; readonly pollMs: number } | undefined;
};

/** How long one round of waiting for a Test Build lasts at most: short, so no round depends on outliving an eviction. */
const TEST_BUILD_ROUND_MS = 25_000;

/** How often a round of waiting asks the Test Build object how its Test Build stands. */
const TEST_BUILD_POLL_MS = 5_000;

/** A Test Build's state as the agent's tool reads it; none held (null): gone. */
const testProgress = (state: TestBuildState | null): TestBuildProgress => {
  if (state === null) return { status: "gone" };

  const { startedAt } = state;

  switch (state.status) {
    case "building":
      return { status: "building", startedAt };
    case "failed":
      return { status: "failed", startedAt, finishedAt: state.finishedAt, reason: state.reason };
    case "succeeded":
    case "cancelled":
      return { status: state.status, startedAt, finishedAt: state.finishedAt };
  }
};

/** An Environment as a change names it: its id and name. */
const changedEnvironment = ({ id, name }: EnvironmentRecord) => ({ id, name });

/** Why `name` cannot be the directory a Repo is cloned into, or undefined when it can. */
const directoryProblem = (name: string): string | undefined =>
  isRepoName(name)
    ? undefined
    : `"${name}" is not a usable directory name: use letters, digits, dots, underscores and dashes, starting with a letter or digit, at most ${MAX_REPO_NAME_LENGTH} characters`;

/** A Repo as the owner's `addRepo` reads one: its address from `source`, its directory the repo's own unless named. */
const repoOf = (
  source: string,
  name: string | undefined,
): Result.Result<EnvironmentRepo, string> => {
  const found = parseRepoSource(source);

  if (Result.isFailure(found)) return Result.fail(found.failure);

  const directory = name ?? found.success.name;
  const problem = directoryProblem(directory);

  return problem === undefined
    ? Result.succeed({ name: directory, url: found.success.url })
    : Result.fail(problem);
};

export const sessionLifecycle = ({
  registry,
  author: source,
  builds,
  spares,
  afterRepos,
  rounds = { roundMs: TEST_BUILD_ROUND_MS, pollMs: TEST_BUILD_POLL_MS },
}: SessionLifecycleOptions): EnvironmentLifecycle => {
  const unlisted = EnvironmentsError.make({ message: unlistedSession("Environment") });

  /** The Registry's author of a change, or why the Session changes no Environment. */
  const authorOf = authored(source, unlisted);

  /**
   * Call `call`'s Test Build: its object's id, the Session's, as the call's task is only within it, and the Test Builds.
   * The endpoint has none (its `proposed` Build is a later stage), so a Test Build is refused there, the one place it is.
   */
  const testOf = (call: string) => {
    const owner = sessionOf(source);

    if (source.kind === "endpoint" || builds.test === undefined) {
      return Effect.fail(
        EnvironmentsError.make({ message: TEST_BUILD_FROM_A_SESSION, code: "invalid_argument" }),
      );
    }

    return owner === undefined
      ? Effect.fail(unlisted)
      : Effect.succeed({ id: `${owner}/${call}`, test: builds.test });
  };

  /** A failed call to a Test Build, as the model sees it. */
  const testFailed = (message: string) =>
    EnvironmentsError.make({ message: `${message}. Try again.` });

  /** The spare Workspace and the Build of `environment`, kept current as after the owner's change to its Repos. */
  const keepCurrent = (environment: string) =>
    spares.of(environment).pipe(Effect.andThen(builds.of(environment)));

  return {
    create: ({ name, repos, author: by }) =>
      Effect.gen(function* () {
        const author = yield* authorOf(by);
        const parsed: EnvironmentRepo[] = [];

        for (const url of repos) {
          const repo = repoOf(url, undefined);

          if (Result.isFailure(repo)) {
            return { status: "rejected" as const, message: `${url}: ${repo.failure}` };
          }

          parsed.push(repo.success);
        }

        const made = yield* registry.agentCreateEnvironment({
          name,
          repos: parsed,
          author,
        });

        if (made.status === "rejected") return made;

        // As after the owner's `createEnvironment`: its spare is made ahead, and so is its Build.
        yield* keepCurrent(made.environment.id);

        if (afterRepos !== undefined && parsed.length > 0) {
          yield* afterRepos({ environment: made.environment.id, look: true });
        }

        return {
          status: "made" as const,
          environment: changedEnvironment(made.environment),
          repos: made.environment.repos,
          change: made.change,
        };
      }),
    rename: ({ environment, name, author: by }) =>
      Effect.gen(function* () {
        const answer = yield* registry.agentRenameEnvironment({
          environment,
          name,
          author: yield* authorOf(by),
        });

        return recordChanged(answer);
      }),
    addRepo: ({ environment, source: url, name, author: by }) =>
      Effect.gen(function* () {
        const author = yield* authorOf(by);
        const repo = repoOf(url, name);

        if (Result.isFailure(repo)) return { status: "rejected" as const, message: repo.failure };

        const answer = yield* registry.agentAddRepo({
          environment,
          repo: repo.success,
          author,
        });

        // The spare holds the Repos it was made with: one made before is stale now, and so is the Build.
        if (answer.status === "changed") {
          yield* keepCurrent(environment);
          yield* afterRepos?.({ environment, repo: repo.success.name, look: true }) ?? Effect.void;
        }

        return recordChanged(answer);
      }),
    removeRepo: ({ environment, name, author: by }) =>
      Effect.gen(function* () {
        const answer = yield* registry.agentRemoveRepo({
          environment,
          name,
          author: yield* authorOf(by),
        });

        if (answer.status === "changed") {
          yield* keepCurrent(environment);
          yield* afterRepos?.({ environment, look: false }) ?? Effect.void;
        }

        return recordedChange(answer);
      }),
    rebuild: ({ environment, author: by }) =>
      Effect.gen(function* () {
        const author = yield* authorOf(by);

        const known = yield* registry.getEnvironment({ id: environment });

        if (known === null) return { status: "missing" as const };

        // Why the Build was not asked for, as the owner's Rebuild says it: nothing to build, or the Build object failed.
        const asked = yield* builds.rebuild(environment).pipe(
          Effect.map((answer) => ({ answer })),
          Effect.catch((message) => Effect.succeed({ message })),
        );

        if ("message" in asked) return { status: "rejected" as const, message: asked.message };

        // A Build of the same key was under way: nothing was asked for, so nothing is recorded.
        if (asked.answer === "underway") {
          return { status: "unchanged" as const, environment: changedEnvironment(known) };
        }

        return recordedChange(yield* registry.recordRebuild({ environment, author }));
      }),
    startTestBuild: ({ environment, call, proposed }) =>
      Effect.gen(function* () {
        const { id, test } = yield* testOf(call);
        const found = yield* registry.getEnvironment({ id: environment });

        if (found === null) return { status: "missing" as const };

        // Each proposed Repo as the owner's `addRepo` reads one; two in one directory cannot both be cloned.
        let repos: EnvironmentRepo[] | undefined;

        if (proposed.repos !== undefined) {
          repos = [];

          for (const { url, name } of proposed.repos) {
            const repo = repoOf(url, name);

            if (Result.isFailure(repo)) {
              return { status: "rejected" as const, message: `${url}: ${repo.failure}` };
            }

            if (Arr.some(repos, (each) => each.name === repo.success.name)) {
              return {
                status: "rejected" as const,
                message: `Two repos would be cloned into ${repo.success.name}: give one another directory with name`,
              };
            }

            repos.push(repo.success);
          }
        }

        const started = yield* test
          .start({ environment, id, proposed: { ...proposed, repos } })
          .pipe(
            Effect.map((state) => ({
              status: "started" as const,
              environment: changedEnvironment(found),
              progress: testProgress(state),
            })),
            Effect.catch((message) => Effect.succeed({ status: "rejected" as const, message })),
          );

        return started;
      }),
    testBuildRound: ({ environment, call }) =>
      Effect.gen(function* () {
        const { id, test } = yield* testOf(call);
        const until = (yield* Clock.currentTimeMillis) + rounds.roundMs;

        while (true) {
          const progress = testProgress(
            yield* test.state({ environment, id }).pipe(Effect.mapError(testFailed)),
          );

          const now = yield* Clock.currentTimeMillis;

          if (progress.status !== "building" || now >= until) return progress;

          yield* Effect.sleep(Math.min(rounds.pollMs, until - now));
        }
      }),
    cancelTestBuild: ({ environment, call }) =>
      Effect.gen(function* () {
        const { id, test } = yield* testOf(call);

        yield* test.cancel({ environment, id }).pipe(Effect.mapError(testFailed));
      }),
  };
};

/** The Registry's answer to a change that was made, as the Session reports it; a refusal as it is. */
const recordedChange = (answer: LifecycleOutcome<LifecycleChanged>): RecordOutcome<RecordMade> =>
  answer.status === "changed"
    ? {
        status: "changed",
        environment: changedEnvironment(answer.environment),
        change: answer.change,
      }
    : answer;

/** The Registry's answer to a rename or an add of a Repo, as the Session reports it. */
const recordChanged = (answer: LifecycleChange): RecordChanged => {
  switch (answer.status) {
    case "changed":
      return recordedChange(answer);
    case "unchanged":
      return { status: "unchanged", environment: changedEnvironment(answer.environment) };
    case "rejected":
    case "missing":
      return answer;
  }
};
