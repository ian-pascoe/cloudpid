// Environments for the test Sessions: one Environment, "Default", whose variables are kept in the Session's storage and
// each of whose changes is applied as the Registry applies one, so a Session's `environment_*` tools run end to end.
import { type AgentChange, fieldVariable } from "@cloudpid/protocol";
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import type { EnvironmentRemovalService } from "@cloudpid/extensions/approval-tools";
import type { EnvironmentsService } from "@cloudpid/extensions/environment";
import type { EnvironmentSkills, SecretMarks } from "@cloudpid/extensions/environment";
import type { EnvironmentLifecycle } from "@cloudpid/extensions/environment-lifecycle";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { SettingsKv } from "./settings.ts";

const VARIABLES_KEY = "test-environment-variables";
const DEFAULT = { id: "default", name: "Default" } as const;

const unused = () => Effect.die("the test Environments make no lifecycle change");

/** Lifecycle operations that die when called, for Environments that make no such change. */
export const unusedLifecycle: EnvironmentLifecycle & SecretMarks & EnvironmentSkills = {
  saveSkill: unused,
  previewSkill: unused,
  removeSkill: unused,
  installSkills: unused,
  updateSkills: unused,
  previewUpdates: unused,
  create: unused,
  rename: unused,
  addRepo: unused,
  removeRepo: unused,
  rebuild: unused,
  markSecret: unused,
  startTestBuild: unused,
  testBuildRound: unused,
  cancelTestBuild: unused,
};

const undeleted = () => Effect.die("the test Environments delete nothing");

/** Deletes that die when called, for Sessions whose tests delete no Environment or kept Secret. */
export const unusedRemoval: EnvironmentRemovalService = {
  footprint: undeleted,
  deleteEnvironment: undeleted,
  keptSecrets: undeleted,
  deleteSecret: undeleted,
};

export const testEnvironments = (kv: SettingsKv): EnvironmentsService => {
  const variables = () => kv.get<Readonly<Record<string, string>>>(VARIABLES_KEY) ?? {};
  const listing = { ...DEFAULT, repos: [], build: { status: "none" as const } };

  return {
    ...unusedLifecycle,
    current: Effect.succeed(DEFAULT.id),
    list: Effect.sync(() => [listing]),
    get: (id) =>
      Effect.sync(() =>
        id === DEFAULT.id
          ? {
              ...listing,
              settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: variables() },
              secrets: [],
              everyVariables: {},
              skills: [],
              everySkills: [],
            }
          : null,
      ),
    every: Effect.succeed({ variables: {}, secrets: [], skills: [] }),
    change: ({ environment, change, author }) =>
      Effect.sync(() => {
        if (environment !== DEFAULT.id) return { status: "missing" as const };

        const name = fieldVariable(change.field) ?? change.field;
        const { [name]: before = null, ...others } = variables();

        if (before === change.value) {
          return { status: "unchanged" as const, environment: DEFAULT, value: before };
        }

        kv.put(
          VARIABLES_KEY,
          Predicate.isString(change.value) ? { ...others, [name]: change.value } : others,
        );

        const recorded: AgentChange = {
          id: 1,
          scope: DEFAULT.id,
          at: 0,
          actor: "agent",
          session: "test",
          conversation: author.conversation,
          tool: author.tool,
          reason: author.reason,
          field: change.field,
          before,
          after: change.value,
          reverts: null,
          revertedBy: null,
        };

        return {
          status: "changed" as const,
          environment: DEFAULT,
          change: recorded,
          newBuild: false,
        };
      }),
  };
};
