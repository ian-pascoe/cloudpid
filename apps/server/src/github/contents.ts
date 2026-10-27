// A repo's commit, tree and blobs, asked of GitHub's REST API as the GitHub App (ADR-0025): the `RepoReader` the Skill
// fetch reads through. It asks with a read-only token (contents) for the installation on the repo's owner, else the app
// owner's, which reads any public repo; a token GitHub refuses with a 401 is invalidated and the request made once more
// with a new one. Failures are told plainly (`GithubReadError`): no such repo or a private one the app cannot see, the
// rate limit, a refused token, a tree too large to list.
// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off preferEffectArray:off -- GitHub is read with `fetch`, a Promise API, and the reads and the checks run over native arrays.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { GitHubTokens } from "./app.ts";
import { GithubReadError, type RepoReader, type RepoTree, type SkillRepo } from "./skill-fetch.ts";

const API = "https://api.github.com";

/** How long one request to GitHub may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** What a token for Skills' reads may do: read a repo's contents, nothing else. */
export const SKILL_FETCH_PERMISSIONS = { contents: "read" } as const;

const TreeAnswer = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.Literals(["blob", "tree", "commit"]),
      sha: Schema.String,
      size: Schema.optionalKey(Schema.Finite),
    }),
  ),
});

const decodeTree = Schema.decodeUnknownOption(TreeAnswer);

const ErrorAnswer = Schema.Struct({ message: Schema.String });

const decodeError = Schema.decodeUnknownOption(ErrorAnswer);

export type GithubContentsOptions = {
  /** GitHub's API; a test replaces it. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Where the tokens come from: the GitHub App, with the permissions Skills are fetched with. */
  readonly github: Pick<GitHubTokens, "token" | "invalidate">;
};

/** The path of `repo` in the API. */
const repoPath = ({ owner, name }: SkillRepo): string =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** A ref as it goes in a URL: each segment escaped, the slashes of a branch name kept. */
const refPath = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

/** The token for the installation on `owner`, else the app owner's; and whether the app is installed on `owner`. */
const tokenFor = async (
  github: GithubContentsOptions["github"],
  owner: string,
): Promise<{ readonly token: string; readonly installed: boolean; readonly problem?: string }> => {
  try {
    return { token: await github.token(owner), installed: true };
  } catch (cause) {
    try {
      return {
        token: await github.token(),
        installed: false,
        problem: cause instanceof Error ? cause.message : String(cause),
      };
    } catch {
      throw GithubReadError.of(
        "failed",
        `No GitHub token: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
};

/** A `RepoReader` over GitHub's REST API. */
export const githubContents = (options: GithubContentsOptions): RepoReader => {
  /** `path` asked as the app, with a token for `repo`'s owner; a 401 asks once more with a new token. */
  const ask = async (
    repo: SkillRepo,
    path: string,
    accept: string,
    notFound: (installed: boolean) => string,
  ): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      const { token, installed } = await tokenFor(options.github, repo.owner);

      let response: Response;

      try {
        response = await options.fetch(`${API}${path}`, {
          method: "GET",
          headers: {
            accept,
            authorization: `Bearer ${token}`,
            "user-agent": "cloudpid",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        throw GithubReadError.of(
          "failed",
          `GitHub could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      if (response.ok) return response;

      if (response.status === 401 && attempt === 1) {
        options.github.invalidate(token);
        continue;
      }

      const said = Option.getOrUndefined(decodeError(await response.json().catch(() => null)));
      const retryAfter = Number(response.headers.get("retry-after"));
      const reset = Number(response.headers.get("x-ratelimit-reset"));

      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            (Number.isFinite(retryAfter) && retryAfter > 0)))
      ) {
        const when =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? ` Try again in ${Math.ceil(retryAfter)} seconds.`
            : Number.isFinite(reset) && reset > 0
              ? ` It resets at ${new Date(reset * 1000).toISOString()}.`
              : "";

        throw GithubReadError.of(
          "rate_limited",
          `GitHub's rate limit for the GitHub App's token on ${repo.owner} is used up.${when}`,
        );
      }

      if (response.status === 404 || response.status === 422) {
        throw GithubReadError.of("not_found", notFound(installed));
      }

      if (response.status === 401 || response.status === 403) {
        throw GithubReadError.of(
          "refused",
          `GitHub refused the GitHub App's token for ${repo.owner}/${repo.name} (${response.status}${said === undefined ? "" : `: ${said.message}`}). Check the GitHub App's installation on ${repo.owner}.`,
        );
      }

      throw GithubReadError.of(
        "failed",
        `GitHub answered ${response.status}${said === undefined ? "" : `: ${said.message}`}`,
      );
    }
  };

  const gone = (repo: SkillRepo) => (installed: boolean) =>
    installed
      ? `GitHub has no repo ${repo.owner}/${repo.name}, or the GitHub App's installation on ${repo.owner} does not include it (install it on all repositories).`
      : `GitHub has no repo ${repo.owner}/${repo.name}, or it is private and the GitHub App is not installed on ${repo.owner} (install it there, on all repositories).`;

  return {
    commit: async (repo, ref) => {
      const response = await ask(
        repo,
        `${repoPath(repo)}/commits/${ref === null ? "HEAD" : refPath(ref)}`,
        "application/vnd.github.sha",
        (installed) =>
          ref === null
            ? gone(repo)(installed)
            : `${gone(repo)(installed)} Or it has no ref ${JSON.stringify(ref)} (a branch, a tag or a commit).`,
      );

      const sha = (await response.text()).trim();

      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw GithubReadError.of("failed", "GitHub's answer to the commit was not a SHA");
      }

      return sha;
    },
    tree: async (repo, commit): Promise<RepoTree> => {
      const response = await ask(
        repo,
        `${repoPath(repo)}/git/trees/${commit}?recursive=1`,
        "application/vnd.github+json",
        gone(repo),
      );

      const decoded = decodeTree(await response.json().catch(() => null));

      if (Option.isNone(decoded)) {
        throw GithubReadError.of("failed", "GitHub's answer to the tree was not a tree");
      }

      return { truncated: decoded.value.truncated, entries: decoded.value.tree };
    },
    blob: async (repo, sha) => {
      const response = await ask(
        repo,
        `${repoPath(repo)}/git/blobs/${sha}`,
        "application/vnd.github.raw+json",
        gone(repo),
      );

      return new Uint8Array(await response.arrayBuffer());
    },
  };
};
