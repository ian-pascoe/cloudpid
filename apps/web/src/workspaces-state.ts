// The Workspace list and what the owner does to a Workspace in it: create, rename, delete.

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

/** Register a Workspace by slug; one already registered keeps its record. */
export const createWorkspaceAtom = appRuntime.fn(
  (slug: string) =>
    RegistryClient.use((registry) => registry("createWorkspace", { slug })).pipe(
      changing(["workspaces"]),
    ),
  { concurrent: true },
);

/** Name a Workspace; its slug never changes. */
export const renameWorkspaceAtom = appRuntime.fn(
  (change: { readonly workspace: string; readonly name: string }) =>
    RegistryClient.use((registry) => registry("renameWorkspace", change)).pipe(
      changing(["workspaces"]),
    ),
  { concurrent: true },
);

/**
 * Delete a Workspace for good: its Sessions, files, Container and settings. A delete that stopped partway deleted some
 * Sessions, so the lists ask again either way.
 */
export const deleteWorkspaceAtom = appRuntime.fn(
  (workspace: string) =>
    RegistryClient.use((registry) => registry("deleteWorkspace", { workspace })).pipe(
      Effect.asVoid,
      changing(["workspaces", "sessions", `repos:${workspace}`, `workspace-settings:${workspace}`]),
    ),
  { concurrent: true },
);
