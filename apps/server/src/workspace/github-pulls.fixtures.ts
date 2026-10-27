// GitHub REST answers recorded from ian-pascoe/cloudpid (`gh api repos/ian-pascoe/cloudpid/pulls?state=open&sort=updated
// &direction=desc&per_page=50` and `.../pulls/<n>`), cut to the fields the Workspace reads, plus the error bodies GitHub
// gives for a bad token (401), a repo the token cannot see (404) and the rate limit (403). Nothing here is invented: the
// list endpoint carries no `additions`, `deletions` or `changed_files`, which only a single pull request does.

/** Any JSON value, which is what a stubbed GitHub answers with. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: Json;
}

/** The answers of a stubbed GitHub, by request path. */
export type Answers = Readonly<Record<string, Json>>;

/** `GET /repos/ian-pascoe/cloudpid/pulls?state=open&sort=updated&direction=desc&per_page=50`. */
export const LIST_OPEN = [
  {
    number: 269,
    title: "feat(diffs): This branch Comparison",
    state: "open",
    draft: false,
    updated_at: "2026-10-27T04:06:31Z",
    user: { login: "ian-pascoe" },
    head: {
      sha: "ac03094e5131bd68b6fbbac0da84fa71df89534e",
      ref: "feat/diffs-231-this-branch",
      repo: { full_name: "ian-pascoe/cloudpid" },
    },
    base: { ref: "feat/diffs-230-reviews", repo: { full_name: "ian-pascoe/cloudpid" } },
  },
  {
    number: 267,
    title: "feat: Annotations and Reviews on Call diffs and Changes",
    state: "open",
    draft: false,
    updated_at: "2026-10-27T01:57:37Z",
    user: { login: "ian-pascoe" },
    head: {
      sha: "e6f5462329acc228c44e404bf333a63d837cfe77",
      ref: "feat/diffs-230-reviews",
      repo: { full_name: "ian-pascoe/cloudpid" },
    },
    base: { ref: "main", repo: { full_name: "ian-pascoe/cloudpid" } },
  },
] as const;

/** `GET /repos/ian-pascoe/cloudpid/pulls/269`. */
export const SINGLE_269 = {
  number: 269,
  title: "feat(diffs): This branch Comparison",
  state: "open",
  draft: false,
  merged: false,
  additions: 5113,
  deletions: 222,
  changed_files: 47,
  updated_at: "2026-10-27T04:06:31Z",
  user: { login: "ian-pascoe" },
  head: {
    sha: "ac03094e5131bd68b6fbbac0da84fa71df89534e",
    ref: "feat/diffs-231-this-branch",
    repo: { full_name: "ian-pascoe/cloudpid" },
  },
  base: { ref: "feat/diffs-230-reviews", repo: { full_name: "ian-pascoe/cloudpid" } },
} as const;

/** `GET /repos/ian-pascoe/cloudpid/pulls/267`. */
export const SINGLE_267 = {
  number: 267,
  title: "feat: Annotations and Reviews on Call diffs and Changes",
  state: "open",
  draft: false,
  merged: false,
  additions: 4499,
  deletions: 136,
  changed_files: 48,
  updated_at: "2026-10-27T01:57:37Z",
  user: { login: "ian-pascoe" },
  head: {
    sha: "e6f5462329acc228c44e404bf333a63d837cfe77",
    ref: "feat/diffs-230-reviews",
    repo: { full_name: "ian-pascoe/cloudpid" },
  },
  base: { ref: "main", repo: { full_name: "ian-pascoe/cloudpid" } },
} as const;

/** `GET /repos/ian-pascoe/cloudpid/pulls/246`, a merged pull request. */
export const SINGLE_246_MERGED = {
  number: 246,
  title: "feat(web): diff rendering and edit's Call diff",
  state: "closed",
  draft: false,
  merged: true,
  additions: 948,
  deletions: 144,
  changed_files: 15,
  updated_at: "2026-10-26T18:11:23Z",
  user: { login: "ian-pascoe" },
  head: {
    sha: "d302e84ffe941f26c1f3e268e5e3ede734277ed8",
    ref: "feat/diffs-226-call-diff",
    repo: { full_name: "ian-pascoe/cloudpid" },
  },
  base: { ref: "main", repo: { full_name: "ian-pascoe/cloudpid" } },
} as const;

/** A request with a bad token: 401. */
export const BAD_CREDENTIALS = {
  message: "Bad credentials",
  documentation_url: "https://docs.github.com/rest",
  status: "401",
} as const;

/** A repo the token cannot see (GitHub answers 404 for a private repo, never 403): 404. */
export const NOT_FOUND = {
  message: "Not Found",
  documentation_url: "https://docs.github.com/rest/pulls/pulls#list-pull-requests",
  status: "404",
} as const;

/** A token without the access, or a blocked one: 403. */
export const FORBIDDEN = {
  message: "Resource not accessible by personal access token",
  documentation_url: "https://docs.github.com/rest/pulls/pulls#list-pull-requests",
  status: "403",
} as const;

/** The rate limit: 403 with `x-ratelimit-remaining: 0`. */
export const RATE_LIMITED = {
  message: "API rate limit exceeded for user ID 1.",
  documentation_url:
    "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
  status: "403",
} as const;
