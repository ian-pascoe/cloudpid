// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- tests of plain functions over values.
import type { PullSource, RepoChanges, ViewedFile } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { foldedFiles, isViewed, paneFilesOf, viewedFileIds } from "./pane-files.ts";

const source: PullSource = {
  kind: "pull",
  repo: "app",
  number: 7,
  title: "Fix it",
  mergeBase: "b".repeat(40),
  head: "a".repeat(40),
};

const repos = (blobs: Record<string, string>): readonly RepoChanges[] => [
  {
    repo: "app",
    head: { commit: source.head, branch: "topic" },
    files: Object.entries(blobs).map(([path, blob]) => ({
      path,
      status: "modified",
      additions: 1,
      deletions: 0,
      blob,
    })),
    more: 0,
    stale: false,
  },
];

const box = (path: string, blob: string, pull = 7): ViewedFile => ({
  repo: "app",
  pull,
  path,
  blob,
});

describe("a pull request's Viewed boxes in the Pane", () => {
  const files = paneFilesOf(repos({ "a.ts": "blob-a", "b.ts": "blob-b" }), source);

  it("count only while the blob they were ticked at is the file's now", () => {
    expect(viewedFileIds(files, [box("a.ts", "blob-a"), box("b.ts", "an-older-blob")])).toEqual(
      new Set(["app/a.ts"]),
    );
  });

  it("belong to one pull request of one repo", () => {
    expect(isViewed(files[0]!, [box("a.ts", "blob-a", 8)])).toBe(false);
    expect(isViewed(files[0]!, [{ ...box("a.ts", "blob-a"), repo: "lib" }])).toBe(false);
  });

  it("are not a thing of the Changes or This branch, or of a file with no blob", () => {
    const changes = paneFilesOf(repos({ "a.ts": "blob-a" }));

    const noBlob = paneFilesOf(
      [
        {
          ...repos({})[0]!,
          files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
        },
      ],
      source,
    );

    expect(isViewed(changes[0]!, [box("a.ts", "blob-a")])).toBe(false);
    expect(isViewed(noBlob[0]!, [box("a.ts", "blob-a")])).toBe(false);
  });

  it("fold the file unless the owner opened it by hand", () => {
    const viewed = new Set(["app/a.ts"]);

    expect(foldedFiles(files, new Map(), viewed)).toEqual(new Set(["app/a.ts"]));
    expect(foldedFiles(files, new Map([["app/a.ts", false]]), viewed)).toEqual(new Set());
    expect(foldedFiles(files, new Map([["app/b.ts", true]]), viewed)).toEqual(
      new Set(["app/a.ts", "app/b.ts"]),
    );
  });

  it("make a file's signature carry the pair of commits, so a push loads it again", () => {
    const moved = paneFilesOf(repos({ "a.ts": "blob-a" }), { ...source, head: "c".repeat(40) });

    expect(moved[0]?.signature).not.toBe(files[0]?.signature);
  });
});
