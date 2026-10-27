// The GitHub REST client for pull requests, over recorded responses (`github-pulls.fixtures.ts`): the list with its counts,
// the 60 s the list is kept, and the refusals (401, 403, and 404 for a private repo).
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalFetch:off
import { describe, expect, it } from "vitest";
import {
  type Json,
  BAD_CREDENTIALS,
  FORBIDDEN,
  LIST_OPEN,
  NOT_FOUND,
  RATE_LIMITED,
  SINGLE_246_MERGED,
  SINGLE_267,
  SINGLE_269,
} from "./github-pulls.fixtures.ts";
import { GithubPulls, PULLS_CACHE_MS, REFUSED_MESSAGE } from "./github-pulls.ts";

const REPO = { owner: "ian-pascoe", name: "cloudpid" };

const json = (body: Json, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

type Call = { readonly url: string; readonly authorization: string | null };

/** A client over a GitHub that answers `routes` by path, and records each request. */
const client = (routes: Record<string, () => Response>) => {
  const calls: Call[] = [];
  const clock = { now: 1_000_000 };

  const pulls = new GithubPulls({
    fetch: (url, init) => {
      const { pathname, search } = new URL(url);
      const route = routes[`${pathname}${search}`] ?? routes[pathname];

      calls.push({
        url: `${pathname}${search}`,
        authorization: new Headers(init.headers).get("authorization"),
      });

      return Promise.resolve(route === undefined ? json(NOT_FOUND, 404) : route());
    },
    token: () => "ghp_secret",
    now: () => clock.now,
    warn: () => undefined,
  });

  return { pulls, calls, clock };
};

const LIST_URL =
  "/repos/ian-pascoe/cloudpid/pulls?state=open&sort=updated&direction=desc&per_page=50";

const OPEN_ROUTES = {
  [LIST_URL]: () => json(LIST_OPEN),
  "/repos/ian-pascoe/cloudpid/pulls/269": () => json(SINGLE_269),
  "/repos/ian-pascoe/cloudpid/pulls/267": () => json(SINGLE_267),
};

describe("the open pull requests of a repo", () => {
  it("lists them most recently updated first, with the counts of each single pull request, and marks the branch's own", async () => {
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

    expect(calls.map((call) => call.url).toSorted()).toEqual(
      [
        LIST_URL,
        "/repos/ian-pascoe/cloudpid/pulls/267",
        "/repos/ian-pascoe/cloudpid/pulls/269",
      ].toSorted(),
    );
    expect(calls.every((call) => call.authorization === "Bearer ghp_secret")).toBe(true);
  });

  it("marks no pull request when the branch is detached or from a fork of the same name", async () => {
    const { pulls } = client({
      ...OPEN_ROUTES,
      [LIST_URL]: () =>
        json([
          {
            ...LIST_OPEN[0],
            head: { ...LIST_OPEN[0].head, repo: { full_name: "someone/cloudpid" } },
          },
        ]),
    });

    const detached = await pulls.list(REPO, null);
    const forked = await pulls.list(REPO, "feat/diffs-231-this-branch");

    expect(detached.status === "ok" && detached.pulls.some((pull) => pull.thisBranch)).toBe(false);
    expect(forked.status === "ok" && forked.pulls.some((pull) => pull.thisBranch)).toBe(false);
  });

  it("keeps the list for 60 s: an opening inside it asks GitHub nothing, one after it asks again", async () => {
    const { pulls, calls, clock } = client(OPEN_ROUTES);

    await pulls.list(REPO, null);

    const asked = calls.length;

    clock.now += PULLS_CACHE_MS - 1;

    const again = await pulls.list(REPO, null);

    expect(calls).toHaveLength(asked);
    expect(again).toMatchObject({ status: "ok", fetchedAt: 1_000_000 });

    clock.now += 1;

    const later = await pulls.list(REPO, null);

    // The list again; the counts of the heads it already read are kept.
    expect(calls).toHaveLength(asked + 1);
    expect(later).toMatchObject({ status: "ok", fetchedAt: 1_000_000 + PULLS_CACHE_MS });
  });

  it("reads the counts again only for a pull request whose head is new", async () => {
    const moved = { ...LIST_OPEN[0], head: { ...LIST_OPEN[0].head, sha: "f".repeat(40) } };
    let list: Json = LIST_OPEN;
    let single: Json = SINGLE_269;

    const { pulls, calls, clock } = client({
      ...OPEN_ROUTES,
      [LIST_URL]: () => json(list),
      "/repos/ian-pascoe/cloudpid/pulls/269": () => json(single),
    });

    await pulls.list(REPO, null);

    list = [moved, LIST_OPEN[1]];
    single = { ...SINGLE_269, head: moved.head, additions: 6000 };
    clock.now += PULLS_CACHE_MS;
    calls.length = 0;

    const after = await pulls.list(REPO, null);

    expect(calls.map((call) => call.url).toSorted()).toEqual(
      [LIST_URL, "/repos/ian-pascoe/cloudpid/pulls/269"].toSorted(),
    );
    expect(after.status === "ok" && after.pulls[0]).toMatchObject({
      number: 269,
      head: "f".repeat(40),
      additions: 6000,
    });
  });

  it("asks GitHub once for two openings at the same time", async () => {
    const { pulls, calls } = client(OPEN_ROUTES);

    await Promise.all([pulls.list(REPO, null), pulls.list(REPO, null)]);

    expect(calls.filter((call) => call.url === LIST_URL)).toHaveLength(1);
  });

  it("lists a pull request whose counts did not come, with none", async () => {
    const { pulls } = client({
      ...OPEN_ROUTES,
      "/repos/ian-pascoe/cloudpid/pulls/267": () => json({ message: "Server Error" }, 500),
    });

    const list = await pulls.list(REPO, null);

    expect(list.status === "ok" && list.pulls[1]).toMatchObject({
      number: 267,
      additions: null,
      deletions: null,
      changedFiles: null,
    });
  });

  it.each([
    ["a 401 (bad token)", () => json(BAD_CREDENTIALS, 401)],
    ["a 403", () => json(FORBIDDEN, 403)],
    ["a 404 (a private repo the token cannot see)", () => json(NOT_FOUND, 404)],
  ])("says GitHub refused the token on %s", async (_, answer) => {
    const { pulls } = client({ [LIST_URL]: answer });

    expect(await pulls.list(REPO, null)).toEqual({
      status: "error",
      kind: "refused",
      message: REFUSED_MESSAGE,
    });
  });

  it("does not take the rate limit for a refused token, and does not keep a failure", async () => {
    let answer = () => json(RATE_LIMITED, 403, { "x-ratelimit-remaining": "0" });

    const { pulls, calls } = client({ ...OPEN_ROUTES, [LIST_URL]: () => answer() });

    expect(await pulls.list(REPO, null)).toEqual({
      status: "error",
      kind: "failed",
      message: "GitHub's rate limit is used up",
    });

    answer = () => json(LIST_OPEN);

    expect(await pulls.list(REPO, null)).toMatchObject({ status: "ok" });
    expect(calls.filter((call) => call.url === LIST_URL)).toHaveLength(2);
  });

  it("fails with GitHub's status on an error, and when it cannot be reached or answers something else", async () => {
    expect(await client({ [LIST_URL]: () => json({}, 502) }).pulls.list(REPO, null)).toEqual({
      status: "error",
      kind: "failed",
      message: "GitHub answered 502",
    });

    expect(
      await client({ [LIST_URL]: () => json({ not: "a list" }) }).pulls.list(REPO, null),
    ).toMatchObject({
      status: "error",
      kind: "failed",
    });

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

  it("is refused on a 404", async () => {
    const { pulls } = client({});

    expect(await pulls.get(REPO, 1)).toEqual({
      status: "error",
      kind: "refused",
      message: REFUSED_MESSAGE,
    });
  });
});
