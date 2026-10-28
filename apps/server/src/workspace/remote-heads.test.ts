// The default-branch heads the Build's daily look asks for (docs/architecture/container.md → Builds): GitHub's REST API as the
// GitHub App for a GitHub repo, git's smart HTTP for another host, each fetch faked.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { describe, expect, it } from "vitest";
import { remoteHeads } from "./remote-heads.ts";

const APP = "a".repeat(40);
const API = "b".repeat(40);

type Call = { readonly url: string; readonly headers: Headers };

/** A network that answers each request with what `answer` makes of its url and its number, and keeps what was asked. */
const network = (answer: (url: string, call: number) => Response | Error) => {
  const calls: Call[] = [];

  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });

      const next = answer(url, calls.length);

      if (next instanceof Error) throw next;

      return next;
    },
  };
};

/** A GitHub App that is installed on `installed` only, and the tokens it handed out. */
const app = (installed: ReadonlyArray<string> = ["acme"]) => {
  const asked: Array<string | undefined> = [];
  const invalidated: string[] = [];

  return {
    asked,
    invalidated,
    github: {
      token: async (account?: string) => {
        asked.push(account);

        if (account !== undefined && !installed.includes(account)) {
          throw new Error(`The GitHub App is not installed on ${account}`);
        }

        return `token-${account ?? "owner"}`;
      },
      invalidate: (token: string) => {
        invalidated.push(token);
      },
    },
  };
};

const repos = [
  { name: "app", url: "https://github.com/acme/app.git" },
  { name: "api", url: "https://github.com/acme/api" },
];

const text = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init });

const shaOf = (url: string) => (url.includes("/acme/app/") ? APP : API);

describe("the default branch heads on GitHub", () => {
  it("asks GitHub for each repo's head as the App, with the installation token of the repo's owner", async () => {
    const { github, asked } = app();
    const net = network((url) => text(shaOf(url)));

    const answer = await remoteHeads({ fetch: net.fetch, github })(repos);

    expect(answer).toEqual({ ok: true, heads: { app: APP, api: API } });
    expect(net.calls.map((call) => call.url).sort()).toEqual([
      "https://api.github.com/repos/acme/api/commits/HEAD",
      "https://api.github.com/repos/acme/app/commits/HEAD",
    ]);
    expect(asked).toEqual(["acme", "acme"]);

    for (const call of net.calls) {
      expect(call.headers.get("authorization")).toBe("Bearer token-acme");
      expect(call.headers.get("accept")).toBe("application/vnd.github.sha");
    }
  });

  it("reads a public repo with the app owner's token where the App is not installed on its owner", async () => {
    const { github, asked } = app([]);
    const net = network(() => text(APP));

    const answer = await remoteHeads({ fetch: net.fetch, github })([
      { name: "lib", url: "https://github.com/octocat/lib.git" },
    ]);

    expect(answer).toEqual({ ok: true, heads: { lib: APP } });
    expect(asked).toEqual(["octocat", undefined]);
    expect(net.calls[0]?.headers.get("authorization")).toBe("Bearer token-owner");
  });

  it("reads a public repo with no token where there is no GitHub App", async () => {
    const net = network(() => text(APP));

    const answer = await remoteHeads({ fetch: net.fetch, github: undefined })([
      { name: "lib", url: "https://github.com/octocat/lib.git" },
    ]);

    expect(answer).toEqual({ ok: true, heads: { lib: APP } });
    expect(net.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("asks once more with a new token after a 401", async () => {
    const { github, invalidated } = app();
    const net = network((_url, call) => (call === 1 ? text("", { status: 401 }) : text(APP)));

    const answer = await remoteHeads({ fetch: net.fetch, github })([repos[0] ?? never()]);

    expect(answer).toEqual({ ok: true, heads: { app: APP } });
    expect(invalidated).toEqual(["token-acme"]);
    expect(net.calls).toHaveLength(2);
  });

  it("tells a repo with no commits yet as none", async () => {
    const { github } = app();
    const net = network(() => text('{"message":"Git Repository is empty."}', { status: 409 }));

    expect(await remoteHeads({ fetch: net.fetch, github })([repos[0] ?? never()])).toEqual({
      ok: true,
      heads: { app: null },
    });
  });

  it("fails, saying why, when GitHub has no such repo for the App", async () => {
    const { github } = app([]);
    const net = network(() => text("", { status: 404 }));

    const answer = await remoteHeads({ fetch: net.fetch, github })([repos[0] ?? never()]);

    expect(answer).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not installed on its owner"),
    });
  });

  it("fails when GitHub refuses the token, answers with an error, or is out of requests", async () => {
    const { github } = app();

    const reasonOf = async (response: Response) =>
      remoteHeads({ fetch: network(() => response).fetch, github })([repos[0] ?? never()]);

    expect(await reasonOf(text("", { status: 403 }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("refused the token"),
    });
    expect(await reasonOf(text("", { status: 502 }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("answered 502"),
    });
    expect(
      await reasonOf(text("", { status: 403, headers: { "x-ratelimit-remaining": "0" } })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("rate limit") });
  });

  it("tells a missing repo as private where there is no GitHub App", async () => {
    const net = network(() => text("", { status: 404 }));

    expect(
      await remoteHeads({ fetch: net.fetch, github: undefined })([repos[0] ?? never()]),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no GitHub App is set up"),
    });
  });

  it("fails when GitHub cannot be reached, or does not answer with a commit", async () => {
    const { github } = app();

    expect(
      await remoteHeads({
        fetch: network(() => new Error("connection reset")).fetch,
        github,
      })([repos[0] ?? never()]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("connection reset") });
    expect(
      await remoteHeads({ fetch: network(() => text("<html>")).fetch, github })([
        repos[0] ?? never(),
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("not a commit") });
  });

  it("fails the whole look when one repo cannot be asked, naming it", async () => {
    const { github } = app();

    const net = network((url) =>
      url.includes("/acme/api/") ? text("", { status: 500 }) : text(APP),
    );

    expect(await remoteHeads({ fetch: net.fetch, github })(repos)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("acme/api"),
    });
  });
});

/** A pkt-line of `payload`. */
const pkt = (payload: string): string =>
  `${(new TextEncoder().encode(payload).length + 4).toString(16).padStart(4, "0")}${payload}`;

const advertisement = (...refs: string[]): string =>
  `${pkt("# service=git-upload-pack\n")}0000${refs.map((ref) => pkt(ref)).join("")}0000`;

const ADVERTISED = { "content-type": "application/x-git-upload-pack-advertisement" };

describe("the default branch heads on another host", () => {
  const gitlab = [{ name: "lib", url: "https://gitlab.com/group/lib" }];

  it("reads HEAD from git's smart HTTP, without credentials", async () => {
    const { github, asked } = app();

    const net = network(() =>
      text(
        advertisement(
          `${APP} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`,
          `${API} refs/heads/main\n`,
        ),
        { headers: ADVERTISED },
      ),
    );

    expect(await remoteHeads({ fetch: net.fetch, github })(gitlab)).toEqual({
      ok: true,
      heads: { lib: APP },
    });
    expect(net.calls[0]?.url).toBe(
      "https://gitlab.com/group/lib/info/refs?service=git-upload-pack",
    );
    expect(net.calls[0]?.headers.has("authorization")).toBe(false);
    expect(asked).toEqual([]);
  });

  it("tells a repo with no commits yet as none", async () => {
    const net = network(() =>
      text(advertisement(`${"0".repeat(40)} capabilities^{}\0multi_ack\n`), {
        headers: ADVERTISED,
      }),
    );

    expect(await remoteHeads({ fetch: net.fetch, github: undefined })(gitlab)).toEqual({
      ok: true,
      heads: { lib: null },
    });
  });

  it("reads a first ref line that arrives in pieces", async () => {
    const body = new TextEncoder().encode(advertisement(`${APP} HEAD\0multi_ack\n`));

    const net = network(
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(body.subarray(0, 10));
              controller.enqueue(body.subarray(10, 60));
              controller.enqueue(body.subarray(60));
              controller.close();
            },
          }),
          { status: 200, headers: ADVERTISED },
        ),
    );

    expect(await remoteHeads({ fetch: net.fetch, github: undefined })(gitlab)).toEqual({
      ok: true,
      heads: { lib: APP },
    });
  });

  it("fails when the remote answers with an error, is unreachable, or is not a git remote", async () => {
    const asked = async (answer: Response | Error) =>
      remoteHeads({ fetch: network(() => answer).fetch, github: undefined })(gitlab);

    expect(await asked(text("", { status: 404 }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("answered 404"),
    });
    expect(await asked(new Error("timed out"))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("timed out"),
    });
    expect(await asked(text("<html>", { headers: { "content-type": "text/html" } }))).toMatchObject(
      {
        ok: false,
        reason: expect.stringContaining("smart HTTP"),
      },
    );
    expect(
      await asked(text(pkt("# service=git-upload-pack\n"), { headers: ADVERTISED })),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ended before any ref"),
    });
    expect(await asked(text("nonsense", { headers: ADVERTISED }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not git's ref advertisement"),
    });
  });
});

const never = (): never => {
  throw new Error("no such repo in the fixture");
};
