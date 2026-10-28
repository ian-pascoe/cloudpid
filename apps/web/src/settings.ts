// The settings: the defaults a Session starts from, as the Registry holds them, saving them, and the settings form's
// state.

import { DEFAULT_SETTINGS, overridesFrom, type Settings } from "@cloudpid/config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { offeredToText } from "./offered-tools.ts";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";
import { visibleTickAtom } from "./sessions.ts";
import { spendLimitToText } from "./spend-limit.ts";

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

/**
 * The Settings' Agent changes (`docs/architecture/agent-changes.md`), newest first, asked again every few seconds while the
 * page is visible: a Session's agent makes them, which the page hears of no other way.
 */
export const settingsChangesAtom = RegistryClient.query("listSettingsChanges", undefined, {
  reactivityKeys: ["settings-changes"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom));

/** Whether the form was saved and not changed since: it then says so. */
export const justSavedAtom = Atom.make(false);

/**
 * Save `settings` as overrides of the defaults, and load them again. Answers with the new state, or with why the
 * Registry refused them (its own message, which lists each problem).
 */
export const updateSettingsAtom = appRuntime.fn(
  (settings: Settings, get) =>
    RegistryClient.use((registry) =>
      registry("updateSettings", { overrides: overridesFrom(settings) }),
    ).pipe(
      changing(["settings"]),
      Effect.tap(() =>
        Effect.sync(() => {
          get.set(justSavedAtom, true);
        }),
      ),
      Effect.tapCause(() =>
        Effect.sync(() => {
          get.set(justSavedAtom, false);
        }),
      ),
    ),
  { concurrent: true },
);

/**
 * A piece of the settings form: it starts as `initial` of the settings in force when the form first reads it, and then
 * holds what was typed, whatever the settings are asked for again (after a save, say). The page has one form, so each
 * piece is one atom, and it starts afresh each time the page is opened.
 */
const formPart = <A>(
  initial: (saved: Settings) => A,
  afterWrite?: (ctx: Atom.WriteContext<A>) => void,
) =>
  Atom.writable(
    (get): A =>
      Option.getOrElse(get.self<A>(), () =>
        initial(get(settingsStateAtom)?.settings ?? DEFAULT_SETTINGS),
      ),
    (ctx, value: A) => {
      ctx.setSelf(value);
      afterWrite?.(ctx);
    },
  );

/** The settings the form holds; changing them takes the "Saved" away. */
export const settingsDraftAtom = formPart(
  (saved) => saved,
  (ctx) => {
    ctx.set(justSavedAtom, false);
  },
);

/** What is typed in the offered tools' text box; the draft holds what it parses to. */
export const offeredTextAtom = formPart((saved) => offeredToText(saved.tools.offered));

/** What is typed in the spend limit's box; the draft holds what it parses to, when it parses. */
export const limitTextAtom = formPart((saved) => spendLimitToText(saved.spendLimit.perSession));

/**
 * Revert one of the Settings' Agent changes, by its id: its value before is written back, as the owner's change. The
 * Registry refuses one whose setting has changed since, saying what it is now. The settings and the history ask again
 * either way, and once the revert is made the form shows what is saved now, not what it held before.
 */
export const revertSettingsChangeAtom = appRuntime.fn(
  (change: number, get) =>
    RegistryClient.use((registry) => registry("revertSettingsChange", { change })).pipe(
      changing(["settings", "settings-changes"]),
      Effect.andThen(RegistryClient.use((registry) => registry("getSettings", undefined))),
      Effect.tap(({ settings }) =>
        Effect.sync(() => {
          get.set(settingsDraftAtom, settings);
          get.set(offeredTextAtom, offeredToText(settings.tools.offered));
          get.set(limitTextAtom, spendLimitToText(settings.spendLimit.perSession));
        }),
      ),
      Effect.asVoid,
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
