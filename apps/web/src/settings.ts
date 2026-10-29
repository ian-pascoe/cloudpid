// The settings (docs/architecture/overview.md → Settings): the defaults a Session starts from, as the Registry holds them, reading and saving them, and their
// Agent changes. The Settings page's sections edit them a part each (`settings/forms.ts`), through `readSettings` and
// `writeSettings`.

import { overridesFrom, overridesPatchBetween, type Settings } from "@cloudpid/config";
import type * as Schema from "effect/Schema";
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

/** The Global Settings (in force, their overrides of the defaults, and who overrides each field), read from the Registry now. */
export const readSettings = RegistryClient.use((registry) => registry("getSettings", undefined));

/**
 * Save `settings` as overrides of the defaults. The Registry refuses them with its own message, which lists each
 * problem.
 */
export const writeSettings = (settings: Settings) =>
  RegistryClient.use((registry) =>
    registry("updateSettings", { overrides: overridesFrom(settings) }),
  );

/** Environment `environment`'s Settings (its Overrides, Global's settings and the two resolved), read from the Registry now. */
export const readSettingsOverrides = (environment: string) =>
  RegistryClient.use((registry) => registry("getSettingsOverrides", { environment }));

/**
 * Make Environment `environment`'s Overrides `before` into `after`: each field added or changed set as its Override
 * (even equal to Global's), each taken out reset so it inherits again, and every other field left as it is now
 * (`overridesPatchBetween`). The Registry refuses them with its own message.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a write helper over an Environment's id, not a combinator.
export const writeSettingsOverrides = (
  environment: string,
  before: Schema.Json,
  after: Schema.Json,
) =>
  RegistryClient.use((registry) =>
    registry("updateSettingsOverrides", { environment, ...overridesPatchBetween(before, after) }),
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
