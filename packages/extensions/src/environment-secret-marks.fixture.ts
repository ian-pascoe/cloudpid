// Fake Build marks of kept Secrets for the `environment` extension's tests: Secrets kept in memory that apply a mark as
// the Registry does, and record what was asked.
import type { AgentChange } from "@cloudpid/protocol";
import { secretBuildField } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  EVERY_ENVIRONMENT_ID,
  EVERY_ENVIRONMENT_NAME,
  type SecretMarks,
} from "./environment-secret-marks.ts";

/** A mark that fails when called, for a fake that serves the other tools only. */
export const unusedSecretMarks: SecretMarks = {
  markSecret: () => Effect.die("markSecret is not used here"),
};

/** A Secret kept in the fake: for an Environment's id, or `EVERY_ENVIRONMENT_ID`. */
export type KeptMark = { scope: string; name: string; build: boolean };

/**
 * Marks over Environments `default` (named Default) and `0000abcd` (named Other), and these kept Secrets: API_KEY for
 * Default, marked for the Build, and NPM_TOKEN for every Environment, not marked.
 */
export const fakeSecretMarks = () => {
  const names = new Map([
    ["default", "Default"],
    ["0000abcd", "Other"],
  ]);

  const kept: KeptMark[] = [
    { scope: "default", name: "API_KEY", build: true },
    { scope: EVERY_ENVIRONMENT_ID, name: "NPM_TOKEN", build: false },
  ];

  const calls: Array<{ environment: string; name: string; build: boolean; tool: string }> = [];
  let next = 1;

  const service: SecretMarks = {
    markSecret: ({ environment, name, build, author }) =>
      Effect.sync(() => {
        const every = environment === EVERY_ENVIRONMENT_ID;
        const known = every ? EVERY_ENVIRONMENT_NAME : names.get(environment);

        if (known === undefined) return { status: "missing" as const };

        const where = { id: environment, name: known };

        const found = Option.getOrUndefined(
          Arr.findFirst(kept, (each) => each.scope === environment && each.name === name),
        );

        if (found === undefined) return { status: "absent" as const, environment: where };

        if (found.build === build) {
          return { status: "unchanged" as const, environment: where, build };
        }

        found.build = build;
        calls.push({ environment, name, build, tool: author.tool });

        const change: AgentChange = {
          id: next++,
          scope: environment,
          at: 1_000,
          actor: "agent",
          session: "s-1",
          conversation: author.conversation,
          tool: author.tool,
          reason: author.reason,
          field: secretBuildField(name),
          before: !build,
          after: build,
          reverts: null,
          revertedBy: null,
        };

        return { status: "changed" as const, environment: where, change };
      }),
  };

  return { service, kept, calls };
};
