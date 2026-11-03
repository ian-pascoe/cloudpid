// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- a plain function over the Session's own state; its readying is a Promise, as the Workspace's is.
// How a Session that may be an import readies its Workspace (`docs/architecture/mcp-endpoint.md` → Session import → The
// import channel): not at all while it is importing, since the Local agent's pushes are known to be done only once finish
// accepted the file, and from an import's own ref when the Workspace is the import's.
import { importCarryRef } from "@cloudpid/sandbox-image/workspaces";
import { isImporting } from "./fork-host.ts";
import type { ImportStaging } from "./import-staging.ts";
import type { SettingsKv } from "./settings.ts";

/** Why a Session that is importing does not ready its Workspace. */
export const IMPORT_NOT_READIED =
  "This Session is importing a local pi Session; its Workspace is readied when the import ends.";

/**
 * What readying Workspace `workspace` asks of the Session named `session`: it throws while the Session is importing, and
 * otherwise answers the ref its uncommitted Changes wait at, when it is an import's own Workspace (`placed` says which
 * Workspace the Session works in); none for any other Session or Workspace, which use the branch's.
 */
export const importReadying = async (options: {
  readonly kv: SettingsKv;
  readonly staging: Pick<ImportStaging, "record">;
  readonly session: string | undefined;
  readonly workspace: string;
  readonly placed: () => Promise<string | null>;
}): Promise<{ readonly carry?: string }> => {
  if (isImporting(options.kv)) throw new Error(IMPORT_NOT_READIED);

  const { session, workspace } = options;

  if (session === undefined || options.staging.record() === undefined) return {};

  return (await options.placed()) === workspace ? { carry: importCarryRef(session) } : {};
};
