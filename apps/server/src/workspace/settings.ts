// A Workspace's Container settings, kept in its Durable Object's storage (docs/spec.md → Container and Toolchains → Container
// settings). They are its Environment's, which the Registry keeps: a Session hands them over when it readies the
// Workspace (`prepare.ts`), since the Workspace DO reads them when it launches its Container, and its Worker
// (`Workspaces`) deploys before the main Worker that hosts the Registry, so it cannot reach the Registry.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import {
  resolveContainerSettings,
  resolveContainerSettingsLeniently,
  type ContainerSettings,
  containerOverridesFrom,
} from "@cloudpid/config";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

/** Where the overrides are kept. */
const SETTINGS_KEY = "cloudpid:workspace-settings";

/** The settings in force and the overrides they come from, as plain data a Durable Object can answer over RPC. */
export type WorkspaceSettingsAnswer = {
  readonly settings: ContainerSettings;
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
    const { settings, dropped } = resolveContainerSettingsLeniently(overrides);

    return dropped.length === 0
      ? { settings, overrides }
      : { settings, overrides, problem: dropped.join("\n") };
  };

  const write = async (overrides: Schema.Json): Promise<WriteAnswer> => {
    const resolved = resolveContainerSettings(overrides);

    if (Result.isFailure(resolved)) return { ok: false, message: resolved.failure.message };

    // Only what differs from the defaults is kept, so a setting left alone follows later changes of the default.
    const kept = containerOverridesFrom(resolved.success);

    await storage.put(SETTINGS_KEY, kept);

    return { ok: true, state: { settings: resolved.success, overrides: kept } };
  };

  return { read, write };
};
