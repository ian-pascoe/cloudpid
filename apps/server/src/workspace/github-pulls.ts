// GitHub's API for pull requests (docs/spec.md → Diffs and review → Comparisons): the open pull requests of a repo for the
// Diff pane's picker (one GraphQL query, counts and heads included), one pull request's state and head for a Comparison
// (REST), and the base of a branch's open pull request (REST). The Workspace DO asks with a GitHub token from the GitHub
// App (ADR-0025), and again with a new one when GitHub refuses it with a 401; opening the picker never starts the
// Container. A list is kept for 60 s per repo, and a failure for a few seconds, so a refused or rate-limited token is
// not asked again on every call. The main Worker asks the same client for a repo's branches,
// for the draft's Start from menu (`docs/spec.md` → Session list → New session), kept the same way.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off globalFetch:off missedPipeableOpportunity:off
import {
  branchProblem,
  MAX_PULLS,
  MAX_REPO_BRANCHES,
  type RemoteBranch,
  type PullList,
  type PullListErrorKind,
  type PullRequest,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { GitHubTokens } from "../github/app.ts";

/** How long a repo's list is kept before the next picker opening asks GitHub again. */
export const PULLS_CACHE_MS = 60_000;

/** How long a failed request is remembered: the same request inside it is answered with the same failure. */
export const ERRORS_CACHE_MS = 15_000;

/** The longest a rate limit is waited out, whatever GitHub says. */
const MAX_LIMIT_MS = 300_000;

/** How long one GitHub request is waited for. */
const REQUEST_TIMEOUT_MS = 8_000;

/** A repo on GitHub, from a remote's URL. */
export type GitHubRepo = { readonly owner: string; readonly name: string };

const GITHUB_URL =
  /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;

/** The GitHub repo a remote URL names, or undefined for another host. */
export const githubRepoOf = (url: string): GitHubRepo | undefined => {
  const match = GITHUB_URL.exec(url.trim());

  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], name: match[2] };
};

/** How many branches one request of a repo's asks for: GraphQL's most. */
const BRANCH_PAGE = 100;

/**
 * How many pages of a repo's branches are read. GitHub cannot order branches by their commits' dates (it orders them
 * by name), so the most recent are found among the first `BRANCH_PAGE * BRANCH_PAGES` and sorted here.
 */
const BRANCH_PAGES = 3;

/** A page of a repo's branches, with its default branch and each branch's head commit date. */
const BRANCHES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { ... on Commit { committedDate } } }
    }
  }
}`;

/** The open pull requests of a repo, most recently updated first, with everything the picker shows. */
const LIST_QUERY = `query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title isDraft updatedAt additions deletions changedFiles
        headRefOid headRefName baseRefName
        author { login }
        headRepository { nameWithOwner }
      }
    }
  }
}`;

const ListedPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  isDraft: Schema.Boolean,
  updatedAt: Schema.String,
  additions: Schema.NullOr(Schema.Int),
  deletions: Schema.NullOr(Schema.Int),
  changedFiles: Schema.NullOr(Schema.Int),
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  headRepository: Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String })),
});

/** What GraphQL answers: the data, or errors (a repo the token cannot see is a 200 with `NOT_FOUND`). */
const ListAnswer = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequests: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(ListedPull)) }),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

/** What GraphQL answers for a page of branches. */
const BranchesAnswer = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
            refs: Schema.NullOr(
              Schema.Struct({
                pageInfo: Schema.Struct({
                  hasNextPage: Schema.Boolean,
                  endCursor: Schema.NullOr(Schema.String),
                }),
                nodes: Schema.Array(
                  Schema.NullOr(
                    Schema.Struct({
                      name: Schema.String,
                      // A branch's head is a commit; anything else has no date.
                      target: Schema.NullOr(
                        Schema.Struct({ committedDate: Schema.optionalKey(Schema.String) }),
                      ),
                    }),
                  ),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

/** `GET /repos/{owner}/{repo}/pulls/{n}`, which carries the state, head and base, and whether it was merged. */
const SinglePull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  updated_at: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
  merged: Schema.optionalKey(Schema.Boolean),
  additions: Schema.optionalKey(Schema.Int),
  deletions: Schema.optionalKey(Schema.Int),
  changed_files: Schema.optionalKey(Schema.Int),
});

/** `GET /repos/{owner}/{repo}/pulls?head=…`: only the base of each is read. */
const BaseOfPulls = Schema.Array(Schema.Struct({ base: Schema.Struct({ ref: Schema.String }) }));

const decodeListAnswer = Schema.decodeUnknownOption(ListAnswer);
const decodeBranchesAnswer = Schema.decodeUnknownOption(BranchesAnswer);
const decodeSingle = Schema.decodeUnknownOption(SinglePull);
const decodeBases = Schema.decodeUnknownOption(BaseOfPulls);

/** What GitHub gave of one pull request, in the shape the Workspace uses. */
export type GithubPull = {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly draft: boolean;
  readonly state: "open" | "closed" | "merged";
  readonly head: string;
  readonly headRef: string;
  /** The head repo's `owner/name`; null when its fork was deleted. */
  readonly headRepo: string | null;
  readonly base: string;
  readonly updatedAt: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changedFiles: number | null;
};

/** Why GitHub gave no answer: the token was refused, or anything else (the rate limit and a missing pull request too). */
export type GithubProblem = {
  readonly kind: "refused" | "failed";
  readonly message: string;
};

export type GithubResult<A> =
  | { readonly status: "ok"; readonly value: A }
  | ({ readonly status: "error" } & GithubProblem);

/** A repo's branches: its default branch, and the most recently committed to first, at most `MAX_REPO_BRANCHES`. */
export type GithubBranches = {
  readonly defaultBranch: string | null;
  readonly branches: readonly RemoteBranch[];
};

/** The ms of an ISO date GitHub gave, or null. */
const dateOf = (date: string | undefined): number | null => {
  const at = date === undefined ? Number.NaN : Date.parse(date);

  return Number.isFinite(at) ? at : null;
};

/** Newest first; a branch without a date after those with one, then by name. */
const byRecency = (a: RemoteBranch, b: RemoteBranch): number =>
  (b.committedAt ?? -Infinity) - (a.committedAt ?? -Infinity) || a.name.localeCompare(b.name);

export type GithubOptions = {
  /** GitHub's API; a test Worker replaces it. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Where the GitHub tokens come from (the GitHub App, a token for the installation on the repo's owner), told of one
   * GitHub refused; absent, GitHub is asked without one (public repos only, REST alone).
   */
  readonly github: Pick<GitHubTokens, "token" | "invalidate"> | undefined;
  /** The time in ms: the 60 s the list is kept, and how long a failure is, are counted by it. */
  readonly now: () => number;
  readonly warn: (message: string) => void;
};

/** What the picker says when GitHub refuses the token (401, 403, or a repo it cannot see). */
export const REFUSED_MESSAGE = "GitHub refused the token";

/** What is said when GitHub's rate limit is used up (primary or secondary: a 403 or 429 with a wait, or GraphQL's own). */
export const RATE_LIMITED_MESSAGE = "GitHub's rate limit is used up";

/** What is said of a 404 on a single pull request or a branch's: there is none, or the token cannot see the repo. */
export const NOT_FOUND_MESSAGE =
  "GitHub has no such pull request, or the token cannot see the repo";

const stateOf = (state: string, merged: boolean | undefined): GithubPull["state"] =>
  state === "open" ? "open" : merged === true ? "merged" : "closed";

/** A repo's `owner/name`, as GitHub compares it (case does not matter). */
const fullName = (repo: GitHubRepo): string => `${repo.owner}/${repo.name}`;

/** A failure, and how long every request waits when it is the rate limit. */
type Failure = GithubProblem & { readonly limitMs?: number };

type Request = { readonly method?: "POST"; readonly body?: string };

export class GithubPulls {
  readonly #options: GithubOptions;
  readonly #lists = new Map<
    string,
    { readonly at: number; readonly pulls: readonly GithubPull[] }
  >();
  readonly #asking = new Map<string, Promise<GithubResult<readonly GithubPull[]>>>();
  readonly #branchLists = new Map<
    string,
    { readonly at: number; readonly branches: GithubBranches }
  >();
  readonly #askingBranches = new Map<string, Promise<GithubResult<GithubBranches>>>();
  /** Failures by request, for `ERRORS_CACHE_MS`. */
  readonly #failures = new Map<string, { readonly until: number; readonly failure: Failure }>();
  /** The rate limit holds every request until this time. */
  #limitedUntil = 0;

  constructor(options: GithubOptions) {
    this.#options = options;
  }

  /**
   * `url`, about `repo`, asked with a GitHub token for its owner: when GitHub refuses it with a 401, the token is
   * invalidated and the request made once more with a new one.
   */
  async #request(
    repo: GitHubRepo,
    url: string,
    request: Request,
  ): Promise<GithubResult<unknown> | Failure> {
    const github = this.#options.github;

    if (github === undefined) return this.#askOnce(url, request, undefined);

    for (let attempt = 1; ; attempt++) {
      let token: string;

      try {
        token = await github.token(repo.owner);
      } catch (cause) {
        return {
          kind: "failed",
          message: `No GitHub token: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      const answer = await this.#askOnce(url, request, token);

      if (!("unauthorized" in answer) || attempt > 1) return answer;

      github.invalidate(token);
    }
  }

  async #askOnce(
    url: string,
    request: Request,
    token: string | undefined,
  ): Promise<GithubResult<unknown> | (Failure & { readonly unauthorized?: true })> {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cloudpid",
    });

    if (token !== undefined && token !== "") headers.set("authorization", `Bearer ${token}`);

    if (request.body !== undefined) headers.set("content-type", "application/json");

    const init: RequestInit = {
      method: request.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    if (request.body !== undefined) init.body = request.body;

    let response: Response;

    try {
      response = await this.#options.fetch(url, init);
    } catch (cause) {
      return {
        kind: "failed",
        message: `GitHub could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waits = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : undefined;

      // The primary limit (no requests left) and the secondary one (a wait is asked, on a 403 or a 429) are not a refusal
      // of the token.
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" || waits !== undefined))
      ) {
        return { kind: "failed", message: RATE_LIMITED_MESSAGE, limitMs: waits ?? 60_000 };
      }

      if (response.status === 401) {
        return { kind: "refused", message: REFUSED_MESSAGE, unauthorized: true };
      }

      if (response.status === 403) return { kind: "refused", message: REFUSED_MESSAGE };

      return response.status === 404
        ? { kind: "failed", message: NOT_FOUND_MESSAGE }
        : { kind: "failed", message: `GitHub answered ${response.status}` };
    }

    try {
      return { status: "ok", value: await response.json() };
    } catch {
      return { kind: "failed", message: "GitHub's answer was not JSON" };
    }
  }

  /**
   * A request about `repo`, unless the rate limit holds it or the same one failed a moment ago; failures are
   * remembered.
   */
  async #send(
    repo: GitHubRepo,
    key: string,
    url: string,
    request: Request = {},
  ): Promise<GithubResult<unknown>> {
    const now = this.#options.now();

    if (now < this.#limitedUntil) {
      return { status: "error", kind: "failed", message: RATE_LIMITED_MESSAGE };
    }

    const remembered = this.#failures.get(key);

    if (remembered !== undefined && now < remembered.until) {
      return {
        status: "error",
        kind: remembered.failure.kind,
        message: remembered.failure.message,
      };
    }

    const answer = await this.#request(repo, url, request);

    if ("status" in answer) {
      this.#failures.delete(key);

      return answer;
    }

    const wait = answer.limitMs === undefined ? 0 : Math.min(answer.limitMs, MAX_LIMIT_MS);
    const until = now + Math.max(wait, ERRORS_CACHE_MS);

    this.#failures.set(key, { until, failure: answer });

    if (answer.limitMs !== undefined) this.#limitedUntil = until;

    return { status: "error", kind: answer.kind, message: answer.message };
  }

  /** The numbers of the open pull requests the last list of `repo` held (however old); undefined before any. */
  lastOpen(repo: GitHubRepo): ReadonlySet<number> | undefined {
    const kept = this.#lists.get(fullName(repo).toLowerCase());

    return kept === undefined ? undefined : new Set(kept.pulls.map((pull) => pull.number));
  }

  /** One pull request of `repo`: its state, head and base (and counts, which a list has anyway). */
  async get(repo: GitHubRepo, number: number): Promise<GithubResult<GithubPull>> {
    const path = `/repos/${repo.owner}/${repo.name}/pulls/${number}`;
    const answer = await this.#send(repo, path, `https://api.github.com${path}`);

    if (answer.status === "error") return answer;

    const decoded = decodeSingle(answer.value);

    if (Option.isNone(decoded)) {
      return { status: "error", kind: "failed", message: "GitHub's answer was not a pull request" };
    }

    const single = decoded.value;
    const counted = single.additions !== undefined && single.deletions !== undefined;

    return {
      status: "ok",
      value: {
        number: single.number,
        title: single.title,
        author: single.user?.login ?? "ghost",
        draft: single.draft === true,
        state: stateOf(single.state, single.merged),
        head: single.head.sha,
        headRef: single.head.ref,
        headRepo: single.head.repo?.full_name ?? null,
        base: single.base.ref,
        updatedAt: single.updated_at,
        additions: counted ? (single.additions ?? null) : null,
        deletions: counted ? (single.deletions ?? null) : null,
        changedFiles: single.changed_files ?? null,
      },
    };
  }

  /**
   * The base branch of the open pull request whose head is `branch` of `repo` itself (so a stacked branch compares with
   * its parent); undefined when there is none.
   */
  async baseOf(repo: GitHubRepo, branch: string): Promise<GithubResult<string | undefined>> {
    const query = new URLSearchParams({
      state: "open",
      head: `${repo.owner}:${branch}`,
      per_page: "1",
    });

    const path = `/repos/${repo.owner}/${repo.name}/pulls?${query.toString()}`;
    const answer = await this.#send(repo, path, `https://api.github.com${path}`);

    if (answer.status === "error") return answer;

    const decoded = decodeBases(answer.value);

    if (Option.isNone(decoded)) {
      return {
        status: "error",
        kind: "failed",
        message: "GitHub's answer was not a list of pull requests",
      };
    }

    return { status: "ok", value: decoded.value[0]?.base.ref };
  }

  async #fetchList(repo: GitHubRepo): Promise<GithubResult<readonly GithubPull[]>> {
    const answer = await this.#send(
      repo,
      `graphql:${fullName(repo).toLowerCase()}`,
      "https://api.github.com/graphql",
      {
        method: "POST",
        body: JSON.stringify({
          query: LIST_QUERY,
          variables: { owner: repo.owner, name: repo.name, first: MAX_PULLS },
        }),
      },
    );

    if (answer.status === "error") return answer;

    const decoded = decodeListAnswer(answer.value);

    if (Option.isNone(decoded)) {
      return {
        status: "error",
        kind: "failed",
        message: "GitHub's answer was not a list of pull requests",
      };
    }

    const { data, errors } = decoded.value;
    const repository = data?.repository;

    if (repository === undefined || repository === null) {
      return this.#noRepository(errors, "a list of pull requests");
    }

    return {
      status: "ok",
      value: repository.pullRequests.nodes.flatMap((node) =>
        node === null
          ? []
          : [
              {
                number: node.number,
                title: node.title,
                author: node.author?.login ?? "ghost",
                draft: node.isDraft,
                state: "open" as const,
                head: node.headRefOid,
                headRef: node.headRefName,
                headRepo: node.headRepository?.nameWithOwner ?? null,
                base: node.baseRefName,
                updatedAt: node.updatedAt,
                additions: node.additions,
                deletions: node.deletions,
                changedFiles: node.changedFiles,
              },
            ],
      ),
    };
  }

  /** A GraphQL answer's reason for having no repository, as a failure. */
  #noRepository(
    errors: ReadonlyArray<{ readonly type?: string; readonly message?: string }> | undefined,
    what: string,
  ): { readonly status: "error" } & GithubProblem {
    // A repo the token cannot see is a `NOT_FOUND` here, with no 404.
    if (errors?.some((error) => error.type === "NOT_FOUND") === true) {
      return { status: "error", kind: "refused", message: REFUSED_MESSAGE };
    }

    if (errors?.some((error) => error.type === "RATE_LIMITED") === true) {
      this.#limitedUntil = this.#options.now() + 60_000;

      return { status: "error", kind: "failed", message: RATE_LIMITED_MESSAGE };
    }

    return {
      status: "error",
      kind: "failed",
      message: errors?.[0]?.message ?? `GitHub's answer was not ${what}`,
    };
  }

  async #fetchBranches(repo: GitHubRepo): Promise<GithubResult<GithubBranches>> {
    const key = fullName(repo).toLowerCase();
    const found: RemoteBranch[] = [];
    let defaultBranch: string | null = null;
    let after: string | null = null;

    // The most recent, with the default branch kept in place of the last when it is older than all of them.
    const listed = (): GithubResult<GithubBranches> => {
      const recent = found.sort(byRecency).slice(0, MAX_REPO_BRANCHES);
      const kept = found.find((branch) => branch.name === defaultBranch);

      if (kept !== undefined && !recent.includes(kept)) recent.splice(-1, 1, kept);

      return { status: "ok", value: { defaultBranch, branches: recent } };
    };

    for (let page = 0; page < BRANCH_PAGES; page += 1) {
      const answer = await this.#send(
        repo,
        `graphql:branches:${key}:${after ?? ""}`,
        "https://api.github.com/graphql",
        {
          method: "POST",
          body: JSON.stringify({
            query: BRANCHES_QUERY,
            variables: { owner: repo.owner, name: repo.name, first: BRANCH_PAGE, after },
          }),
        },
      );

      // A later page that fails leaves the pages read before it.
      if (answer.status === "error") return page === 0 ? answer : listed();

      const decoded = decodeBranchesAnswer(answer.value);

      if (Option.isNone(decoded)) {
        return page === 0
          ? {
              status: "error",
              kind: "failed",
              message: "GitHub's answer was not a list of branches",
            }
          : listed();
      }

      const repository = decoded.value.data?.repository;

      if (repository === undefined || repository === null) {
        return page === 0
          ? this.#noRepository(decoded.value.errors, "a list of branches")
          : listed();
      }

      defaultBranch = repository.defaultBranchRef?.name ?? null;

      for (const node of repository.refs?.nodes ?? []) {
        // Only a name a new Workspace may start from is offered.
        if (node !== null && branchProblem(node.name) === undefined) {
          found.push({ name: node.name, committedAt: dateOf(node.target?.committedDate) });
        }
      }

      const pageInfo = repository.refs?.pageInfo;

      if (pageInfo?.hasNextPage !== true || pageInfo.endCursor === null) break;

      after = pageInfo.endCursor;
    }

    return listed();
  }

  /**
   * The branches of `repo`, most recently committed to first, with its default branch: from GitHub when the last list is
   * over 60 s old (or there is none), else the kept one. At most `MAX_REPO_BRANCHES`, the default branch always among
   * them; a repo with more than GitHub's few pages has the most recent of those pages (ordered by name), and one whose
   * later page failed has those read before it.
   */
  async branches(repo: GitHubRepo): Promise<GithubResult<GithubBranches>> {
    const key = fullName(repo).toLowerCase();
    const kept = this.#branchLists.get(key);
    const now = this.#options.now();

    if (kept !== undefined && now - kept.at >= 0 && now - kept.at < PULLS_CACHE_MS) {
      return { status: "ok", value: kept.branches };
    }

    // Two drafts at once ask GitHub once.
    const running = this.#askingBranches.get(key) ?? this.#fetchBranches(repo);

    this.#askingBranches.set(key, running);

    try {
      const result = await running;

      if (result.status === "ok") this.#branchLists.set(key, { at: now, branches: result.value });

      return result;
    } finally {
      if (this.#askingBranches.get(key) === running) this.#askingBranches.delete(key);
    }
  }

  /**
   * The open pull requests of `repo`, most recently updated first, up to 50 (so a repo with more has the 50 latest, and
   * only those count as open here): from GitHub when the last list is over 60 s old (or there is none), else the kept one.
   * `branch` marks the pull request of the repo's current branch.
   */
  async list(repo: GitHubRepo, branch: string | null): Promise<PullList> {
    const key = fullName(repo).toLowerCase();
    const kept = this.#lists.get(key);
    const now = this.#options.now();

    let pulls: readonly GithubPull[];
    let fetchedAt: number;

    if (kept !== undefined && now - kept.at >= 0 && now - kept.at < PULLS_CACHE_MS) {
      pulls = kept.pulls;
      fetchedAt = kept.at;
    } else {
      // Two openings at once ask GitHub once.
      const running = this.#asking.get(key) ?? this.#fetchList(repo);

      this.#asking.set(key, running);

      let result: GithubResult<readonly GithubPull[]>;

      try {
        result = await running;
      } finally {
        if (this.#asking.get(key) === running) this.#asking.delete(key);
      }

      if (result.status === "error") return problem(result.kind, result.message);

      pulls = result.value;
      fetchedAt = now;
      this.#lists.set(key, { at: fetchedAt, pulls });
    }

    return {
      status: "ok",
      fetchedAt,
      pulls: pulls.map((pull) => requestOf(pull, repo, branch)),
    };
  }
}

const problem = (kind: PullListErrorKind, message: string): PullList => ({
  status: "error",
  kind,
  message,
});

/** `pull` as the picker lists it; `thisBranch` when it is the pull request of `branch` (from a branch of the repo itself). */
const requestOf = (pull: GithubPull, repo: GitHubRepo, branch: string | null): PullRequest => {
  const request: PullRequest = {
    number: pull.number,
    title: pull.title,
    author: pull.author,
    draft: pull.draft,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changedFiles,
    head: pull.head,
    headRef: pull.headRef,
    base: pull.base,
    updatedAt: pull.updatedAt,
  };

  return branch !== null &&
    pull.headRef === branch &&
    pull.headRepo?.toLowerCase() === fullName(repo).toLowerCase()
    ? { ...request, thisBranch: true }
    : request;
};
