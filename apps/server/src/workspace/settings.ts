// A Workspace's own settings, kept in its Durable Object's storage (docs/spec.md → Container and Toolchains → Size and
// idle). They live here, not in the Registry: the Workspace DO reads them when it launches its Container, and its
// Worker (`Workspaces`) deploys before the main Worker that hosts the Registry, so it cannot reach the Registry. The
// UI reads and writes them through `RegistryRpcs` (`getMachineSettings`/`updateMachineSettings`), which the main
// Worker answers from this object.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import {
  resolveMachineSettings,
  resolveMachineSettingsLeniently,
  type MachineSettings,
  machineOverridesFrom,
} from "@cloudpid/config";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

/** Where the overrides are kept. */
const SETTINGS_KEY = "cloudpid:workspace-settings";

/** The settings in force and the overrides they come from, as plain data a Durable Object can answer over RPC. */
export type WorkspaceSettingsAnswer = {
  readonly settings: MachineSettings;
  readonly overrides: Schema.Json;
  /** Why only some of the saved overrides applied, when a later release no longer accepts one. */
  readonly problem?: string;
};

export type WriteAnswer =
  | { readonly ok: true; readonly state: WorkspaceSettingsAnswer }
  | { readonly ok: false; readonly message: string };

/** The part of the Durable Object's storage the settings use. */
export type SettingsStorage = {
  readonly get: <T>(key: string) => Promise<T | undefined>;
  readonly put: (key: string, value: Schema.Json) => Promise<void>;
};

export const workspaceSettingsStore = (storage: SettingsStorage) => {
  const read = async (): Promise<WorkspaceSettingsAnswer> => {
    const overrides = (await storage.get<Schema.Json>(SETTINGS_KEY)) ?? {};
    const { settings, dropped } = resolveMachineSettingsLeniently(overrides);

    return dropped.length === 0
      ? { settings, overrides }
      : { settings, overrides, problem: dropped.join("\n") };
  };

  const write = async (overrides: Schema.Json): Promise<WriteAnswer> => {
    const resolved = resolveMachineSettings(overrides);

    if (Result.isFailure(resolved)) return { ok: false, message: resolved.failure.message };

    // Only what differs from the defaults is kept, so a setting left alone follows later changes of the default.
    const kept = machineOverridesFrom(resolved.success);

    await storage.put(SETTINGS_KEY, kept);

    return { ok: true, state: { settings: resolved.success, overrides: kept } };
  };

  /** The overrides as stored, to put back once the rest of the storage is wiped (`Workspace.clear`). */
  const saved = () => storage.get<Schema.Json>(SETTINGS_KEY);

  /** Put back what `saved` answered; nothing saved stays nothing. */
  const restore = async (overrides: Schema.Json | undefined): Promise<void> => {
    if (overrides !== undefined) await storage.put(SETTINGS_KEY, overrides);
  };

  return { read, write, saved, restore };
};

/** The Workspaces' settings, as the main Worker reaches them: asked of each Workspace's Durable Object. */
export type WorkspaceSettingsRemote = {
  readonly read: (slug: string) => Promise<WorkspaceSettingsAnswer>;
  readonly write: (slug: string, overrides: Schema.Json) => Promise<WriteAnswer>;
};

/** What the Workspace DO answers for the settings: `containerSettings` and `updateContainerSettings`. */
type SettingsHost = {
  containerSettings(): Promise<WorkspaceSettingsAnswer>;
  updateContainerSettings(overrides: Schema.Json): Promise<WriteAnswer>;
};

/** The settings of the Workspace DOs `namespace` holds. */
export const workspaceSettingsRemote = (namespace: {
  getByName(slug: string): SettingsHost;
}): WorkspaceSettingsRemote => ({
  read: (slug) => namespace.getByName(slug).containerSettings(),
  write: (slug, overrides) => namespace.getByName(slug).updateContainerSettings(overrides),
});
