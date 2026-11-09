// What the setters' cores (`./environment-changes.ts`) and the Session's `environment` tools (`./environment.ts`) share
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared definitions and the core/wrapper split):
// the check of a text for a deploy-time credential, the words of when a change applies and what it costs, and the
// Environment a tool's `id` names. It imports `./environment.ts` for types only, so the cores and the tools import it
// with no cycle between them; `./environment.ts` re-exports it, the supported import path.
// @effect-diagnostics missingPipeableSignature:off
import {
  containerRates,
  INSTANCE_RESOURCES,
  type InstanceType,
  SPARE_WORKSPACE_FIELD,
} from "@cloudpid/config";
import { GLOBAL_ID, type Surface } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type { EnvironmentsService, GlobalChanged } from "./environment.ts";
import { EnvironmentsError, namedEnvironment } from "./environment-describe.ts";
import { holdsGitHubToken } from "./github-tokens.ts";
import { Redactions } from "./secrets/redaction.ts";

/**
 * The deploy-time credentials no plain value may hold: the GitHub App's private key. The GitHub tokens minted from it
 * are never seen here; any text shaped like one is refused instead (`holdsGitHubToken`).
 */
export class DeployCredentials extends Context.Service<
  DeployCredentials,
  { readonly values: ReadonlyArray<string> }
>()("@cloudpid/extensions/environment-change-parts/DeployCredentials") {}

/**
 * Whether a text holds a deploy-time credential, as written or in an encoding redaction knows, or anything shaped like
 * a GitHub token: what no plain value the agent saves may hold.
 */
export const credentialCheck: Effect.Effect<(text: string) => boolean, never, DeployCredentials> =
  Effect.gen(function* () {
    const credentials = new Redactions();

    for (const value of (yield* DeployCredentials).values) {
      credentials.hold("GITHUB_APP_PRIVATE_KEY", value);
    }

    return (text: string) => credentials.redact(text) !== text || holdsGitHubToken(text);
  });

/**
 * When a change applies, and whether a Build was asked for (`newBuild` undefined: not known, so look at the Build). On
 * the endpoint nothing is a Session's own, and only `environment_get` is named.
 */
export const describeApplied = (
  own: boolean,
  newBuild: boolean | undefined,
  surface: Surface = "session",
): string =>
  Arr.join(
    [
      "It applies at the next Container start of each of the Environment's Workspaces: a Container that runs keeps what it started with.",
      ...(own && surface === "session"
        ? [
            "This is this Session's own Environment, and its Workspace has the change already: container_restart applies it to this Workspace's Container now.",
          ]
        : []),
      ...(newBuild === undefined
        ? ["environment_get shows the Build."]
        : newBuild
          ? [
              surface === "session"
                ? "The Environment's Build is made with it, so a new Build was asked for (environment_get shows how it goes; environment_rebuild asks for another now, such as after it failed)."
                : "The Environment's Build is made with it, so a new Build was asked for (environment_get shows how it goes).",
            ]
          : []),
    ],
    " ",
  );

/**
 * When a change of a Container setting at Global (`field`) applies, whom it does not reach, and whose Build was asked
 * for.
 */
export const describeAppliedGlobal = (
  field: string,
  { overriddenIn, newBuilds, own }: GlobalChanged,
): string =>
  Arr.join(
    [
      overriddenIn.length === 0
        ? "No Environment overrides it, so it reaches them all."
        : `An Environment's own value wins; it does not reach ${Arr.join(Arr.map(overriddenIn, namedEnvironment), ", ")}, which override it.`,
      ...(field === SPARE_WORKSPACE_FIELD
        ? ["It applies at once: no Container restarts."]
        : [
            "It applies at the next Container start of every Workspace that inherits it: a Container that runs keeps what it started with.",
          ]),
      ...(own && field !== SPARE_WORKSPACE_FIELD
        ? [
            "This Session's Workspace has the change already: container_restart applies it to its Container now.",
          ]
        : []),
      ...(newBuilds.length === 0
        ? []
        : [
            `The Builds are made with it, so a new Build was asked for in ${Arr.join(Arr.map(newBuilds, namedEnvironment), ", ")} (environment_get shows how each goes).`,
          ]),
    ],
    " ",
  );

/**
 * The refusal of a call whose text holds a credential, saying `outcome` (nothing was saved) and `what` holds it: on a
 * Session's surface it names the Secrets the Session holds, on the endpoint it is `invalid_argument` and names the owner.
 */
export const holdsRefusal = (surface: Surface, outcome: string, what: string): EnvironmentsError =>
  surface === "session"
    ? EnvironmentsError.make({
        message: `${outcome}: ${what} holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Say it without the value; a credential belongs in a Secret kept for the Environment, which the user keeps on the Environments page.`,
      })
    : EnvironmentsError.make({
        message: `${outcome}: ${what} holds a GitHub token or the GitHub App's key. Say it without the value; a credential belongs in a Secret the owner keeps for the Environment on the Secrets page.`,
        code: "invalid_argument",
      });

/**
 * Fails, saving nothing (`outcome` says what was not done), when a text holds a credential `holdsSecret` knows: in the
 * words of `surface` (`holdsRefusal`). The Session's tools and the cores share it.
 */
export const refuseSecretsIn =
  (holdsSecret: (text: string) => Effect.Effect<boolean, EnvironmentsError>) =>
  (
    surface: Surface,
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
    outcome = "Nothing was saved",
  ) =>
    Effect.gen(function* () {
      for (const { what, text } of texts) {
        if (text !== "" && (yield* holdsSecret(text))) {
          return yield* holdsRefusal(surface, outcome, what);
        }
      }
    });

/** US dollars, to two significant digits. */
const money = (dollars: number): string => `$${dollars.toPrecision(2)}`;

/** The memory cost of idle time: a Container that sits unused is billed for its memory until the idle stop. */
export const describeIdleCost = (minutes: number, instance: InstanceType): string => {
  const { memoryMib } = INSTANCE_RESOURCES[instance];
  const perMinute = containerRates(instance).memory * 60;

  return `A Container that sits unused is billed for its memory until the idle stop: at ${instance} (${memoryMib / 1024} GiB) about ${money(perMinute)} a minute, so up to ${money(perMinute * minutes)} for each idle stretch of ${minutes} minute${minutes === 1 ? "" : "s"}, per Workspace. A shorter idle time costs less but loses the warm Container (the next command starts a new one from the snapshot, several seconds).`;
};

/** A script or Toolchains value as a result sizes it: the card shows the user the difference. */
export const textSize = (value: Schema.Json | null): string => {
  const text = Predicate.isString(value) ? value : "";
  const lines = text.replace(/\n$/, "").split("\n").length;

  return text === ""
    ? "none"
    : `${lines} line${lines === 1 ? "" : "s"}, ${new TextEncoder().encode(text).length} bytes`;
};

/** A size or a number of minutes as a result says it: a text bare, a number as it is. */
export const plainValue = (value: Schema.Json | null): string =>
  Predicate.isString(value) ? value : JSON.stringify(value);

/** A list of Container-only paths as a result says it. */
export const pathsLine = (value: Schema.Json | null): string =>
  Arr.isArray(value) && value.length > 0 ? Arr.join(Arr.map(value, String), ", ") : "none";

/**
 * Fails when `id` is `*`, which only the tools that keep something at Global take: the others change one
 * Environment's own record, or (`environment_setting_reset`) make one Environment's field inherit Global's.
 */
export const refuseGlobal = (id: string, surface: Surface) =>
  id !== GLOBAL_ID
    ? Effect.void
    : surface === "endpoint"
      ? EnvironmentsError.make({
          message: `The id "${GLOBAL_ID}" names what is kept Global, which this tool does not change: it changes one Environment's own record or fields. Name one Environment with its id (environment_list shows them).`,
          code: "invalid_argument",
        })
      : EnvironmentsError.make({
          message: `The id "${GLOBAL_ID}" names what is kept Global (the Container settings, Secrets and Skills): only environment_get, the Container setting tools (environment_variable_set, environment_variable_unset, environment_container_resize, environment_container_size_limit_set, environment_idle_time_set, environment_ignore_set, environment_setup_script_set, environment_start_script_set, environment_toolchains_set, environment_spare_workspace_set), environment_secret_build, environment_secret_delete, environment_skill_save, environment_skill_install, environment_skill_update and environment_skill_remove take it. Name one Environment with its id (environment_list shows them).`,
        });

/** The Environment a tool's `id` names (never assumed: a call without one fails to decode), with whether it is the Session's. */
export type EnvironmentTarget = (
  id: string,
) => Effect.Effect<{ readonly environment: string; readonly own: boolean }, EnvironmentsError>;

/**
 * The `EnvironmentTarget` over `environments`: it refuses `*` (on the endpoint, as `invalid_argument` in words that name
 * no tool it does not serve), and only compares the id with the Session's own.
 */
export const environmentTarget =
  (environments: Pick<EnvironmentsService, "current">, surface: Surface): EnvironmentTarget =>
  (id) =>
    Effect.gen(function* () {
      yield* refuseGlobal(id, surface);

      return { environment: id, own: id === (yield* environments.current) };
    });
