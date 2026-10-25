// The `environment` extension's tools for an Environment's own record (`docs/spec.md` → Agent changes): the agent makes
// an Environment, renames it, adds Repos to it and takes them out, and asks for its Build. Each is applied as the
// owner's RPC is and recorded as an Agent change, like the tools for its Container settings; they are the same
// extension's, built next to those (`EnvironmentTools`) over the same `Environments`.
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import { type AgentChange, type EnvironmentRepo, fieldRepo } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type ChangeAuthor,
  type ChangedEnvironment,
  EnvironmentsError,
  type EnvironmentsService,
  MAX_CHANGE_REASON,
  type RunChange,
} from "./environment.ts";

/** How an Agent change to an Environment's record went, as the Session reports it. */
export type RecordChanged =
  | {
      readonly status: "changed";
      readonly environment: ChangedEnvironment;
      /** The change as the Registry recorded it, with the values before and after. */
      readonly change: AgentChange;
    }
  /** The record already was as asked: nothing was saved or recorded. */
  | { readonly status: "unchanged"; readonly environment: ChangedEnvironment }
  /** Not allowed, said as the owner's save says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" };

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
  }) => Effect.Effect<RecordChanged, EnvironmentsError>;
  /** Ask for a new Build now, as the owner's Rebuild does, and record it once it is under way. */
  readonly rebuild: (input: {
    readonly environment: string;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<RecordChanged, EnvironmentsError>;
};

const Id = Schema.String.annotate({
  description:
    "The Environment's id, as environment_list shows it (default: this Session's Environment)",
});

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

const WORKSPACES_UNTOUCHED =
  "Only the Environment's record and its spare Workspace change: no Workspace a Session has gets a clone or loses one, this Session's included.";

/** What the tools of this file need of `EnvironmentTools`: what it builds them over, and its refusals. */
export type LifecycleDeps = {
  readonly environments: EnvironmentsService;
  /** Where the Run's Agent changes are kept for the Notification of its end. */
  readonly log: { readonly record: (change: RunChange) => Effect.Effect<void> };
  /** Fails when any of `texts` holds the value of a Secret the Session holds or of a deploy-time credential. */
  readonly refuseSecrets: (
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
  ) => Effect.Effect<void, EnvironmentsError>;
  /** The Environment `id` names, the Session's own by default, with whether it is the Session's own. */
  readonly target: (
    id: string | undefined,
  ) => Effect.Effect<{ readonly environment: string; readonly own: boolean }, EnvironmentsError>;
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

  /** The result of a change that was recorded: its text, and what the card shows. */
  const recordedResult = (
    tool: string,
    environment: ChangedEnvironment,
    change: AgentChange,
    text: string,
  ) =>
    log.record({ tool, environmentName: environment.name, field: change.field }).pipe(
      Effect.as({
        output: [{ type: "text" as const, text }],
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
  const unchangedResult = (text: string, environment: ChangedEnvironment) => ({
    output: [{ type: "text" as const, text }],
    details: { unchanged: { environment } },
  });

  /** Apply `change` to the Environment `id` names; what it answers for each outcome but a recorded change. */
  const applied = (
    id: string | undefined,
    change: (environment: string) => Effect.Effect<RecordChanged, EnvironmentsError>,
  ) =>
    Effect.gen(function* () {
      const { environment, own } = yield* target(id);
      const answer = yield* change(environment);

      switch (answer.status) {
        case "missing":
          return yield* notFound(environment);
        case "rejected":
          return yield* refused(answer.message);
        default:
          return { answer, own };
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
        );
      }),
  });

  const rename = defineEffectTool({
    name: "environment_rename",
    description:
      "Rename an Environment (this Session's unless id names another): the same name rules as the user's (1 to 80 characters, free among the Environments whatever the case). Its id never changes. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
    parameters: Schema.Struct({
      id: Schema.optionalKey(Id),
      name: Schema.String.annotate({ description: "The new name" }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the name", text: name },
          { what: "the reason", text: reason },
        ]);

        const { answer } = yield* applied(id, (environment) =>
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
          );
        }

        const { environment, change } = answer;

        return yield* recordedResult(
          "environment_rename",
          environment,
          change,
          `Renamed "${shown(change.before)}" to "${shown(change.after)}": ${named(environment)}. Its id is the same.`,
        );
      }),
  });

  const repoAdd = defineEffectTool({
    name: "environment_repo_add",
    description: Arr.join(
      [
        "Add a Repo to an Environment (this Session's unless id names another), for the Workspaces made from then on: the same rules as the user's. It is cloned into /workspace/<name> by a Workspace's first use. The Environment's spare Workspace is made again, and its Build is made with the Repo.",
        "Only the Environment's record and its spare Workspace change: no Workspace a Session has gets the clone, this Session's included. A new Workspace gets it. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(Id),
      url: RepoSource,
      name: Schema.optionalKey(RepoDirectory),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, url, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([
          { what: "the repo", text: url },
          { what: "the directory", text: name ?? "" },
          { what: "the reason", text: reason },
        ]);

        const { answer } = yield* applied(id, (environment) =>
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
          );
        }

        const { environment, change } = answer;

        return yield* recordedResult(
          "environment_repo_add",
          environment,
          change,
          `Added the repo ${fieldRepo(change.field) ?? ""} (${shown(change.after)}) to ${named(environment)}. ${WORKSPACES_UNTOUCHED} A new Workspace made from the Environment gets the clone.`,
        );
      }),
  });

  const repoRemove = defineEffectTool({
    name: "environment_repo_remove",
    description: Arr.join(
      [
        "Take a Repo out of an Environment (this Session's unless id names another), by its directory name as environment_get shows it: the same rules as the user's. The Environment's spare Workspace is made again, and its Build is made without the Repo.",
        "Only the Environment's record and its spare Workspace change: no Workspace a Session has loses its clone, this Session's included. A new Workspace does not get one. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(Id),
      name: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The repo's directory name below /workspace, as environment_get shows it",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, name, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        const { answer } = yield* applied(id, (environment) =>
          environments.removeRepo({
            environment,
            name,
            author: { conversation: api.conversationId, tool: "environment_repo_remove", reason },
          }),
        );

        if (answer.status === "unchanged") {
          return unchangedResult(
            `${named(answer.environment)} has no repo ${name}: nothing changed, and nothing was recorded.`,
            answer.environment,
          );
        }

        const { environment, change } = answer;

        return yield* recordedResult(
          "environment_repo_remove",
          environment,
          change,
          `Took the repo ${name} (${shown(change.before)}) out of ${named(environment)}. ${WORKSPACES_UNTOUCHED} A new Workspace made from the Environment does not get the clone.`,
        );
      }),
  });

  const rebuild = defineEffectTool({
    name: "environment_rebuild",
    description: Arr.join(
      [
        "Ask for a new Build of an Environment now (this Session's unless id names another), as the user's Rebuild does: its Repos cloned and its Toolchains and Setup Script run on a fresh Container, then snapshotted, for the Workspaces made from then on to start from. A Build already under way for the same Repos and settings is left to finish. An Environment with no Repos, no Setup Script and no Toolchains has nothing to build.",
        "It answers at once, with the Build under way: environment_get shows how it goes and, when it fails, the end of its reason. The request is recorded with your reason. It cannot be reverted.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({ id: Schema.optionalKey(Id), reason: Reason }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        const { answer } = yield* applied(id, (environment) =>
          environments.rebuild({
            environment,
            author: { conversation: api.conversationId, tool: "environment_rebuild", reason },
          }),
        );

        if (answer.status === "unchanged") {
          return unchangedResult(
            `${named(answer.environment)}: nothing to ask for.`,
            answer.environment,
          );
        }

        const { environment, change } = answer;

        return yield* recordedResult(
          "environment_rebuild",
          environment,
          change,
          `Asked for a new Build of ${named(environment)}: the Build is under way. environment_get shows its state and, when it fails, the end of its reason.`,
        );
      }),
  });

  return Effect.all([create, rename, repoAdd, repoRemove, rebuild]);
};
