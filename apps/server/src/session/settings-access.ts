// The Session's `SettingsAccess` (`@cloudpid/extensions/settings`, `docs/architecture/agent-changes.md`): the Registry's Settings
// at either Scope (ADR-0027: Global, or an Environment's Overrides), read and changed for the agent. A change is applied
// and recorded by the Registry (`changeSettings`), as the owner's save is applied; the Session reads the Settings again
// after it (the tools call `SettingsReload`), so its next request uses them, and other Sessions read them when they next
// admit input, as after the owner's save.
import {
  type AppliedSettingsChange,
  GLOBAL_SETTINGS_SCOPE,
  SettingsAccessError,
  type SettingsAccessService,
  type SettingsView,
} from "@cloudpid/extensions/settings";
import * as Effect from "effect/Effect";
import type { RegistryMethods } from "../registry/Registry.ts";

/** What the Session's Settings read and change in the Registry. */
export type SettingsRegistry = Pick<
  RegistryMethods,
  "getSettings" | "getSettingsOverrides" | "getEnvironment" | "sessionSettings" | "changeSettings"
>;

export type SessionSettingsAccessOptions = {
  readonly registry: SettingsRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then changes nothing. */
  readonly session: string | undefined;
};

/** Why an Environment's Settings are not reached: no Environment has the id. */
const noEnvironment = (id: string) =>
  SettingsAccessError.make({
    message: `No Environment has the id ${JSON.stringify(id)}. Give scope "*" for Global, or an Environment's id as environment_list shows it.`,
  });

export const sessionSettingsAccess = ({
  registry,
  session,
}: SessionSettingsAccessOptions): SettingsAccessService => ({
  get: (scope) =>
    scope === GLOBAL_SETTINGS_SCOPE
      ? Effect.suspend(() => registry.getSettings()).pipe(
          Effect.map(({ settings, overrides, problem, overriddenIn }): SettingsView => ({
            scope: GLOBAL_SETTINGS_SCOPE,
            settings,
            overrides,
            overriddenIn,
            problem,
          })),
        )
      : Effect.all([
          Effect.suspend(() => registry.getSettingsOverrides({ environment: scope })),
          Effect.suspend(() => registry.getEnvironment({ id: scope })),
        ]).pipe(
          Effect.flatMap(([state, environment]) =>
            state === null || environment === null
              ? Effect.fail(noEnvironment(scope))
              : Effect.succeed<SettingsView>({
                  scope,
                  name: environment.name,
                  settings: state.settings,
                  overrides: state.overrides,
                  global: state.global,
                  problem: state.problem,
                }),
          ),
        ),
  own:
    session === undefined
      ? Effect.succeed(null)
      : Effect.suspend(() => registry.sessionSettings({ session })).pipe(
          Effect.map(({ environment }) => environment),
        ),
  change: ({ scope, changes, author }) =>
    Effect.gen(function* () {
      if (session === undefined) {
        return yield* SettingsAccessError.make({
          message: "This Session is not one the Registry lists, so it changes no Settings.",
        });
      }

      const answer = yield* registry.changeSettings({
        environment: scope === GLOBAL_SETTINGS_SCOPE ? undefined : scope,
        changes,
        author: { session, ...author },
      });

      switch (answer.status) {
        case "changed":
          return {
            status: "changed",
            changes: answer.changes,
            dropped: answer.dropped,
          } satisfies AppliedSettingsChange;
        case "missing":
          return yield* noEnvironment(scope);
        case "unchanged":
        case "rejected":
        case "changed-since":
          return answer;
      }
    }),
});
