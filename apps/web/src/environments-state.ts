// The Environment list, what the owner does to an Environment in it (create, edit, delete, add and remove Repos, make
// its Build again, keep Secrets for it) and to its Workspaces (start a Session, remove, restart the Container), the
// Secrets kept for every Environment, and the state of the Environments page's forms and dialogs.

import {
  containerOverridesFrom,
  type InstanceType,
  type ContainerSettings,
} from "@cloudpid/config";
import type {
  BuildView,
  ContainerSettingsState,
  WorkspaceRecord,
  WorkspaceWork,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Record from "effect/Record";
import {
  EMPTY_SECRET_DRAFT,
  type SecretDraft,
  secretScopeOf,
  secretsIn,
  secretWrite,
  variablesText,
} from "./environments.ts";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { appRuntime } from "./runtime.ts";
import { createSession, visibleTickAtom } from "./sessions.ts";

/**
 * Every Environment, newest first, with its Repos, asked again every few seconds while the page is visible: a Session's
 * agent makes, renames and adds Repos to Environments, which the page hears of no other way.
 */
export const environmentsAtom = RegistryClient.query("listEnvironments", undefined, {
  reactivityKeys: ["environments"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom), Atom.refreshOnWindowFocus);

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
export const addRepoSourceAtom = Atom.family((_id: string) => Atom.make(""));

/** What is typed in the add-Repo form of Environment `id` as the directory to clone into; empty for the repo's own name. */
export const addRepoNameAtom = Atom.family((_id: string) => Atom.make(""));

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
 * Environment has its own, so a refusal shows, with the Registry's message, on the card it was asked on.
 */
export const startSessionAtom = Atom.family((id: string) =>
  appRuntime.fn((workspace: string, get) => createSession({ environment: id, workspace }, get), {
    concurrent: true,
  }),
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

/** What a Workspace holds that is not on the remote, in words: `app: 2 commits not pushed, 1 uncommitted change`. */
export const describeWorkspaceWork = (work: ReadonlyArray<WorkspaceWork>): string =>
  Arr.join(
    Arr.map(
      work,
      ({ repo, uncommitted, unpushed }) =>
        `${repo}: ${Arr.join(
          [
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
    { reactivityKeys: [`environment-settings:${id}`] },
  ),
);

/**
 * Environment `id`'s Agent changes (`docs/spec.md` → Agent changes), newest first, asked again every few seconds while
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
          "environment-secrets",
          "builds",
          "environments",
        ]),
      ),
    { concurrent: true },
  ),
);

/**
 * What the Edit dialog's form holds: the name, and the Container's size, idle time (minutes), paths, variables,
 * scripts and Toolchains as typed.
 */
export interface EnvironmentDraft {
  readonly name: string;
  /** Undefined until the Environment's settings have answered and nothing was picked. */
  readonly instance: InstanceType | undefined;
  /** The size limit; undefined until the Environment's settings have answered and nothing was picked. */
  readonly maxInstance: InstanceType | undefined;
  /** Undefined until the Environment's settings have answered and nothing was typed. */
  readonly idle: string | undefined;
  /** The extra Container-only paths, one per line; undefined until the settings have answered and nothing was typed. */
  readonly ignore: string | undefined;
  /** The variables, a `NAME=value` line each; undefined until the settings have answered and nothing was typed. */
  readonly variables: string | undefined;
  /** The Environment's Setup Script; undefined until the settings have answered and nothing was typed. */
  readonly setupScript: string | undefined;
  /** The Environment's Start Script; undefined until the settings have answered and nothing was typed. */
  readonly startScript: string | undefined;
  /** The Environment's Toolchains (a mise.toml); undefined until the settings have answered and nothing was typed. */
  readonly toolchains: string | undefined;
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
        maxInstance: draft.maxInstance ?? saved.settings.maxInstance,
        idle: draft.idle ?? String(saved.settings.idleMinutes),
        ignore: draft.ignore ?? Arr.join(saved.settings.ignore, "\n"),
        variables: draft.variables ?? variablesText(saved.settings.variables),
        setupScript: draft.setupScript ?? saved.settings.setupScript,
        startScript: draft.startScript ?? saved.settings.startScript,
        toolchains: draft.toolchains ?? saved.settings.toolchains,
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
          maxInstance: undefined,
          idle: undefined,
          ignore: undefined,
          variables: undefined,
          setupScript: undefined,
          startScript: undefined,
          toolchains: undefined,
        })),
        saved,
      );
    },
    (ctx, draft: EnvironmentDraft) => {
      ctx.setSelf(draft);
    },
  ),
);

/**
 * Every kept Secret, of every Environment and for every Environment: names, scopes and build flags, never a value. A
 * section of the page is keyed by the Environment's id, or by `EVERY_ENVIRONMENT`. Asked again every few seconds while the
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
