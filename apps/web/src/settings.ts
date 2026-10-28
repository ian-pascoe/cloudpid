// The settings (docs/architecture/overview.md → Settings): the defaults a Session starts from, as the Registry holds them, reading and saving them, and their
// Agent changes. The Settings page's sections edit them a part each (`settings/forms.ts`), through `readSettings` and
// `writeSettings`.

import { overridesFrom, type Settings } from "@cloudpid/config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";
import { visibleTickAtom } from "./sessions.ts";

/** The settings in force, and the overrides saved over the defaults. */
export const settingsAtom = RegistryClient.query("getSettings", undefined, {
  reactivityKeys: ["settings"],
});

/** The settings state as of the last answer; null until the first. */
export const settingsStateAtom = Atom.map(settingsAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/**
 * Environment `environment`'s Settings (ADR-0027): its Overrides, the Global settings it inherits, and the settings its
 * Sessions run with.
 */
export const settingsOverridesAtom = Atom.family((environment: string) =>
  RegistryClient.query("getSettingsOverrides", { environment }, { reactivityKeys: ["settings"] }),
);

/** Why the settings could not load, or null. */
export const settingsLoadErrorAtom = Atom.map(settingsAtom, failureOf);

/** The settings in force, as the last answer has them. */
export const savedSettingsAtom = Atom.map(settingsAtom, (result) =>
  AsyncResult.map(result, (state) => state.settings),
);

/** The settings in force, read from the Registry now. */
export const readSettings = RegistryClient.use((registry) =>
  registry("getSettings", undefined),
).pipe(Effect.map((state) => state.settings));

/**
 * Save `settings` as overrides of the defaults. The Registry refuses them with its own message, which lists each
 * problem.
 */
export const writeSettings = (settings: Settings) =>
  RegistryClient.use((registry) =>
    registry("updateSettings", { overrides: overridesFrom(settings) }),
  );

/**
 * The Settings' Agent changes (`docs/architecture/agent-changes.md`), newest first, asked again every few seconds while the
 * page is visible: a Session's agent makes them, which the page hears of no other way.
 */
export const settingsChangesAtom = RegistryClient.query("listSettingsChanges", undefined, {
  reactivityKeys: ["settings-changes"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom));

/**
 * Revert one of the Settings' Agent changes, by its id: its value before is written back, as the owner's change. The
 * Registry refuses one whose setting has changed since, saying what it is now. The settings and the history ask again
 * either way, so a section with no draft shows what is saved now; a section's draft is the owner's and stays.
 */
export const revertSettingsChangeAtom = appRuntime.fn(
  (change: number) =>
    RegistryClient.use((registry) => registry("revertSettingsChange", { change })).pipe(
      Effect.asVoid,
      changing(["settings", "settings-changes"]),
    ),
  { concurrent: true },
);

/**
 * Dismiss one of the Settings' Agent changes, by its id: it leaves the history, and the setting keeps the value it has.
 * The history asks again either way.
 */
export const dismissSettingsChangeAtom = appRuntime.fn(
  (change: number) =>
    RegistryClient.use((registry) => registry("dismissSettingsChange", { change })).pipe(
      changing(["settings-changes"]),
    ),
  { concurrent: true },
);
