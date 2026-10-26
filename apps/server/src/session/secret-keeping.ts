// Keeping the Secrets the owner chose to keep in a `secret_ask` form (`docs/spec.md` → Secrets, Agent changes): the
// Session hands the values to the Registry DO over Durable Object RPC, which seals and records them as the owner's form on
// the Environments page does; then, as after that form, the Builds' upkeep runs, and each kept Secret goes in the Run's
// Agent changes for the Notification of its end. The values are in this call's memory only: they reach no storage, log,
// result or message of the Session, and the Registry's answers and records name them, never show them.
import type { KeepRequest, KeepResult } from "@cloudpid/extensions/secrets";
import type { RunChange } from "@cloudpid/extensions/environment";
import * as Arr from "effect/Array";
import { keptSecretField } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Builds } from "../registry/builds.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { RunChanges } from "./agent-changes.ts";
import { buildsAfterScope } from "./environments.ts";

/** What keeping Secrets uses of the Registry. */
export type KeepingRegistry = Pick<RegistryMethods, "keepAskedSecrets" | "listEnvironments">;

export type SessionKeepOptions = {
  readonly registry: KeepingRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then keeps nothing. */
  readonly session: string | undefined;
  /** The Builds' upkeep, run for the Environments a kept Secret reaches. */
  readonly builds: Pick<Builds, "of">;
  /** The Run's Agent changes, which a kept Secret joins. */
  readonly changes: Pick<RunChanges, "record">;
};

/** The longest reason an Agent change gets from the agent's request, as the tools' reasons are bounded. */
const MAX_REASON = 500;

/** Why the Agent change is made: the owner's choice, on the request of the agent, whose reason follows. */
const changeReason = (asked: string | undefined): string => {
  const base = "The user chose to keep the Secret in the form the agent asked it in";
  const why = asked?.trim() ?? "";

  return (why === "" ? base : `${base}: ${why}`).slice(0, MAX_REASON);
};

const notKept = (request: KeepRequest, problem: string): ReadonlyArray<KeepResult> =>
  Arr.map(request.secrets, ({ name }) => ({ name, kept: false, problem }));

/**
 * The keep hook of the Session's Secrets (`SecretsOptions.keep`): saves the Secrets of an answer for the Session's
 * Environment or for every Environment, and says of each how it went. Never fails.
 */
export const sessionKeepSecrets =
  ({ registry, session, builds, changes }: SessionKeepOptions) =>
  (request: KeepRequest): Effect.Effect<ReadonlyArray<KeepResult>> => {
    if (session === undefined) {
      return Effect.succeed(
        notKept(request, "This Session is not one the Registry lists, so it keeps no Secret"),
      );
    }

    return Effect.gen(function* () {
      const answer = yield* registry.keepAskedSecrets({
        session,
        conversation: request.ask.conversationId,
        scope: request.scope,
        reason: changeReason(request.ask.reason),
        secrets: request.secrets,
      });

      if (answer.status === "unknown") {
        return notKept(
          request,
          "This Session is not one the Registry lists, so it keeps no Secret",
        );
      }

      const kept = Arr.filter(answer.results, (result) => result.status === "kept");

      for (const { name } of kept) {
        const change: RunChange = {
          tool: "secret_ask",
          environmentName: answer.environment.name,
          field: keptSecretField(name),
        };

        yield* changes.record(change);
      }

      // As after the owner's form, in the background: the answer does not wait for the Builds to be looked at.
      if (kept.length > 0) {
        yield* Effect.forkDetach(
          buildsAfterScope(registry, builds, answer.environment.id).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("The Builds' upkeep after a Secret was kept failed", cause),
            ),
          ),
        );
      }

      return Arr.map(request.secrets, ({ name }): KeepResult => {
        const result = Option.getOrUndefined(
          Arr.findFirst(answer.results, (each) => each.name === name),
        );

        if (result?.status === "kept") return { name, kept: true, shadowed: result.shadowed };

        return {
          name,
          kept: false,
          problem: result?.status === "rejected" ? result.message : "The Secret was not kept",
        };
      });
    }).pipe(
      // The Registry could not be reached: the Secrets stay the Session's, and the answer says so.
      Effect.catchCause(() =>
        Effect.logWarning("Keeping Secrets in the Registry failed").pipe(
          Effect.as(notKept(request, "The Registry could not be reached; try again")),
        ),
      ),
    );
  };
