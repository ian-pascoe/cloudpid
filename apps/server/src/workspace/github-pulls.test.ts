// The GitHub client for pull requests, over recorded responses (`github-pulls.fixtures.ts`): the list in one GraphQL
// request, the 60 s it is kept, the refusals (401, 403, and a repo the token cannot see), the rate limits, and how long a
// failure is remembered.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalFetch:off
import { describe, expect, it } from "vitest";
import {
  type Json,
  BAD_CREDENTIALS,
  FORBIDDEN,
  GRAPHQL_LIST,
  GRAPHQL_NOT_FOUND,
  GRAPHQL_RATE_LIMITED,
  NOT_FOUND,
  RATE_LIMITED,
  SINGLE_246_MERGED,
  SINGLE_269,
} from "./github-pulls.fixtures.ts";
import {
  ERRORS_CACHE_MS,
  GithubPulls,
  NOT_FOUND_MESSAGE,
  PULLS_CACHE_MS,
  RATE_LIMITED_MESSAGE,
  REFUSED_MESSAGE,
} from "./github-pulls.ts";

const REPO = { owner: "ian-pascoe", name: "cloudpid" };

const json = (body: Json, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

type Call = {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string;
};

/** A client over a GitHub that answers `routes` by path, and records each request. */
const client = (routes: Record<string, () => Response>) => {
  const calls: Call[] = [];
  const clock = { now: 1_000_000 };

  const pulls = new GithubPulls({
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      const route = routes[`${pathname}${search}`] ?? routes[pathname];

      calls.push({
        method: init.method ?? "GET",
        url: `${pathname}${search}`,
        authorization: new Headers(init.headers).get("authorization"),
        body: await new Response(init.body).text(),
      });

      return route === undefined ? json(NOT_FOUND, 404) : route();
    },
    token: () => "ghp_secret",
    now: () => clock.now,
    warn: () => undefined,
  });

  return { pulls, calls, clock };
};

const GRAPHQL = "/graphql";
const OPEN_ROUTES = { [GRAPHQL]: () => json(GRAPHQL_LIST) };

describe("the open pull requests of a repo", () => {
  it("lists them most recently updated first in one request, counts and heads included, and marks the branch's own", async () => {
    const { pulls, calls } = client(OPEN_ROUTES);
    const list = await pulls.list(REPO, "feat/diffs-231-this-branch");

    expect(list).toEqual({
      status: "ok",
      fetchedAt: 1_000_000,
      pulls: [
        {
          number: 269,
          title: "feat(diffs): This branch Comparison",
          author: "ian-pascoe",
          draft: false,
          additions: 5113,
          deletions: 222,
          changedFiles: 47,
          head: "ac03094e5131bd68b6fbbac0da84fa71df89534e",
          headRef: "feat/diffs-231-this-branch",
          base: "feat/diffs-230-reviews",
          updatedAt: "2026-10-27T04:06:31Z",
          thisBranch: true,
        },
        {
          number: 267,
          title: "feat: Annotations and Reviews on Call diffs and Changes",
          author: "ian-pascoe",
          draft: false,
          additions: 4499,
          deletions: 136,
          changedFiles: 48,
          head: "e6f5462329acc228c44e404bf333a63d837cfe77",
          headRef: "feat/diffs-230-reviews",
          base: "main",
          updatedAt: "2026-10-27T01:57:37Z",
        },
      ],
    });

    // One request, however many pull requests: no request per pull request for its counts.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: GRAPHQL,
      authorization: "Bearer ghp_secret",
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      variables: { owner: "ian-pascoe", name: "cloudpid", first: 50 },
    });
  });

  it("marks no pull request when the branch is detached or from a fork of the same name", async () => {
    const node = GRAPHQL_LIST.data.repository.pullRequests.nodes[0];

    const { pulls } = client({
      [GRAPHQL]: () =>
        json({
          data: {
            repository: {
              pullRequests: {
                nodes: [{ ...node, headRepository: { nameWithOwner: "someone/cloudpid" } }],
              },
            },
          },
        }),
    });

    const detached = await pulls.list(REPO, null);
    const forked = await pulls.list(REPO, "feat/diffs-231-this-branch");

    expect(detached.status === "ok" && detached.pulls.some((pull) => pull.thisBranch)).toBe(false);
    expect(forked.status === "ok" && forked.pulls.some((pull) => pull.thisBranch)).toBe(false);
  });

  it("lists a pull request whose author or fork is gone, and one with no counts yet", async () => {
    const node = GRAPHQL_LIST.data.repository.pullRequests.nodes[0];

    const { pulls } = client({
      [GRAPHQL]: () =>
        json({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  null,
                  {
                    ...node,
                    author: null,
                    headRepository: null,
                    additions: null,
                    deletions: null,
                    changedFiles: null,
                  },
                ],
              },
            },
          },
        }),
    });

    const list = await pulls.list(REPO, "feat/diffs-231-this-branch");

    expect(list.status === "ok" && list.pulls).toMatchObject([
      { number: 269, author: "ghost", additions: null, deletions: null, changedFiles: null },
    ]);
    expect(list.status === "ok" && list.pulls[0]?.thisBranch).toBeUndefined();
  });

  it("keeps the list for 60 s: an opening inside it asks GitHub nothing, one after it asks again", async () => {
    const { pulls, calls, clock } = client(OPEN_ROUTES);

    await pulls.list(REPO, null);

    clock.now += PULLS_CACHE_MS - 1;

    const again = await pulls.list(REPO, null);

    expect(calls).toHaveLength(1);
    expect(again).toMatchObject({ status: "ok", fetchedAt: 1_000_000 });

    clock.now += 1;

    const later = await pulls.list(REPO, null);

    expect(calls).toHaveLength(2);
    expect(later).toMatchObject({ status: "ok", fetchedAt: 1_000_000 + PULLS_CACHE_MS });
  });

  it("asks GitHub once for two openings at the same time", async () => {
    const { pulls, calls } = client(OPEN_ROUTES);

    await Promise.all([pulls.list(REPO, null), pulls.list(REPO, null)]);

    expect(calls).toHaveLength(1);
  });

  it("remembers the open numbers of the last list, however old", async () => {
    const { pulls, clock } = client(OPEN_ROUTES);

    expect(pulls.lastOpen(REPO)).toBeUndefined();

    await pulls.list(REPO, null);
    clock.now += 10 * PULLS_CACHE_MS;
    expect(pulls.lastOpen(REPO)).toEqual(new Set([269, 267]));
  });

  it.each([
    ["a 401 (bad token)", () => json(BAD_CREDENTIALS, 401)],
    ["a 403", () => json(FORBIDDEN, 403)],
    ["a repo the token cannot see (GraphQL's NOT_FOUND)", () => json(GRAPHQL_NOT_FOUND)],
  ])("says GitHub refused the token on %s", async (_, answer) => {
    const { pulls } = client({ [GRAPHQL]: answer });

    expect(await pulls.list(REPO, null)).toEqual({
      status: "error",
      kind: "refused",
      message: REFUSED_MESSAGE,
    });
  });

  it.each([
    [
      "a 403 with no requests left",
      () => json(RATE_LIMITED, 403, { "x-ratelimit-remaining": "0" }),
    ],
    [
      "a secondary limit: a 403 with a wait",
      () => json(RATE_LIMITED, 403, { "retry-after": "30" }),
    ],
    ["a 429", () => json(RATE_LIMITED, 429)],
    ["GraphQL's own limit", () => json(GRAPHQL_RATE_LIMITED)],
  ])("does not take %s for a refused token", async (_, answer) => {
    const { pulls } = client({ [GRAPHQL]: answer });

    expect(await pulls.list(REPO, null)).toEqual({
      status: "error",
      kind: "failed",
      message: RATE_LIMITED_MESSAGE,
    });
  });

  it("remembers a failure for a few seconds, so a refused token is not asked on every call", async () => {
    let answer = () => json(BAD_CREDENTIALS, 401);

    const { pulls, calls, clock } = client({ [GRAPHQL]: () => answer() });

    expect(await pulls.list(REPO, null)).toMatchObject({ status: "error", kind: "refused" });
    clock.now += ERRORS_CACHE_MS - 1;
    expect(await pulls.list(REPO, null)).toMatchObject({ status: "error", kind: "refused" });
    expect(calls).toHaveLength(1);

    // After it GitHub is asked again, and a good answer is a list.
    answer = () => json(GRAPHQL_LIST);
    clock.now += 1;
    expect(await pulls.list(REPO, null)).toMatchObject({ status: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("holds every request while the rate limit lasts, as long as GitHub asked", async () => {
    const { pulls, calls, clock } = client({
      [GRAPHQL]: () => json(RATE_LIMITED, 403, { "retry-after": "120" }),
      "/repos/ian-pascoe/cloudpid/pulls/269": () => json(SINGLE_269),
    });

    await pulls.list(REPO, null);

    // Not the list and not another request, REST included, until the wait is over.
    clock.now += 119_000;
    expect(await pulls.get(REPO, 269)).toMatchObject({
      status: "error",
      message: RATE_LIMITED_MESSAGE,
    });
    expect(await pulls.list(REPO, null)).toMatchObject({ message: RATE_LIMITED_MESSAGE });
    expect(calls).toHaveLength(1);

    clock.now += 1_000;
    expect(await pulls.get(REPO, 269)).toMatchObject({ status: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("fails with GitHub's status on an error, and when it cannot be reached or answers something else", async () => {
    expect(await client({ [GRAPHQL]: () => json({}, 502) }).pulls.list(REPO, null)).toEqual({
      status: "error",
      kind: "failed",
      message: "GitHub answered 502",
    });

    expect(
      await client({ [GRAPHQL]: () => json({ not: "a list" }) }).pulls.list(REPO, null),
    ).toMatchObject({ status: "error", kind: "failed" });

    expect(
      await client({
        [GRAPHQL]: () => json({ errors: [{ message: "Something broke" }] }),
      }).pulls.list(REPO, null),
    ).toEqual({ status: "error", kind: "failed", message: "Something broke" });

    const down = new GithubPulls({
      fetch: () => Promise.reject(new Error("connection reset")),
      token: () => undefined,
      now: () => 0,
      warn: () => undefined,
    });

    expect(await down.list(REPO, null)).toEqual({
      status: "error",
      kind: "failed",
      message: "GitHub could not be reached: connection reset",
    });
  });
});

describe("one pull request", () => {
  it("reads an open one's head and counts, and a merged one as merged", async () => {
    const { pulls } = client({
      "/repos/ian-pascoe/cloudpid/pulls/269": () => json(SINGLE_269),
      "/repos/ian-pascoe/cloudpid/pulls/246": () => json(SINGLE_246_MERGED),
    });

    expect(await pulls.get(REPO, 269)).toMatchObject({
      status: "ok",
      value: { number: 269, state: "open", head: SINGLE_269.head.sha, additions: 5113 },
    });
    expect(await pulls.get(REPO, 246)).toMatchObject({
      status: "ok",
      value: { number: 246, state: "merged" },
    });
  });

  it("calls a closed one that was not merged closed", async () => {
    const { pulls } = client({
      "/repos/ian-pascoe/cloudpid/pulls/246": () => json({ ...SINGLE_246_MERGED, merged: false }),
    });

    expect(await pulls.get(REPO, 246)).toMatchObject({ status: "ok", value: { state: "closed" } });
  });

  it("does not take every 404 for a refusal: there may be no such pull request", async () => {
    const { pulls } = client({});

    expect(await pulls.get(REPO, 1)).toEqual({
      status: "error",
      kind: "failed",
      message: NOT_FOUND_MESSAGE,
    });
  });

  it.each([401, 403])("is refused on a %s", async (status) => {
    const { pulls } = client({
      "/repos/ian-pascoe/cloudpid/pulls/1": () =>
        json(status === 401 ? BAD_CREDENTIALS : FORBIDDEN, status),
    });

    expect(await pulls.get(REPO, 1)).toEqual({
      status: "error",
      kind: "refused",
      message: REFUSED_MESSAGE,
    });
  });
});

describe("the base of a branch's pull request", () => {
  const URL_OF =
    "/repos/ian-pascoe/cloudpid/pulls?state=open&head=ian-pascoe%3Afeat%2Fx&per_page=1";

  it("is the base of the open pull request from that branch of the repo, or none", async () => {
    const { pulls } = client({ [URL_OF]: () => json([{ base: { ref: "feat/parent" } }]) });

    expect(await pulls.baseOf(REPO, "feat/x")).toEqual({ status: "ok", value: "feat/parent" });

    const none = client({ [URL_OF]: () => json([]) });

    expect(await none.pulls.baseOf(REPO, "feat/x")).toEqual({ status: "ok", value: undefined });
  });

  it("fails as the other calls do", async () => {
    const { pulls } = client({ [URL_OF]: () => json(FORBIDDEN, 403) });

    expect(await pulls.baseOf(REPO, "feat/x")).toMatchObject({ status: "error", kind: "refused" });
  });
});
