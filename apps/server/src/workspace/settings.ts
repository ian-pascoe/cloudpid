// A Workspace's Container settings, kept in its Durable Object's storage (docs/architecture/container.md → Container
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
import type { EnvironmentBuild } from "./build-record.ts";

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

    // Answered as a read would have them, so a size limit below the size (the Registry refuses one, but a legacy
    // Environment's overrides name no limit) is the size here too.
    return {
      ok: true,
      state: { settings: resolveContainerSettingsLeniently(kept).settings, overrides: kept },
    };
  };

  return { read, write };
};

/** Where the Environment's Build the Workspace was handed is kept, and the Builds it gave up on. */
const BUILD_KEY = "cloudpid:environment-build";
const FAILED_BUILDS_KEY = "cloudpid:failed-builds";

/** How many Builds a Workspace remembers giving up on: the latest, as each replaces the one before. */
const FAILED_BUILDS_KEPT = 10;

/**
 * The Workspace's copy of its Environment's Build (docs/architecture/container.md → Builds), which its next launch with no snapshot of its
 * own starts from (`ContainerLaunch`). A Session's readying and a spare's request hand it over with the settings
 * (`prepare.ts`). A Build a Container did not come up from is remembered, and not offered again.
 */
export const workspaceBuildStore = (storage: SettingsStorage) => {
  const failedBuilds = async () => (await storage.get<string[]>(FAILED_BUILDS_KEY)) ?? [];

  return {
    /** The Build last handed over, or null for none. */
    read: async (): Promise<EnvironmentBuild | null> =>
      (await storage.get<EnvironmentBuild | null>(BUILD_KEY)) ?? null,
    /** Keep `build` (null: none) in place of the one handed over before. */
    write: async (build: EnvironmentBuild | null): Promise<void> => {
      await storage.put(BUILD_KEY, build);
    },
    /** The Build a launch may start from: the one handed over, unless a Container did not come up from it. */
    current: async (): Promise<EnvironmentBuild | undefined> => {
      const build = (await storage.get<EnvironmentBuild | null>(BUILD_KEY)) ?? undefined;

      return build === undefined || (await failedBuilds()).includes(build.snapshot.id)
        ? undefined
        : build;
    },
    /** A Container started from the Build `id` did not come up: it is not offered again. */
    failed: async (id: string): Promise<void> => {
      const failed = await failedBuilds();

      if (!failed.includes(id)) {
        await storage.put(FAILED_BUILDS_KEY, [...failed, id].slice(-FAILED_BUILDS_KEPT));
      }
    },
  };
};
