// The Skills section's state (ADR-0026, docs/architecture/client-and-protocol.md → Settings page): the tab it shows, the Skills
// each Environment keeps and those kept Global, what the owner does to them on the Installed tab
// (install from GitHub or a skills.sh search, update, remove), the files of a Skill's Agent change and of a Skill with no
// Skill source, and the state of the tab's forms and dialogs. Each family is keyed by scope: an Environment's id, or
// `GLOBAL` for the Skills kept Global. The Skill directory's lists and search, and the install
// confirm the rows (and, later, a repo's and a Skill's page) open, are here too.

import type { SkillDirectoryView } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { changing, RegistryClient } from "./registry.ts";
import { skillsParamsAtom, type SkillsTab } from "./router.ts";
import { appRuntime } from "./runtime.ts";
import { visibleTickAtom } from "./sessions.ts";
import { installSource } from "./skills.ts";

/**
 * Whether Scope `scope` (`GLOBAL` or an Environment's id) keeps a Skill: asked once while the Skills section is open,
 * never again, so that an install made from the page does not change which tab is the default under the owner. A
 * failure is an answer too: the Installed tab is where the page says what went wrong.
 */
export const anySkillInstalledAtom = Atom.family((scope: string) =>
  appRuntime.atom(
    RegistryClient.use((registry) =>
      registry("listEnvironmentSkills", { environment: scope }).pipe(
        Effect.map((skills) => skills.length > 0),
      ),
    ),
  ),
);

/**
 * The tab the Skills section shows at Scope `scope`: the one `?tab=` names, else Installed when the Scope keeps a Skill
 * and All time when it keeps none. Null while that is being asked (nothing is current yet), so that the page does not
 * flash the wrong tab.
 */
export const skillsTabAtom = Atom.family((scope: string) =>
  Atom.readable((get): SkillsTab | null => {
    const named = get(skillsParamsAtom).tab;

    if (named !== undefined) return named;

    const any = get(anySkillInstalledAtom(scope));

    if (AsyncResult.isSuccess(any)) return any.value ? "installed" : "all-time";

    return AsyncResult.isFailure(any) ? "installed" : null;
  }),
);

/**
 * The Skills Environment `id` keeps (ADR-0026), by name, asked again every few seconds while the page is visible: a
 * Session's agent saves and removes them, which the page hears of no other way.
 */
export const environmentSkillsAtom = Atom.family((id: string) =>
  RegistryClient.query(
    "listEnvironmentSkills",
    { environment: id },
    { reactivityKeys: [`environment-skills:${id}`] },
  ).pipe(Atom.makeRefreshOnSignal(visibleTickAtom)),
);

/** The Skill of Environment `id` whose Remove dialog is open, by name: null when none is. */
export const skillDialogAtom = Atom.family((_id: string) => Atom.make<string | null>(null));

/** The Skill of Environment `id` whose Update dialog is open, by name: null when none is. */
export const skillUpdateDialogAtom = Atom.family((_id: string) => Atom.make<string | null>(null));

/** The Skill of Environment `id` to update, and whether the edits made to it may be replaced (the owner confirmed). */
export interface SkillUpdateRequest {
  readonly name: string;
  readonly overwrite: boolean;
}

/**
 * Update Skill `name` of Environment `id` (or `GLOBAL`) to the latest commit of its ref, on the owner's word:
 * no Approval, and no Agent change, so no revert. It answers how the Skill went; the Skills list, and the badges of the
 * pages that show where a Skill is installed (the `skill-badges` key), ask again either way.
 */
export const updateSkillAtom = Atom.family((id: string) =>
  appRuntime.fn(
    ({ name, overwrite }: SkillUpdateRequest) =>
      RegistryClient.use((registry) =>
        registry("updateEnvironmentSkills", { environment: id, names: [name], overwrite }),
      ).pipe(changing([`environment-skills:${id}`, "skill-badges"])),
    { concurrent: true },
  ),
);

/**
 * Remove Skill `name` from Environment `id`: its Workspaces stop serving it at their next readying. Once it is removed,
 * its dialog closes.
 */
export const removeSkillAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (name: string, get) =>
      RegistryClient.use((registry) =>
        registry("removeEnvironmentSkill", { environment: id, name }),
      ).pipe(
        changing([`environment-skills:${id}`, "skill-badges"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(skillDialogAtom(id), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** What is typed in the add-Skills form of Environment `id` as the GitHub source: `owner/repo`, `owner/repo@skill` or a URL. */
export const skillSourceAtom = Atom.family((_id: string) => Atom.make(""));

/** What is typed in the add-Skills form of Environment `id` as the search of skills.sh. */
export const skillSearchQueryAtom = Atom.family((_id: string) => Atom.make(""));

/**
 * Search skills.sh for `query`. The main Worker asks (skills.sh answers no browser's cross-origin request), and a
 * failure comes back with its reason. Nothing is recorded: the owner picks a result to install from.
 */
export const searchSkillsAtom = Atom.family((_id: string) =>
  appRuntime.fn((query: string) =>
    RegistryClient.use((registry) => registry("searchSkills", { query: query.trim() })),
  ),
);

/** What the add-Skills form of Environment `id` installs: the source, and the Skills of it to take (absent: its only one). */
export interface SkillInstallRequest {
  readonly source: string;
  readonly skills?: ReadonlyArray<string>;
}

/**
 * Install Skills from a GitHub source into Environment `id`, on the owner's word (an install that is no Agent change).
 * It answers with what was kept, each pinned to the commit, or, for a source that holds several Skills and none was
 * named, the list of them to tick and nothing kept. The Skills list asks again either way; the form's source empties
 * once Skills were kept.
 */
export const installSkillsAtom = Atom.family((id: string) =>
  appRuntime.fn(
    ({ source, skills }: SkillInstallRequest, get) =>
      RegistryClient.use((registry) =>
        registry(
          "installEnvironmentSkills",
          skills === undefined
            ? { environment: id, source: source.trim() }
            : { environment: id, source: source.trim(), skills },
        ),
      ).pipe(
        changing([`environment-skills:${id}`]),
        Effect.tap((installed) =>
          Effect.sync(() => {
            if (installed.status === "installed") get.set(skillSourceAtom(id), "");
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** One Agent change of an Environment, as `skillChangeFilesAtom` is keyed. */
export interface SkillChangeKey {
  readonly environment: string;
  readonly change: number;
}

/** The key of Agent change `change` of Environment `environment`, so equal keys are equal values, as a family compares them. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain constructor of a key, called from React.
export const skillChangeKey = (environment: string, change: number): SkillChangeKey => ({
  environment,
  change,
});

/** The files of a Skill before and after an Agent change, to show as diffs. A change does not change: asked once. */
export const skillChangeFilesAtom = Atom.family(({ environment, change }: SkillChangeKey) =>
  RegistryClient.query("skillChangeFiles", { environment, change }),
);

/** One Skill of a scope, as `keptSkillFilesAtom` and `skillFilesDialogAtom` are keyed. */
export interface SkillKey {
  readonly environment: string;
  readonly name: string;
}

/** The key of Skill `name` of `environment` (or `GLOBAL`), so equal keys are equal values, as a family compares them. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain constructor of a key, called from React.
export const skillKey = (environment: string, name: string): SkillKey => ({ environment, name });

/**
 * The files the Registry keeps for a Skill, with their texts, by path: what the viewer of a Skill with no Skill source
 * shows. Asked when the viewer opens, and again when the scope's Skills change.
 */
export const keptSkillFilesAtom = Atom.family(({ environment, name }: SkillKey) =>
  RegistryClient.query(
    "environmentSkillFiles",
    { environment, name },
    { reactivityKeys: [`environment-skills:${environment}`] },
  ),
);

/** The Skill of Environment `id` whose files viewer is open, by name: null when none is. */
export const skillFilesDialogAtom = Atom.family((_id: string) => Atom.make<string | null>(null));

/** A page of a Skill directory list, as `skillDirectoryPageAtom` is keyed. */
export interface SkillDirectoryPageKey {
  readonly view: SkillDirectoryView;
  readonly page: number;
}

/** The key of page `page` (from 0) of list `view`, so equal keys are equal values, as a family compares them. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain constructor of a key, called from React.
export const skillDirectoryPageKey = (
  view: SkillDirectoryView,
  page: number,
): SkillDirectoryPageKey => ({ view, page });

/**
 * One page (200 rows) of a Skill directory list, each row saying where its Skill is installed. The main Worker keeps what
 * skills.sh answered about an hour, so asking again after an install or an update costs nothing there: the page does,
 * to show the new badge.
 */
export const skillDirectoryPageAtom = Atom.family(({ view, page }: SkillDirectoryPageKey) =>
  RegistryClient.query("listSkillDirectory", { view, page }, { reactivityKeys: ["skill-badges"] }),
);

/** How many pages of list `view` the page shows: one, and one more for each Load more. */
export const skillDirectoryPagesAtom = Atom.family((_view: SkillDirectoryView) => Atom.make(1));

/** What skills.sh finds for `query` (at most 200, fuzzy), each result saying where its Skill is installed. */
export const skillDirectorySearchAtom = Atom.family((query: string) =>
  RegistryClient.query("searchSkillDirectory", { query }, { reactivityKeys: ["skill-badges"] }),
);

/** The Skills an install is being picked a target for: their source, and the IDs in it to install (never the whole repo). */
export interface SkillsToInstall {
  /** `owner/repo`, or another source an install takes. */
  readonly source: string;
  /** The Skills of the source to install, by ID; only these are installed, whatever else the source holds. */
  readonly skills: ReadonlyArray<string>;
  /**
   * The folders (repo-relative, `""` for the repo's root) that hold the Skills, when the page knows them, as a repo's page
   * does: the install then takes exactly these folders and `skills` only labels them, since names are not exact (two
   * folders can declare one name, a name can be another folder's). Absent: the install resolves `skills` by name.
   */
  readonly folders?: ReadonlyArray<string> | undefined;
  /** The branch, tag or commit to install at (a repo's or a Skill's page `?ref=`); absent: the repo's default branch. */
  readonly ref?: string | undefined;
}

/**
 * What the install confirm (`InstallSkillsDialog`) is open for, or null when it is closed. A page that offers
 * Install sets it: a row of a list, a repo's selected Skills, a Skill's page.
 */
export const skillsToInstallAtom = Atom.make<SkillsToInstall | null>(null);

/** An install the confirm makes: `skills` of `source`, into Environment `target` or, for `GLOBAL`, Global. */
export interface SkillInstallToTarget extends SkillsToInstall {
  readonly target: string;
}

/**
 * Install the picked Skills of a source into `target`, on the owner's word (no Approval, and no Agent change), through the
 * same RPC as the Installed tab's form, at `ref` when one is named. It names the Skills, so a source that holds several
 * installs only those. The target's Skills and every query that reads the `skill-badges` key (the Skill directory's rows,
 * and a repo's or a Skill's page, which put their badge queries on that key) ask again, so the badges update.
 */
export const installToTargetAtom = appRuntime.fn(
  ({ target, source, skills, folders, ref }: SkillInstallToTarget) =>
    RegistryClient.use((registry) =>
      registry("installEnvironmentSkills", {
        environment: target,
        source: installSource(source, ref),
        ...(folders === undefined ? { skills } : { folders }),
      }),
    ).pipe(changing([`environment-skills:${target}`, "skill-badges"])),
);
