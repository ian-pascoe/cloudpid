// The looks at a Repo's `.pi/mcp.json` over the Registry's real storage and a fake `RepoReader` (`docs/architecture/mcp-configuration.md`
// → A Repo's `.pi/mcp.json`; D7 of the MCP server configuration design): the file on the default branch with its blob, the
// copy kept when GitHub does not answer (and the problem it becomes after 24 h), a 404, an invalid file, an oversize one, a
// Repo that is not on GitHub, the throttle, and what the set makes of it all.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalDate:off
import { runInDurableObject } from "cloudflare:test";
import { resolveMcpServerSet } from "@cloudpid/config";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { fakeGithub } from "../github/skill-repo.fixture.ts";
import { GithubReadError } from "../github/skill-fetch.ts";
import { environmentMcpSet, mcpServerValuesAnswer, readsSecrets } from "./mcp-registry.ts";
import {
  MCP_REPO_STALE_MS,
  mcpRepoFileViews,
  mcpRepoLayers,
  mcpUnlookedRepos,
} from "./mcp-repo-files.ts";
import { firstMcpLook, openMcpRepoLooks } from "./mcp-repo-look.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const APP = { name: "app", url: "https://github.com/acme/app" };
const FILE = ".pi/mcp.json";
const MINUTE = 60_000;

const file = (servers: Schema.JsonObject) => JSON.stringify({ mcpServers: servers });

const DOCS = { url: "https://docs.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" } };
const LOCAL = { command: "node", args: ["server.js"] };

/** Run `body` over a fresh Registry's store, whose Default Environment has the Repo `app` and a fake GitHub behind its looks. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly github: ReturnType<typeof fakeGithub>;
    readonly looks: ReturnType<typeof openMcpRepoLooks>;
    /** The Repo files as the page is told them, and the servers of the set, at `now`. */
    readonly view: (now: number) => NonNullable<ReturnType<typeof mcpRepoFileViews>>;
    readonly servers: () => ReadonlyArray<string>;
    readonly problems: () => ReadonlyArray<string>;
  }) => Promise<A>,
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const github = fakeGithub();

      store.addRepo(DEFAULT_ENVIRONMENT, APP);

      return body({
        store,
        github,
        looks: openMcpRepoLooks(store, github.reader),
        view: (now) => mcpRepoFileViews(store, DEFAULT_ENVIRONMENT, now) ?? [],
        servers: () =>
          Arr.map(environmentMcpSet(store, DEFAULT_ENVIRONMENT)?.entries ?? [], ({ name }) => name),
        problems: () =>
          Arr.map(
            resolveMcpServerSet({}, {}, mcpRepoLayers(store, DEFAULT_ENVIRONMENT)).problems,
            ({ name, message }) => `${name ?? "file"} ${message}`,
          ),
      });
    },
  );

describe("a Repo's .pi/mcp.json", () => {
  it("is read from the default branch with its blob, and not read again while the blob is the same", () =>
    inRegistry(async ({ github, looks, view, servers }) => {
      const first = github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      // A branch that is not the default has its own file: the set never sees it.
      github.push("acme/app", { [FILE]: file({ branch: LOCAL }) }, "feature");

      expect(servers()).toEqual([]);

      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 1_000 });

      expect(servers()).toEqual(["docs"]);
      expect(view(2_000)).toEqual([
        expect.objectContaining({
          repo: "app",
          slug: "acme/app",
          path: FILE,
          state: "read",
          readAt: 1_000,
          lookedAt: 1_000,
        }),
      ]);
      expect(github.requests.filter((request) => request.startsWith("blob"))).toHaveLength(1);

      // The default branch moves without touching the file: it is looked at again, and not read again.
      github.push("acme/app", { [FILE]: file({ docs: DOCS }), "README.md": "hi" });
      github.reset();
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 60_000 });

      expect(github.requests.filter((request) => request.startsWith("file"))).toHaveLength(1);
      expect(github.requests.filter((request) => request.startsWith("blob"))).toEqual([]);
      expect(view(61_000)[0]).toMatchObject({ readAt: 1_000, lookedAt: 60_000 });
      expect(first).toBeTruthy();

      // The file changes: its new text is read.
      github.push("acme/app", { [FILE]: file({ docs: DOCS, local: LOCAL }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 120_000 });

      expect(servers()).toEqual(["docs", "local"]);
    }));

  it("is looked at by the host's pull only when the last look is over 10 minutes old, and by a move when over 30 seconds", () =>
    inRegistry(async ({ github, looks }) => {
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });

      const asks = () => github.requests.filter((request) => request.startsWith("file")).length;

      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 0 });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 9 * MINUTE });

      expect(asks()).toBe(1);

      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 10 * MINUTE });

      expect(asks()).toBe(2);

      // A Build's move or an add is held to one look per 30 seconds; the owner's Reload is not.
      await looks.look({
        environment: DEFAULT_ENVIRONMENT,
        reason: "moved",
        now: 10 * MINUTE + 29_000,
      });

      expect(asks()).toBe(2);

      await looks.look({
        environment: DEFAULT_ENVIRONMENT,
        reason: "moved",
        now: 10 * MINUTE + 30_000,
      });

      expect(asks()).toBe(3);

      await looks.look({
        environment: DEFAULT_ENVIRONMENT,
        reason: "reload",
        now: 10 * MINUTE + 31_000,
      });

      expect(asks()).toBe(4);
    }));

  it("takes its servers away when the file is gone from a readable Repo, with no problem", () =>
    inRegistry(async ({ github, looks, view, servers, problems }) => {
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });

      expect(servers()).toEqual(["docs"]);

      github.push("acme/app", { "README.md": "no servers here" });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 11 * MINUTE });

      expect(servers()).toEqual([]);
      expect(problems()).toEqual([]);
      expect(view(11 * MINUTE)).toEqual([
        { repo: "app", slug: "acme/app", path: FILE, state: "absent", lookedAt: 11 * MINUTE },
      ]);
    }));

  describe("when GitHub does not answer", () => {
    const down = GithubReadError.of("failed", "GitHub answered 502");

    it("keeps the last good copy with the error and since when, and makes it a problem after 24 hours", () =>
      inRegistry(async ({ github, looks, view, servers }) => {
        github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 1_000 });

        github.fail("acme/app", down);
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 11 * MINUTE });

        expect(servers()).toEqual(["docs"]);
        expect(view(12 * MINUTE)[0]).toMatchObject({
          state: "unreadable",
          error: "GitHub answered 502",
          errorSince: 11 * MINUTE,
          readAt: 1_000,
          text: file({ docs: DOCS }),
        });
        expect(view(12 * MINUTE)[0]?.problem).toBeUndefined();

        // Looks keep failing: the run's start does not move, and the copy stands.
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 22 * MINUTE });

        expect(view(22 * MINUTE)[0]).toMatchObject({ errorSince: 11 * MINUTE });
        expect(servers()).toEqual(["docs"]);

        const day = 11 * MINUTE + MCP_REPO_STALE_MS;

        expect(view(day - 1)[0]?.problem).toBeUndefined();
        expect(view(day)[0]?.problem).toMatch(
          /could not be read for over a day.*GitHub answered 502/,
        );
        // Still the copy's servers.
        expect(servers()).toEqual(["docs"]);
      }));

    it("is a problem at once when there was never a copy, asking for the App where it is the repo's", () =>
      inRegistry(async ({ github, looks, view, servers }) => {
        github.fail(
          "acme/app",
          GithubReadError.of(
            "not_found",
            "GitHub has no repo acme/app, or it is private and the GitHub App is not installed on acme (install it there, on all repositories).",
          ),
        );
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 5 });

        expect(servers()).toEqual([]);
        expect(view(6)[0]).toMatchObject({
          state: "unreadable",
          problem: expect.stringMatching(
            /^could not be read: GitHub has no repo acme\/app.*install it there/,
          ),
        });
      }));

    it("recovers when GitHub answers again, whatever was kept", () =>
      inRegistry(async ({ github, looks, view, servers }) => {
        github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });
        github.fail("acme/app", down);
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 11 * MINUTE });
        github.fail("acme/app", undefined);
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 22 * MINUTE });

        expect(servers()).toEqual(["docs"]);
        expect(view(22 * MINUTE)[0]).toMatchObject({
          state: "read",
          readAt: 0,
          lookedAt: 22 * MINUTE,
        });
        expect(view(22 * MINUTE)[0]?.error).toBeUndefined();
        expect(view(22 * MINUTE)[0]?.errorSince).toBeUndefined();
      }));

    it("drops the copy only on the owner's Reload", () =>
      inRegistry(async ({ github, looks, view, servers }) => {
        github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });
        github.fail("acme/app", down);
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: MINUTE });

        expect(servers()).toEqual(["docs"]);

        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "reload", now: 2 * MINUTE });

        expect(servers()).toEqual([]);
        expect(view(2 * MINUTE)[0]).toMatchObject({
          state: "unreadable",
          problem: "could not be read: GitHub answered 502",
        });
        expect(view(2 * MINUTE)[0]?.text).toBeUndefined();
      }));

    it("tells an error that is not GitHub's own the same way, and keeps the copy", () =>
      inRegistry(async ({ github, looks, view, servers }) => {
        github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });
        github.fail("acme/app", new Error("socket closed"));
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 11 * MINUTE });

        expect(servers()).toEqual(["docs"]);
        expect(view(11 * MINUTE)[0]).toMatchObject({
          state: "unreadable",
          error: "the read failed (socket closed)",
        });
      }));
  });

  it("takes its servers away when the file is not valid, with a problem, and keeps no old copy", () =>
    inRegistry(async ({ github, looks, view, servers, problems }) => {
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });

      github.push("acme/app", { [FILE]: '{ "mcpServers": ' });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 11 * MINUTE });

      expect(servers()).toEqual([]);
      expect(problems()).toEqual(["file is not valid JSON"]);
      expect(view(11 * MINUTE)[0]).toMatchObject({ state: "read", text: '{ "mcpServers": ' });

      // Valid JSON without an `mcpServers` object is as bad.
      github.push("acme/app", { [FILE]: JSON.stringify({ servers: {} }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 22 * MINUTE });

      expect(servers()).toEqual([]);
      expect(problems()).toEqual(["file has no mcpServers object"]);

      // Fixed, its servers are back; the broken copy is gone.
      github.push("acme/app", { [FILE]: file({ local: LOCAL }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 33 * MINUTE });

      expect(servers()).toEqual(["local"]);
      expect(problems()).toEqual([]);
    }));

  it("is not read at all over 64 KiB: no servers, a problem, no old copy", () =>
    inRegistry(async ({ github, looks, view, servers }) => {
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });

      const big = file({ docs: { ...DOCS, description: "x".repeat(70 * 1024) } });

      github.push("acme/app", { [FILE]: big });
      github.reset();
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 11 * MINUTE });

      expect(github.requests.filter((request) => request.startsWith("blob"))).toEqual([]);
      expect(servers()).toEqual([]);
      expect(view(11 * MINUTE)[0]).toMatchObject({
        state: "oversize",
        problem: expect.stringMatching(/^is 7\d KiB, over 64 KiB, so it is not read$/),
      });
      expect(view(11 * MINUTE)[0]?.text).toBeUndefined();
    }));

  it("is not read for a Repo that is not on GitHub, and says so", () =>
    inRegistry(async ({ store, github, looks, view, servers }) => {
      store.addRepo(DEFAULT_ENVIRONMENT, {
        name: "lab",
        url: "https://git.example.com/lab/tools.git",
      });
      github.push("acme/app", { "README.md": "hi" });

      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });

      expect(servers()).toEqual([]);
      expect(github.requests.filter((request) => request.includes("lab"))).toEqual([]);
      expect(view(1)[1]).toEqual({
        repo: "lab",
        path: FILE,
        state: "not_github",
        lookedAt: 0,
      });
    }));

  it("lists a Repo not looked at yet as never, and as one to look at", () =>
    inRegistry(async ({ looks, view, store }) => {
      expect(view(0)).toEqual([{ repo: "app", path: FILE, state: "never" }]);
      expect(mcpUnlookedRepos(store, DEFAULT_ENVIRONMENT)).toEqual(["app"]);

      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 0 });

      expect(mcpUnlookedRepos(store, DEFAULT_ENVIRONMENT)).toEqual([]);
    }));

  describe("a Session's first look", () => {
    /** A reader whose file read waits for `release`. */
    const slow = (github: ReturnType<typeof fakeGithub>) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));

      return {
        release: () => release(),
        reader: {
          ...github.reader,
          file: async (...asked: Parameters<typeof github.reader.file>) => {
            await gate;

            return github.reader.file(...asked);
          },
        },
      };
    };

    it("gives up waiting for a slow look, which goes on and leaves the Repo looked at", () =>
      inRegistry(async ({ store, github, servers }) => {
        github.push("acme/app", { [FILE]: file({ docs: DOCS }) });

        const { reader, release } = slow(github);
        const looks = openMcpRepoLooks(store, reader);
        const started = Date.now();

        await Effect.runPromise(firstMcpLook(looks, store, DEFAULT_ENVIRONMENT, "30 millis"));

        // It answered at the bound, without the Repo's servers, and the look is still running.
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(servers()).toEqual([]);
        expect(mcpUnlookedRepos(store, DEFAULT_ENVIRONMENT)).toEqual(["app"]);

        release();
        // The same look, joined: it is not made twice.
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 0 });

        expect(servers()).toEqual(["docs"]);
        expect(github.requests.filter((request) => request.startsWith("file"))).toHaveLength(1);
      }));

    it("does not wait, or look, for a Repo that was looked at", () =>
      inRegistry(async ({ store, github, looks }) => {
        github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
        await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 0 });
        github.reset();

        await Effect.runPromise(firstMcpLook(looks, store, DEFAULT_ENVIRONMENT, "30 millis"));

        expect(github.requests).toEqual([]);
      }));
  });

  it("goes with its Repo and with its Environment, and a Repo taken out while it is read is not left a row", () =>
    inRegistry(async ({ store, github, looks, view }) => {
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });

      const reading = looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });

      store.removeRepo(DEFAULT_ENVIRONMENT, "app");
      await reading;

      expect(store.getMcpRepoFiles(DEFAULT_ENVIRONMENT)).toEqual([]);

      store.addRepo(DEFAULT_ENVIRONMENT, APP);
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 1 });

      expect(view(2)[0]).toMatchObject({ state: "read" });

      store.removeRepo(DEFAULT_ENVIRONMENT, "app");

      expect(store.getMcpRepoFiles(DEFAULT_ENVIRONMENT)).toEqual([]);

      store.createEnvironment("5a5a5a5a", "Staging", 3);
      store.addRepo("5a5a5a5a", APP);
      await looks.look({ environment: "5a5a5a5a", reason: "moved", now: 4 });

      expect(store.getMcpRepoFiles("5a5a5a5a")).toHaveLength(1);
      expect(store.deleteEnvironment("5a5a5a5a")).toBe("deleted");
      expect(store.getMcpRepoFiles("5a5a5a5a")).toEqual([]);
    }));

  it("makes one look of looks of one reason that overlap", () =>
    inRegistry(async ({ github, looks }) => {
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });

      await Promise.all([
        looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 0 }),
        looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 }),
        looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 0 }),
      ]);

      expect(github.requests.filter((request) => request.startsWith("file"))).toHaveLength(1);
    }));

  it("makes a Reload that overlaps a scheduled look look again, so that it drops the copy a failed look keeps", () =>
    inRegistry(async ({ github, looks, servers, view }) => {
      github.push("acme/app", { [FILE]: file({ docs: DOCS }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "added", now: 0 });
      github.fail("acme/app", GithubReadError.of("failed", "GitHub answered 502"));
      github.reset();

      // The scheduled look is running when the owner's Reload comes.
      await Promise.all([
        looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "due", now: 11 * MINUTE }),
        looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "reload", now: 11 * MINUTE }),
        looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "reload", now: 11 * MINUTE }),
      ]);

      expect(servers()).toEqual([]);
      expect(view(11 * MINUTE)[0]).toMatchObject({ state: "unreadable" });
      expect(view(11 * MINUTE)[0]?.text).toBeUndefined();
      // The scheduled look, and one more for the Reloads, which join each other.
      expect(github.requests.filter((request) => request.startsWith("file"))).toHaveLength(2);
    }));
});

describe("a Repo's servers in the Environment's set", () => {
  const TOKEN_NEEDED = {
    url: "https://docs.example/mcp",
    headers: { Authorization: "Bearer ${TOKEN}" },
  };

  it("read ${NAME} from the Variables only, and the owner's own entry of the name hides them", () =>
    inRegistry(async ({ store, github, looks }) => {
      github.push("acme/app", { [FILE]: file({ docs: TOKEN_NEEDED }) });
      await looks.look({ environment: DEFAULT_ENVIRONMENT, reason: "moved", now: 0 });

      const set = environmentMcpSet(store, DEFAULT_ENVIRONMENT);
      const entry = set?.entries[0];

      expect(entry?.source).toEqual({
        kind: "repo",
        directory: "app",
        slug: "acme/app",
        path: FILE,
      });

      const input = { environment: DEFAULT_ENVIRONMENT, server: "docs", conn: entry?.conn ?? "" };

      // It never opens the Secrets, and a Secret of that name is not read.
      expect(readsSecrets(store, DEFAULT_ENVIRONMENT, "docs")).toBe(false);
      expect(mcpServerValuesAnswer(store, input, { TOKEN: "a-secret" })).toMatchObject({
        status: "values",
        headers: { Authorization: "Bearer ${TOKEN}" },
        missing: ["TOKEN"],
        redact: [],
      });

      store.putEnvironmentSettings(DEFAULT_ENVIRONMENT, { variables: { TOKEN: "a-variable" } });

      expect(mcpServerValuesAnswer(store, input, { TOKEN: "a-secret" })).toMatchObject({
        headers: { Authorization: "Bearer a-variable" },
        missing: [],
        redact: [],
      });
    }));
});
