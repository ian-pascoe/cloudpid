// @effect-diagnostics preferEffectArray:off -- fixtures and assertions over native arrays.
import type { ChangeEntry, RepoChanges } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  changeId,
  changesPreview,
  changesTotals,
  findChange,
  groupedByRepo,
  repoTotals,
} from "./changes.ts";

const file = (
  path: string,
  additions: number | null,
  deletions: number | null,
  more: Partial<ChangeEntry> = {},
): ChangeEntry => ({
  path,
  status: "modified",
  additions,
  deletions,
  ...more,
});

const repo = (
  name: string,
  files: readonly ChangeEntry[],
  more: Partial<RepoChanges> = {},
): RepoChanges => ({
  repo: name,
  head: { commit: "abc", branch: "main" },
  files,
  more: 0,
  stale: false,
  ...more,
});

describe("changedFiles", () => {
  it("lists every repo's files in order, each with an ID of its repo and path", () => {
    const files = changedFiles([
      repo("api", [file("a.ts", 1, 0)]),
      repo("web", [file("a.ts", 2, 1), file("b.ts", 0, 3)]),
    ]);

    expect(files.map((known) => known.id)).toEqual(["api/a.ts", "web/a.ts", "web/b.ts"]);
    expect(files[1]).toMatchObject({ repo: "web", entry: { path: "a.ts" } });
    expect(changeId("web", "src/x.ts")).toBe("web/src/x.ts");
  });
});

describe("changesTotals", () => {
  it("counts the files, the cap's leftovers included, and adds up the lines", () => {
    expect(
      changesTotals([
        repo("api", [file("a.ts", 4, 1), file("img.png", null, null, { binary: true })], {
          more: 3,
        }),
        repo("web", [file("b.ts", 2, 7)]),
      ]),
    ).toEqual({ files: 6, additions: 6, deletions: 8, approximate: false, stale: false });
  });

  it("is approximate when a file's counts are, and stale when a repo may be out of date", () => {
    expect(
      changesTotals([
        repo("api", [file("a.ts", 400, 300, { approximate: true })], { stale: true }),
      ]),
    ).toEqual({ files: 1, additions: 400, deletions: 300, approximate: true, stale: true });
  });

  it("counts a repo's own totals", () => {
    expect(repoTotals(repo("web", [file("a.ts", 1, 2), file("b.ts", 3, 4)], { more: 1 }))).toEqual({
      files: 3,
      additions: 4,
      deletions: 6,
      approximate: false,
      stale: false,
    });
  });
});

describe("groupedByRepo", () => {
  it("groups when the list holds more than one repo", () => {
    expect(groupedByRepo([repo("web", [file("a.ts", 1, 0)])])).toBe(false);
    expect(groupedByRepo([repo("api", []), repo("web", [file("a.ts", 1, 0)])])).toBe(true);
  });
});

describe("changesPreview", () => {
  it("shows the first files and says how many more there are, the cap's included", () => {
    const files = Array.from({ length: 12 }, (_, index) => file(`f${index}.ts`, 1, 0));
    const preview = changesPreview([repo("web", files, { more: 5 })], 10);

    expect(preview.shown.map((shown) => shown.entry.path)).toEqual(
      files.slice(0, 10).map((known) => known.path),
    );
    expect(preview.more).toBe(7);
  });

  it("shows them all when they fit", () => {
    const preview = changesPreview([repo("web", [file("a.ts", 1, 0)])], 10);

    expect(preview.shown).toHaveLength(1);
    expect(preview.more).toBe(0);
  });
});

describe("findChange", () => {
  const repos = [
    repo("api", [file("src/a.ts", 1, 0)]),
    repo("web", [file("src/a.ts", 2, 0), file("apps/web/src/b.ts", 1, 1)]),
  ];

  it("finds an absolute path in its repo", () => {
    expect(findChange(repos, "/workspace/web/src/a.ts")?.id).toBe("web/src/a.ts");
    expect(findChange(repos, "/workspace/api/src/a.ts")?.id).toBe("api/src/a.ts");
    expect(findChange(repos, "/workspace/web/apps/../src/./a.ts")?.id).toBe("web/src/a.ts");
  });

  it("takes a relative path from the Workspace root when the list holds several repos", () => {
    expect(findChange(repos, "web/src/a.ts")?.id).toBe("web/src/a.ts");
    expect(findChange(repos, "./api//src/a.ts")?.id).toBe("api/src/a.ts");
    expect(findChange(repos, "src/a.ts")).toBeUndefined();
  });

  it("takes a relative path from the repo's clone when the list holds one", () => {
    const one = [repo("web", [file("src/index.ts", 1, 0), file("README.md", 1, 0)])];

    expect(findChange(one, "src/index.ts")?.id).toBe("web/src/index.ts");
    expect(findChange(one, "index.ts")).toBeUndefined();
    expect(findChange(one, "../web/README.md")?.id).toBe("web/README.md");
  });

  it("finds nothing for a file without Changes, or a partial name", () => {
    expect(findChange(repos, "/workspace/web/src/c.ts")).toBeUndefined();
    expect(findChange(repos, "web/src/a.ts.bak")).toBeUndefined();
    expect(findChange(repos, "/workspace/web/rc/a.ts")).toBeUndefined();
    expect(findChange(repos, "/etc/passwd")).toBeUndefined();
    expect(findChange([], "src/a.ts")).toBeUndefined();
  });
});
