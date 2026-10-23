// The Environment list, what the owner does to an Environment in it (create, edit, delete, add and remove Repos) and to
// its Workspaces (remove, restart the Container), and the state of the Environments page's forms and dialogs.

import {
  containerOverridesFrom,
  type InstanceType,
  type ContainerSettings,
} from "@cloudpid/config";
import type { ContainerSettingsState } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Record from "effect/Record";
import { variablesText } from "./environments.ts";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";

/** Every Environment, newest first, with its Repos. */
export const environmentsAtom = RegistryClient.query("listEnvironments", undefined, {
  reactivityKeys: ["environments"],
});

/** The Environments, newest first, as of the last answer; null until the first. */
export const environmentListAtom = Atom.map(environmentsAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** Why the list could not load, or null. */
export const environmentsErrorAtom = Atom.map(environmentsAtom, failureOf);

/** Each Environment's name, by id. */
export const environmentNamesAtom = Atom.map(environmentListAtom, (environments) =>
  Record.fromEntries(Arr.map(environments ?? [], (known) => [known.id, known.name] as const)),
);

/** What is typed in the new-Environment form. The page has one. */
export const newEnvironmentNameAtom = Atom.make("");

/** Make an Environment by name. The form empties once it is made. */
export const createEnvironmentAtom = appRuntime.fn(
  (name: string, get) =>
    RegistryClient.use((registry) => registry("createEnvironment", { name })).pipe(
      changing(["environments"]),
      Effect.tap(() =>
        Effect.sync(() => {
          get.set(newEnvironmentNameAtom, "");
        }),
      ),
    ),
  { concurrent: true },
);

/**
 * Which of the dialogs of Environment `id`'s card is open, if any: removing a Workspace or restarting its Container
 * names the Workspace's id.
 */
export type EnvironmentDialog =
  | "edit"
  | "delete"
  | { readonly removeWorkspace: string }
  | { readonly restart: string };

/** The dialog of Environment `id`'s card that is open: null when none is. */
export const environmentDialogAtom = Atom.family((_id: string) =>
  Atom.make<EnvironmentDialog | null>(null),
);

/** What changes in Environment `id` when its Edit dialog is saved: a new name, new Container settings, or both. */
export interface EnvironmentEdit {
  readonly name: string | undefined;
  readonly settings: ContainerSettings | undefined;
}

/**
 * Save an edit of Environment `id`: rename it, then save its Container settings as overrides of the defaults, and load
 * both again. The first the Registry refuses ends it with its own message. It answers with the new settings state when
 * settings were saved. Once saved, the Edit dialog closes. Each Environment has its own, so one's save does not show on
 * another's dialog.
 */
export const saveEnvironmentAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (edit: EnvironmentEdit, get) =>
      Effect.gen(function* () {
        const { name, settings } = edit;

        if (name !== undefined)
          yield* RegistryClient.use((registry) =>
            registry("renameEnvironment", { environment: id, name }),
          );

        return settings === undefined
          ? undefined
          : yield* RegistryClient.use((registry) =>
              registry("updateEnvironmentSettings", {
                environment: id,
                overrides: containerOverridesFrom(settings),
              }),
            );
      }).pipe(
        changing(["environments", `environment-settings:${id}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(environmentDialogAtom(id), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the Delete dialog of Environment `id`: its name, to confirm. */
export const deleteTypedAtom = Atom.family((_id: string) => Atom.make(""));

/**
 * Delete Environment `id` for good: its Workspaces and their Sessions, then the Environment. A delete that stopped
 * partway removed some Workspaces, so the lists ask again either way. Once it is deleted, its dialog closes.
 */
export const deleteEnvironmentAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("deleteEnvironment", { environment: id })).pipe(
        Effect.asVoid,
        changing(["environments", "sessions", "workspaces", `environment-settings:${id}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(environmentDialogAtom(id), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the add-Repo form of Environment `id`: `owner/repo` or an https URL. */
export const addRepoSourceAtom = Atom.family((_id: string) => Atom.make(""));

/**
 * Add `source` (`owner/repo` or an https URL) to Environment `id`'s Repos and list the Environments again; the form
 * empties once it is added, and keeps what was typed when it was not. Nothing is cloned: a Workspace made later clones
 * it. It answers with the directory name the Repo got. Each Environment has its own, so one's add does not show on
 * another's form.
 */
export const addRepoAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (source: string, get) =>
      RegistryClient.use((registry) => registry("addRepo", { environment: id, source })).pipe(
        changing(["environments"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(addRepoSourceAtom(id), "");
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** Take Repo `repo` out of Environment `id`. Workspaces made before keep their clones of it. */
export const removeRepoAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (repo: string) =>
      RegistryClient.use((registry) => registry("removeRepo", { environment: id, repo })).pipe(
        Effect.asVoid,
        changing(["environments"]),
      ),
    { concurrent: true },
  ),
);

/** Every Workspace, of every Environment, newest first. */
export const workspacesAtom = RegistryClient.query("listWorkspaces", undefined, {
  reactivityKeys: ["workspaces"],
});

/** The Workspaces as of the last answer; null until the first. */
export const workspaceListAtom = Atom.map(workspacesAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** Each Workspace's branch, by id, which names it to the owner. */
export const workspaceBranchesAtom = Atom.map(workspaceListAtom, (workspaces) =>
  Record.fromEntries(Arr.map(workspaces ?? [], (known) => [known.id, known.branch] as const)),
);

/** What is typed in the Remove dialog of Workspace `id`: its branch, to confirm. */
export const removeWorkspaceTypedAtom = Atom.family((_id: string) => Atom.make(""));

/**
 * Remove a Workspace of Environment `id` by its id: its Sessions, then its files and Container; its branch stays on the
 * remote. A removal that stopped partway deleted some Sessions, so the lists ask again either way. Once it is removed,
 * the dialog closes.
 */
export const removeWorkspaceAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (workspace: string, get) =>
      RegistryClient.use((registry) => registry("removeWorkspace", { id: workspace })).pipe(
        Effect.asVoid,
        changing(["sessions", "workspaces"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(environmentDialogAtom(id), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/**
 * Stop a Workspace's Container of Environment `id` and forget its saved disk; its files and Sessions stay. Once it is
 * stopped, the dialog closes.
 */
export const restartContainerAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (workspace: string, get) =>
      RegistryClient.use((registry) => registry("restartContainer", { workspace })).pipe(
        Effect.asVoid,
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(environmentDialogAtom(id), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** The Container settings of Environment `id` in force (size, idle time, paths), which apply at each Workspace's next launch. */
export const environmentSettingsAtom = Atom.family((id: string) =>
  RegistryClient.query(
    "getEnvironmentSettings",
    { environment: id },
    { reactivityKeys: [`environment-settings:${id}`] },
  ),
);

/**
 * What the Edit dialog's form holds: the name, and the Container's size, idle time (minutes), paths, variables and
 * scripts as typed.
 */
export interface EnvironmentDraft {
  readonly name: string;
  /** Undefined until the Environment's settings have answered and nothing was picked. */
  readonly instance: InstanceType | undefined;
  /** Empty until the Environment's settings have answered and nothing was typed. */
  readonly idle: string;
  /** The extra Container-only paths, one per line; undefined until the settings have answered and nothing was typed. */
  readonly ignore: string | undefined;
  /** The variables, a `NAME=value` line each; undefined until the settings have answered and nothing was typed. */
  readonly variables: string | undefined;
  /** The Environment's Setup Script; undefined until the settings have answered and nothing was typed. */
  readonly setupScript: string | undefined;
  /** The Environment's Start Script; undefined until the settings have answered and nothing was typed. */
  readonly startScript: string | undefined;
}

/** `draft`, with the settings it has not got yet taken from `saved`, the settings in force once they answer. */
const filledFrom = (
  draft: EnvironmentDraft,
  saved: ContainerSettingsState | null,
): EnvironmentDraft =>
  saved === null
    ? draft
    : {
        ...draft,
        instance: draft.instance ?? saved.settings.instance,
        idle: draft.idle === "" ? String(saved.settings.idleMinutes) : draft.idle,
        ignore: draft.ignore ?? Arr.join(saved.settings.ignore, "\n"),
        variables: draft.variables ?? variablesText(saved.settings.variables),
        setupScript: draft.setupScript ?? saved.settings.setupScript,
        startScript: draft.startScript ?? saved.settings.startScript,
      };

/**
 * The Edit dialog's form of Environment `id`: its name and the Container settings in force, to change. The settings may
 * answer after the dialog opened: what they bring fills in only what has not been picked or typed.
 */
export const environmentDraftAtom = Atom.family((id: string) =>
  Atom.writable(
    (get): EnvironmentDraft => {
      const saved = get(environmentSettingsAtom(id)).pipe(AsyncResult.value, Option.getOrNull);

      return filledFrom(
        Option.getOrElse(get.self<EnvironmentDraft>(), () => ({
          name: get(environmentNamesAtom)[id] ?? "",
          instance: undefined,
          idle: "",
          ignore: undefined,
          variables: undefined,
          setupScript: undefined,
          startScript: undefined,
        })),
        saved,
      );
    },
    (ctx, draft: EnvironmentDraft) => {
      ctx.setSelf(draft);
    },
  ),
);
