// GitHub's REST API for pull requests (docs/spec.md → Diffs and review → Comparisons): the open pull requests of a repo
// for the Diff pane's picker, and one pull request's state and head for a Comparison. The Workspace DO asks with
// `CLOUDPID_GITHUB_TOKEN`; opening the picker never starts the Container. A list is kept for 60 s per repo, and the
// counts GitHub gives only on a single pull request (`additions`, `deletions`, `changed_files`) are kept by the head they
// were read at, so a repo's list costs one request plus one per pull request whose head is new.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off globalFetch:off
import {
  MAX_PULLS,
  type PullList,
  type PullListErrorKind,
  type PullRequest,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** How long a repo's list is kept before the next picker opening asks GitHub again. */
export const PULLS_CACHE_MS = 60_000;

/** How long one GitHub request is waited for. */
const REQUEST_TIMEOUT_MS = 8_000;

/** How many single-pull-request requests run at once when a list needs the counts of several. */
const DETAIL_CONCURRENCY = 6;

/** The most pull requests' counts kept in memory. */
const MAX_KEPT_DETAILS = 1_000;

/** A repo on GitHub, from a remote's URL. */
export type GitHubRepo = { readonly owner: string; readonly name: string };

const Repo = Schema.NullOr(Schema.Struct({ full_name: Schema.String }));

/** The fields of a pull request both GitHub endpoints give. */
const PullFields = {
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  updated_at: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  head: Schema.Struct({ sha: Schema.String, ref: Schema.String, repo: Repo }),
  base: Schema.Struct({ ref: Schema.String }),
};

const ListedPull = Schema.Struct(PullFields);

/** `GET /repos/{owner}/{repo}/pulls/{n}`, which also carries the counts and whether it was merged. */
const SinglePull = Schema.Struct({
  ...PullFields,
  merged: Schema.optionalKey(Schema.Boolean),
  additions: Schema.optionalKey(Schema.Int),
  deletions: Schema.optionalKey(Schema.Int),
  changed_files: Schema.optionalKey(Schema.Int),
});

const decodeList = Schema.decodeUnknownOption(Schema.Array(ListedPull));
const decodeSingle = Schema.decodeUnknownOption(SinglePull);

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

/** Why GitHub gave no answer: the token was refused, or anything else. */
export type GithubProblem = {
  readonly kind: "refused" | "failed";
  readonly message: string;
};

export type GithubResult<A> =
  | { readonly status: "ok"; readonly value: A }
  | ({ readonly status: "error" } & GithubProblem);

export type GithubOptions = {
  /** GitHub's REST API; a test Worker replaces it. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The GitHub token (`CLOUDPID_GITHUB_TOKEN`); absent, the API is asked without one (public repos only). */
  readonly token: () => string | undefined;
  /** The time in ms: the 60 s the list is kept is counted by it. */
  readonly now: () => number;
  readonly warn: (message: string) => void;
};

/** What the picker says when GitHub refuses the token (401, 403, or 404 for a private repo). */
export const REFUSED_MESSAGE = "GitHub refused the token";

/** Whether `problem` is a refusal of the token. */
const refusal = (status: number): boolean => status === 401 || status === 403 || status === 404;

const stateOf = (state: string, merged: boolean | undefined): GithubPull["state"] =>
  state === "open" ? "open" : merged === true ? "merged" : "closed";

type Counts = Pick<GithubPull, "additions" | "deletions" | "changedFiles">;

const NO_COUNTS: Counts = { additions: null, deletions: null, changedFiles: null };

/** A repo's `owner/name`, as GitHub compares it (case does not matter). */
const fullName = (repo: GitHubRepo): string => `${repo.owner}/${repo.name}`;

export class GithubPulls {
  readonly #options: GithubOptions;
  readonly #lists = new Map<
    string,
    { readonly at: number; readonly pulls: readonly GithubPull[] }
  >();
  readonly #asking = new Map<string, Promise<GithubResult<readonly GithubPull[]>>>();
  /** The counts of pull requests by `repo#number@head`: a head's counts do not change. */
  readonly #counts = new Map<string, Counts>();

  constructor(options: GithubOptions) {
    this.#options = options;
  }

  async #get(path: string): Promise<GithubResult<unknown>> {
    const token = this.#options.token();

    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cloudpid",
    });

    if (token !== undefined && token !== "") headers.set("authorization", `Bearer ${token}`);

    let response: Response;

    try {
      response = await this.#options.fetch(`https://api.github.com${path}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      return {
        status: "error",
        kind: "failed",
        message: `GitHub could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    if (!response.ok) {
      // A 403 with no requests left is the rate limit, not a refusal of the token.
      if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
        return { status: "error", kind: "failed", message: "GitHub's rate limit is used up" };
      }

      return refusal(response.status)
        ? { status: "error", kind: "refused", message: REFUSED_MESSAGE }
        : { status: "error", kind: "failed", message: `GitHub answered ${response.status}` };
    }

    try {
      return { status: "ok", value: await response.json() };
    } catch {
      return { status: "error", kind: "failed", message: "GitHub's answer was not JSON" };
    }
  }

  #pullOf(
    pull: typeof ListedPull.Type | typeof SinglePull.Type,
    counts: Counts,
    merged: boolean | undefined,
  ): GithubPull {
    return {
      number: pull.number,
      title: pull.title,
      author: pull.user?.login ?? "ghost",
      draft: pull.draft === true,
      state: stateOf(pull.state, merged),
      head: pull.head.sha,
      headRef: pull.head.ref,
      headRepo: pull.head.repo?.full_name ?? null,
      base: pull.base.ref,
      updatedAt: pull.updated_at,
      ...counts,
    };
  }

  #countsKey(repo: GitHubRepo, pull: { number: number; head: string }): string {
    return `${fullName(repo).toLowerCase()}#${pull.number}@${pull.head}`;
  }

  #keepCounts(key: string, counts: Counts): void {
    this.#counts.delete(key);
    this.#counts.set(key, counts);

    for (const old of this.#counts.keys()) {
      if (this.#counts.size <= MAX_KEPT_DETAILS) break;

      this.#counts.delete(old);
    }
  }

  /** The numbers of the open pull requests the last list of `repo` held (however old); undefined before any. */
  lastOpen(repo: GitHubRepo): ReadonlySet<number> | undefined {
    const kept = this.#lists.get(fullName(repo).toLowerCase());

    return kept === undefined ? undefined : new Set(kept.pulls.map((pull) => pull.number));
  }

  /** One pull request of `repo`: its state, head, and counts. */
  async get(repo: GitHubRepo, number: number): Promise<GithubResult<GithubPull>> {
    const answer = await this.#get(`/repos/${repo.owner}/${repo.name}/pulls/${number}`);

    if (answer.status === "error") return answer;

    const decoded = decodeSingle(answer.value);

    if (Option.isNone(decoded)) {
      return { status: "error", kind: "failed", message: "GitHub's answer was not a pull request" };
    }

    const single = decoded.value;

    const counts: Counts =
      single.additions === undefined ||
      single.deletions === undefined ||
      single.changed_files === undefined
        ? NO_COUNTS
        : {
            additions: single.additions,
            deletions: single.deletions,
            changedFiles: single.changed_files,
          };

    const pull = this.#pullOf(single, counts, single.merged);

    if (counts.additions !== null) this.#keepCounts(this.#countsKey(repo, pull), counts);

    return { status: "ok", value: pull };
  }

  /** Fill in the counts of `pulls`, a few requests at a time; one that fails keeps none. */
  async #withCounts(repo: GitHubRepo, pulls: readonly GithubPull[]): Promise<GithubPull[]> {
    const filled = [...pulls];
    let next = 0;

    const worker = async () => {
      for (;;) {
        const at = next;

        next += 1;

        const pull = filled[at];

        if (pull === undefined) return;

        const key = this.#countsKey(repo, pull);
        const known = this.#counts.get(key);

        if (known !== undefined) {
          filled[at] = { ...pull, ...known };
          continue;
        }

        const single = await this.get(repo, pull.number);

        if (single.status === "ok") {
          // The pull request may have moved on since the list: its counts are those of the head they were read at, and
          // a list shows the head it listed.
          if (single.value.head === pull.head) {
            const { additions, deletions, changedFiles } = single.value;

            filled[at] = { ...pull, additions, deletions, changedFiles };
          }
        } else {
          this.#options.warn(`pulls: counts of #${pull.number} failed: ${single.message}`);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(DETAIL_CONCURRENCY, pulls.length) }, () => worker()),
    );

    return filled;
  }

  async #fetchList(repo: GitHubRepo): Promise<GithubResult<readonly GithubPull[]>> {
    const query = new URLSearchParams({
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: String(MAX_PULLS),
    });

    const answer = await this.#get(`/repos/${repo.owner}/${repo.name}/pulls?${query.toString()}`);

    if (answer.status === "error") return answer;

    const decoded = decodeList(answer.value);

    if (Option.isNone(decoded)) {
      return {
        status: "error",
        kind: "failed",
        message: "GitHub's answer was not a list of pull requests",
      };
    }

    const listed = decoded.value
      .slice(0, MAX_PULLS)
      .map((pull) => this.#pullOf(pull, NO_COUNTS, undefined));

    return { status: "ok", value: await this.#withCounts(repo, listed) };
  }

  /**
   * The open pull requests of `repo`, most recently updated first, up to 50: from GitHub when the last list is over 60 s
   * old (or there is none), else the kept one. `branch` marks the pull request of the repo's current branch.
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
