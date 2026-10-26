// The Session's `Environments` (`@cloudpid/extensions/environment`, `docs/spec.md` → Agent changes): the Registry's
// Environments, read and changed for the agent. A change is applied and recorded by the Registry (`changeEnvironment`),
// as the owner's save is applied; then, as after that save, the Builds' upkeep runs for the Environment, and a change to
// the Session's own Environment is handed to its Workspace at once (`updateContainerSettings`), which applies it at its
// next Container start. Other Environments' Workspaces get it at their next readying, as they get the owner's.
import type {
  AppliedChange,
  EnvironmentDetails,
  EnvironmentListing,
  EnvironmentsService,
  KeptSecretListing,
} from "@cloudpid/extensions/environment";
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import type { BuildView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { EnvironmentRecord } from "../registry/store.ts";
import type { EnvironmentLifecycle } from "@cloudpid/extensions/environment-lifecycle";
import type { Builds } from "../registry/builds.ts";
import type { Placement } from "./workspace.ts";

/** What the Session's Environments read and change in the Registry. */
export type EnvironmentsRegistry = Pick<
  RegistryMethods,
  | "listEnvironments"
  | "listBuilds"
  | "getEnvironment"
  | "getEnvironmentSettings"
  | "listEnvironmentSecrets"
  | "changeEnvironment"
  | "getWorkspace"
>;

export type SessionEnvironmentsOptions = {
  readonly registry: EnvironmentsRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then belongs to no Environment. */
  readonly session: string | undefined;
  /** Where the Session works: its Workspace, whose Environment is the Session's. */
  readonly placement: () => Promise<Placement>;
  /** Hand an Environment's new Container settings overrides to the Workspace DO `object`. */
  readonly handOver: (
    object: string,
    overrides: Schema.Json,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** The Builds' upkeep, run for an Environment after each change, as after the owner's save. */
  readonly builds: Pick<Builds, "of">;
  /** What the agent does to an Environment's own record: make, rename, Repos, Build (`sessionLifecycle`). */
  readonly lifecycle: EnvironmentLifecycle;
};

const NO_BUILD: BuildView = { status: "none" };

/** The Secrets `environment` uses, by name: its own, then those kept for every Environment that it does not override. */
const keptFor = (
  environment: string,
  records: Effect.Success<ReturnType<RegistryMethods["listEnvironmentSecrets"]>>,
): ReadonlyArray<KeptSecretListing> => {
  const own = Arr.filter(records, (record) => record.environment === environment);
  const names = new Set(Arr.map(own, (record) => record.name));

  return [
    ...Arr.map(own, ({ name, build }) => ({ name, scope: "environment" as const, build })),
    ...Arr.map(
      Arr.filter(records, (record) => record.environment === null && !names.has(record.name)),
      ({ name, build }) => ({ name, scope: "every" as const, build }),
    ),
  ];
};

/** An Environment as a change names it: its id and name. */
const changedEnvironment = ({ id, name }: EnvironmentRecord) => ({ id, name });

/** The error of a failed call to the Registry or the Workspace, as the model sees it. */
const failedCall = (what: string) => (cause: unknown) =>
  EnvironmentsError.make({ message: `${what} failed: ${String(cause)}. Try again.` });

export const sessionEnvironments = ({
  registry,
  session,
  placement,
  handOver,
  builds,
  lifecycle,
}: SessionEnvironmentsOptions): EnvironmentsService => {
  /** The Session's Workspace and its Environment, once found: neither changes for the Session's life. */
  let found: { readonly object: string; readonly environment: string } | undefined;

  const where = Effect.gen(function* () {
    if (found !== undefined) return found;

    const { workspace, object } = yield* Effect.tryPromise({
      try: placement,
      catch: failedCall("Finding the Session's Workspace"),
    });

    const record =
      session === undefined || workspace === null
        ? null
        : yield* registry.getWorkspace({ id: workspace });

    if (record === null) return null;

    found = { object, environment: record.environment };

    return found;
  });

  const buildsById = Effect.map(
    registry.listBuilds(),
    (builds) => new Map(Arr.map(builds, ({ environment, build }) => [environment, build] as const)),
  );

  return {
    ...lifecycle,
    current: Effect.map(where, (known) => known?.environment ?? null),
    list: Effect.gen(function* () {
      const environments = yield* registry.listEnvironments();
      const byId = yield* buildsById;

      return Arr.map(environments, ({ id, name, repos }): EnvironmentListing => ({
        id,
        name,
        repos,
        build: byId.get(id) ?? NO_BUILD,
      }));
    }),
    get: (id) =>
      Effect.gen(function* () {
        const environment = yield* registry.getEnvironment({ id });
        const state = yield* registry.getEnvironmentSettings({ environment: id });

        if (environment === null || state === null) return null;

        const byId = yield* buildsById;
        const secrets = yield* registry.listEnvironmentSecrets();

        return {
          id,
          name: environment.name,
          repos: environment.repos,
          build: byId.get(id) ?? NO_BUILD,
          settings: state.settings,
          problem: state.problem,
          secrets: keptFor(id, secrets),
        } satisfies EnvironmentDetails;
      }),
    change: ({ environment, change, author }) =>
      Effect.gen(function* () {
        if (session === undefined) {
          return yield* EnvironmentsError.make({
            message: "This Session is not one the Registry lists, so it changes no Environment.",
          });
        }

        const answer = yield* registry.changeEnvironment({
          environment,
          change,
          author: { session, ...author },
        });

        switch (answer.status) {
          case "rejected":
          case "missing":
            return answer;
          case "unchanged":
            return {
              status: "unchanged",
              environment: changedEnvironment(answer.environment),
              value: answer.value,
            };
          case "changed":
            break;
        }

        const own = yield* where;

        // The Session's own Workspace takes it now, not at its next readying; one that cannot be reached gets it then.
        if (own?.environment === environment) {
          yield* Effect.tryPromise(() => handOver(own.object, answer.state.overrides)).pipe(
            Effect.flatMap((written) =>
              written.ok
                ? Effect.void
                : Effect.logWarning(
                    `The Session's Workspace refused an Agent change: ${written.message}`,
                  ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Handing an Agent change to the Session's Workspace failed; it takes it at its next readying",
                cause,
              ),
            ),
          );
        }

        // As after the owner's save: the variables are among what a Build is made with.
        yield* builds.of(environment);

        return {
          status: "changed",
          environment: changedEnvironment(answer.environment),
          change: answer.change,
          newBuild: answer.newBuild,
        } satisfies AppliedChange;
      }),
  };
};
