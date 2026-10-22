// The Machine list, what the owner does to a Machine in it (create, edit, delete, clone a repo), and the state of the
// Machines page's forms and dialogs.

import { machineOverridesFrom, type InstanceType, type MachineSettings } from "@cloudpid/config";
import type { MachineSettingsState } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Record from "effect/Record";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";

/** Every Machine, newest first. */
export const machinesAtom = RegistryClient.query("listMachines", undefined, {
  reactivityKeys: ["machines"],
});

/** The Machines, newest first, as of the last answer; null until the first. */
export const machineListAtom = Atom.map(machinesAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** Why the list could not load, or null. */
export const machinesErrorAtom = Atom.map(machinesAtom, failureOf);

/** Each Machine's name, by slug. */
export const machineNamesAtom = Atom.map(machineListAtom, (machines) =>
  Record.fromEntries(Arr.map(machines ?? [], (known) => [known.slug, known.name] as const)),
);

/** What is typed in the new-Machine form. The page has one. */
export const newMachineSlugAtom = Atom.make("");

/** Register a Machine by slug; one already registered keeps its record. The form empties once it is registered. */
export const createMachineAtom = appRuntime.fn(
  (slug: string, get) =>
    RegistryClient.use((registry) => registry("createMachine", { slug })).pipe(
      changing(["machines"]),
      Effect.tap(() =>
        Effect.sync(() => {
          get.set(newMachineSlugAtom, "");
        }),
      ),
    ),
  { concurrent: true },
);

/** Which of the dialogs of Machine `slug`'s card is open, if any: removing a repo names the repo. */
export type MachineDialog =
  | "edit"
  | "delete"
  | "reset"
  | "restart"
  | { readonly removeRepo: string };

/** The dialog of Machine `slug`'s card that is open: null when none is. */
export const machineDialogAtom = Atom.family((_slug: string) =>
  Atom.make<MachineDialog | null>(null),
);

/** What changes in Machine `slug` when its Edit dialog is saved: a new name, new Container settings, or both. */
export interface MachineEdit {
  readonly name: string | undefined;
  readonly settings: MachineSettings | undefined;
}

/**
 * Save an edit of Machine `slug`: rename it, then save its Container settings as overrides of the defaults, and load
 * both again. The first the Machine refuses ends it with the Machine's own message. It answers with the new
 * settings state when settings were saved. Once saved, the Edit dialog closes. Each Machine has its own, so one's
 * save does not show on another's dialog.
 */
export const saveMachineAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (edit: MachineEdit, get) =>
      Effect.gen(function* () {
        const { name, settings } = edit;

        if (name !== undefined)
          yield* RegistryClient.use((registry) =>
            registry("renameMachine", { machine: slug, name }),
          );

        return settings === undefined
          ? undefined
          : yield* RegistryClient.use((registry) =>
              registry("updateMachineSettings", {
                machine: slug,
                overrides: machineOverridesFrom(settings),
              }),
            );
      }).pipe(
        changing(["machines", `machine-settings:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(machineDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the Delete dialog of Machine `slug`: its slug, to confirm. */
export const deleteTypedAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Delete Machine `slug` for good: its Sessions, files, Container and settings. A delete that stopped partway deleted
 * some Sessions, so the lists ask again either way. Once it is deleted, its dialog closes.
 */
export const deleteMachineAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("deleteMachine", { machine: slug })).pipe(
        Effect.asVoid,
        changing(["machines", "sessions", `repos:${slug}`, `machine-settings:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(machineDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the Reset dialog of Machine `slug`: its slug, to confirm. Apart from the Delete dialog's. */
export const resetTypedAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Reset Machine `slug` to a fresh start: its Sessions, files, Container and saved disk go, its slug, name and Container
 * settings stay. A reset that stopped partway deleted some Sessions, so the lists ask again either way. Once it is
 * reset, its dialog closes.
 */
export const resetMachineAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("resetMachine", { machine: slug })).pipe(
        Effect.asVoid,
        changing(["machines", "sessions", `repos:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(machineDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/**
 * Stop Machine `slug`'s Container and forget its saved disk; its files and Sessions stay. Once it is stopped, its
 * dialog closes.
 */
export const restartContainerAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("restartContainer", { machine: slug })).pipe(
        Effect.asVoid,
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(machineDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the Remove dialog of Machine `slug`'s card: the repo's name, to confirm. */
export const removeTypedAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Remove repo `repo` from Machine `slug`: the Sessions bound to it, then its directory. A removal that stopped partway
 * deleted some Sessions, so the lists ask again either way. Once it is removed, the dialog closes.
 */
export const removeRepoAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (repo: string, get) =>
      RegistryClient.use((registry) => registry("removeRepo", { machine: slug, repo })).pipe(
        Effect.asVoid,
        changing(["sessions", `repos:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(machineDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** The repos Machine `slug` holds, by directory name; asked again after a clone. */
export const reposAtom = Atom.family((slug: string) =>
  RegistryClient.query("listRepos", { machine: slug }, { reactivityKeys: [`repos:${slug}`] }),
);

/** What is typed in the clone form of Machine `slug`: `owner/repo` or an https URL. */
export const cloneSourceAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Clone `source` (`owner/repo` or an https URL) into Machine `slug` and list its repos again; the form empties once it
 * is cloned, and keeps what was typed when it was not. It answers with the directory the repo went to, or with git's own
 * message when it did not. It can take a minute: the Container starts, and the repo is downloaded. Each Machine has
 * its own, so one's clone does not show on another's form.
 */
export const cloneRepoAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (source: string, get) =>
      RegistryClient.use((registry) => registry("cloneRepo", { machine: slug, source })).pipe(
        changing([`repos:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(cloneSourceAtom(slug), "");
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** The Container settings of Machine `slug` in force (size, idle time, paths), which apply at its next launch. */
export const machineSettingsAtom = Atom.family((slug: string) =>
  RegistryClient.query(
    "getMachineSettings",
    { machine: slug },
    { reactivityKeys: [`machine-settings:${slug}`] },
  ),
);

/** What the Edit dialog's form holds: the name, and the Container's size, idle time (minutes) and paths as typed. */
export interface MachineDraft {
  readonly name: string;
  /** Undefined until the Machine's settings have answered and nothing was picked. */
  readonly instance: InstanceType | undefined;
  /** Empty until the Machine's settings have answered and nothing was typed. */
  readonly idle: string;
  /** The extra Container-only paths, one per line; undefined until the settings have answered and nothing was typed. */
  readonly ignore: string | undefined;
}

/** `draft`, with the settings it has not got yet taken from `saved`, the settings in force once they answer. */
const filledFrom = (draft: MachineDraft, saved: MachineSettingsState | null): MachineDraft =>
  saved === null
    ? draft
    : {
        ...draft,
        instance: draft.instance ?? saved.settings.instance,
        idle: draft.idle === "" ? String(saved.settings.idleMinutes) : draft.idle,
        ignore: draft.ignore ?? Arr.join(saved.settings.ignore, "\n"),
      };

/**
 * The Edit dialog's form of Machine `slug`: its name and the Container settings in force, to change. The settings may
 * answer after the dialog opened: what they bring fills in only what has not been picked or typed.
 */
export const machineDraftAtom = Atom.family((slug: string) =>
  Atom.writable(
    (get): MachineDraft => {
      const saved = get(machineSettingsAtom(slug)).pipe(AsyncResult.value, Option.getOrNull);

      return filledFrom(
        Option.getOrElse(get.self<MachineDraft>(), () => ({
          name: get(machineNamesAtom)[slug] ?? "",
          instance: undefined,
          idle: "",
          ignore: undefined,
        })),
        saved,
      );
    },
    (ctx, draft: MachineDraft) => {
      ctx.setSelf(draft);
    },
  ),
);
