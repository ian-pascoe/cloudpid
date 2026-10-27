// The repos the Comparison workerd tests read, shared by the Node set-up that makes them with real git
// (`comparison.setup.ts`) and the tests that write them into a Workspace (`comparison.workerd.test.ts`). Nothing here
// may import Node built-ins: the workerd tests import it too.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import type { RepoFiles } from "./changes.repos.ts";

/** A repo at one head: its files, and what the Container's command printed for it. */
export type ComparisonRepo = {
  readonly files: RepoFiles;
  readonly stdout: string;
};

export type ComparisonRepos = {
  /** `app` on `feat`, three commits beyond `main`, which moved on in the remote; the base was fetched. */
  readonly first: ComparisonRepo;
  /** `app` after one more commit on `feat` (every file of it, to be written over the first). */
  readonly second: ComparisonRepo;
  /** `first`, without the new file's blob: an object the Workspace DO has not got yet. */
  readonly withoutBlob: RepoFiles;
  /** The new file's blob id, and what `blobsScript` printed for it. */
  readonly blob: { readonly id: string; readonly stdout: string };
  /** Pull request 7 at `first`'s head (the remote keeps it at `refs/pull/7/head`): its head, and what the command printed. */
  readonly pull: { readonly head: string; readonly stdout: string };
  /** Pull request 7 after the push of `second`'s commit: the new head, and what the command printed for it. */
  readonly pullMoved: { readonly head: string; readonly stdout: string };
};

declare module "vitest" {
  export interface ProvidedContext {
    /** The repos real git made (`comparison.setup.ts`). */
    readonly comparisonRepos: ComparisonRepos;
  }
}
