// The draft composer's menus (`docs/spec.md` → Session list → New session): the Prompt templates and Skills after `/`
// and `$`, and the files after `@`, of the directory the Session the draft makes would work in. There is no Session to
// ask yet, so they are asked of the Registry (`draftCatalog`, `draftFiles`), for the Environment and Workspace the
// draft is made in, and kept as a Session's composer keeps its own (`catalog.ts`, `file-search.ts`). The Start from
// menu's branches are asked of it too (`draftBranches`).

// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key, not a combinator.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { catalogLookup } from "./chat/catalog.ts";
import type { ComposerLookups } from "./chat/composer-state.ts";
import { fileSearchLookup } from "./chat/file-search.ts";
import { effectiveWorkspace } from "./draft.ts";
import { draftEnvironmentAtom, draftWorkspaceAtom } from "./draft-state.ts";
import { workspaceListAtom } from "./environments-state.ts";
import { RegistryClient } from "./registry.ts";

/** Where the draft's Session would work: its Environment, and `NEW_WORKSPACE` or one of the Environment's Workspaces. */
export interface DraftPlace {
  readonly environment: string;
  readonly workspace: string;
}

/** The key of a place, with both fields set, so equal places are equal values. */
export const draftPlace = (environment: string, workspace: string): DraftPlace => ({
  environment,
  workspace,
});

/** The place the draft is made in now: a Workspace picked that is not the Environment's is a new one. */
export const draftPlaceAtom = Atom.make((get) => {
  const environment = get(draftEnvironmentAtom);

  const workspaces = Arr.filter(
    get(workspaceListAtom) ?? [],
    (known) => known.environment === environment,
  );

  return draftPlace(environment, effectiveWorkspace(get(draftWorkspaceAtom), workspaces));
});

/**
 * The branches of Environment `environment`'s Repos on GitHub, for the Start from menu: asked while the menu is shown
 * (the main Worker keeps each Repo's for 60 s), and again when the Environments change, as a Repo added has its own.
 */
export const draftBranchesAtom = Atom.family((environment: string) =>
  RegistryClient.query("draftBranches", { environment }, { reactivityKeys: ["environments"] }),
);

/** The catalogs of the draft's places. */
export const { catalogAtom: draftCatalogAtom, askCatalogAtom: askDraftCatalogAtom } = catalogLookup(
  (place: DraftPlace) => RegistryClient.use((registry) => registry("draftCatalog", place)),
);

/** The `@` menus of the draft's places. */
export const { fileSearchAtom: draftFileSearchAtom, searchFilesAtom: searchDraftFilesAtom } =
  fileSearchLookup((place: DraftPlace) =>
    RegistryClient.use((registry) =>
      Effect.succeed((query: string) => registry("draftFiles", { ...place, query })),
    ),
  );

/**
 * The draft composer's lookups, in the place the draft is made in at the time: reading one keeps that place's alive,
 * and writing one asks about it.
 */
export const draftLookups: ComposerLookups = {
  searchFiles: Atom.writable(
    (get) => get(searchDraftFilesAtom(get(draftPlaceAtom))),
    (ctx, query: string | null) => {
      ctx.set(searchDraftFilesAtom(ctx.get(draftPlaceAtom)), query);
    },
  ),
  askCatalog: Atom.writable(
    (get) => get(askDraftCatalogAtom(get(draftPlaceAtom))),
    (ctx) => {
      ctx.set(askDraftCatalogAtom(ctx.get(draftPlaceAtom)), undefined);
    },
  ),
};
