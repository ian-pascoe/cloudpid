// What the host does for a stdio server beyond an HTTP one's (`docs/architecture/mcp-connections.md` → The stdio
// bridge): the Roots it is offered, and the seam where a child's end is told (#478).
// @effect-diagnostics missingPipeableSignature:off -- the host's operations, not combinators.
import type { McpRoot } from "@cloudpid/mcp/types";
import { repoDirectory } from "@cloudpid/protocol/repo";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** A Repo of a Workspace, as the Registry lists it: its directory below `/workspace`, and its `owner/repo`. */
export type WorkspaceRepo = { readonly directory: string; readonly slug: string };

/** The Roots a stdio server is offered: each Repo as the `file://` URI of its directory, named by its slug. */
export const rootsOf = (repos: ReadonlyArray<WorkspaceRepo>): ReadonlyArray<McpRoot> =>
  Arr.map(repos, ({ directory, slug }) => ({
    uri: `file://${repoDirectory(directory)}`,
    name: slug,
  }));

/**
 * What is done when a stdio server's child ended: the child with spawn id `spawn` (absent when the Workspace itself is
 * gone) of `conn` in `workspace`. The seam for #478, which closes what hung on that child (an outstanding sign-in, a
 * watch); nothing is done with it yet.
 */
export type McpProcessEndedHandler = (
  conn: string,
  workspace: string,
  spawn: string | undefined,
) => Effect.Effect<void>;

/** The host's handler of a child's end, from every place that learns of it. Internal to the host. */
export class McpProcessEnded extends Context.Service<McpProcessEnded, McpProcessEndedHandler>()(
  "@cloudpid/server/mcp/stdio/McpProcessEnded",
) {
  /** Nothing is done, until #478. */
  static readonly none = Layer.succeed(McpProcessEnded, () => Effect.void);
}

/** A child's end, told to the host's handler: its spawn id changed under a call, or its Workspace is gone. */
export const processEnded = (conn: string, workspace: string, spawn: string | undefined) =>
  Effect.flatMap(McpProcessEnded, (handler) => handler(conn, workspace, spawn));
