// What the host does for a stdio server beyond an HTTP one's (`docs/architecture/mcp-connections.md` → The stdio
// bridge): the Roots it is offered, and the seam where a child's end is told (#478).
// @effect-diagnostics missingPipeableSignature:off -- the host's operations, not combinators.
import type { McpRoot } from "@cloudpid/mcp/types";
import { repoDirectory } from "@cloudpid/protocol/repo";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

/** A Repo of a Workspace, as the Registry lists it: its directory below `/workspace`, and its `owner/repo`. */
export type WorkspaceRepo = { readonly directory: string; readonly slug: string };

/** The Roots a stdio server is offered: each Repo as the `file://` URI of its directory, named by its slug. */
export const rootsOf = (repos: ReadonlyArray<WorkspaceRepo>): ReadonlyArray<McpRoot> =>
  Arr.map(repos, ({ directory, slug }) => ({
    uri: `file://${repoDirectory(directory)}`,
    name: slug,
  }));

/**
 * The seam for #478: the child with spawn id `spawn` of `conn` in `workspace` ended (the server was spawned again under
 * another id, or its Workspace is gone). Nothing is done with it yet; whatever closes what hung on that child (an
 * outstanding sign-in, a watch) is hooked in here, once, from every place that learns of it.
 */
export const processEnded = (_conn: string, _workspace: string, _spawn: string | undefined) =>
  Effect.void;
