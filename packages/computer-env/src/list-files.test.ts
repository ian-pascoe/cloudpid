// `listFiles`' walk over an in-memory file tree: what it skips is never walked, and a repository below the listed
// directory applies its own ignore rules. The conformance cases (`apps/server/src/workspace/env.workerd.test.ts`) check
// the rest against a real Workspace.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import type { Workspace } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import { listFiles } from "./list-files.ts";

/** A file tree of `files` (absolute path to text; a path ending in `/` is an empty directory), and the directories walked. */
const treeOf = (files: Readonly<Record<string, string>>) => {
  const nodes = new Map<string, "file" | "dir">([["/", "dir"]]);
  const walked: string[] = [];

  for (const path of Object.keys(files)) {
    const parts = path.replace(/\/$/, "").split("/").slice(1);

    parts.forEach((_, index) => {
      const at = `/${parts.slice(0, index + 1).join("/")}`;

      nodes.set(at, index === parts.length - 1 && !path.endsWith("/") ? "file" : "dir");
    });
  }

  const missing = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

  const fs = {
    stat: async (path: string) => {
      const type = nodes.get(path);

      if (type === undefined) throw missing();

      return { isDirectory: type === "dir" };
    },
    lstat: async (path: string) => {
      if (!nodes.has(path)) throw missing();

      return {};
    },
    readFile: async (path: string) => {
      const text = files[path];

      if (text === undefined) throw missing();

      return text;
    },
    find: async (directory: string, _pattern: undefined, options: { exclude: string[] }) => {
      expect(options.exclude).toEqual(["*/*"]);
      walked.push(directory);

      const prefix = directory === "/" ? "/" : `${directory}/`;

      return [...nodes.entries()]
        .flatMap(([path, type]) =>
          path !== "/" && path.startsWith(prefix) && !path.slice(prefix.length).includes("/")
            ? [{ path, type }]
            : [],
        )
        .toSorted((a, b) => (a.path < b.path ? -1 : 1));
    },
  };

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: `listFiles` uses only `stat`, `lstat`, `readFile` and `find`, which the fake answers.
  return { fs: fs as unknown as Workspace["fs"], walked };
};

const paths = async (
  tree: ReturnType<typeof treeOf>,
  path: string,
  options: Parameters<typeof listFiles>[2] = {},
) => (await listFiles(tree.fs, path, options)).entries.map((entry) => entry.path);

describe("listFiles' walk", () => {
  it("never walks a directory it skips: excluded, ignored, or .git", async () => {
    const tree = treeOf({
      "/w/.git/HEAD": "ref",
      "/w/.gitignore": "dist/\n",
      "/w/src/a.ts": "",
      "/w/dist/x/y.js": "",
      "/w/node_modules/m/i.js": "",
    });

    expect(await paths(tree, "/w", { exclude: ["node_modules"] })).toEqual([
      ".gitignore",
      "src",
      "src/a.ts",
    ]);
    expect(tree.walked).toEqual(["/w", "/w/src"]);
  });

  it("applies a repository's rules below a directory outside any work tree, from that repository on", async () => {
    const tree = treeOf({
      "/workspace/notes.log": "",
      "/workspace/repo/.git/HEAD": "ref",
      "/workspace/repo/.git/info/exclude": "secret.txt\n",
      "/workspace/repo/.gitignore": "*.log\nbuild/\n",
      "/workspace/repo/app.log": "",
      "/workspace/repo/build/out.js": "",
      "/workspace/repo/secret.txt": "",
      "/workspace/repo/src/.gitignore": "!keep.log\n",
      "/workspace/repo/src/keep.log": "",
      "/workspace/repo/src/main.ts": "",
      "/workspace/plain/.gitignore": "*\n",
      "/workspace/plain/kept.txt": "",
    });

    expect(await paths(tree, "/workspace")).toEqual([
      "notes.log",
      "plain",
      "plain/.gitignore",
      "plain/kept.txt",
      "repo",
      "repo/.gitignore",
      "repo/src",
      "repo/src/.gitignore",
      "repo/src/keep.log",
      "repo/src/main.ts",
    ]);
    expect(tree.walked).not.toContain("/workspace/repo/build");
  });

  it("gives a nested repository its own rules, not those of the one around it", async () => {
    const tree = treeOf({
      "/w/.git/HEAD": "ref",
      "/w/.gitignore": "*.tmp\n",
      "/w/a.tmp": "",
      "/w/vendor/lib/.git/HEAD": "ref",
      "/w/vendor/lib/.gitignore": "*.o\n",
      "/w/vendor/lib/b.tmp": "",
      "/w/vendor/lib/c.o": "",
    });

    expect(await paths(tree, "/w")).toEqual([
      ".gitignore",
      "vendor",
      "vendor/lib",
      "vendor/lib/.gitignore",
      "vendor/lib/b.tmp",
    ]);
    expect(await paths(tree, "/w", { gitignore: false })).toContain("vendor/lib/c.o");
  });

  it("stops at its bounds without walking further", async () => {
    const tree = treeOf({ "/w/a/1": "", "/w/a/2": "", "/w/b/3": "" });

    expect(await listFiles(tree.fs, "/w", { maxEntries: 2 })).toEqual({
      entries: [
        { path: "a", kind: "directory" },
        { path: "a/1", kind: "file" },
      ],
      truncated: true,
    });
    expect(tree.walked).toEqual(["/w", "/w/a"]);
  });
});
