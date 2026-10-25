// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { ComputerExecutionEnv, ComputerFiles } from "@cloudpid/computer-env";
import { Files, WorkspaceFiles } from "@cloudpid/extensions/files";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it } from "vitest";
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

const workspace = env.WORKSPACES.getByName("files");

const executionEnv = new ComputerExecutionEnv({
  workspace,
  id: "computer:files",
  cwd: "/workspace/repo",
});

const extension = await Effect.runPromise(
  Files.pipe(Effect.provideService(WorkspaceFiles, () => new ComputerFiles(workspace))),
);

/** What the model reads from calling `name`: the result's text, and whether it is an error. */
const call = async (name: string, args: Record<string, string | number | boolean>) => {
  const tool = extension.tools?.find((candidate) => candidate.name === name);

  if (tool === undefined) throw new Error(`No tool ${name}`);

  // SAFETY: the tools read only the call's environment from the API.
  const result = await tool.execute(args, { env: executionEnv } as never, context);

  return {
    text:
      result.output?.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ?? "",
    isError: result.isError === true,
    details: result.details,
  };
};

const write = async (path: string, content: string) =>
  getOrThrow(await executionEnv.writeFile(path, content, context));

beforeAll(async () => {
  await write("README.md", "# Repo\nA needle in a haystack.\n");
  await write("src/a.ts", "export const a = 1;\nconst Needle = 'x';\n");
  await write("src/deep/b.ts", "line one\nline two\nneedle here\nline four\nline five\n");
  await write("src/deep/c.json", "{}");
  await write(".env", "NEEDLE=1\n");
  await write("node_modules/dep/index.ts", "needle\n");
  await write(".git/config", "needle\n");
  getOrThrow(await executionEnv.createDir("empty", { recursive: true }, context));
});

describe("ls", () => {
  it("lists a directory alphabetically, dotfiles included, directories with a slash", async () => {
    expect(await call("ls", {})).toMatchObject({
      text: ".env\n.git/\nempty/\nnode_modules/\nREADME.md\nsrc/",
      isError: false,
    });
    expect((await call("ls", { path: "src" })).text).toBe("a.ts\ndeep/");
  });

  it("says so for an empty directory, and fails for a path that is missing or a file", async () => {
    expect((await call("ls", { path: "empty" })).text).toBe("(empty directory)");
    expect(await call("ls", { path: "nope" })).toEqual({
      text: "Path not found: /workspace/repo/nope",
      isError: true,
      details: undefined,
    });
    expect(await call("ls", { path: "README.md" })).toMatchObject({
      text: "Not a directory: /workspace/repo/README.md",
      isError: true,
    });
  });

  it("stops at the limit and says how to see more", async () => {
    const listed = await call("ls", { limit: 2 });

    expect(listed.text).toBe(".env\n.git/\n\n[2 entries limit reached. Use limit=4 for more]");
    expect(listed.details).toEqual({ entryLimitReached: 2 });
  });
});

describe("find", () => {
  it("finds files by glob at any depth, relative to the searched directory", async () => {
    expect((await call("find", { pattern: "*.ts" })).text).toBe("src/a.ts\nsrc/deep/b.ts");
    expect((await call("find", { pattern: "**/*.json", path: "src" })).text).toBe("deep/c.json");
    expect((await call("find", { pattern: "src/**/*.ts" })).text).toBe("src/a.ts\nsrc/deep/b.ts");
  });

  it("lists matching directories with a slash, and skips node_modules and .git", async () => {
    expect((await call("find", { pattern: "dee*" })).text).toBe("src/deep/");
    expect((await call("find", { pattern: "**" })).text).not.toMatch(/node_modules|\.git/);
  });

  it("says so when nothing matches, and fails for a missing path", async () => {
    expect((await call("find", { pattern: "*.rs" })).text).toBe("No files found matching pattern");
    expect(await call("find", { pattern: "*", path: "nope" })).toMatchObject({ isError: true });
  });

  it("stops at the limit and says how to see more", async () => {
    const found = await call("find", { pattern: "*.ts", limit: 1 });

    expect(found.text).toBe(
      "src/a.ts\n\n[1 results limit reached. Use limit=2 for more, or refine pattern]",
    );
    expect(found.details).toEqual({ resultLimitReached: 1 });
  });
});

describe("grep", () => {
  it("finds matching lines with their path and line number, below the searched directory", async () => {
    expect((await call("grep", { pattern: "needle", literal: true })).text).toBe(
      "README.md:2: A needle in a haystack.\nsrc/deep/b.ts:3: needle here",
    );
  });

  it("matches a regular expression unless told the pattern is literal, and can ignore case", async () => {
    expect((await call("grep", { pattern: "^line (one|five)$", glob: "*.ts" })).text).toBe(
      "src/deep/b.ts:1: line one\nsrc/deep/b.ts:5: line five",
    );
    expect((await call("grep", { pattern: "needle", ignoreCase: true, glob: "*.ts" })).text).toBe(
      "src/a.ts:2: const Needle = 'x';\nsrc/deep/b.ts:3: needle here",
    );
    expect((await call("grep", { pattern: "(", literal: true, glob: "*.ts" })).text).toBe(
      "No matches found",
    );
    expect((await call("grep", { pattern: "(" })).isError).toBe(true);
  });

  it("shows the lines around each match, marked as context", async () => {
    expect((await call("grep", { pattern: "needle", glob: "*.ts", context: 1 })).text).toBe(
      "src/deep/b.ts-2- line two\nsrc/deep/b.ts:3: needle here\nsrc/deep/b.ts-4- line four",
    );
  });

  it("names a searched file by its own name, and fails for a missing path", async () => {
    expect((await call("grep", { pattern: "two", path: "src/deep/b.ts" })).text).toBe(
      "b.ts:2: line two",
    );
    expect(await call("grep", { pattern: "x", path: "nope" })).toMatchObject({
      text: "Path not found: /workspace/repo/nope",
      isError: true,
    });
  });

  it("stops at the limit, and cuts a long line", async () => {
    const limited = await call("grep", { pattern: "line", glob: "*.ts", limit: 2 });

    expect(limited.text).toBe(
      "src/deep/b.ts:1: line one\nsrc/deep/b.ts:2: line two\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]",
    );

    await write("long.txt", `${"x".repeat(600)}\n`);

    const long = await call("grep", { pattern: "xxx", path: "long.txt" });

    expect(long.text).toBe(
      `long.txt:1: ${"x".repeat(500)}... [truncated]\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]`,
    );
  });
});

describe("limit", () => {
  it.each(["ls", "find", "grep"])("must be a positive integer for %s", async (name) => {
    const args = name === "ls" ? {} : { pattern: "needle" };

    for (const limit of [0, -1, 2.5]) {
      const result = await call(name, { ...args, limit });

      expect(result.isError).toBe(true);
    }
  });

  it("must be a non-negative integer for grep's context", async () => {
    for (const context of [-1, 1.5]) {
      expect((await call("grep", { pattern: "needle", context })).isError).toBe(true);
    }
  });
});

describe("the harness's own files and the Container's", () => {
  it("are left out of a search from above /workspace/.cloudpid, and found by one inside it", async () => {
    await write("/workspace/.cloudpid/tmp/tmp-1/out.log", "needle in a spill\n");

    expect((await call("grep", { pattern: "spill", path: "/workspace" })).text).toBe(
      "No matches found",
    );
    expect((await call("find", { pattern: "*.log", path: "/workspace" })).text).toBe(
      "No files found matching pattern",
    );
    expect((await call("grep", { pattern: "spill", path: "/workspace/.cloudpid" })).text).toBe(
      "tmp/tmp-1/out.log:1: needle in a spill",
    );
  });

  it("marks the Container-only entries a listing of a synced directory brings", async () => {
    const files = new ComputerFiles(workspace);

    const marked = await Effect.runPromise(
      Files.pipe(
        Effect.provideService(WorkspaceFiles, () => ({
          readdir: async (path) => [
            ...(await files.readdir(path)),
            { name: ".venv", isDirectory: true, isSymbolicLink: false, containerOnly: true },
          ],
          find: (directory, pattern, options) => files.find(directory, pattern, options),
          grep: (pattern, path, options) => files.grep(pattern, path, options),
        })),
      ),
    );

    const ls = marked.tools?.find((candidate) => candidate.name === "ls");

    // SAFETY: the tools read only the call's environment from the API.
    const result = await ls?.execute({ path: "src" }, { env: executionEnv } as never, context);

    expect(result?.output).toEqual([
      { type: "text", text: ".venv/ (container-only)\na.ts\ndeep/" },
    ]);
  });
});

describe("a Workspace's Container", () => {
  it("is never started by ls, find, or grep on the Workspace's own paths, but is by a command", async () => {
    await call("ls", {});
    await call("find", { pattern: "*.ts" });
    await call("grep", { pattern: "needle" });

    expect((await workspace.liveStubs()).started).toBe(0);

    getOrThrow(await executionEnv.exec("echo hi", undefined, context));

    expect((await workspace.liveStubs()).started).toBe(1);
  });
});
