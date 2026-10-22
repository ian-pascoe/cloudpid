// The Workspace list, what the owner does to a Workspace in it (create, edit, delete, clone a repo), and the state of the
// Workspaces page's forms and dialogs.

import {
  workspaceOverridesFrom,
  type InstanceType,
  type WorkspaceSettings,
} from "@cloudpid/config";
import type { WorkspaceSettingsState } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Record from "effect/Record";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";

/** Every Workspace, newest first. */
export const workspacesAtom = RegistryClient.query("listWorkspaces", undefined, {
  reactivityKeys: ["workspaces"],
});

/** The Workspaces, newest first, as of the last answer; null until the first. */
export const workspaceListAtom = Atom.map(workspacesAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** Why the list could not load, or null. */
export const workspacesErrorAtom = Atom.map(workspacesAtom, failureOf);

/** Each Workspace's name, by slug. */
export const workspaceNamesAtom = Atom.map(workspaceListAtom, (workspaces) =>
  Record.fromEntries(Arr.map(workspaces ?? [], (known) => [known.slug, known.name] as const)),
);

/** What is typed in the new-Workspace form. The page has one. */
export const newWorkspaceSlugAtom = Atom.make("");

/** Register a Workspace by slug; one already registered keeps its record. The form empties once it is registered. */
export const createWorkspaceAtom = appRuntime.fn(
  (slug: string, get) =>
    RegistryClient.use((registry) => registry("createWorkspace", { slug })).pipe(
      changing(["workspaces"]),
      Effect.tap(() =>
        Effect.sync(() => {
          get.set(newWorkspaceSlugAtom, "");
        }),
      ),
    ),
  { concurrent: true },
);

/** Which of the dialogs of Workspace `slug`'s card is open, if any: removing a repo names the repo. */
export type WorkspaceDialog =
  | "edit"
  | "delete"
  | "reset"
  | "restart"
  | { readonly removeRepo: string };

/** The dialog of Workspace `slug`'s card that is open: null when none is. */
export const workspaceDialogAtom = Atom.family((_slug: string) =>
  Atom.make<WorkspaceDialog | null>(null),
);

/** What changes in Workspace `slug` when its Edit dialog is saved: a new name, new Container settings, or both. */
export interface WorkspaceEdit {
  readonly name: string | undefined;
  readonly settings: WorkspaceSettings | undefined;
}

/**
 * Save an edit of Workspace `slug`: rename it, then save its Container settings as overrides of the defaults, and load
 * both again. The first the Workspace refuses ends it with the Workspace's own message. It answers with the new
 * settings state when settings were saved. Once saved, the Edit dialog closes. Each Workspace has its own, so one's
 * save does not show on another's dialog.
 */
export const saveWorkspaceAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (edit: WorkspaceEdit, get) =>
      Effect.gen(function* () {
        const { name, settings } = edit;

        if (name !== undefined)
          yield* RegistryClient.use((registry) =>
            registry("renameWorkspace", { workspace: slug, name }),
          );

        return settings === undefined
          ? undefined
          : yield* RegistryClient.use((registry) =>
              registry("updateWorkspaceSettings", {
                workspace: slug,
                overrides: workspaceOverridesFrom(settings),
              }),
            );
      }).pipe(
        changing(["workspaces", `workspace-settings:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(workspaceDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the Delete dialog of Workspace `slug`: its slug, to confirm. */
export const deleteTypedAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Delete Workspace `slug` for good: its Sessions, files, Container and settings. A delete that stopped partway deleted
 * some Sessions, so the lists ask again either way. Once it is deleted, its dialog closes.
 */
export const deleteWorkspaceAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("deleteWorkspace", { workspace: slug })).pipe(
        Effect.asVoid,
        changing(["workspaces", "sessions", `repos:${slug}`, `workspace-settings:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(workspaceDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the Reset dialog of Workspace `slug`: its slug, to confirm. Apart from the Delete dialog's. */
export const resetTypedAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Reset Workspace `slug` to a fresh start: its Sessions, files, Container and saved disk go, its slug, name and Container
 * settings stay. A reset that stopped partway deleted some Sessions, so the lists ask again either way. Once it is
 * reset, its dialog closes.
 */
export const resetWorkspaceAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("resetWorkspace", { workspace: slug })).pipe(
        Effect.asVoid,
        changing(["workspaces", "sessions", `repos:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(workspaceDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/**
 * Stop Workspace `slug`'s Container and forget its saved disk; its files and Sessions stay. Once it is stopped, its
 * dialog closes.
 */
export const restartContainerAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("restartContainer", { workspace: slug })).pipe(
        Effect.asVoid,
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(workspaceDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the Remove dialog of Workspace `slug`'s card: the repo's name, to confirm. */
export const removeTypedAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Remove repo `repo` from Workspace `slug`: the Sessions bound to it, then its directory. A removal that stopped partway
 * deleted some Sessions, so the lists ask again either way. Once it is removed, the dialog closes.
 */
export const removeRepoAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (repo: string, get) =>
      RegistryClient.use((registry) => registry("removeRepo", { workspace: slug, repo })).pipe(
        Effect.asVoid,
        changing(["sessions", `repos:${slug}`]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(workspaceDialogAtom(slug), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** The repos Workspace `slug` holds, by directory name; asked again after a clone. */
export const reposAtom = Atom.family((slug: string) =>
  RegistryClient.query("listRepos", { workspace: slug }, { reactivityKeys: [`repos:${slug}`] }),
);

/** What is typed in the clone form of Workspace `slug`: `owner/repo` or an https URL. */
export const cloneSourceAtom = Atom.family((_slug: string) => Atom.make(""));

/**
 * Clone `source` (`owner/repo` or an https URL) into Workspace `slug` and list its repos again; the form empties once it
 * is cloned, and keeps what was typed when it was not. It answers with the directory the repo went to, or with git's own
 * message when it did not. It can take a minute: the Container starts, and the repo is downloaded. Each Workspace has
 * its own, so one's clone does not show on another's form.
 */
export const cloneRepoAtom = Atom.family((slug: string) =>
  appRuntime.fn(
    (source: string, get) =>
      RegistryClient.use((registry) => registry("cloneRepo", { workspace: slug, source })).pipe(
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

/** The Container settings of Workspace `slug` in force (size, idle time, paths), which apply at its next launch. */
export const workspaceSettingsAtom = Atom.family((slug: string) =>
  RegistryClient.query(
    "getWorkspaceSettings",
    { workspace: slug },
    { reactivityKeys: [`workspace-settings:${slug}`] },
  ),
);

/** What the Edit dialog's form holds: the name, and the Container's size, idle time (minutes) and paths as typed. */
export interface WorkspaceDraft {
  readonly name: string;
  /** Undefined until the Workspace's settings have answered and nothing was picked. */
  readonly instance: InstanceType | undefined;
  /** Empty until the Workspace's settings have answered and nothing was typed. */
  readonly idle: string;
  /** The extra Container-only paths, one per line; undefined until the settings have answered and nothing was typed. */
  readonly ignore: string | undefined;
}

/** `draft`, with the settings it has not got yet taken from `saved`, the settings in force once they answer. */
const filledFrom = (draft: WorkspaceDraft, saved: WorkspaceSettingsState | null): WorkspaceDraft =>
  saved === null
    ? draft
    : {
        ...draft,
        instance: draft.instance ?? saved.settings.instance,
        idle: draft.idle === "" ? String(saved.settings.idleMinutes) : draft.idle,
        ignore: draft.ignore ?? Arr.join(saved.settings.ignore, "\n"),
      };

/**
 * The Edit dialog's form of Workspace `slug`: its name and the Container settings in force, to change. The settings may
 * answer after the dialog opened: what they bring fills in only what has not been picked or typed.
 */
export const workspaceDraftAtom = Atom.family((slug: string) =>
  Atom.writable(
    (get): WorkspaceDraft => {
      const saved = get(workspaceSettingsAtom(slug)).pipe(AsyncResult.value, Option.getOrNull);

      return filledFrom(
        Option.getOrElse(get.self<WorkspaceDraft>(), () => ({
          name: get(workspaceNamesAtom)[slug] ?? "",
          instance: undefined,
          idle: "",
          ignore: undefined,
        })),
        saved,
      );
    },
    (ctx, draft: WorkspaceDraft) => {
      ctx.setSelf(draft);
    },
  ),
);
