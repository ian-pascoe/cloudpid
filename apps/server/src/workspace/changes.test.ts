// The Changes module's choice of backend, and what it keeps, over repos real git made in a temp directory: the
// Workspace DO's files are that directory (as `/workspace`), and the Container is bash running the real script there.
// The Workspace DO's own reading is covered in workerd (`changes.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off processEnv:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@cloudpid/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChangesFiles,
  COUNT_WORK,
  type ContainerOnly,
  type KeptChanges,
  LISTING_COUNT_WORK,
  WorkspaceChangesModule,
} from "./changes.ts";

const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();

  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A Workspace root holding repo `name`, `head` committed on `main`, then `change` written over it. */
const workspace = (
  name: string,
  head: Readonly<Record<string, string>>,
  change: Readonly<Record<string, string>>,
) => {
  const root = mkdtempSync(join(tmpdir(), "changes-module-"));
  const dir = join(root, name);

  roots.push(root);

  /** Write `path`, made `ago` seconds back. */
  const write = (path: string, content: string, ago = 0) => {
    const full = join(dir, path);

    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    // Committed files are made in the past, so a same-size edit's stat differs from the index's (racy git): in a
    // Workspace no stat matches git's anyway, as the Workspace DO's files have their own inodes.
    utimesSync(full, new Date(), new Date(Date.now() - ago * 1000));
  };

  const sh = (script: string, cwd = dir) => {
    const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env });

    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  mkdirSync(dir);
  sh("git init -q -b main");

  for (const [path, content] of Object.entries(head)) write(path, content, 100);

  sh("git add -A && git commit -q -m first");

  for (const [path, content] of Object.entries(change)) write(path, content);

  /** Paths whose stat fails in the Workspace DO (not as a missing file), though the Container's git reads them. */
  const broken = new Set<string>();

  /** The Workspace DO's files: the root, as `/workspace`. */
  const files: ChangesFiles = {
    readFile: (path, options) =>
      fsp.readFile(root + path.slice(WORKSPACE_ROOT.length), options ?? null),
    stat: (path) => fsp.stat(root + path.slice(WORKSPACE_ROOT.length)),
    lstat: (path) =>
      broken.has(path)
        ? Promise.reject(Object.assign(new Error("EIO: the provider failed"), { code: "EIO" }))
        : fsp.lstat(root + path.slice(WORKSPACE_ROOT.length)),
    readdir: (path) => fsp.readdir(root + path.slice(WORKSPACE_ROOT.length)),
    readlink: (path) => fsp.readlink(root + path.slice(WORKSPACE_ROOT.length)),
  };

  return { root, write, sh, files, broken };
};

/** A module over `space`, its Container started by a call that may start it, and its runs and kept lists recorded. */
const module = (
  space: ReturnType<typeof workspace>,
  options: { readonly maxTrackedFiles?: number; readonly containerOnly?: ContainerOnly } = {},
) => {
  const kept = new Map<string, KeptChanges>();
  const container = { running: false, runs: 0, fails: false };

  const changes = new WorkspaceChangesModule({
    files: () => space.files,
    containerOnly: async () => options.containerOnly ?? (() => false),
    running: () => container.running,
    run: async (script) => {
      container.runs++;
      container.running = true;

      if (container.fails) return { exitCode: 1, stdout: "", stderr: "git: no\n" };

      // The script the Workspace DO runs, for `/workspace`, is run on the temp root instead.
      expect(script).toMatch(/^root=.*\/workspace.*$/mu);

      return space.sh(script.replace(/^root=.*$/mu, `root='${space.root}'`), space.root);
    },
    kept: {
      load: async (repo) => kept.get(repo),
      save: async (repo, list) => {
        kept.set(repo, list);
      },
    },
    warn: () => {},
    maxTrackedFiles: options.maxTrackedFiles,
  });

  return { changes, kept, container };
};

describe("the Changes module", () => {
  it("lists a repo whose .gitattributes git applies through the Container, and keeps the list for when it stops", async () => {
    const space = workspace(
      "app",
      {
        ".gitattributes": "* text=auto eol=lf\n*.gen.ts linguist-generated\n",
        "a.txt": "one\ntwo\n",
        "b.gen.ts": "x\n",
      },
      { "a.txt": "one\r\ntwo\r\n", "b.gen.ts": "y\n", "c.txt": "new\n" },
    );

    const { changes, kept, container } = module(space);
    const request = { directory: "/workspace/app" } as const;

    // Automatic, with the Container stopped: nothing to show yet, "may be out of date", and the Container stays stopped.
    expect((await changes.list({ ...request, startContainer: false })).repos).toEqual([
      {
        repo: "app",
        head: { commit: expect.any(String), branch: "main" },
        files: [],
        more: 0,
        stale: true,
      },
    ]);
    expect(container.runs).toBe(0);

    // The owner's Refresh starts it: git's own view, so the CRLF-only change to a.txt is no change.
    const listed = [
      { path: "b.gen.ts", status: "modified", additions: 1, deletions: 1, generated: true },
      { path: "c.txt", status: "added", additions: 1, deletions: 0 },
    ];

    expect((await changes.list({ ...request, startContainer: true })).repos).toEqual([
      {
        repo: "app",
        head: { commit: expect.any(String), branch: "main" },
        files: listed,
        more: 0,
        stale: false,
      },
    ]);
    expect(container.runs).toBe(1);
    expect(kept.get("app")).toEqual({ files: listed, more: 0 });

    // Running, an automatic refresh uses it too.
    space.write("d.txt", "more\n");
    expect(
      (await changes.list({ ...request, startContainer: false })).repos[0]?.files.map(
        (file) => file.path,
      ),
    ).toEqual(["b.gen.ts", "c.txt", "d.txt"]);
    expect(container.runs).toBe(2);

    // Stopped again: the last list, "may be out of date".
    container.running = false;
    space.write("e.txt", "unseen\n");
    expect((await changes.list({ ...request, startContainer: false })).repos[0]).toMatchObject({
      stale: true,
      files: [{ path: "b.gen.ts" }, { path: "c.txt" }, { path: "d.txt" }],
    });
    expect(container.runs).toBe(2);
  });

  it("says why when the Container's listing fails, and still shows the last list", async () => {
    const space = workspace(
      "app",
      { ".gitattributes": "* text\n", "a.txt": "a\n" },
      { "a.txt": "b\n" },
    );

    const { changes, container } = module(space);

    await changes.list({ directory: "/workspace", startContainer: true });
    container.fails = true;

    expect(
      (await changes.list({ directory: "/workspace", startContainer: true })).repos[0],
    ).toMatchObject({
      stale: true,
      files: [{ path: "a.txt", status: "modified" }],
      error: expect.stringContaining("git: no"),
    });
  });

  it("sends a repo with more tracked files than the guard to the Container", async () => {
    const space = workspace("app", { "a.txt": "a\n", "b.txt": "b\n" }, { "a.txt": "c\n" });

    expect(
      (
        await module(space, { maxTrackedFiles: 2 }).changes.list({
          directory: "/workspace",
          startContainer: false,
        })
      ).repos[0],
    ).toMatchObject({
      stale: false,
      files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }],
    });

    const guarded = module(space, { maxTrackedFiles: 1 });

    expect(
      (await guarded.changes.list({ directory: "/workspace", startContainer: false })).repos[0],
    ).toMatchObject({
      stale: true,
      files: [],
    });
    expect(guarded.container.runs).toBe(0);
    expect(
      (await guarded.changes.list({ directory: "/workspace", startContainer: true })).repos[0],
    ).toMatchObject({
      stale: false,
      files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }],
    });
  });

  it("refuses a HEAD side it would need a stopped Container for, rather than start it", async () => {
    const space = workspace("app", { "a.txt": "a\n" }, { "a.txt": "b\n" });

    // A pack over the cap: isomorphic-git does not read it.
    mkdirSync(join(space.root, "app/.git/objects/pack"), { recursive: true });
    writeFileSync(
      join(space.root, "app/.git/objects/pack/pack-big.pack"),
      new Uint8Array(16 * 1024 * 1024 + 1),
    );

    const { changes, container } = module(space);

    await expect(changes.file({ repo: "app", path: "a.txt" })).rejects.toThrow(
      /needs the Container, which is stopped/,
    );
    expect(container.runs).toBe(0);
  });

  it("sends a repo isomorphic-git fails on to the Container's git", async () => {
    const space = workspace("app", { "a.txt": "a\n" }, { "a.txt": "b\n" });

    space.broken.add("/workspace/app/a.txt");

    const { changes, container } = module(space);

    expect(
      (await changes.list({ directory: "/workspace", startContainer: false })).repos[0],
    ).toMatchObject({ stale: true, files: [] });
    expect(container.runs).toBe(0);
    expect(
      (await changes.list({ directory: "/workspace", startContainer: true })).repos[0],
    ).toMatchObject({
      stale: false,
      files: [{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }],
    });
  });

  it("leaves the Container-only paths out of the Container's list too", async () => {
    const space = workspace(
      "app",
      { ".gitattributes": "* text\n", "a.txt": "a\n", "target/out.txt": "x\n", "old.txt": "o\n" },
      { "a.txt": "b\n", "target/out.txt": "y\n", "target/new.txt": "n\n" },
    );

    // A rename from a path the Workspace DO holds onto a Container-only one is left out too.
    space.sh("mv old.txt target/old.txt");

    const { changes } = module(space, {
      containerOnly: (path) => path.startsWith("/workspace/app/target/"),
    });

    expect(
      (await changes.list({ directory: "/workspace", startContainer: true })).repos[0],
    ).toMatchObject({
      stale: false,
      files: [{ path: "a.txt", status: "modified" }],
      more: 0,
    });
  });

  it("does not count a pair whose HEAD side is over 1 MiB, as for the working side", async () => {
    const big = "x\n".repeat(512 * 1024 + 1);
    const space = workspace("app", { "big.txt": big }, { "big.txt": "small\n" });

    expect(
      (await module(space).changes.list({ directory: "/workspace", startContainer: false }))
        .repos[0]?.files,
    ).toEqual([
      { path: "big.txt", status: "modified", additions: null, deletions: null, tooLarge: true },
    ]);
  });

  it("bounds lining up by the work it takes, not the clock, which stands still while code runs deployed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const numbered = (count: number, tag: string) =>
      Array.from({ length: count }, (_, index) => `${tag} ${index}\n`).join("");

    // Files of `lines` lines each side are lined up for `COUNT_WORK / (2 × lines)` edits at most, and the listing for
    // `LISTING_COUNT_WORK` in all, so each of these takes a whole file's share of the listing's budget.
    const lines = 5_000;
    const shares = Math.floor(LISTING_COUNT_WORK / COUNT_WORK);
    // Each its own, so no count is reused.
    const indexes = Array.from({ length: shares }, (_, index) => index);

    const space = workspace(
      "app",
      {
        // Listed first: every line changed, more edits than are looked for.
        "0-rewrite.txt": numbered(lines, "old"),
        ...Object.fromEntries(
          indexes.map((index) => [`f${index}.txt`, numbered(lines, `file${index}`)]),
        ),
      },
      {
        "0-rewrite.txt": numbered(lines, "new"),
        ...Object.fromEntries(
          indexes.map((index) => [
            `f${index}.txt`,
            numbered(lines, `file${index}`).replace(`file${index} 7\n`, "changed 7\n"),
          ]),
        ),
      },
    );

    const listed = await module(space).changes.list({
      directory: "/workspace",
      startContainer: false,
    });

    const exact = { status: "modified", additions: 1, deletions: 1 };
    const whole = { status: "modified", additions: lines, deletions: lines, approximate: true };

    expect(listed.repos[0]?.files).toEqual([
      // "≈" though the clock never moved.
      { path: "0-rewrite.txt", ...whole },
      // One edit each, lined up until the listing's budget is spent; the file past it gets whole-file numbers.
      ...Array.from({ length: shares - 1 }, (_, index) => ({ path: `f${index}.txt`, ...exact })),
      { path: `f${shares - 1}.txt`, ...whole },
    ]);
  });
});
