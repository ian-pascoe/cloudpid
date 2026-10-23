// The composer's lookups where no Session works yet: the draft composer's catalog and `@` menu (`draftCatalog`,
// `draftFiles` in `RegistryRpcs`), which the main Worker answers from a Workspace's own DO, as a Session answers its
// composer's from its Workspace's (`catalogFor` and `filesFor` in `host.ts`). Lookups only read files: the Workspace
// is never readied for them, so they never wait for clones or a Container.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off

import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import { type Catalog, EnvironmentError, type FileMatches } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { reason } from "../registry/messages.ts";
import { catalogEntries } from "./commands.ts";
import { type FileListingsService, listedPaths, matchFiles } from "./file-search.ts";

/**
 * `@cloudpid/computer-env` loads on first use: `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
const computer = () => import("@cloudpid/computer-env");

/** Where a lookup looks: a Workspace's DO (`workspaceObjectName`), and the directory a Session there works in. */
export type LookupPlace = { readonly object: string; readonly directory: string };

/** The draft composer's lookups, in the Workspace `place` names. Each fails with an `EnvironmentError` saying why. */
export type WorkspaceLookups = {
  /** The Prompt templates and Skills of `place`'s directory, nearest first, and no commands: there is no Session yet. */
  readonly catalog: (place: LookupPlace) => Effect.Effect<Catalog, EnvironmentError>;
  /** The files and folders of `place`'s directory that best match `query`, relative to it. */
  readonly files: (
    place: LookupPlace,
    query: string,
  ) => Effect.Effect<FileMatches, EnvironmentError>;
};

/** Why a lookup failed, for the owner. */
const failure = (what: string) => (cause: unknown) =>
  EnvironmentError.make({ message: `${what}: ${reason(Cause.fail(cause))}` });

/**
 * The lookups over the Workspace DO namespace the main Worker binds (`WorkspaceNamespace`). Listings are held in
 * `listings`, which the main Worker keeps per isolate, so typing a mention lists the directory once.
 */
export const workspaceLookups = (
  namespace: { getByName(objectName: string): ComputerWorkspaceStub },
  listings: FileListingsService,
): WorkspaceLookups => {
  const envIn = (place: LookupPlace) =>
    Effect.tryPromise({
      try: async () => {
        const { ComputerExecutionEnv } = await computer();

        return new ComputerExecutionEnv({
          workspace: namespace.getByName(place.object),
          // The same file namespace as the Sessions' environments in the Workspace (`sessionWorkspace`).
          id: `computer:${place.object}`,
          cwd: place.directory,
        });
      },
      catch: failure("Could not reach the workspace"),
    });

  return {
    catalog: (place) =>
      envIn(place).pipe(
        Effect.flatMap((env) =>
          Effect.tryPromise({
            try: () =>
              Promise.all([
                env.discoverSkills(BACKGROUND_CONTEXT),
                env.discoverPrompts(BACKGROUND_CONTEXT),
              ]),
            catch: failure("Could not list the skills and prompt templates"),
          }),
        ),
        Effect.map(([skills, templates]) => ({
          commands: [],
          ...catalogEntries(skills, templates),
        })),
      ),
    files: (place, query) =>
      envIn(place).pipe(
        Effect.flatMap((env) =>
          listedPaths(listings, env, BACKGROUND_CONTEXT).pipe(
            Effect.mapError((error) => EnvironmentError.make({ message: error.message })),
          ),
        ),
        Effect.map((paths): FileMatches => ({ paths: matchFiles(query, paths) })),
      ),
  };
};
