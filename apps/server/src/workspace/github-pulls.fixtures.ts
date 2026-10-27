// GitHub answers recorded from ian-pascoe/cloudpid (the picker's GraphQL list, `gh api graphql`, and REST's
// `.../pulls/<n>`), cut to the fields the Workspace reads, plus the error bodies GitHub gives for a bad token (401), a
// repo the token cannot see and the rate limit (403, 429 and GraphQL's own). Nothing here is invented.
// @effect-diagnostics missedPipeableOpportunity:off preferEffectArray:off schemaSync:off
import * as Schema from "effect/Schema";

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

/**
 * `POST /graphql` with the list query for ian-pascoe/cloudpid (`pullRequests(states: OPEN, orderBy: UPDATED_AT desc)`), the
 * first two of the three open pull requests at the time, recorded with `gh api graphql`: the counts are on the nodes.
 */
export const GRAPHQL_LIST = {
  data: {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 269,
            title: "feat(diffs): This branch Comparison",
            isDraft: false,
            updatedAt: "2026-10-27T04:06:31Z",
            additions: 5113,
            deletions: 222,
            changedFiles: 47,
            headRefOid: "ac03094e5131bd68b6fbbac0da84fa71df89534e",
            headRefName: "feat/diffs-231-this-branch",
            baseRefName: "feat/diffs-230-reviews",
            author: { login: "ian-pascoe" },
            headRepository: { nameWithOwner: "ian-pascoe/cloudpid" },
          },
          {
            number: 267,
            title: "feat: Annotations and Reviews on Call diffs and Changes",
            isDraft: false,
            updatedAt: "2026-10-27T01:57:37Z",
            additions: 4499,
            deletions: 136,
            changedFiles: 48,
            headRefOid: "e6f5462329acc228c44e404bf333a63d837cfe77",
            headRefName: "feat/diffs-230-reviews",
            baseRefName: "main",
            author: { login: "ian-pascoe" },
            headRepository: { nameWithOwner: "ian-pascoe/cloudpid" },
          },
        ],
      },
    },
  },
} as const;

/**
 * `POST /graphql` for a repo the token cannot see (recorded for a repo that does not exist; a private one answers the same,
 * with a 200 and no 404).
 */
export const GRAPHQL_NOT_FOUND = {
  data: { repository: null },
  errors: [
    {
      type: "NOT_FOUND",
      path: ["repository"],
      locations: [{ line: 1, column: 7 }],
      message: "Could not resolve to a Repository with the name 'ian-pascoe/does-not-exist-zzz'.",
    },
  ],
} as const;

/**
 * `POST /graphql` with the branches query for ian-pascoe/cloudpid (`refs(refPrefix: "refs/heads/", first: 3)`), its first
 * page, recorded with `gh api graphql`: GitHub orders the branches by name, not by date.
 */
export const GRAPHQL_BRANCHES_PAGE_1 = {
  data: {
    repository: {
      defaultBranchRef: { name: "main" },
      refs: {
        pageInfo: { hasNextPage: true, endCursor: "Mw" },
        nodes: [
          {
            name: "cloudpid/subagent-pages-server",
            target: { committedDate: "2026-10-27T01:16:01Z" },
          },
          {
            name: "cloudpid/subagent-pages-web",
            target: { committedDate: "2026-10-27T01:21:34Z" },
          },
          { name: "main", target: { committedDate: "2026-10-27T11:13:23Z" } },
        ],
      },
    },
  },
} as const;

/** The page after `GRAPHQL_BRANCHES_PAGE_1` (`after: "Mw"`), recorded the same way. */
export const GRAPHQL_BRANCHES_PAGE_2 = {
  data: {
    repository: {
      defaultBranchRef: { name: "main" },
      refs: {
        pageInfo: { hasNextPage: true, endCursor: "Ng" },
        nodes: [
          { name: "prototype/diff-pane", target: { committedDate: "2026-10-26T13:08:24Z" } },
          {
            name: "research/changes-without-container",
            target: { committedDate: "2026-10-21T17:26:02Z" },
          },
          {
            name: "research/comparison-in-container",
            target: { committedDate: "2026-10-21T17:22:00Z" },
          },
        ],
      },
    },
  },
} as const;

/** GraphQL's own rate limit, as GitHub documents it: a 200 with a `RATE_LIMITED` error. */
export const GRAPHQL_RATE_LIMITED = {
  errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }],
} as const;

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

/** The fields of a single pull request's REST JSON (as the tests' stubs make it) that GraphQL's list node has too. */
const RestPull = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  draft: Schema.Boolean,
  updated_at: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  changed_files: Schema.Finite,
  user: Schema.Struct({ login: Schema.String }),
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.Struct({ full_name: Schema.String }),
  }),
  base: Schema.Struct({ ref: Schema.String }),
});

/** GraphQL's answer to the list query for `pulls`, given as REST's single-pull JSON (what a test stub keeps). */
export const graphqlList = (pulls: readonly JsonObject[]): JsonObject => ({
  data: {
    repository: {
      pullRequests: {
        nodes: pulls.map((json) => {
          const pull = Schema.decodeUnknownSync(RestPull)(json);

          return {
            number: pull.number,
            title: pull.title,
            isDraft: pull.draft,
            updatedAt: pull.updated_at,
            additions: pull.additions,
            deletions: pull.deletions,
            changedFiles: pull.changed_files,
            headRefOid: pull.head.sha,
            headRefName: pull.head.ref,
            baseRefName: pull.base.ref,
            author: { login: pull.user.login },
            headRepository: { nameWithOwner: pull.head.repo.full_name },
          };
        }),
      },
    },
  },
});

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
