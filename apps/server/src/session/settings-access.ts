// The Session's `SettingsAccess` (`@cloudpid/extensions/settings`, `docs/architecture/agent-changes.md`): the Registry's Settings
// at either Scope (ADR-0027: Global, or an Environment's Overrides), read and changed for the agent. A change is applied
// and recorded by the Registry (`changeSettings`), as the owner's save is applied; the Session reads the Settings again
// after it (the tools call `SettingsReload`), so its next request uses them, and other Sessions read them when they next
// admit input, as after the owner's save.
import {
  type AppliedSettingsChange,
  SettingsAccessError,
  type SettingsAccessService,
  type SettingsView,
} from "@cloudpid/extensions/settings";
import { GLOBAL_SETTINGS_SCOPE } from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import type { RegistryMethods } from "../registry/Registry.ts";
import { healingRefusal, keptSecretRefusal } from "../registry/via-secrets.ts";
import { type AuthorSource, authored, sessionOf, unlistedSession } from "./change-author.ts";

/** What the Session's Settings read and change in the Registry. */
export type SettingsRegistry = Pick<
  RegistryMethods,
  | "getSettings"
  | "getSettingsOverrides"
  | "getEnvironment"
  | "sessionSettings"
  | "changeSettings"
  | "mcpServerNames"
  | "getModelCatalog"
>;

export type SessionSettingsAccessOptions = {
  readonly registry: SettingsRegistry;
  /**
   * Who the changes are made by: the Session (its id in the Registry; undefined when unknown, for a Session that then
   * changes nothing and has no own Environment), or the endpoint's caller, who has none either.
   */
  readonly author: AuthorSource;
};

/** The Environment of the Session `source` names, as the Registry lists it; null for a Session it does not, or the endpoint. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const ownEnvironment = (
  registry: Pick<RegistryMethods, "sessionSettings">,
  source: AuthorSource,
): Effect.Effect<string | null> => {
  const session = sessionOf(source);

  return session === undefined
    ? Effect.succeed(null)
    : Effect.suspend(() => registry.sessionSettings({ session })).pipe(
        Effect.map(({ environment }) => environment),
      );
};

/** Why an Environment's Settings or MCP servers are not reached: no Environment has the id. */
export const noEnvironment = (id: string) =>
  SettingsAccessError.make({
    message: `No Environment has the id ${JSON.stringify(id)}. Give scope "*" for Global, or an Environment's id as environment_list shows it.`,
    code: "not_found",
  });

/** What the Settings' read uses of the Registry: the endpoint's Registry stub fits it, as the Session's does. */
export type SettingsReadsRegistry = Pick<
  RegistryMethods,
  "getSettings" | "getSettingsOverrides" | "getEnvironment" | "mcpServerNames"
>;

/**
 * The read of the Session's `SettingsAccess`, which needs no Session: the Settings of Global or of an Environment, with the
 * count of MCP servers at the Scope (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared
 * definitions: No Session). The Session spreads it into its service, adding `own` and `change`; the MCP endpoint builds it
 * from its Registry alone.
 */
export const settingsReads = (
  registry: SettingsReadsRegistry,
): Pick<SettingsAccessService, "get"> => ({
  get: (scope) =>
    scope === GLOBAL_SETTINGS_SCOPE
      ? Effect.suspend(() => registry.getSettings()).pipe(
          Effect.map(({ settings, overrides, problem, overriddenIn }): SettingsView => ({
            scope: GLOBAL_SETTINGS_SCOPE,
            settings,
            overrides,
            overriddenIn,
            problem,
            // Global's own entries, which `settings` holds as they resolve.
            mcpServers: Record.size(settings.mcp.servers),
          })),
        )
      : Effect.all([
          Effect.suspend(() => registry.getSettingsOverrides({ environment: scope })),
          Effect.suspend(() => registry.getEnvironment({ id: scope })),
          // The Environment's whole set, its Repos' servers included: not known to a Registry from before it was asked.
          // A count that cannot be read leaves the line without it; it never fails the tool.
          Effect.suspend(() => registry.mcpServerNames({ environment: scope })).pipe(
            Effect.orElseSucceed(() => null),
          ),
        ]).pipe(
          Effect.flatMap(([state, environment, names]) =>
            state === null || environment === null
              ? Effect.fail(noEnvironment(scope))
              : Effect.succeed<SettingsView>({
                  scope,
                  name: environment.name,
                  settings: state.settings,
                  overrides: state.overrides,
                  global: state.global,
                  problem: state.problem,
                  instructions: state.instructions,
                  mcpServers: names?.length,
                }),
          ),
        ),
});

export const sessionSettingsAccess = ({
  registry,
  author: source,
}: SessionSettingsAccessOptions): SettingsAccessService => ({
  ...settingsReads(registry),
  own: ownEnvironment(registry, source),
  models: Effect.suspend(() => registry.getModelCatalog()),
  change: ({ scope, changes, author, guard }) =>
    Effect.gen(function* () {
      const by = yield* authored(
        source,
        SettingsAccessError.make({ message: unlistedSession("Settings") }),
      )(author);

      const answer = yield* registry.changeSettings({
        environment: scope === GLOBAL_SETTINGS_SCOPE ? undefined : scope,
        changes,
        author: by,
        guard,
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
        case "rejected":
          // The endpoint's check of the kept Secrets answers in its own words, which a tool does not prefix again; one that
          // heals by itself is `unavailable`, and the caller may try the same call again.
          return source.kind === "endpoint" && keptSecretRefusal(answer.message)
            ? yield* SettingsAccessError.make({
                message: answer.message,
                code: healingRefusal(answer.message) ? "unavailable" : "invalid_argument",
              })
            : answer;
        case "unchanged":
        case "changed-since":
          return answer;
      }
    }),
});
