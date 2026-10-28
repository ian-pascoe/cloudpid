// The Skills page's state (ADR-0026, docs/architecture/client-and-protocol.md → Skills page): the tab it shows, the Skills
// each Environment keeps and those kept for every Environment, what the owner does to them on the Installed tab
// (install from GitHub or a skills.sh search, update, remove), the files of a Skill's Agent change and of a Skill with no
// Skill source, and the state of the tab's forms and dialogs. Each family is keyed by scope: an Environment's id, or
// `EVERY_ENVIRONMENT` for the Skills kept for every Environment.

import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { changing, RegistryClient } from "./registry.ts";
import { skillsParamsAtom, type SkillsTab } from "./router.ts";
import { appRuntime } from "./runtime.ts";
import { visibleTickAtom } from "./sessions.ts";

/** The tab the Skills page shows: the one `?tab=` names, else Installed. */
export const skillsTabAtom = Atom.map(
  skillsParamsAtom,
  (params): SkillsTab => params.tab ?? "installed",
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
 * Update Skill `name` of Environment `id` (or `EVERY_ENVIRONMENT`) to the latest commit of its ref, on the owner's word:
 * no Approval, and no Agent change, so no revert. It answers how the Skill went; the Skills list asks again either way.
 */
export const updateSkillAtom = Atom.family((id: string) =>
  appRuntime.fn(
    ({ name, overwrite }: SkillUpdateRequest) =>
      RegistryClient.use((registry) =>
        registry("updateEnvironmentSkills", { environment: id, names: [name], overwrite }),
      ).pipe(changing([`environment-skills:${id}`])),
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
        changing([`environment-skills:${id}`]),
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

/** The key of Skill `name` of `environment` (or `EVERY_ENVIRONMENT`), so equal keys are equal values, as a family compares them. */
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
