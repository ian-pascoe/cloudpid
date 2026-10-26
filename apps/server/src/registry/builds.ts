// Keeping each Environment's Build current (docs/spec.md → Builds, ADR-0016), from the main Worker after an answer, as
// the spares are kept (`spareUpkeep`): the Registry says what each Environment is (one call), each Environment's Build
// object says what it has and which image a launch runs now, and a Build is asked for when the one wanted (`buildKey`:
// the Repos, the Container settings a Build uses, the image) is neither the last good one nor under way, or once a day
// to look at the Repos' default branches. What the Build object answers is recorded in the Registry, which hands the
// last good Build to each new Workspace and shows where each stands (`listBuilds`).
import { resolveContainerSettingsLeniently } from "@cloudpid/config";
import type { BuildView, EnvironmentRepo } from "@cloudpid/protocol";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { buildObjectName } from "../workspace/binding.ts";
import { buildKey, type BuildState, buildWanted } from "../workspace/build-record.ts";
import type { WorkspaceObjects } from "../workspace/lifecycle.ts";
import { noEnvironment, reason } from "./messages.ts";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";
import type { Spares } from "./rpc.ts";
import type { BuildRecord } from "./store.ts";

/** What keeping one Environment's Build current needs of the Registry: what the Environment is, and what is recorded. */
export type BuildWork = {
  readonly environment: string;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  /** The Environment's Container settings overrides. */
  readonly settings: Schema.Json;
  readonly recorded: BuildRecord;
  /**
   * A keyed digest of the Secrets that reach the Build (`buildSecretsDigest`), null when none does: their values are
   * asked for only when a Build is (`environmentSecrets`).
   */
  readonly secrets: string | null;
};

/** How long after the last Build or look the next look at the Repos' default branches is due (or a failed Build retried). */
export const BUILD_LOOK_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How long an isolate whose run behind the Session list found nothing to do or under way asks nothing more: the
 * daily look and a failed Build's retry come due with time alone.
 */
export const BUILD_QUIET_MS = 60 * 60_000;

/**
 * What to ask an Environment's Build object for, given what it answered (`state`) and the key of the Build wanted
 * (`key`, null when none is: `buildWanted` says no): a Build, the daily look at the default branches, or nothing.
 * A forced one (the owner's Rebuild) is asked for unless a Build of the key is under way already.
 */
export const buildDue = ({
  key,
  state,
  now,
  force = false,
}: {
  readonly key: string | null;
  readonly state: BuildState;
  readonly now: number;
  readonly force?: boolean;
}): "build" | "check" | undefined => {
  const { progress, last, attemptedAt } = state;

  if (key === null) return undefined;

  if (progress !== null && progress.status !== "failed" && progress.key === key) {
    return force && progress.status === "checking" ? "build" : undefined;
  }

  if (force) return "build";

  const due = attemptedAt === null || now - attemptedAt >= BUILD_LOOK_INTERVAL_MS;

  if (last?.key !== key) {
    // A Build of the wanted key that failed is tried again a day later, or when something changes.
    return progress?.status === "failed" && progress.key === key && !due ? undefined : "build";
  }

  return due ? "check" : undefined;
};

/** Where an Environment's Build stands, for the owner, from what the Registry recorded. */
export const buildView = ({ build, status }: BuildRecord): BuildView => {
  const lastGoodAt = build?.finishedAt ?? null;

  switch (status?.status) {
    case "building":
      return { status: "building", since: status.startedAt, lastGoodAt };
    case "failed":
      return { status: "failed", reason: status.reason, at: status.at, lastGoodAt };
    default:
      return build === null ? { status: "none" } : { status: "ready", at: build.finishedAt };
  }
};

/** The upkeep of the Environments' Builds (`buildUpkeep`). Only `rebuild` fails, with why. */
export type Builds = {
  /** Keep every Environment's Build current. Once a run finds nothing to do or under way, this isolate rests a while. */
  readonly all: Effect.Effect<void>;
  /** Keep `environment`'s Build current, as after its Repos or settings changed. */
  readonly of: (environment: string) => Effect.Effect<void>;
  /**
   * Make `environment`'s Build again now (the owner's Rebuild). Answers "underway" when a Build of the wanted key was under
   * way already, which asks for nothing.
   */
  readonly rebuild: (environment: string) => Effect.Effect<"asked" | "underway", string>;
};

const sameJson = Schema.toEquivalence(Schema.Json);

/** Whether what the Registry recorded is what the Build object answered, whatever the order of their keys. */
const recordedAs = (recorded: BuildRecord, state: BuildState): boolean =>
  sameJson(recorded, { build: state.last, status: state.progress });

/**
 * The upkeep of the Environments' Builds. An Environment deleted while its Build object was asked for a Build has the
 * object wiped again, since the request made it anew; an Environment whose last good Build changed has its spare
 * Workspace looked at (`spares`), as the spare is made from that Build.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const buildUpkeep = (
  registries: Cloudflare.DurableObject<Registry>,
  {
    workspaces,
    spares,
  }: {
    readonly workspaces: Pick<WorkspaceObjects, "buildState" | "startBuild" | "destroy">;
    readonly spares: Pick<Spares, "of">;
  },
): Builds => {
  /** Keep one Environment's Build current: what was asked of its Build object, and whether a Build was asked for or is under way. */
  const keepAsking = (work: BuildWork, force: boolean) =>
    Effect.gen(function* () {
      const registry = registries.getByName(REGISTRY_NAME);
      const name = buildObjectName(work.environment);
      let state = yield* Effect.promise(() => workspaces.buildState(name));
      const { settings } = resolveContainerSettingsLeniently(work.settings);
      const wanted = buildWanted(work.repos, settings);

      const key = wanted
        ? yield* Effect.promise(() =>
            buildKey({ repos: work.repos, settings, image: state.image, secrets: work.secrets }),
          )
        : null;

      const asked = buildDue({ key, state, now: yield* Clock.currentTimeMillis, force });

      if (asked !== undefined && key !== null) {
        // The values only now, for the Build object: those for the Build reach its scripts, and every one is searched
        // for before its snapshot. They are never in the request it stores.
        const secrets = yield* registry.environmentSecrets({ environment: work.environment });

        state = yield* Effect.promise(() =>
          workspaces.startBuild(
            name,
            { key, repos: work.repos, settings: work.settings, check: asked === "check" },
            secrets,
          ),
        );

        // The Environment deleted meanwhile (its Build object wiped) is not made anew by the request.
        if ((yield* registry.getEnvironment({ id: work.environment })) === null) {
          yield* Effect.promise(() => workspaces.destroy(name));

          return { asked, busy: false };
        }
      }

      // What Workspaces start from: none while no Build is wanted.
      const answered: BuildState = wanted ? state : { ...state, last: null, progress: null };

      if (!recordedAs(work.recorded, answered)) {
        yield* registry.recordBuild({
          environment: work.environment,
          build: answered.last,
          status: answered.progress,
        });

        // The spare is made from the last good Build: one made from another is stale now.
        if (answered.last?.snapshot.id !== work.recorded.build?.snapshot.id) {
          yield* spares.of(work.environment);
        }
      }

      return {
        asked,
        busy:
          asked !== undefined ||
          (answered.progress !== null && answered.progress.status !== "failed"),
      };
    });

  /** Keep one Environment's Build current; whether a Build was asked for or is under way. */
  const keep = (work: BuildWork, force: boolean) =>
    Effect.map(keepAsking(work, force), ({ busy }) => busy);

  /** Keep the Builds of `environments` (all when undefined) current; whether there was anything to do. */
  const keepAll = (environments: ReadonlyArray<string> | undefined) =>
    Effect.gen(function* () {
      const registry = registries.getByName(REGISTRY_NAME);
      let busy = false;

      for (const work of yield* registry.buildWork({ environments })) {
        busy =
          (yield* keep(work, false).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `The upkeep of environment ${work.environment}'s Build failed`,
                cause,
              ).pipe(Effect.as(true)),
            ),
          )) || busy;
      }

      return busy;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The upkeep of the Builds failed", cause).pipe(Effect.as(true)),
      ),
    );

  /** Until when the runs behind the Session list ask nothing (`BUILD_QUIET_MS`). */
  let quietUntil = 0;

  return {
    all: Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) < quietUntil) return;

      if (!(yield* keepAll(undefined))) {
        quietUntil = (yield* Clock.currentTimeMillis) + BUILD_QUIET_MS;
      }
    }),
    // A Build asked for here is followed by the runs behind the Session list until it ends.
    of: (environment) =>
      keepAll([environment]).pipe(
        Effect.map((busy) => {
          if (busy) quietUntil = 0;
        }),
      ),
    rebuild: (environment) =>
      Effect.gen(function* () {
        const registry = registries.getByName(REGISTRY_NAME);
        const [work] = yield* registry.buildWork({ environments: [environment] });

        if (work === undefined) return yield* Effect.fail(noEnvironment(environment));

        if (!buildWanted(work.repos, resolveContainerSettingsLeniently(work.settings).settings)) {
          return yield* Effect.fail(
            "The environment has no repos, no Setup Script and no Toolchains: there is nothing to build",
          );
        }

        quietUntil = 0;

        const { asked } = yield* keepAsking(work, true).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(`Could not ask for the Build: ${reason(cause)}`),
          ),
        );

        return asked === undefined ? "underway" : "asked";
      }),
  };
};
