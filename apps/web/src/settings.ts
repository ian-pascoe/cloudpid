// The settings: the defaults a Session starts from, as the Registry holds them, and saving them.

import { overridesFrom, type Settings } from "@cloudpid/config";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";

/** The settings in force, and the overrides saved over the defaults. */
export const settingsAtom = RegistryClient.query("getSettings", undefined, {
  reactivityKeys: ["settings"],
});

/** The settings state as of the last answer; null until the first. */
export const settingsStateAtom = Atom.map(settingsAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** Why the settings could not load, or null. */
export const settingsLoadErrorAtom = Atom.map(settingsAtom, failureOf);

/**
 * Save `settings` as overrides of the defaults, and load them again. Answers with the new state, or with why the
 * Registry refused them (its own message, which lists each problem).
 */
export const updateSettingsAtom = appRuntime.fn(
  (settings: Settings) =>
    RegistryClient.use((registry) =>
      registry("updateSettings", { overrides: overridesFrom(settings) }),
    ).pipe(changing(["settings"])),
  { concurrent: true },
);
