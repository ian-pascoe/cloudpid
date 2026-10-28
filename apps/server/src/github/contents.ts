// A repo's commit, tree and blobs, asked of GitHub's REST API as the GitHub App (ADR-0025): the `RepoReader` the Skill
// fetch reads through. It asks with a read-only token (contents) for the installation on the repo's owner, else the app
// owner's, which reads any public repo; a token GitHub refuses with a 401 is invalidated and the request made once more
// with a new one. Failures are told plainly (`GithubReadError`): no such repo or a private one the app cannot see, the
// rate limit, a refused token, a tree too large to list.
// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off preferEffectArray:off -- GitHub is read with `fetch`, a Promise API, and the reads and the checks run over native arrays.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { GitHubTokens } from "./app.ts";
import { askAsApp, type GithubFetch, messageOf, rateLimitOf } from "./request.ts";
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
  readonly fetch: GithubFetch;
  /** Where the tokens come from: the GitHub App, with the permissions Skills are fetched with. */
  readonly github: Pick<GitHubTokens, "token" | "invalidate">;
};

/**
 * A name that goes in a URL's path as one segment, escaped. A URL parser resolves `.` and `..` (escaped or not), which
 * would send the request, made with the owner's token, to another endpoint: they and an empty name are refused.
 */
const segment = (name: string): string => {
  if (name === "" || name === "." || name === "..") {
    throw GithubReadError.of("refused", `${JSON.stringify(name)} is not a name GitHub has`);
  }

  return encodeURIComponent(name);
};

/** The path of `repo` in the API. */
const repoPath = ({ owner, name }: SkillRepo): string =>
  `/repos/${segment(owner)}/${segment(name)}`;

/** A ref as it goes in a URL: each segment escaped, the slashes of a branch name kept. */
const refPath = (ref: string): string => ref.split("/").map(segment).join("/");

/** A response's body, or the failure of GitHub's connection while it was read. */
const bodyOf = async <A>(read: () => Promise<A>): Promise<A> => {
  try {
    return await read();
  } catch (cause) {
    throw GithubReadError.of("failed", `GitHub could not be reached: ${messageOf(cause)}`);
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
    const answer = await askAsApp(
      { fetch: options.fetch, github: options.github, timeoutMs: REQUEST_TIMEOUT_MS },
      repo.owner,
      `${API}${path}`,
      { accept },
    );

    if (answer.status === "no_token") throw GithubReadError.of("failed", answer.message);

    if (answer.status === "unreachable") {
      throw GithubReadError.of("failed", `GitHub could not be reached: ${answer.message}`);
    }

    const { response, installed } = answer;

    if (response.ok) return response;

    const said = Option.getOrUndefined(decodeError(await response.json().catch(() => null)));
    const limit = rateLimitOf(response);

    if (limit !== undefined) {
      const when =
        limit.retryAfterSeconds !== undefined
          ? ` Try again in ${Math.ceil(limit.retryAfterSeconds)} seconds.`
          : limit.resetsAt !== undefined
            ? ` It resets at ${new Date(limit.resetsAt).toISOString()}.`
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
  };

  const gone = (repo: SkillRepo) => (installed: boolean) =>
    installed
      ? `GitHub has no repo ${repo.owner}/${repo.name}, or the GitHub App's installation on ${repo.owner} does not include it (install it on all repositories).`
      : `GitHub has no repo ${repo.owner}/${repo.name}, or it is private and the GitHub App is not installed on ${repo.owner} (install it there, on all repositories).`;

  /** The recursive tree `at` names (a commit's SHA, or a ref as it goes in a URL). */
  const treeAt = async (repo: SkillRepo, at: string): Promise<RepoTree> => {
    const response = await ask(
      repo,
      `${repoPath(repo)}/git/trees/${at}?recursive=1`,
      "application/vnd.github+json",
      gone(repo),
    );

    const decoded = decodeTree(await response.json().catch(() => null));

    if (Option.isNone(decoded)) {
      throw GithubReadError.of("failed", "GitHub's answer to the tree was not a tree");
    }

    return { truncated: decoded.value.truncated, entries: decoded.value.tree };
  };

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

      const sha = (await bodyOf(() => response.text())).trim();

      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw GithubReadError.of("failed", "GitHub's answer to the commit was not a SHA");
      }

      return sha;
    },
    tree: (repo, commit) => treeAt(repo, commit),
    // One request, whatever the ref is: GitHub's Trees API takes a branch, a tag or a SHA, and `HEAD` is the default branch.
    headTree: (repo, ref) => treeAt(repo, ref === null ? "HEAD" : refPath(ref)),
    blob: async (repo, sha) => {
      const response = await ask(
        repo,
        `${repoPath(repo)}/git/blobs/${sha}`,
        "application/vnd.github.raw+json",
        gone(repo),
      );

      return new Uint8Array(await bodyOf(() => response.arrayBuffer()));
    },
  };
};
