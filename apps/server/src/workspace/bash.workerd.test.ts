// `bash` without a `backend`, on a real Workspace DO: a command routed to the Worker Shell runs there, whole, and never
// starts the Container. The Workspace test Worker has no Container, so a command sent to it fails, and its counter
// (`liveStubs().container`) says whether one was.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { ComputerExecutionEnv } from "@cloudpid/computer-env";
import { CodingTools } from "@cloudpid/extensions/coding-tools";
import { WORKER_SHELL_BUILTINS, WORKER_SHELL_COMMANDS } from "@cloudpid/extensions/bash-routing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_PACK_BYTES } from "./git.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
    }
  }
}

const context = BACKGROUND_CONTEXT;

const bash = CodingTools.tools?.find((tool) => tool.name === "bash");

/** One Workspace for every case (each Workspace loads its own Worker Shell); each case gets a directory of its own. */
const shared = env.WORKSPACES.getByName("bash-routing");

let cases = 0;

const open = async () => {
  cases++;

  const cwd = `/workspace/case-${cases}`;
  const executionEnv = new ComputerExecutionEnv({ workspace: shared, id: "computer:bash", cwd });
  const before = await shared.liveStubs();

  getOrThrow(await executionEnv.createDir(cwd, { recursive: true }, context));
  getOrThrow(
    await executionEnv.writeFile("package.json", '{"name":"demo","version":"1.2.3"}\n', context),
  );
  getOrThrow(await executionEnv.writeFile("notes.txt", "alpha\nneedle\nomega\n", context));

  /** What the model sees from calling `bash` with `args`: its output, and whether the tool reported an error. */
  const run = async (args: Record<string, string | number>) => {
    if (bash === undefined) throw new Error("no bash tool");

    const chunks: string[] = [];

    const api = {
      env: executionEnv,
      output: (text: string) => chunks.push(text),
      retainedOutput: () => chunks.join(""),
      diagnostic: () => {},
    };

    try {
      // SAFETY: `args` are `bash`'s parameters (the lookup by name types it as any of the tools), and `bash` uses only the
      // environment, the output sink, and diagnostics of the API.
      const result = await bash.execute(args as never, api as never, context);

      // A command that exits nonzero comes back as a result with `isError`; only a timeout or an abort throws.
      return { text: chunks.join(""), isError: result.isError === true };
    } catch (error) {
      return { text: `${chunks.join("")}${String(error)}`, isError: true };
    }
  };

  /** Runs `command` on the Worker Shell explicitly, as test setup that the router would send to the Container. */
  const setup = async (command: string) => {
    const result = await run({ command, backend: "worker" });

    expect(result, command).toMatchObject({ isError: false });
  };

  /** Writes bytes the shell would mangle (it writes text), creating the directories above `path`. */
  const put = async (path: string, bytes: Uint8Array) => {
    getOrThrow(
      await executionEnv.createDir(
        path.slice(0, path.lastIndexOf("/")),
        { recursive: true },
        context,
      ),
    );
    getOrThrow(await executionEnv.writeFile(path, bytes, context));
  };

  /** The commands the Workspace started since this case opened. */
  const counts = async () => {
    const now = await shared.liveStubs();

    return { started: now.started - before.started, container: now.container - before.container };
  };

  return { run, setup, put, counts };
};

// The first command loads the Worker Shell and its modules (git, jq) cold, which can take longer than the default 5 s on CI.
describe("bash on a Workspace", { timeout: 30_000 }, () => {
  it.each([
    ["cat notes.txt", "alpha\nneedle\nomega"],
    ["grep needle notes.txt", "needle"],
    ["sed -n 2p notes.txt", "needle"],
    ["jq -r .version package.json", "1.2.3"],
    ["grep -c a notes.txt | cat", "2"],
    ["cd . && ls | head -1", "notes.txt"],
  ])("runs `%s` on the Worker Shell without starting the Container", async (command, output) => {
    const { run, counts } = await open();

    const result = await run({ command });

    expect(result.isError).toBe(false);
    expect(result.text.trim()).toBe(output);
    expect(await counts()).toMatchObject({ started: 1, container: 0 });
  });

  describe("read-only git, which the Worker Shell answers as git does", () => {
    /** A repository with `notes.txt` and `package.json` committed, as the Worker Shell's git writes it. */
    const repository = async () => {
      const opened = await open();

      await opened.setup(
        [
          "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com",
          "git init -b main && git add -A && git commit -m first",
        ].join("; "),
      );

      return opened;
    };

    /** The Worker Shell's `git status` lines as `git status --porcelain` writes them (`1 XY path` is ` M path`), sorted. */
    const porcelain = (text: string) =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const entry = /^1 (..) (.+)$/.exec(line);

          if (entry !== null) return `${entry[1]} ${entry[2]}`;

          const untracked = /^\? (.+)$/.exec(line);

          if (untracked !== null) return `?? ${untracked[1]}`;

          throw new Error(`unrecognized git status line: ${line}`);
        })
        .sort();

    it("lists unstaged changes and untracked files in git status, and nothing in a clean repository", async () => {
      const { run, setup, counts } = await repository();

      const clean = await run({ command: "git status" });

      expect(clean).toMatchObject({ isError: false });
      expect(clean.text.trim()).toBe("");

      await setup("echo more >> notes.txt && rm package.json && echo new > new.txt");

      const status = await run({ command: "git status" });

      expect(status.isError).toBe(false);
      // What `git status --porcelain` writes for the same tree.
      expect(porcelain(status.text)).toEqual([" D package.json", " M notes.txt", "?? new.txt"]);
      expect(await counts()).toMatchObject({ container: 0 });
    });

    it("lists the index in git ls-files", async () => {
      const { run, setup, counts } = await repository();

      await setup("echo new > new.txt");

      const files = await run({ command: "git ls-files" });

      // `new.txt` is untracked, so it is not in the index.
      expect(files).toEqual({ text: "notes.txt\npackage.json\n", isError: false });
      expect(await counts()).toMatchObject({ container: 0 });
    });

    it("lists the branches in git branch, and the current one in --show-current", async () => {
      const { run, setup, counts } = await repository();

      await setup("git branch dev");

      expect(await run({ command: "git branch" })).toEqual({
        text: "  dev\n* main\n",
        isError: false,
      });
      expect(await run({ command: "git branch --show-current" })).toEqual({
        text: "main\n",
        isError: false,
      });
      expect(await counts()).toMatchObject({ container: 0 });
    });

    it("answers rev-parse and log --oneline with the same commit", async () => {
      const { run, counts } = await repository();

      const head = await run({ command: "git rev-parse HEAD" });
      const branch = await run({ command: "git rev-parse --abbrev-ref HEAD" });
      const top = await run({ command: "git rev-parse --show-toplevel" });
      const log = await run({ command: "git log --oneline" });

      expect(head.text).toMatch(/^[0-9a-f]{40}\n$/);
      expect(branch.text).toBe("main\n");
      expect(top.text).toMatch(/\/case-\d+\n$/);
      // `--oneline` abbreviates the hash to 7 characters, as git does.
      expect(log.text).toMatch(/^[0-9a-f]{7} first$/m);
      expect(log.text.slice(0, 7)).toBe(head.text.slice(0, 7));
      expect([head, branch, top, log].map((result) => result.isError)).toEqual([
        false,
        false,
        false,
        false,
      ]);
      expect(await counts()).toMatchObject({ container: 0 });
    });

    it("refuses a repository whose packfiles are too big to read into the Workspace's memory", async () => {
      const { run, put, counts } = await repository();

      // isomorphic-git reads a whole packfile, and the Workspace DO has 128 MB. A pack of this size is not a valid one;
      // the guard answers before git opens it.
      await put(".git/objects/pack/pack-big.pack", new Uint8Array(MAX_PACK_BYTES + 1));

      const status = await run({ command: "git status" });

      expect(status.isError).toBe(true);
      expect(status.text).toMatch(/packfiles are 17 MB.*backend: "container"/);
      expect(await counts()).toMatchObject({ container: 0 });
    });

    it("reads a repository whose packfiles are within the limit", async () => {
      const { run, put } = await repository();

      // Not a valid pack, but small: git does not open it for `status` in a repository whose objects are loose.
      await put(".git/objects/pack/pack-small.pack", new Uint8Array(1024));

      expect(await run({ command: "git status" })).toMatchObject({ isError: false });
    });

    // The Container's real git writes the index and the objects, and the Worker Shell's git reads them after sync. These
    // files are what real git 2.5x wrote for `a.txt` ("hi") and `b.txt` ("n"), committed as "first".
    const REAL_GIT_FILES = {
      ".git/index":
        "RElSQwAAAAIAAAACatfffywf0vNq199/LB/S8wEAABILPCZDAACBpAAAAfUAAAAAAAAAA0W5g742tzwHiNycvLdsu4D8e7BXAAVhLnR4dAAAAAAAatfffywguj1q199/LCC6PQEAABILPCZEAACBpAAAAfUAAAAAAAAAAoujoWOEqsw30BVksoQBdVzoBT9RAAViLnR4dAAAAAAAVFJFRQAAABkAMiAwCt14lefPhLy30YQQP6/lYDRQdjZZpKfI5OI0BtsfWOnm+md22kh/7Sc=",
      ".git/refs/heads/main": "NGY0NTBjY2M4MmFmY2RiNDk4YjE1YWUzYmE4ZWU2N2ZjZTZkNmNmMgo=",
      ".git/objects/45/b983be36b73c0788dc9cbcb76cbb80fc7bb057": "eAFLyslPUjBmyMjkAgARowLO",
      ".git/objects/dd/7895e7cf84bcb7d184103fafe5603450763659":
        "eAErKUpNVTAzYzA0MDAzMVFI1CupKGFw3dm8z2y7DXvHnTl7tufsbvhTvSEcqiAJrKB78cLkllVnzC+IpmxqYSyNecFqHwgA+zMc8g==",
      ".git/objects/4f/450ccc82afcdb498b15ae3ba8ee67fce6d6cf2":
        "eAF9zD0KgDAMQGHnniK7S/qbCiJeRdsUHUSoETy+xQP45o+XzuPYBbTBTioz5Exx8EypRLemlbKOTqMtS2Ef0DqPFGzwg1pu2c4KAqPMzwSaAhnTCEKPLZW+sfAPUWWvl6gXifwjhg==",
      ".git/objects/8b/a3a16384aacc37d01564b28401755ce8053f51": "eAFLyslPUjBiyOMCAA5+Amo=",
    };

    it("reads a commit and an index real git wrote after the repository had none", async () => {
      const { run, setup, put, counts } = await open();

      await setup("git init -b main");
      // The Worker Shell's git reads the repository while its index does not exist yet.
      expect(await run({ command: "git status" })).toMatchObject({ isError: false });

      await setup("printf 'hi\\n' > a.txt && printf 'n\\n' > b.txt");

      for (const [path, data] of Object.entries(REAL_GIT_FILES)) {
        await put(
          path,
          Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
        );
      }

      const files = await run({ command: "git ls-files" });
      const log = await run({ command: "git log --oneline" });
      const status = await run({ command: "git status" });

      expect(files.text).toBe("a.txt\nb.txt\n");
      expect(log.text).toMatch(/^4f450cc first$/m);
      // `notes.txt` and `package.json` are the case's own files, which real git never saw.
      expect(porcelain(status.text)).toEqual(["?? notes.txt", "?? package.json"]);
      expect(await counts()).toMatchObject({ container: 0 });
    });
  });

  // git that writes the index or a ref, or whose output the Worker Shell's git gets wrong, goes to the Container.
  it.each([
    "git add -A",
    "git commit -m x",
    "git diff",
    "git show",
    "git branch dev",
    "git status --short",
    "git log",
  ])("sends `%s` to the Container", async (command) => {
    const { run, counts } = await open();

    await run({ command });

    expect(await counts()).toMatchObject({ started: 1, container: 1 });
  });

  it.each(["node -v", "npm test", "gh pr list", "cat notes.txt && node x.js", "git push"])(
    "sends `%s` to the Container",
    async (command) => {
      const { run, counts } = await open();

      // This test Worker has no Container, so the command fails; what matters is that it was sent there.
      await run({ command });

      expect(await counts()).toMatchObject({ started: 1, container: 1 });
    },
  );

  it("runs an explicit worker backend on the Worker Shell even for a binary, which fails there", async () => {
    const { run, counts } = await open();

    const result = await run({ command: "node -v", backend: "worker" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not found/);
    expect(await counts()).toMatchObject({ started: 1, container: 0 });
  });

  // The router sends a command to the Worker Shell by name, so a Worker Shell that lacks one would fail it there.
  it("has every command and builtin the router sends to the Worker Shell", async () => {
    const { run } = await open();
    const missing: string[] = [];

    for (const name of [...WORKER_SHELL_COMMANDS, "git"]) {
      const result = await run({ command: `command -v '${name}'`, backend: "worker" });

      // `command -v` prints where it found the command, and exits nonzero for one it did not.
      if (result.isError || result.text.trim() === "") missing.push(name);
    }

    for (const name of WORKER_SHELL_BUILTINS) {
      // `type -t` prints `builtin` or `keyword`, and nothing for a name that is not a command at all (quoted: `[[` is a keyword).
      const result = await run({ command: `type -t '${name}'`, backend: "worker" });

      if (result.isError || result.text.trim() === "") missing.push(name);
    }

    expect(missing).toEqual([]);
  });
});
