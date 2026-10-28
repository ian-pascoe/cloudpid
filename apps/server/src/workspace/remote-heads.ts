// Where each Repo's default branch is on its remote (docs/architecture/container.md → Builds), for the Build's daily look,
// asked from the Build object itself so that no Container starts when nothing moved. A GitHub repo is asked of GitHub's
// REST API as the GitHub App (`askAsApp`: a token for the installation on the repo's owner, else the app owner's, which
// reads any public repo; no token at all where the app is not set up, which reads public repos too). A repo on another
// host (an https address of a public host: `parseRepoSource`) is asked through git's smart HTTP, as `git ls-remote`
// does, without credentials. Either way a repo with no commits yet has no head (null).
// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off -- GitHub and git are asked with `fetch`, a Promise API, over native arrays.
import type { GitHubTokens } from "../github/app.ts";
import {
  askAsApp,
  askGithub,
  type GithubFetch,
  messageOf,
  rateLimitOf,
} from "../github/request.ts";
import type { BuildRepo } from "./build-record.ts";
import { githubRepoOf } from "./github-pulls.ts";

/** How long asking one remote may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** What asking the remotes came to: each Repo's head commit by name, or why one could not be had. */
export type RemoteHeadsAnswer =
  | { readonly ok: true; readonly heads: Readonly<Record<string, string | null>> }
  | { readonly ok: false; readonly reason: string };

/** Each Repo's default branch head on its remote, as `git ls-remote <url> HEAD` tells it; never throws. */
export type RemoteHeads = (repos: ReadonlyArray<BuildRepo>) => Promise<RemoteHeadsAnswer>;

export type RemoteHeadsOptions = {
  /** GitHub's API, and the other remotes; a test replaces it. */
  readonly fetch: GithubFetch;
  /** Where the GitHub tokens come from; absent, GitHub is asked without one (public repos only). */
  readonly github: Pick<GitHubTokens, "token" | "invalidate"> | undefined;
};

type Head =
  | { readonly ok: true; readonly head: string | null }
  | { readonly ok: false; readonly reason: string };

const failed = (reason: string): Head => ({ ok: false, reason });

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const NO_COMMIT = /^0+$/;

/** What GitHub's refusal or rate limit or absence of a repo is told as. */
const refusalOf = (response: Response, repo: string, installed: boolean): string => {
  const limit = rateLimitOf(response);

  if (limit !== undefined) {
    const when =
      limit.retryAfterSeconds !== undefined
        ? ` Try again in ${Math.ceil(limit.retryAfterSeconds)} seconds.`
        : limit.resetsAt !== undefined
          ? ` It resets at ${new Date(limit.resetsAt).toISOString()}.`
          : "";

    return `GitHub's rate limit is used up asking for ${repo}'s default branch.${when}`;
  }

  if (response.status === 404) {
    return installed
      ? `GitHub has no repo ${repo}, or the GitHub App's installation does not include it (install it on all repositories)`
      : `GitHub has no repo ${repo}, or it is private and the GitHub App is not installed on its owner (install it there, on all repositories)`;
  }

  if (response.status === 401 || response.status === 403) {
    return `GitHub refused the token for ${repo} (${response.status})`;
  }

  return `GitHub answered ${response.status} asking for ${repo}'s default branch`;
};

/** The head of `repo`'s default branch on GitHub. */
const githubHead = async (
  options: RemoteHeadsOptions,
  repo: { readonly owner: string; readonly name: string },
): Promise<Head> => {
  const name = `${repo.owner}/${repo.name}`;
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/HEAD`;
  const request = { accept: "application/vnd.github.sha" };
  const { github, fetch } = options;

  let response: Response;
  let installed = true;

  if (github === undefined) {
    const asked = await askGithub(fetch, url, request, undefined, REQUEST_TIMEOUT_MS);

    if ("unreachable" in asked) {
      return failed(`GitHub could not be reached asking for ${name}: ${asked.unreachable}`);
    }

    response = asked.response;
  } else {
    const asked = await askAsApp(
      { fetch, github, timeoutMs: REQUEST_TIMEOUT_MS },
      repo.owner,
      url,
      request,
    );

    if (asked.status !== "answered") {
      return failed(
        asked.status === "no_token"
          ? asked.message
          : `GitHub could not be reached asking for ${name}: ${asked.message}`,
      );
    }

    ({ response, installed } = asked);
  }

  // An empty repo has no commit to name.
  if (response.status === 409) return { ok: true, head: null };

  if (!response.ok) return failed(refusalOf(response, name, installed));

  const commit = (await response.text().catch(() => "")).trim();

  return COMMIT.test(commit)
    ? { ok: true, head: commit }
    : failed(`GitHub's answer for ${name}'s default branch was not a commit`);
};

const decoder = new TextDecoder();

/**
 * The commit HEAD is at in git's smart-HTTP ref advertisement (protocol v0), from its first bytes: the first ref line
 * follows the service announcement, and is HEAD's when the repo has one, else `capabilities^{}` on an empty repo.
 * Undefined while `bytes` stop short of that line.
 */
const advertisedHead = (bytes: Uint8Array): string | null | undefined => {
  for (let at = 0; at + 4 <= bytes.length;) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);

    if (!Number.isInteger(length)) throw new Error("not git's ref advertisement");

    // A flush packet (0000) ends the service announcement.
    if (length < 4) {
      at += 4;
      continue;
    }

    if (at + length > bytes.length) return undefined;

    const line = decoder.decode(bytes.subarray(at + 4, at + length)).split("\0")[0] ?? "";

    at += length;

    if (line.startsWith("#")) continue;

    const [commit = "", ref = ""] = line.trimEnd().split(" ");

    return ref === "HEAD" && COMMIT.test(commit) && !NO_COMMIT.test(commit) ? commit : null;
  }

  return undefined;
};

/** The head of the default branch of the repo at `url`, a host other than GitHub, through git's smart HTTP. */
const smartHttpHead = async (options: RemoteHeadsOptions, url: string): Promise<Head> => {
  const base = url.replace(/\/+$/, "");
  let response: Response;

  try {
    response = await options.fetch(`${base}/info/refs?service=git-upload-pack`, {
      headers: { "user-agent": "git/cloudpid", accept: "*/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    return failed(`${url} could not be reached: ${messageOf(cause)}`);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);

    return failed(`${url} answered ${response.status} asking for its default branch`);
  }

  if (!(response.headers.get("content-type") ?? "").includes("x-git-upload-pack-advertisement")) {
    await response.body?.cancel().catch(() => undefined);

    return failed(`${url} does not speak git's smart HTTP`);
  }

  const reader = response.body?.getReader();

  if (reader === undefined) return failed(`${url} answered nothing`);

  try {
    let bytes = new Uint8Array(0);

    // Only the first lines matter, and a big repo's advertisement lists every ref: stop reading once they are in.
    for (;;) {
      const head = advertisedHead(bytes);

      if (head !== undefined) return { ok: true, head };

      const chunk = await reader.read();

      if (chunk.done) return { ok: true, head: null };

      const joined = new Uint8Array(bytes.length + chunk.value.length);

      joined.set(bytes);
      joined.set(chunk.value, bytes.length);
      bytes = joined;
    }
  } catch (cause) {
    return failed(`${url}'s answer could not be read: ${messageOf(cause)}`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

/** The `RemoteHeads` over GitHub's API and git's smart HTTP. */
export const remoteHeads =
  (options: RemoteHeadsOptions): RemoteHeads =>
  async (repos) => {
    const asked = await Promise.all(
      repos.map(async (repo): Promise<Head> => {
        const github = githubRepoOf(repo.url);

        try {
          return github === undefined
            ? await smartHttpHead(options, repo.url)
            : await githubHead(options, github);
        } catch (cause) {
          return failed(`${repo.url} could not be asked: ${messageOf(cause)}`);
        }
      }),
    );

    const heads: Record<string, string | null> = {};

    for (const [index, repo] of repos.entries()) {
      const head = asked[index];

      if (head === undefined || !head.ok) {
        return { ok: false, reason: head?.reason ?? `${repo.url} could not be asked` };
      }

      heads[repo.name] = head.head;
    }

    return { ok: true, heads };
  };
