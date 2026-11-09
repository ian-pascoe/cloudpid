// The `environment` extension's tool for the Build mark of a kept Secret (`docs/architecture/agent-changes.md`, ADR-0019;
// `docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared definitions and the core/wrapper split):
// `environment_secret_build` marks a Secret kept for an Environment, or Global, as reaching the Build, or
// takes the mark off. The Registry applies it as the owner's switch on the Environments page does and records it, with the
// mark before and after, so the owner can revert it. Keeping a Secret is not a tool: only the owner's choice in
// `secret_ask`'s form keeps one (`secrets/store.ts`). Its `structuredOutput`
// (`docs/architecture/agent-capabilities.md` → Values for programs; `outputs.ts`) is the outcome of the mark
// (`ChangeOutput`): the Agent change with the mark before and after, or the field that had it already. Its core, shared with
// the endpoint, is `environment-changes.ts`'s; the tool here is the Session's wrapper over it.
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange } from "@cloudpid/protocol";
import { HARNESS_TOOLS } from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import type {
  ChangeAuthor,
  ChangedEnvironment,
  EnvironmentsError,
  RunChange,
} from "./environment.ts";
import { type HarnessWrite, loggedOf, toolResult } from "./harness.ts";
import { outputSchema } from "./outputs.ts";

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
    readonly author: Pick<ChangeAuthor, "conversation" | "tool" | "reason">;
  }) => Effect.Effect<SecretMarked, EnvironmentsError>;
};

/** What the tool needs of `EnvironmentTools`: its core, and where the Run's changes are kept. */
export type SecretMarkDeps = {
  /** `environment_secret_build`'s core (`./environment-changes.ts`). */
  readonly core: HarnessWrite<
    (typeof HARNESS_TOOLS)["environment_secret_build"]["session"]["input"]["Type"],
    EnvironmentsError
  >;
  /** Where the Run's Agent changes are kept for the Notification of its end. */
  readonly log: { readonly record: (change: RunChange) => Effect.Effect<void> };
};

/**
 * `environment_secret_build`: runs alone and is not replayed after an eviction, which would record the change again.
 * Built here, not at the module's top: `environment.ts` imports this file, so its exports are not there yet then.
 */
export const secretMarkTools = ({ core, log }: SecretMarkDeps) => {
  const declared = HARNESS_TOOLS.environment_secret_build;

  const secretBuild = defineEffectTool({
    name: declared.name,
    description: declared.session.description,
    parameters: declared.session.input,
    structuredOutputSchema: outputSchema(declared.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      core(args, "session", api.conversationId).pipe(
        Effect.tap(({ logged }) => Effect.forEach(loggedOf(logged), log.record, { discard: true })),
        Effect.map(toolResult),
      ),
  });

  return Effect.all([secretBuild]);
};
