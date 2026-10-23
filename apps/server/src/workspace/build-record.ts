// What an Environment's Build is to everything but the Build's own Durable Object (docs/spec.md → Builds, ADR-0016):
// the record of a finished good Build, which the Registry keeps with the Environment and hands to each of its
// Workspaces with their set-up, what the main Worker asks a Build's object for and is answered, the key that says
// whether a Build is current, and the variable that has a Container started from it reset computerd's store. Plain
// data, as it crosses Workers RPC and the Registry's JSON. No Workers or Node imports: the main Worker loads it too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import type { ContainerSettings } from "@cloudpid/config";
import type * as Schema from "effect/Schema";

/** A Repo a Build clones: the address, and the directory name its Setup Script's record has. */
export type BuildRepo = { readonly name: string; readonly url: string };

/** A finished good Build: its snapshot, and what decides whether a launch may start from it. Times are epoch milliseconds. */
export type EnvironmentBuild = {
  /** The digest of what it was made from (`buildKey`): the Environment's Repos and Container settings, and the image. */
  readonly key: string;
  /** The platform's handle of the Build's snapshot, and its size in bytes. */
  readonly snapshot: { readonly id: string; readonly size: number };
  /** The reference of the image the Build's Container ran, which the snapshot is not portable beyond. */
  readonly image: string;
  /** The Container-only paths its Container launched with (null: it had none), which a launch from it must have too. */
  readonly ignore: ReadonlyArray<string> | null;
  /** The commit each Repo's default branch was at, by Repo name: null for a Repo with no commits yet. */
  readonly commits: Readonly<Record<string, string | null>>;
  readonly finishedAt: number;
};

/**
 * The variable a launch from a Build sets in the Container's environment (`ContainerLaunchSpec.env`): the image's
 * supervisor then deletes computerd's store before it starts computerd (`apps/sandbox-image/image/supervise`), so the
 * Workspace's Durable Object is not handed the sync state of the Build's.
 */
export const RESET_STORE_VARIABLE = "CLOUDPID_RESET_STORE";

/** What the main Worker asks a Build's object for. */
export type BuildRequest = {
  /** The digest of what the Build is made from (`buildKey`). */
  readonly key: string;
  /** The Environment's Repos, cloned at their default branches. */
  readonly repos: ReadonlyArray<BuildRepo>;
  /** The Environment's Container settings overrides. */
  readonly settings: Schema.Json;
  /**
   * The daily look at the Repos' default branches: build only when one moved since the last good Build of this key (or
   * that Build is old), else just note that it looked.
   */
  readonly check?: boolean | undefined;
};

/** The Build in progress (`checking`: the daily look, which is not a Build yet), or the last that failed. */
export type BuildProgress =
  | {
      readonly status: "building" | "checking";
      readonly key: string;
      readonly startedAt: number;
    }
  | {
      readonly status: "failed";
      readonly key: string;
      /** Why, in a line with the end of the step's output, the GitHub token taken out. */
      readonly reason: string;
      readonly at: number;
    };

/** What a Build's object answers: its Builds, and the image a launch would run now, which a Build's key covers. */
export type BuildState = {
  readonly image: string | undefined;
  /** The last good Build, kept while later ones fail. */
  readonly last: EnvironmentBuild | null;
  readonly progress: BuildProgress | null;
  /** When the last Build or daily look ended, good or not: the next look is due a day after. */
  readonly attemptedAt: number | null;
};

/** What a Build's key covers, besides the image: the Container settings a Build depends on. */
type BuildSettings = Pick<ContainerSettings, "variables" | "setupScript" | "ignore">;

/**
 * The key of the Build `repos`, `settings`, `image` and `secrets` make: a digest of what a Build depends on, so a Build
 * of another key is not current. That is the Repos (names and addresses, in any order), the variables, the
 * Environment's Setup Script and the Container-only paths (a launch starts only from a Build with its own), the image,
 * and the keyed digest of the Secrets that reach the Build (`secrets`, which the Registry makes: never a value; with
 * none, the key is what it was before Secrets reached Builds); not the size, the idle time or the Start Script, which
 * a Build does not use. A Repo's default branch moving is the daily look's to find (`BuildRequest.check`), not the key's.
 */
export const buildKey = async ({
  repos,
  settings,
  image,
  secrets = null,
}: {
  readonly repos: ReadonlyArray<BuildRepo>;
  readonly settings: BuildSettings;
  readonly image: string | undefined;
  readonly secrets?: string | null | undefined;
}): Promise<string> => {
  const byFirst = (left: readonly [string, string], right: readonly [string, string]) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;

  const keyed = {
    version: 1,
    image: image ?? null,
    repos: repos.map((repo): readonly [string, string] => [repo.name, repo.url]).sort(byFirst),
    variables: Object.entries(settings.variables).sort(byFirst),
    setupScript: settings.setupScript,
    ignore: settings.ignore,
  };

  // The Secrets' digest only where Secrets reach the Build, so the keys of Builds without any stay what they were.
  const canonical = JSON.stringify(secrets === null ? keyed : { ...keyed, secrets });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
