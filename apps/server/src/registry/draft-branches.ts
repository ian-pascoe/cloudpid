// The draft's Start from menu (`docs/spec.md` → Session list → New session): the branches of each of an Environment's
// Repos, asked of GitHub by the main Worker with `CLOUDPID_GITHUB_TOKEN` through the client the Diff pane's picker uses
// (`GithubPulls`), which keeps each repo's list for 60 s per isolate. No Workspace or Container is woken.
// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off
import type { EnvironmentRepo, RepoBranches } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { GithubPulls, githubRepoOf } from "../workspace/github-pulls.ts";

/** What a Repo whose remote is not on GitHub says in the menu. */
export const NO_GITHUB_MESSAGE = "it is not on GitHub";

/** The branches of `repos`, in their order: each one's, or why GitHub did not list them. */
export type DraftBranches = (
  repos: ReadonlyArray<EnvironmentRepo>,
) => Effect.Effect<ReadonlyArray<RepoBranches>>;

/** The GitHub client the main Worker asks with `token`, built once per isolate so its 60 s lists are shared. */
export const githubBranches = (token: Redacted.Redacted<string>): Pick<GithubPulls, "branches"> =>
  new GithubPulls({
    fetch: (url, init) => fetch(url, init),
    token: () => Redacted.value(token),
    now: () => Date.now(),
    warn: () => undefined,
  });

/** `DraftBranches` over `github`, which answers each repo's branches or why not, and never throws. */
export const draftBranches =
  (github: Pick<GithubPulls, "branches">): DraftBranches =>
  (repos) =>
    Effect.forEach(
      repos,
      (repo) =>
        Effect.promise(async (): Promise<RepoBranches> => {
          const remote = githubRepoOf(repo.url);

          if (remote === undefined) {
            return {
              repo: repo.name,
              status: "error",
              kind: "no_github",
              message: NO_GITHUB_MESSAGE,
            };
          }

          const listed = await github.branches(remote);

          return listed.status === "ok"
            ? { repo: repo.name, status: "ok", ...listed.value }
            : { repo: repo.name, status: "error", kind: listed.kind, message: listed.message };
        }),
      { concurrency: "unbounded" },
    );
