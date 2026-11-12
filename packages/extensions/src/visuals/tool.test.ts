// docs/architecture/visuals.md → The copy (Bounds), Testing. How `visual_show` reads the Workspace: a file is measured at its
// canonical path (every link on the way resolved) before it is read, and one there under `/dev`, `/proc` or `/sys`, one that
// is not a regular file, or one over the bound is never read.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- vitest awaits; a fake file system
// over plain maps.
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { visualFilesOf } from "./tool.ts";

type Env = Pick<ExecutionEnv, "absolutePath" | "fileInfo" | "canonicalPath" | "readBinaryFile">;

/** A file system of `files`, with `links` from a directory or file to its target, that records each path read. */
const envOf = (
  files: Readonly<Record<string, number>>,
  links: Readonly<Record<string, string>>,
  reads: string[],
): Env => {
  const canonical = (path: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (path === from || path.startsWith(`${from}/`))
        return canonical(to + path.slice(from.length));
    }

    return path;
  };

  return {
    absolutePath: async (path) => ok(path),
    canonicalPath: async (path) => ok(canonical(path)),
    fileInfo: async (path) => {
      const size = files[path];

      return size === undefined
        ? err(new FileError("not_found", "No such file", path))
        : ok({ name: path, path, kind: "file" as const, size, mtimeMs: 0 });
    },
    readBinaryFile: async (path) => {
      reads.push(path);

      const size = files[path];

      return size === undefined
        ? err(new FileError("not_found", "No such file", path))
        : ok(new Uint8Array(size));
    },
  };
};

describe("the Workspace as visual_show reads it", () => {
  const files = { "/workspace/page.html": 10, "/workspace/big.png": 2000, "/proc/self/environ": 5 };

  const links = {
    "/workspace/p": "/proc",
    "/workspace/alias.html": "/workspace/page.html",
  };

  it("reads a file at its canonical path", async () => {
    const reads: string[] = [];

    const read = await Effect.runPromise(
      visualFilesOf(envOf(files, links, reads)).read("/workspace/alias.html", 1000),
    );

    expect(read).toMatchObject({ kind: "file" });
    expect(reads).toEqual(["/workspace/page.html"]);
  });

  it("refuses a kernel file behind a linked directory, and a file over the bound, unread", async () => {
    const reads: string[] = [];
    const workspace = visualFilesOf(envOf(files, links, reads));

    expect(await Effect.runPromise(workspace.read("/workspace/p/self/environ", 1000))).toEqual({
      kind: "not_file",
    });
    expect(await Effect.runPromise(workspace.read("/workspace/big.png", 1000))).toEqual({
      kind: "too_large",
      size: 2000,
    });
    expect(await Effect.runPromise(workspace.read("/workspace/gone.png", 1000))).toEqual({
      kind: "missing",
    });
    expect(reads).toEqual([]);
  });
});
