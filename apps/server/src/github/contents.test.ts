// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- fakes of `fetch` and the Registry over native arrays.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { githubContents, SKILL_FETCH_PERMISSIONS } from "./contents.ts";
import { GithubReadError } from "./skill-fetch.ts";

const SHA = "a".repeat(40);

type Call = { readonly url: string; readonly init: RequestInit };

/** A GitHub that answers each request with the next response, and the tokens it was asked for. */
const harness = (answers: Array<Response | Error>, installed = new Set(["acme"])) => {
  const calls: Call[] = [];
  const asked: Array<string | undefined> = [];
  const invalidated: string[] = [];
  let minted = 0;

  const github = {
    token: async (account?: string) => {
      asked.push(account);

      if (account !== undefined && !installed.has(account)) {
        throw new Error(`The GitHub App is not installed on ${account}`);
      }

      minted++;

      return `token-${account ?? "owner"}-${minted}`;
    },
    invalidate: (token: string) => {
      invalidated.push(token);
    },
  };

  const reader = githubContents({
    github,
    fetch: async (url, init) => {
      calls.push({ url, init });

      const next = answers.shift();

      if (next === undefined) throw new Error("no answer left");

      if (next instanceof Error) throw next;

      return next;
    },
  });

  return { reader, calls, asked, invalidated };
};

const json = (body: Schema.Json, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const failure = async (promise: Promise<unknown>): Promise<GithubReadError> => {
  try {
    await promise;
  } catch (cause) {
    if (Schema.is(GithubReadError)(cause)) return cause;

    throw cause;
  }

  throw new Error("did not fail");
};

const repo = { owner: "acme", name: "skills" };

describe("githubContents", () => {
  it("asks only for contents, so its tokens are read-only", () => {
    expect(SKILL_FETCH_PERMISSIONS).toEqual({ contents: "read" });
  });

  it("resolves the default branch's head with HEAD, as a SHA, with a token for the repo's owner", async () => {
    const { reader, calls, asked } = harness([new Response(`${SHA}\n`)]);

    expect(await reader.commit(repo, null)).toBe(SHA);

    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/skills/commits/HEAD");
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe("application/vnd.github.sha");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-acme-1");
    expect(asked).toEqual(["acme"]);
  });

  it("escapes a ref's segments and keeps its slashes", async () => {
    const { reader, calls } = harness([new Response(SHA)]);

    await reader.commit(repo, "feature/a b");

    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/skills/commits/feature/a%20b");
  });

  it("never sends a request for a ref or a repo that a URL parser would resolve to another endpoint", async () => {
    const { reader, calls } = harness([]);

    for (const ref of ["..", "../../app/installations", "a/./b", "a//b", "/a", "a/"]) {
      const error = await failure(reader.commit(repo, ref));

      expect(error.kind, ref).toBe("refused");
    }

    for (const bad of [
      { owner: "acme", name: ".." },
      { owner: "acme", name: "." },
      { owner: "..", name: "skills" },
      { owner: "acme", name: "" },
    ]) {
      expect((await failure(reader.commit(bad, null))).kind).toBe("refused");
      expect((await failure(reader.tree(bad, SHA))).kind).toBe("refused");
      expect((await failure(reader.blob(bad, SHA))).kind).toBe("refused");
    }

    // Nothing reached GitHub.
    expect(calls).toHaveLength(0);
  });

  it("falls back to the app owner's token (public repos) where the app is not installed on the owner", async () => {
    const { reader, asked, calls } = harness([new Response(SHA)]);

    await reader.commit({ owner: "mattpocock", name: "skills" }, null);

    expect(asked).toEqual(["mattpocock", undefined]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-owner-1");
  });

  it("lists the tree recursively at the commit", async () => {
    const { reader, calls } = harness([
      json({
        sha: "tree",
        truncated: false,
        tree: [
          { path: "skills", type: "tree", sha: "t1" },
          { path: "skills/a/SKILL.md", type: "blob", sha: "b1", size: 12 },
        ],
      }),
    ]);

    expect(await reader.tree(repo, SHA)).toEqual({
      truncated: false,
      entries: [
        { path: "skills", type: "tree", sha: "t1" },
        { path: "skills/a/SKILL.md", type: "blob", sha: "b1", size: 12 },
      ],
    });

    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/acme/skills/git/trees/${SHA}?recursive=1`,
    );
  });

  it("lists the tree at a ref's head in one request, the default branch's with HEAD", async () => {
    const listing = json({
      sha: "tree",
      truncated: false,
      tree: [{ path: "a/SKILL.md", type: "blob", sha: "b1", size: 12 }],
    });

    const { reader, calls } = harness([listing, listing.clone()]);

    expect(await reader.headTree(repo, null)).toEqual({
      truncated: false,
      entries: [{ path: "a/SKILL.md", type: "blob", sha: "b1", size: 12 }],
    });

    await reader.headTree(repo, "feature/a b");

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/acme/skills/git/trees/HEAD?recursive=1",
      "https://api.github.com/repos/acme/skills/git/trees/feature/a%20b?recursive=1",
    ]);
  });

  it("says a tree GitHub cut short is truncated", async () => {
    const { reader } = harness([json({ sha: "tree", truncated: true, tree: [] })]);

    expect((await reader.tree(repo, SHA)).truncated).toBe(true);
  });

  it("reads a blob's bytes raw", async () => {
    const { reader, calls } = harness([new Response(new Uint8Array([104, 105]))]);

    expect(await reader.blob(repo, "b1")).toEqual(new Uint8Array([104, 105]));
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/skills/git/blobs/b1");
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe(
      "application/vnd.github.raw+json",
    );
  });

  it("invalidates a token GitHub refuses with a 401 and asks once more with a new one", async () => {
    const { reader, calls, invalidated } = harness([
      json({ message: "Bad credentials" }, { status: 401 }),
      new Response(SHA),
    ]);

    expect(await reader.commit(repo, null)).toBe(SHA);
    expect(invalidated).toEqual(["token-acme-1"]);
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer token-acme-2");
  });

  it("says a missing repo may be private where the app is not installed", async () => {
    const { reader } = harness([json({ message: "Not Found" }, { status: 404 })]);

    const error = await failure(reader.commit({ owner: "stranger", name: "private" }, null));

    expect(error.kind).toBe("not_found");
    expect(error.message).toContain("GitHub has no repo stranger/private");
    expect(error.message).toContain("private and the GitHub App is not installed on stranger");
  });

  it("says a missing repo may not be in the installation where the app is installed", async () => {
    const { reader } = harness([json({ message: "Not Found" }, { status: 404 })]);

    const error = await failure(reader.tree(repo, SHA));

    expect(error.kind).toBe("not_found");
    expect(error.message).toContain("installation on acme does not include it");
  });

  it("names the ref in a not-found answer to a commit", async () => {
    const { reader } = harness([
      json({ message: "No commit found for the ref nope" }, { status: 422 }),
    ]);

    const error = await failure(reader.commit(repo, "nope"));

    expect(error.kind).toBe("not_found");
    expect(error.message).toContain('no ref "nope"');
  });

  it("tells the rate limit, with when to try again", async () => {
    const retry = harness([
      json({ message: "secondary rate limit" }, { status: 403, headers: { "retry-after": "30" } }),
    ]);

    const waits = await failure(retry.reader.commit(repo, null));

    expect(waits.kind).toBe("rate_limited");
    expect(waits.message).toContain("Try again in 30 seconds");

    const primary = harness([
      json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
        },
      ),
    ]);

    const resets = await failure(primary.reader.commit(repo, null));

    expect(resets.kind).toBe("rate_limited");
    expect(resets.message).toContain("2030-01-01T00:00:00.000Z");

    const tooMany = harness([new Response("", { status: 429 })]);

    expect((await failure(tooMany.reader.commit(repo, null))).kind).toBe("rate_limited");
  });

  it("tells a refused token, an unexpected status, an unreachable GitHub and an answer that is not a tree", async () => {
    const refused = harness([json({ message: "Resource not accessible" }, { status: 403 })]);
    const refusedError = await failure(refused.reader.tree(repo, SHA));

    expect(refusedError.kind).toBe("refused");
    expect(refusedError.message).toContain("Resource not accessible");

    const broken = harness([new Response("oops", { status: 502 })]);

    expect((await failure(broken.reader.tree(repo, SHA))).message).toBe("GitHub answered 502");

    const down = harness([new Error("connection reset")]);

    expect((await failure(down.reader.tree(repo, SHA))).message).toBe(
      "GitHub could not be reached: connection reset",
    );

    const odd = harness([json({ nothing: true })]);

    expect((await failure(odd.reader.tree(repo, SHA))).message).toContain("not a tree");

    const notSha = harness([new Response("<html>")]);

    expect((await failure(notSha.reader.commit(repo, null))).message).toContain("not a SHA");
  });
});
