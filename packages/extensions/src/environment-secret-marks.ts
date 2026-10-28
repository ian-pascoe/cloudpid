// The `environment` extension's tool for the Build mark of a kept Secret (`docs/architecture/agent-changes.md`, ADR-0019):
// `environment_secret_build` marks a Secret kept for an Environment, or Global, as reaching the Build, or
// takes the mark off. The Registry applies it as the owner's switch on the Environments page does and records it, with the
// mark before and after, so the owner can revert it. Keeping a Secret is not a tool: only the owner's choice in
// `secret_ask`'s form keeps one (`secrets/store.ts`).
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import { type AgentChange, SecretName } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type ChangedEnvironment,
  type EnvironmentTarget,
  EnvironmentsError,
  idOrGlobal,
  MAX_CHANGE_REASON,
  type EnvironmentsService,
  type RunChange,
} from "./environment.ts";
import { secretEnvName } from "./secrets/references.ts";

/** The id that addresses the variables and Secrets kept Global. */
export const GLOBAL_ID = "*";

/** The name the Agent changes of the variables and Secrets kept Global give their scope. */
export const GLOBAL_NAME = "Global";

/** How the Build mark of a kept Secret was changed. */
export type SecretMarked =
  | {
      readonly status: "changed";
      /** The Environment, or Global (`GLOBAL_ID`), whose history records it. */
      readonly environment: ChangedEnvironment;
      /** The change as the Registry recorded it, with the mark before and after. */
      readonly change: AgentChange;
    }
  /** The Secret already had the mark: nothing was saved or recorded. */
  | {
      readonly status: "unchanged";
      readonly environment: ChangedEnvironment;
      readonly build: boolean;
    }
  /** No Secret of the name is kept there. */
  | { readonly status: "absent"; readonly environment: ChangedEnvironment }
  | { readonly status: "missing" };

/**
 * What the Session does for the Build mark of a kept Secret, over the Registry: applies it as the owner's switch does,
 * records it as an Agent change, and runs the Builds' upkeep the owner's switch runs (each Environment's, for a Secret
 * kept Global).
 */
export type SecretMarks = {
  readonly markSecret: (input: {
    /** The Environment's id, or `GLOBAL_ID`. */
    readonly environment: string;
    readonly name: string;
    readonly build: boolean;
    readonly author: {
      readonly conversation: number;
      readonly tool: string;
      readonly reason: string;
    };
  }) => Effect.Effect<SecretMarked, EnvironmentsError>;
};

/** What the tool needs of `EnvironmentTools`: what it builds over, and its refusals. */
export type SecretMarkDeps = {
  readonly environments: EnvironmentsService;
  /** Where the Run's Agent changes are kept for the Notification of its end. */
  readonly log: { readonly record: (change: RunChange) => Effect.Effect<void> };
  /** Fails when any of `texts` holds the value of a Secret the Session holds or of a deploy-time credential. */
  readonly refuseSecrets: (
    texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
  ) => Effect.Effect<void, EnvironmentsError>;
  readonly target: EnvironmentTarget;
};

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: AgentChange["before"]): JsonValue | null => value as JsonValue | null;

/** Where a Secret is kept, as a result names it. */
const where = (named: ChangedEnvironment): string =>
  named.id === GLOBAL_ID ? "Global" : `Environment ${JSON.stringify(named.name)} (${named.id})`;

/** "kept Global", or "kept for" the Environment, as a result says it. */
const keptIn = (named: ChangedEnvironment): string =>
  named.id === GLOBAL_ID ? "kept Global" : `kept for ${where(named)}`;

const noEnvironment = (id: string) =>
  EnvironmentsError.make({
    message: `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`,
  });

/** A Secret's Build mark, as a result says it. */
const markWords = (build: boolean): string => (build ? "marked for the Build" : "not marked");

/**
 * `environment_secret_build`: runs alone and is not replayed after an eviction, which would record the change again.
 * Built here, not at the module's top: `environment.ts` imports this file, so its exports are not there yet then.
 */
export const secretMarkTools = ({ environments, log, refuseSecrets, target }: SecretMarkDeps) => {
  const Reason = Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CHANGE_REASON),
  ).annotate({
    description:
      "Why you change the mark, for the user to read in the Agent changes, such as 'the Setup Script runs npm install against the private registry'",
  });

  const secretBuild = defineEffectTool({
    name: "environment_secret_build",
    description: Arr.join(
      [
        `Mark a Secret kept for an Environment as reaching the Build, or take the mark off (the one id names; id "${GLOBAL_ID}" is a Secret kept Global). Only a Secret the user kept can be marked: ask for one with secret_ask and keep, and the user chooses in the form whether to keep it.`,
        "A Secret marked for the Build reaches every Setup Script of the Environment as $PI_SECRET_<NAME>: the Environment's own and each Repo's .cloudpid/setup.sh, in the Environment's Build and in the Setup Scripts of each Workspace's Container. A script can print it or write it to a file, so mark only a Secret a Setup Script needs (a private registry token); an unmarked one reaches only commands and Sessions. A Secret marked for the Build is part of the Build's key, so changing the mark can make a new Build.",
        "The change is recorded with your reason, the mark before and after (never the value), and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: idOrGlobal("a Secret kept Global"),
      name: SecretName.annotate({ description: "The Secret's name, such as NPM_TOKEN" }),
      build: Schema.Boolean.annotate({
        description: "true marks the Secret for the Build, false takes the mark off",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, name, build, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        const environment = id === GLOBAL_ID ? GLOBAL_ID : (yield* target(id)).environment;

        const marked = yield* environments.markSecret({
          environment,
          name,
          build,
          author: {
            conversation: api.conversationId,
            tool: "environment_secret_build",
            reason,
          },
        });

        switch (marked.status) {
          case "missing":
            return yield* noEnvironment(environment);
          case "absent":
            return yield* EnvironmentsError.make({
              message: `Nothing was saved: no Secret ${name} is ${keptIn(marked.environment)}. environment_get with id ${marked.environment.id} shows the Secrets kept (names only); a Secret kept Global is addressed with id "${GLOBAL_ID}". To keep one, call secret_ask with keep: the user chooses in the form whether to keep it.`,
            });
          case "unchanged":
            return {
              output: [
                {
                  type: "text" as const,
                  text: `${name}, ${keptIn(marked.environment)}, is ${markWords(marked.build)} already: nothing changed, and nothing was recorded.`,
                },
              ],
              details: { unchanged: { environment: marked.environment, name } },
            };
          case "changed": {
            const { change } = marked;

            yield* log.record({
              tool: "environment_secret_build",
              environmentName: marked.environment.name,
              field: change.field,
            });

            return {
              output: [
                {
                  type: "text" as const,
                  text: Arr.join(
                    [
                      `${name}, ${keptIn(marked.environment)}, was ${markWords(change.before === true)} and is ${markWords(build)} now.`,
                      build
                        ? `${marked.environment.id === GLOBAL_ID ? "Every Setup Script of each Environment" : `Every Setup Script of ${where(marked.environment)}`} gets it as $${secretEnvName(name)}, in the Environment's Build and in the Setup Scripts of each Workspace's Container, from each Workspace's next Container start; a script can print it, so keep the marked Secrets to what a Setup Script needs.`
                        : "No Setup Script gets it any more; commands and Sessions still do.",
                      "The Builds' upkeep ran, as after the user's own switch: a new Build is made when the mark changes what the Setup Scripts get (environment_get shows how the Build goes). The change is recorded with your reason, and the user can revert it on the Environments page.",
                    ],
                    " ",
                  ),
                },
              ],
              details: {
                agentChange: {
                  id: change.id,
                  environment: marked.environment,
                  field: change.field,
                  before: asJsonValue(change.before),
                  after: asJsonValue(change.after),
                },
              },
            };
          }
        }
      }),
  });

  return Effect.all([secretBuild]);
};
