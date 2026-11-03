// What a change to an MCP server's keys would do to each Environment's set, asked by the agent's `settings_mcp_*` tools before
// they write (`docs/architecture/mcp-configuration.md` → The agent's changes → Approval, The check; Scopes and layers). Pure over
// the store's rows: it resolves the set before and after with `resolveMcpServerSet`, by name, for each Environment the change
// reaches (every one at Global, only the named one at an Environment), and says for each whether the server's entry in
// force changes there and what `checkMcpWidening` finds it makes reachable. It writes nothing.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values, not combinators.
import {
  checkMcpWidening,
  DEFAULT_SETTINGS,
  type McpResolvedServer,
  type OverrideFieldChange,
  overridesWithFields,
  resolveMcpServerSet,
  settingsFieldValue,
  sortedJson,
  withOverrideFields,
} from "@cloudpid/config";
import type { SettingsMcpChangeCheck, SettingsMcpReach } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { McpSetStore } from "./mcp-registry.ts";
import { mcpRepoLayers } from "./mcp-repo-files.ts";
import {
  mcpLayersOf,
  readSettings,
  readSettingsOverrides,
  type SettingsStore,
} from "./settings.ts";

/** One field of a server given a new value, or reset (Global: back to its default; an Environment: inheriting again). */
export type McpFieldChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
  readonly reset?: true | undefined;
};

const serverOf = (
  servers: ReadonlyArray<McpResolvedServer>,
  name: string,
): McpResolvedServer | undefined =>
  Option.getOrUndefined(Arr.findFirst(servers, (each) => each.name === name));

const sameEntry = (left: McpResolvedServer | undefined, right: McpResolvedServer | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : JSON.stringify(sortedJson(JSON.parse(JSON.stringify(left.server)))) ===
      JSON.stringify(sortedJson(JSON.parse(JSON.stringify(right.server))));

/**
 * `changes` to server `name`'s keys, at Global (`environment` absent) or at an Environment's Overrides, resolved against each
 * Environment's set before and after. Null when no Environment has the id.
 */
export const mcpChangeCheck = (
  store: McpSetStore & SettingsStore,
  input: {
    readonly environment: string | undefined;
    readonly name: string;
    readonly changes: ReadonlyArray<McpFieldChange>;
  },
): SettingsMcpChangeCheck | null => {
  const { environment, name, changes } = input;

  const reach = (
    id: string,
    label: string,
    before: ReturnType<typeof mcpLayersOf>,
    after: ReturnType<typeof mcpLayersOf>,
  ): SettingsMcpReach | undefined => {
    const was = serverOf(
      resolveMcpServerSet(before.global, before.overrides, before.repos).servers,
      name,
    );

    const now = serverOf(
      resolveMcpServerSet(after.global, after.overrides, after.repos).servers,
      name,
    );

    return was === undefined && now === undefined
      ? undefined
      : {
          environment: { id, name: label },
          reached: !sameEntry(was, now),
          widening: checkMcpWidening(was, now),
        };
  };

  if (environment !== undefined) {
    const known = readSettingsOverrides(store, environment);

    if (known === null) return null;

    const before = mcpLayersOf(
      store,
      store.getSettingsOverrides(environment) ?? {},
      mcpRepoLayers(store, environment),
    );

    const next = withOverrideFields(
      known.overrides,
      Arr.map(changes, (change): OverrideFieldChange =>
        change.reset === true
          ? { field: change.field, reset: true }
          : { field: change.field, value: change.value },
      ),
      known.settings,
    );

    // A change the Registry will not take is refused when it is written, with its own message.
    if (Result.isFailure(next)) return { environments: [] };

    const found = reach(environment, known.environment, before, {
      ...before,
      overrides: next.success,
    });

    return { environments: found === undefined ? [] : [found] };
  }

  const global = readSettings(store);

  const afterGlobal = overridesWithFields(
    global.settings,
    Arr.map(changes, (change) => ({
      field: change.field,
      value:
        change.reset === true ? settingsFieldValue(DEFAULT_SETTINGS, change.field) : change.value,
    })),
  );

  return {
    environments: Arr.filterMap(store.listEnvironments(), (each) => {
      const before = mcpLayersOf(
        store,
        store.getSettingsOverrides(each.id) ?? {},
        mcpRepoLayers(store, each.id),
      );

      const found = reach(each.id, each.name, before, { ...before, global: afterGlobal });

      return found === undefined ? Result.failVoid : Result.succeed(found);
    }),
  };
};

/** The Environments whose set has a server called `name`, for a name Global's own entries do not have. */
export const mcpDefinedIn = (
  store: McpSetStore,
  name: string,
): ReadonlyArray<{ readonly id: string; readonly name: string }> =>
  Arr.filterMap(store.listEnvironments(), (each) => {
    const layers = mcpLayersOf(
      store,
      store.getSettingsOverrides(each.id) ?? {},
      mcpRepoLayers(store, each.id),
    );

    return serverOf(
      resolveMcpServerSet(layers.global, layers.overrides, layers.repos).servers,
      name,
    ) === undefined
      ? Result.failVoid
      : Result.succeed({ id: each.id, name: each.name });
  });
