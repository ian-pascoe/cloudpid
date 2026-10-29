// @effect-diagnostics missingPipeableSignature:off -- read and write helpers over an Environment's id, not combinators.

// The Environment list (docs/architecture/workspace.md → Environments from the UI), what the owner does to an
// Environment in it (create, rename, delete, add and remove Repos, make its Build again, keep Secrets for it) and to its
// Workspaces (start a Session, remove, restart the Container), reading and saving an Environment's Container settings
// and the variables kept Global, and the state of the Settings page's forms and dialogs for them. The sections' drafts
// are `settings/forms.ts`'s, over the read and write helpers here, which save a patch of what a section changed.

import {
  CONTAINER_SETTING_NAMES,
  containerPatchBetween,
  DEFAULT_CONTAINER_SETTINGS,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  patchOf,
  sameJson,
} from "@cloudpid/config";
import type {
  BuildView,
  ContainerSettingsState,
  EnvironmentRecord,
  WorkspaceRecord,
  WorkspaceWork,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import {
  EMPTY_SECRET_DRAFT,
  inPickerOrder,
  type SecretDraft,
  secretScopeOf,
  secretsIn,
  secretWrite,
} from "./environments.ts";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";
import { createSession, visibleTickAtom } from "./sessions.ts";

/**
 * All Environments, newest first, with their Repos, asked again every few seconds while the page is visible: a Session's
 * agent makes, renames and adds Repos to Environments, which the page hears of no other way.
 */
export const environmentsAtom = RegistryClient.query("listEnvironments", undefined, {
  reactivityKeys: ["environments"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom), Atom.refreshOnWindowFocus);

/** The Environments, newest first, as of the last answer; null until the first. */
export const environmentListAtom = Atom.map(environmentsAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** The Environments in the order the pickers and lists show them (`inPickerOrder`); null until the first answer. */
export const environmentsInOrderAtom = Atom.map(environmentListAtom, (environments) =>
  environments === null ? null : inPickerOrder(environments),
);

/** Why the list could not load, or null. */
export const environmentsErrorAtom = Atom.map(environmentsAtom, failureOf);

/** Each Environment's name, by id. */
export const environmentNamesAtom = Atom.map(environmentListAtom, (environments) =>
  Record.fromEntries(Arr.map(environments ?? [], (known) => [known.id, known.name] as const)),
);

/**
 * Where each Environment's Build stands, asked again every few seconds while the page is visible: a Build takes
 * minutes, and the page shows it end.
 */
export const buildsAtom = RegistryClient.query("listBuilds", undefined, {
  reactivityKeys: ["builds"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom), Atom.refreshOnWindowFocus);

/** Where Environment `id`'s Build stands as of the last answer; null until the first, or for an Environment not listed. */
export const environmentBuildAtom = Atom.family((id: string) =>
  Atom.map(buildsAtom, (result): BuildView | null =>
    result.pipe(
      AsyncResult.value,
      Option.flatMap((builds) => Arr.findFirst(builds, (known) => known.environment === id)),
      Option.map((known) => known.build),
      Option.getOrNull,
    ),
  ),
);

/** Make Environment `id`'s Build again now, from its Repos' default branches; the build line shows it under way. */
export const rebuildEnvironmentAtom = Atom.family((id: string) =>
  appRuntime.fn(
    () =>
      RegistryClient.use((registry) => registry("rebuildEnvironment", { environment: id })).pipe(
        changing(["builds"]),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the new-Environment form. The page has one. */
// Kept while the app is open, as a section's draft is, so leaving the section keeps what was typed.
export const newEnvironmentNameAtom = Atom.make("").pipe(Atom.keepAlive);

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
 * Which of the dialogs of Environment `id` is open, if any: deleting it, and removing one of its Workspaces or
 * restarting that Workspace's Container, by the Workspace's id.
 */
export type EnvironmentDialog =
  | "delete"
  | { readonly removeWorkspace: string }
  | { readonly restart: string };

/** The dialog of Environment `id` that is open: null when none is. */
export const environmentDialogAtom = Atom.family((_id: string) =>
  Atom.make<EnvironmentDialog | null>(null),
);

/** The name of Environment `id` in `environments`; `""` for one not listed. */
const nameIn = (environments: readonly EnvironmentRecord[], id: string): string =>
  Arr.findFirst(environments, (known) => known.id === id).pipe(
    Option.map((known) => known.name),
    Option.getOrElse(() => ""),
  );

/** Environment `id`'s name, as the last listing has it; `""` for an Environment not listed. */
export const environmentNameResultAtom = Atom.family((id: string) =>
  Atom.map(environmentsAtom, (result) =>
    AsyncResult.map(result, (environments) => nameIn(environments, id)),
  ),
);

/** Environment `id`'s name, read from the Registry now; `""` for one it does not list. */
export const readEnvironmentName = (id: string) =>
  RegistryClient.use((registry) => registry("listEnvironments", undefined)).pipe(
    Effect.map((environments) => nameIn(environments, id)),
  );

/** Rename Environment `id` to `name`; the Registry refuses a name another Environment has, saying so. */
export const writeEnvironmentName = (id: string, name: string) =>
  RegistryClient.use((registry) => registry("renameEnvironment", { environment: id, name }));

/** What is typed in the Delete dialog of Environment `id`: its name, to confirm. */
export const deleteTypedAtom = Atom.family((_id: string) => Atom.make(""));

/**
 * Delete Environment `id` for good: its Workspaces and their Sessions, then the Environment with its Secrets and its
 * Build. A delete that stopped partway removed some Workspaces, so the lists ask again either way. Once it is deleted,
 * its dialog closes.
 */
export const deleteEnvironmentAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) => registry("deleteEnvironment", { environment: id })).pipe(
        Effect.asVoid,
        changing([
          "environments",
          "sessions",
          "workspaces",
          `environment-settings:${id}`,
          "environment-secrets",
          "builds",
        ]),
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
export const addRepoSourceAtom = Atom.family((_id: string) => Atom.make("").pipe(Atom.keepAlive));

/** What is typed in the add-Repo form of Environment `id` as the directory to clone into; empty for the repo's own name. */
export const addRepoNameAtom = Atom.family((_id: string) => Atom.make("").pipe(Atom.keepAlive));

/** What the add-Repo form sends: the repo, and the directory as typed (empty for the repo's own name). */
export interface RepoAdd {
  readonly source: string;
  readonly name: string;
}

/**
 * Add `source` (`owner/repo` or an https URL) to Environment `id`'s Repos, in directory `name` when one is typed, and
 * list the Environments again; the form empties once it is added, and keeps what was typed when it was not (a directory
 * the Environment has already says to name this one). Nothing is cloned: a Workspace made later clones it. It answers
 * with the directory name the Repo got. Each Environment has its own, so one's add does not show on another's form.
 */
export const addRepoAtom = Atom.family((id: string) =>
  appRuntime.fn(
    ({ source, name }: RepoAdd, get) => {
      const directory = name.trim();

      return RegistryClient.use((registry) =>
        registry(
          "addRepo",
          directory === ""
            ? { environment: id, source }
            : { environment: id, source, name: directory },
        ),
      ).pipe(
        changing(["environments"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(addRepoSourceAtom(id), "");
            get.set(addRepoNameAtom(id), "");
          }),
        ),
      );
    },
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

/**
 * Start a Session in a Workspace of Environment `id`, by the Workspace's id, and open it (`createSession`). Each
 * Environment has its own, so a refusal shows, with the Registry's message, under that Environment's Workspaces.
 */
export const startSessionAtom = Atom.family((id: string) =>
  appRuntime.fn((workspace: string, get) => createSession({ environment: id, workspace }, get), {
    concurrent: true,
  }),
);

/** Every Workspace, of all Environments, newest first. */
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
 * What Workspace `id`'s clones hold that is not on the remote, per Repo (`workspaceWork`): read on its Container when a
 * confirmation that would lose it opens, and again each time one does.
 */
export const workspaceWorkAtom = Atom.family((id: string) =>
  RegistryClient.query("workspaceWork", { id }, { reactivityKeys: [`workspace-work:${id}`] }),
);

/** The Subagent Workspaces of Session `session`, as the last listing has them. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain lookup in a listing.
export const subagentWorkspacesOf = (
  workspaces: ReadonlyArray<WorkspaceRecord> | null,
  session: string,
): WorkspaceRecord[] =>
  Arr.filter(workspaces ?? [], (workspace) => workspace.subagent?.session === session);

/**
 * The Subagent Workspaces of the subagents below `owner` (its descendants', whose IDs extend its own), which deleting it
 * removes too.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain lookup in a listing.
export const subagentWorkspacesBelow = (
  workspaces: ReadonlyArray<WorkspaceRecord> | null,
  owner: { readonly session: string; readonly agent: string },
): WorkspaceRecord[] =>
  Arr.filter(subagentWorkspacesOf(workspaces, owner.session), (workspace) =>
    (workspace.subagent?.agent ?? "").startsWith(`${owner.agent}.`),
  );

/**
 * What a Workspace holds that is not on the remote, in words: `app: 2 commits not pushed, 1 uncommitted change`, or
 * `app: not set up (on cloudpid/spare, not cloudpid/1a2b3c4d)` for a clone whose work is not known.
 */
export const describeWorkspaceWork = (work: ReadonlyArray<WorkspaceWork>): string =>
  Arr.join(
    Arr.map(
      work,
      ({ repo, uncommitted, unpushed, unsettled }) =>
        `${repo}: ${Arr.join(
          [
            ...(unsettled === undefined ? [] : [unsettled]),
            ...(unpushed > 0
              ? [`${unpushed} ${unpushed === 1 ? "commit" : "commits"} not pushed`]
              : []),
            ...(uncommitted > 0
              ? [`${uncommitted} uncommitted ${uncommitted === 1 ? "change" : "changes"}`]
              : []),
          ],
          ", ",
        )}`,
    ),
    "; ",
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

/**
 * The Container settings of Environment `id` in force (`ContainerSettings`: the size, idle time and paths, and the
 * variables and scripts each Container start gets), which apply at each Workspace's next Container start.
 */
export const environmentSettingsAtom = Atom.family((id: string) =>
  RegistryClient.query(
    "getEnvironmentSettings",
    { environment: id },
    // A field the Environment inherits follows Global's, so a save at Global asks again too.
    { reactivityKeys: [`environment-settings:${id}`, "global"] },
  ),
);

/**
 * Environment `id`'s Agent changes (`docs/architecture/agent-changes.md`), newest first, asked again every few seconds while
 * its history is shown and the page is visible: a Session's agent makes them, which the page hears of no other way.
 */
export const agentChangesAtom = Atom.family((id: string) =>
  RegistryClient.query(
    "listAgentChanges",
    { environment: id },
    { reactivityKeys: [`agent-changes:${id}`] },
  ).pipe(Atom.makeRefreshOnSignal(visibleTickAtom)),
);

/**
 * Revert one of Environment `id`'s Agent changes, by its id: its value before is written back, as the owner's change.
 * The Registry refuses one whose field has changed since, saying what it is now. The history, the settings and the
 * Builds ask again either way.
 */
export const revertAgentChangeAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (change: number) =>
      RegistryClient.use((registry) =>
        registry("revertAgentChange", { environment: id, change }),
      ).pipe(
        Effect.asVoid,
        changing([
          `agent-changes:${id}`,
          `environment-settings:${id}`,
          // An Environment's Settings Overrides (ADR-0027) are among its Agent changes too.
          "settings",
          `environment-skills:${id}`,
          "global",
          "environment-secrets",
          "builds",
          "environments",
        ]),
      ),
    { concurrent: true },
  ),
);

/**
 * Dismiss one of Environment `id`'s Agent changes, by its id: it leaves the history, and what it changed stays. The
 * history asks again either way.
 */
export const dismissAgentChangeAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (change: number) =>
      RegistryClient.use((registry) =>
        registry("dismissAgentChange", { environment: id, change }),
      ).pipe(changing([`agent-changes:${id}`])),
    { concurrent: true },
  ),
);

/**
 * The settings an Environment's sections show and edit: every field as in force, but the variables are the
 * Environment's own, not the ones it gets from Global, so saving them never copies a Global variable into the
 * Environment.
 */
export const loadedSettingsOf = (state: ContainerSettingsState): ContainerSettings => ({
  ...state.settings,
  variables: state.overrides.variables ?? {},
});

/** Environment `id`'s Container settings as its sections edit them (`loadedSettingsOf`), as the last answer has them. */
export const containerSettingsAtom = Atom.family((id: string) =>
  Atom.map(environmentSettingsAtom(id), (result) => AsyncResult.map(result, loadedSettingsOf)),
);

/** Environment `id`'s Container settings (in force, Global's, and its Overrides), read from the Registry now. */
export const readEnvironmentContainerSettings = (id: string) =>
  RegistryClient.use((registry) => registry("getEnvironmentSettings", { environment: id }));

/** Environment `id`'s Container settings as its Variables section edits them (`loadedSettingsOf`), read now. */
export const readContainerSettings = (id: string) =>
  readEnvironmentContainerSettings(id).pipe(Effect.map(loadedSettingsOf));

/**
 * Make Environment `id`'s Container settings `before` into `after` (both as `loadedSettingsOf` gives them): each field
 * that differs is set as its Override, each variable taken out reset so it inherits Global's again, and any other field
 * keeps whether it is inherited or overridden. The Registry refuses them with its own message.
 */
export const writeContainerSettings = (
  id: string,
  before: ContainerSettings,
  after: ContainerSettings,
) =>
  RegistryClient.use((registry) =>
    registry("updateEnvironmentSettings", {
      environment: id,
      ...containerPatchBetween(before, after),
    }),
  );

/**
 * Make Environment `id`'s Container Overrides `before` into `after` (its variables aside, which the Variables section
 * saves): each field `after` overrides otherwise than `before` set as its Override, even equal to Global's, and each
 * only `before` overrides reset, so it inherits Global's again. The Registry refuses them with its own message.
 */
export const writeContainerOverrides = (
  id: string,
  before: ContainerSettingsOverrides,
  after: ContainerSettingsOverrides,
) => {
  const fields = Arr.filter(CONTAINER_SETTING_NAMES, (field) => field !== "variables");

  const set = Record.fromEntries(
    Arr.filterMap(fields, (field) =>
      after[field] !== undefined && !sameJson(after[field], before[field])
        ? Result.succeed([field, after[field]] as const)
        : Result.failVoid,
    ),
  );

  const reset = Arr.filter(
    fields,
    (field) => before[field] !== undefined && after[field] === undefined,
  );

  return RegistryClient.use((registry) =>
    registry("updateEnvironmentSettings", { environment: id, ...patchOf(set, reset) }),
  );
};

/**
 * The Container settings at Global in force (of which the page edits the variables), which every Workspace of an
 * Environment that inherits them applies at its next Container start. Asked again every few seconds while the page is visible: a Session's agent changes them,
 * which the page hears of no other way.
 */
export const globalSettingsAtom = RegistryClient.query("getGlobalContainerSettings", undefined, {
  reactivityKeys: ["global"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom));

/** Why the settings kept Global could not load, or null. */
export const globalSettingsErrorAtom = Atom.map(globalSettingsAtom, failureOf);

/** The variables kept Global as of the last answer; none until the first. */
export const globalVariablesAtom = Atom.map(
  globalSettingsAtom,
  (result): Readonly<Record<string, string>> =>
    result.pipe(
      AsyncResult.value,
      Option.map((state) => state.settings.variables),
      Option.getOrElse(() => ({})),
    ),
);

/** The variables kept Global in force, as the last answer has them. */
export const globalVariablesResultAtom = Atom.map(globalSettingsAtom, (result) =>
  AsyncResult.map(result, (state) => state.settings.variables),
);

/** The Container settings at Global (in force, what is saved, and who overrides each field), read from the Registry now. */
export const readGlobalContainerSettings = RegistryClient.use((registry) =>
  registry("getGlobalContainerSettings", undefined),
);

/** The variables kept Global in force, read from the Registry now. */
export const readGlobalVariables = readGlobalContainerSettings.pipe(
  Effect.map((state) => state.settings.variables),
);

/**
 * Make the Container settings at Global `before` into `after` (their variables aside, which the Variables section saves):
 * each field changed set, or reset where it is back at its default, so Global keeps only what differs from the defaults.
 * Every field of an Environment that does not override it follows. The Registry refuses them with its own message,
 * naming the Environments a change would put past a limit.
 */
export const writeGlobalContainerSettings = (
  before: ContainerSettings,
  after: ContainerSettings,
) => {
  const changed = Arr.filter(
    CONTAINER_SETTING_NAMES,
    (field) => field !== "variables" && !sameJson(before[field], after[field]),
  );

  const atDefault = (field: keyof ContainerSettings) =>
    sameJson(after[field], DEFAULT_CONTAINER_SETTINGS[field]);

  const set = Record.fromEntries(
    Arr.map(
      Arr.filter(changed, (field) => !atDefault(field)),
      (field) => [field, after[field]] as const,
    ),
  );

  const reset = Arr.filter(changed, atDefault);

  return RegistryClient.use((registry) =>
    registry("updateGlobalContainerSettings", patchOf(set, reset)),
  );
};

/**
 * Make the variables kept Global `before` into `after`: those added or changed are set and those taken out reset, so a
 * variable neither names is left as it is. The Registry refuses them with its own message.
 */
export const writeGlobalVariables = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
) =>
  RegistryClient.use((registry) =>
    registry(
      "updateGlobalContainerSettings",
      containerPatchBetween(
        { ...DEFAULT_CONTAINER_SETTINGS, variables: before },
        { ...DEFAULT_CONTAINER_SETTINGS, variables: after },
      ),
    ),
  );

/**
 * Every kept Secret, of Global and of each Environment: names, scopes and build flags, never a value. A
 * section of the page is keyed by the Environment's id, or by `GLOBAL`. Asked again every few seconds while the
 * page is visible: a Session's agent keeps a Secret or marks one for the Build, which the page hears of no other way.
 */
export const environmentSecretsAtom = RegistryClient.query("listEnvironmentSecrets", undefined, {
  reactivityKeys: ["environment-secrets"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom));

/** Why the Secrets could not load, or null. */
export const environmentSecretsErrorAtom = Atom.map(environmentSecretsAtom, failureOf);

/** The Secrets kept in section `key`, by name, as of the last answer; null until the first. */
export const secretsInAtom = Atom.family((key: string) =>
  Atom.map(environmentSecretsAtom, (result) =>
    result.pipe(
      AsyncResult.value,
      Option.map((records) => secretsIn(records, key)),
      Option.getOrNull,
    ),
  ),
);

/** What is typed in section `key`'s form. The value stays here only until it is saved. */
export const secretDraftAtom = Atom.family((_key: string) =>
  Atom.make<SecretDraft>(EMPTY_SECRET_DRAFT),
);

/**
 * Keep the form's Secret in section `key`, or replace the value of the one kept under its name (`secretWrite`). It
 * reads the form as it starts rather than taking the draft as its argument, which the atom would keep: once the Secret
 * is kept the form empties, so the value is held nowhere in the page; a refusal keeps what was typed and says why. A
 * Build that takes Secrets is made again, so the Builds are asked again too.
 */
export const saveSecretAtom = Atom.family((key: string) =>
  appRuntime.fn(
    (_: void, get) =>
      RegistryClient.use((registry) =>
        registry("setEnvironmentSecret", {
          environment: secretScopeOf(key),
          ...secretWrite(
            get.registry.get(secretDraftAtom(key)),
            get.registry.get(secretsInAtom(key)) ?? [],
          ),
        }),
      ).pipe(
        changing(["environment-secrets", "builds"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(secretDraftAtom(key), EMPTY_SECRET_DRAFT);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** Say whether Secret `name` of section `key` reaches the Build. */
export const setSecretBuildAtom = Atom.family((key: string) =>
  appRuntime.fn(
    ({ name, build }: { readonly name: string; readonly build: boolean }) =>
      RegistryClient.use((registry) =>
        registry("setEnvironmentSecretBuild", { environment: secretScopeOf(key), name, build }),
      ).pipe(changing(["environment-secrets", "builds"])),
    { concurrent: true },
  ),
);

/** The Secret of section `key` whose Delete dialog is open, by name: null when none is. */
export const secretDialogAtom = Atom.family((_key: string) => Atom.make<string | null>(null));

/** Delete Secret `name` of section `key`. Once it is deleted, its dialog closes. */
export const deleteSecretAtom = Atom.family((key: string) =>
  appRuntime.fn(
    (name: string, get) =>
      RegistryClient.use((registry) =>
        registry("deleteEnvironmentSecret", { environment: secretScopeOf(key), name }),
      ).pipe(
        changing(["environment-secrets", "builds"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(secretDialogAtom(key), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);
