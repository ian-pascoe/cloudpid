// The Session's lifecycle operations on Environments (`@cloudpid/extensions/environment`, `docs/spec.md` → Agent
// changes): the agent makes, renames, adds Repos to and takes Repos out of an Environment, and asks for its Build. Each
// is applied and recorded by the Registry (`agentCreateEnvironment` and the rest), as the owner's RPC applies it; then
// the Session runs the upkeep the main Worker runs after the owner's RPC: the spare Workspace and the Build. No
// Workspace a Session has is touched, so there is no handover to a Workspace DO as for a Container setting.
import type {
  EnvironmentLifecycle,
  RecordChanged,
  RecordMade,
  RecordOutcome,
} from "@cloudpid/extensions/environment-lifecycle";
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import {
  type EnvironmentRepo,
  isRepoName,
  MAX_REPO_NAME_LENGTH,
  parseRepoSource,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Builds } from "../registry/builds.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { Spares } from "../registry/rpc.ts";
import type {
  LifecycleChange,
  LifecycleChanged,
  LifecycleOutcome,
} from "../registry/environment-lifecycle.ts";
import type { EnvironmentRecord } from "../registry/store.ts";

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
  /** The Session's id in the Registry; undefined when unknown, for a Session that then changes no Environment. */
  readonly session: string | undefined;
  /** The upkeep of the Builds: kept current after a change, and asked for a Build by `rebuild`. */
  readonly builds: Pick<Builds, "of" | "rebuild">;
  /** The upkeep of the spare Workspaces, run after the Repos change. */
  readonly spares: Pick<Spares, "of">;
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
  session,
  builds,
  spares,
}: SessionLifecycleOptions): EnvironmentLifecycle => {
  /** The Session's id, or why it changes no Environment. */
  const author = Effect.fromNullishOr(session).pipe(
    Effect.mapError(() =>
      EnvironmentsError.make({
        message: "This Session is not one the Registry lists, so it changes no Environment.",
      }),
    ),
  );

  /** The spare Workspace and the Build of `environment`, kept current as after the owner's change to its Repos. */
  const keepCurrent = (environment: string) =>
    spares.of(environment).pipe(Effect.andThen(builds.of(environment)));

  return {
    create: ({ name, repos, author: by }) =>
      Effect.gen(function* () {
        const owner = yield* author;
        const parsed: EnvironmentRepo[] = [];

        for (const source of repos) {
          const repo = repoOf(source, undefined);

          if (Result.isFailure(repo)) {
            return { status: "rejected" as const, message: `${source}: ${repo.failure}` };
          }

          parsed.push(repo.success);
        }

        const made = yield* registry.agentCreateEnvironment({
          name,
          repos: parsed,
          author: { session: owner, ...by },
        });

        if (made.status === "rejected") return made;

        // As after the owner's `createEnvironment`: its spare is made ahead, and so is its Build.
        yield* keepCurrent(made.environment.id);

        return {
          status: "made" as const,
          environment: changedEnvironment(made.environment),
          repos: made.environment.repos,
          change: made.change,
        };
      }),
    rename: ({ environment, name, author: by }) =>
      Effect.gen(function* () {
        const owner = yield* author;

        const answer = yield* registry.agentRenameEnvironment({
          environment,
          name,
          author: { session: owner, ...by },
        });

        return recordChanged(answer);
      }),
    addRepo: ({ environment, source, name, author: by }) =>
      Effect.gen(function* () {
        const owner = yield* author;
        const repo = repoOf(source, name);

        if (Result.isFailure(repo)) return { status: "rejected" as const, message: repo.failure };

        const answer = yield* registry.agentAddRepo({
          environment,
          repo: repo.success,
          author: { session: owner, ...by },
        });

        // The spare holds the Repos it was made with: one made before is stale now, and so is the Build.
        if (answer.status === "changed") yield* keepCurrent(environment);

        return recordChanged(answer);
      }),
    removeRepo: ({ environment, name, author: by }) =>
      Effect.gen(function* () {
        const owner = yield* author;

        const answer = yield* registry.agentRemoveRepo({
          environment,
          name,
          author: { session: owner, ...by },
        });

        if (answer.status === "changed") yield* keepCurrent(environment);

        return recordedChange(answer);
      }),
    rebuild: ({ environment, author: by }) =>
      Effect.gen(function* () {
        const owner = yield* author;

        if ((yield* registry.getEnvironment({ id: environment })) === null) {
          return { status: "missing" as const };
        }

        // Why the Build was not asked for, as the owner's Rebuild says it: nothing to build, or the Build object failed.
        const refused = yield* builds.rebuild(environment).pipe(
          Effect.as(undefined),
          Effect.catch((message) => Effect.succeed(message)),
        );

        if (refused !== undefined) return { status: "rejected" as const, message: refused };

        return recordedChange(
          yield* registry.recordRebuild({ environment, author: { session: owner, ...by } }),
        );
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
