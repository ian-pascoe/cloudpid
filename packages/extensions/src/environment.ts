// The `environment` extension (`docs/spec.md` → Agent changes, ADR-0019): the agent's tools for its Environments,
// `environment_list`, `environment_get`, `environment_variable_set` and `environment_variable_unset`. Each change is an
// Agent change: the Registry applies it as the owner's save is applied and records it, the Session hands a change to its
// own Environment to its Workspace at once, and the Run's end notifies the owner of the changes it made
// (`AgentChangeLog`). They are the root conversation's only (`PARENT_ONLY_TOOL_PREFIXES`), as `secret_ask` is. Values
// are plain: a change is refused when its value holds a Secret the Session holds or the GitHub token, and a Secret
// Reference in it is saved as the text it is, since these tools are not wrapped to resolve one.
// @effect-diagnostics missingPipeableSignature:off
import type { ContainerSettings } from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  type AgentChange,
  type BuildView,
  type EnvironmentRepo,
  variableField,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { Redactions } from "./secrets/redaction.ts";
import { secretEnvName } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";

export const extensionName = "environment";

/** The prefix of every tool of the extension: all of them are the root conversation's only. */
export const ENVIRONMENT_TOOL_PREFIX = "environment_";

/** An Environment as `environment_list` shows it. */
export type EnvironmentListing = {
  readonly id: string;
  readonly name: string;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly build: BuildView;
};

/** A Secret kept for an Environment, by name only: where it is kept, and whether it reaches the Build. */
export type KeptSecretListing = {
  readonly name: string;
  /** Kept for this Environment, or for every Environment. */
  readonly scope: "environment" | "every";
  readonly build: boolean;
};

/** An Environment as `environment_get` shows it: its listing, every Container setting, and its kept Secrets' names. */
export type EnvironmentDetails = EnvironmentListing & {
  readonly settings: ContainerSettings;
  /** Why only some of the saved settings apply, when a later release no longer accepts one. */
  readonly problem?: string | undefined;
  readonly secrets: ReadonlyArray<KeptSecretListing>;
};

/** One Container setting given a new value: a setting's name or `variables.<NAME>`; null takes it back (unsets). */
export type SettingChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
};

/** Who makes an Agent change: the conversation that called the tool, the tool, and the agent's reason. */
export type ChangeAuthor = {
  readonly conversation: number;
  readonly tool: string;
  readonly reason: string;
};

/** The Environment a change was made to, by id and name. */
export type ChangedEnvironment = { readonly id: string; readonly name: string };

/** How an Agent change went, as the Session reports it. */
export type AppliedChange =
  | {
      readonly status: "changed";
      readonly environment: ChangedEnvironment;
      /** The change as the Registry recorded it, with the values before and after. */
      readonly change: AgentChange;
      /** Whether the Build upkeep after it asked for a new Build. */
      readonly newBuild: boolean;
    }
  /** The setting already had the value: nothing was saved or recorded. */
  | {
      readonly status: "unchanged";
      readonly environment: ChangedEnvironment;
      readonly value: Schema.Json | null;
    }
  /** Not a value the setting takes, said as the owner's save says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

/** Reaching the Environments failed; its message is what the model sees. */
export class EnvironmentsError extends Schema.TaggedError<
  EnvironmentsError,
  { readonly brand: unique symbol }
>()("EnvironmentsError", { message: Schema.String }) {}

/**
 * The Environments, as the Session reaches them through the Registry. `change` applies an Agent change as the owner's
 * save does, hands it to the Session's own Workspace at once when it is the Session's Environment, and runs the Build
 * upkeep after it.
 */
export type EnvironmentsService = {
  /** The Session's own Environment; null for a Session the Registry does not list. */
  readonly current: Effect.Effect<string | null, EnvironmentsError>;
  readonly list: Effect.Effect<ReadonlyArray<EnvironmentListing>, EnvironmentsError>;
  /** Environment `id`, or null when there is none. */
  readonly get: (id: string) => Effect.Effect<EnvironmentDetails | null, EnvironmentsError>;
  readonly change: (input: {
    readonly environment: string;
    readonly change: SettingChange;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<AppliedChange, EnvironmentsError>;
};

export class Environments extends Context.Service<Environments, EnvironmentsService>()(
  "@cloudpid/extensions/environment/Environments",
) {}

/** An Agent change of the Run, for the Notification its end sends: the tool, the Environment's name and the field. */
export type RunChange = {
  readonly tool: string;
  readonly environmentName: string;
  readonly field: string;
};

/** Where the Session keeps the Run's Agent changes until its end notifies the owner of them. */
export class AgentChangeLog extends Context.Service<
  AgentChangeLog,
  { readonly record: (change: RunChange) => Effect.Effect<void> }
>()("@cloudpid/extensions/environment/AgentChangeLog") {}

/** The deploy-time credentials no plain value may hold: the GitHub token commands get. */
export class DeployCredentials extends Context.Service<
  DeployCredentials,
  { readonly values: ReadonlyArray<string> }
>()("@cloudpid/extensions/environment/DeployCredentials") {}

/** The longest reason a change may give. */
export const MAX_CHANGE_REASON = 500;

const iso = (time: number): string => DateTime.formatIso(DateTime.makeUnsafe(time));

/** The last characters of a failed Build's reason that `environment_get` shows. */
const FAILED_REASON_TAIL = 1_000;

/** Where a Build stands, in a line. */
export const describeBuild = (build: BuildView): string => {
  const meanwhile = (lastGoodAt: number | null) =>
    lastGoodAt === null
      ? "new Workspaces start from the image meanwhile"
      : `new Workspaces start from the last good Build, of ${iso(lastGoodAt)}, meanwhile`;

  switch (build.status) {
    case "none":
      return "none (no Repo, Setup Script or Toolchains to build, or none made yet)";
    case "building":
      return `building since ${iso(build.since)}; ${meanwhile(build.lastGoodAt)}`;
    case "ready":
      return `ready, made ${iso(build.at)}`;
    case "failed": {
      const reason =
        build.reason.length > FAILED_REASON_TAIL
          ? `…${build.reason.slice(-FAILED_REASON_TAIL)}`
          : build.reason;

      return `failed at ${iso(build.at)}; ${meanwhile(build.lastGoodAt)}. Its reason ends: ${reason}`;
    }
  }
};

const reposLine = (repos: ReadonlyArray<EnvironmentRepo>): string =>
  repos.length === 0
    ? "none"
    : Arr.join(
        Arr.map(repos, (repo) => `${repo.name} (${repo.url})`),
        ", ",
      );

/** `text` as a fenced block, or `none` when it is empty. */
const block = (text: string, language: string): string =>
  text === "" ? "none" : `\n\`\`\`${language}\n${text}\n\`\`\``;

const describeSecret = (secret: KeptSecretListing): string =>
  `${secret.name} (${secret.scope === "environment" ? "kept for this Environment" : "kept for every Environment"}${secret.build ? ", reaches the Build" : ""}; commands get it as $${secretEnvName(secret.name)})`;

/** What `environment_get` says of an Environment. */
export const describeEnvironment = (details: EnvironmentDetails, current: boolean): string => {
  const { settings } = details;
  const variables = Record.toEntries(settings.variables);

  return Arr.join(
    [
      `Environment ${JSON.stringify(details.name)} (id ${details.id}${current ? ", the Environment of this Session" : ""})`,
      `Repos: ${reposLine(details.repos)}`,
      `Container size: ${settings.instance}`,
      `Idle time: ${settings.idleMinutes} minute${settings.idleMinutes === 1 ? "" : "s"}`,
      `Container-only paths (ignore): ${settings.ignore.length === 0 ? "none" : Arr.join(settings.ignore, ", ")}`,
      `Variables (plain, in every command's environment): ${
        variables.length === 0
          ? "none"
          : Arr.join(
              Arr.map(variables, ([name, value]) => `\n  ${name}=${value}`),
              "",
            )
      }`,
      `Setup Script: ${block(settings.setupScript, "bash")}`,
      `Start Script: ${block(settings.startScript, "bash")}`,
      `Toolchains (mise.toml): ${settings.toolchains === "" ? "none: the image's base Toolchains" : block(settings.toolchains, "toml")}`,
      `Kept Secrets (values never shown): ${
        details.secrets.length === 0
          ? "none"
          : Arr.join(Arr.map(details.secrets, describeSecret), "; ")
      }`,
      `Build: ${describeBuild(details.build)}`,
      ...(details.problem === undefined
        ? []
        : [`Saved settings left out, as they no longer apply: ${details.problem}`]),
    ],
    "\n",
  );
};

/** What `environment_list` says of an Environment. */
const listingLine = (environment: EnvironmentListing, current: boolean): string =>
  `- ${environment.id}: ${JSON.stringify(environment.name)}${current ? " (this Session's)" : ""}; repos: ${reposLine(environment.repos)}; Build: ${describeBuild(environment.build)}`;

/** A variable's value as the result shows it: plain, in full. */
const shownValue = (value: Schema.Json | null): string =>
  value === null ? "not set" : JSON.stringify(value);

/** An Environment as a result names it: its name in quotes, then its id. */
const namedEnvironment = ({ id, name }: { readonly id: string; readonly name: string }): string =>
  `Environment ${JSON.stringify(name)} (${id})`;

/** When a change applies, and whether a Build was asked for. */
export const describeApplied = (own: boolean, newBuild: boolean): string =>
  Arr.join(
    [
      "It applies at the next Container start of each of the Environment's Workspaces: a Container that runs keeps what it started with.",
      ...(own
        ? [
            "This is this Session's own Environment, and its Workspace has the change already: container_restart applies it to this Workspace's Container now.",
          ]
        : []),
      ...(newBuild
        ? [
            "The Environment's Build is made with it, so a new Build was asked for (environment_get shows how it goes).",
          ]
        : []),
    ],
    " ",
  );

const Id = Schema.String.annotate({
  description:
    "The Environment's id, as environment_list shows it (default: this Session's Environment)",
});

const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Environment's Agent changes, such as 'the tests read the API address from API_URL'",
});

const VariableName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The variable's name, such as API_URL: letters, digits and _, not starting with a digit",
});

const PLAIN_VALUES =
  "Variables are plain: every command, and you, can read them, and they are not taken out of output. Never put a credential in one: a value holding a Secret this Session holds, or the GitHub token, is refused. The value is saved as written: a Secret Reference in it is not resolved.";

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json): JsonValue => value as JsonValue;

const notFound = (id: string) =>
  EnvironmentsError.make({
    message: `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`,
  });

/**
 * The `environment` extension: its tools over the Session's `Environments`, refusing values that hold a Secret
 * (`Secrets`) or a deploy-time credential (`DeployCredentials`), and telling the Session of each change for the Run's
 * Notification (`AgentChangeLog`).
 */
export const EnvironmentTools: Effect.Effect<
  Extension,
  never,
  Environments | AgentChangeLog | DeployCredentials | Secrets
> = Effect.gen(function* () {
  const environments = yield* Environments;
  const log = yield* AgentChangeLog;
  const secrets = yield* Secrets;

  const credentials = new Redactions();

  for (const value of (yield* DeployCredentials).values) credentials.hold("GITHUB_TOKEN", value);

  /**
   * Whether `value` holds a Secret's value or a credential, as written or in an encoding redaction knows: checked once
   * the Secrets are fresh, so one the owner has just kept for the Environment counts.
   */
  const holdsSecret = (value: string) =>
    Effect.map(
      secrets.refresh,
      () => secrets.redact(value) !== value || credentials.redact(value) !== value,
    );

  /** The Environment `id` names, this Session's by default, with whether it is this Session's. */
  const target = (id: string | undefined) =>
    Effect.gen(function* () {
      const current = yield* environments.current;
      const environment = id ?? current;

      if (environment === null) {
        return yield* EnvironmentsError.make({
          message:
            "This Session belongs to no Environment the Registry lists: name one with id (environment_list shows them).",
        });
      }

      return { environment, own: environment === current };
    });

  /** Apply `change` of variable `name` as `tool`, and say how it went. */
  const changeVariable = (
    tool: string,
    {
      id,
      name,
      value,
      reason,
    }: {
      readonly id?: string | undefined;
      readonly name: string;
      readonly value: string | null;
      readonly reason: string;
    },
    conversation: number,
  ) =>
    Effect.gen(function* () {
      if (value !== null && (yield* holdsSecret(value))) {
        return yield* EnvironmentsError.make({
          message:
            "Nothing was saved: the value holds the value of a Secret this Session holds, or of the GitHub token. Variables are plain, so every command and the agent read them. Ask the user to keep the value as a Secret for the Environment on the Environments page instead: every command then gets it as $PI_SECRET_<NAME>, and it is taken out of their output.",
        });
      }

      // The reason is kept with the change as written, for the user to read.
      if (yield* holdsSecret(reason)) {
        return yield* EnvironmentsError.make({
          message:
            "Nothing was saved: the reason holds the value of a Secret this Session holds, or of the GitHub token. Say why without it.",
        });
      }

      const { environment, own } = yield* target(id);
      const field = variableField(name);

      const applied = yield* environments.change({
        environment,
        change: { field, value },
        author: { conversation, tool, reason },
      });

      switch (applied.status) {
        case "missing":
          return yield* notFound(environment);
        case "rejected":
          return yield* EnvironmentsError.make({
            message: `Nothing was saved: ${applied.message}`,
          });
        case "unchanged": {
          const where = namedEnvironment(applied.environment);

          return {
            output: [
              {
                type: "text" as const,
                text:
                  value === null
                    ? `${name} is not set in ${where}: nothing changed, and nothing was recorded.`
                    : `${name} already has that value in ${where}: nothing changed, and nothing was recorded.`,
              },
            ],
            details: { unchanged: { environment: applied.environment, field } },
          };
        }

        case "changed": {
          const { change } = applied;

          yield* log.record({ tool, environmentName: applied.environment.name, field });

          const did = value === null ? `Unset ${name}` : `Set ${name}`;

          return {
            output: [
              {
                type: "text" as const,
                text: `${did} in ${namedEnvironment(applied.environment)}: it was ${shownValue(change.before)}, and is ${shownValue(change.after)} now. ${describeApplied(own, applied.newBuild)}`,
              },
            ],
            details: {
              agentChange: {
                id: change.id,
                environment: applied.environment,
                field,
                before: asJsonValue(change.before),
                after: asJsonValue(change.after),
              },
              own,
              newBuild: applied.newBuild,
            },
          };
        }
      }
    });

  const list = yield* defineEffectTool({
    name: "environment_list",
    description:
      "List the Environments: each one's id, name, Repos and Build, marking this Session's own. An Environment is what a Workspace is made from: its Repos and its Container settings. Use environment_get with an id to see an Environment's settings.",
    parameters: Schema.Struct({}),
    replay: "safe",
    execute: () =>
      Effect.gen(function* () {
        const current = yield* environments.current;
        const listed = yield* environments.list;

        return {
          output: [
            {
              type: "text" as const,
              text:
                listed.length === 0
                  ? "There are no Environments."
                  : `Environments (id: name):\n${Arr.join(
                      Arr.map(listed, (environment) =>
                        listingLine(environment, environment.id === current),
                      ),
                      "\n",
                    )}`,
            },
          ],
          details: { current, environments: Arr.map(listed, ({ id, name }) => ({ id, name })) },
        };
      }),
  });

  const get = yield* defineEffectTool({
    name: "environment_get",
    description:
      "Show an Environment (this Session's unless id names another): its name and Repos, every Container setting (size, idle time, Container-only paths, variables, Setup and Start Scripts, Toolchains), the names of the Secrets kept for it and for every Environment (never their values), and how its Build stands, with the end of the last failed Build's reason.",
    parameters: Schema.Struct({ id: Schema.optionalKey(Id) }),
    replay: "safe",
    execute: ({ id }) =>
      Effect.gen(function* () {
        const { environment, own } = yield* target(id);
        const details = yield* environments.get(environment);

        if (details === null) return yield* notFound(environment);

        return {
          output: [{ type: "text" as const, text: describeEnvironment(details, own) }],
          details: { environment: { id: details.id, name: details.name }, current: own },
        };
      }),
  });

  const set = yield* defineEffectTool({
    name: "environment_variable_set",
    description: Arr.join(
      [
        "Set one of an Environment's variables (this Session's Environment unless id names another): every command on its Workspaces' Containers, their Setup and Start Scripts and the Environment's Build get it. The same rules as the user's Edit dialog: at most 50 variables, values of at most 4096 characters, and names a shell can export, other than those the Container sets itself (PATH, HOME, GITHUB_TOKEN, CLOUDPID_…).",
        PLAIN_VALUES,
        "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(Id),
      name: VariableName,
      value: Schema.String.annotate({ description: "The value, saved as written" }),
      reason: Reason,
    }),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: (args, api) => changeVariable("environment_variable_set", args, api.conversationId),
  });

  const unset = yield* defineEffectTool({
    name: "environment_variable_unset",
    description:
      "Unset one of an Environment's variables (this Session's Environment unless id names another). The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now. A variable that is not set is left as it is, and nothing is recorded.",
    parameters: Schema.Struct({ id: Schema.optionalKey(Id), name: VariableName, reason: Reason }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      changeVariable("environment_variable_unset", { ...args, value: null }, api.conversationId),
  });

  return defineExtension({ name: extensionName, tools: [list, get, set, unset] });
});
