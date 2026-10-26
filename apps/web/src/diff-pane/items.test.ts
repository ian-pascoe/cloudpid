// @effect-diagnostics preferEffectArray:off -- fixtures over native arrays.
import type { ChangeEntry } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { fileDiffOf } from "./file-diff.ts";
import { itemsOf } from "./items.ts";
import { lineUp } from "./line-up.ts";
import type { Loads } from "./loader.ts";
import { paneFilesOf } from "./pane-files.ts";

const entry = (path: string): ChangeEntry => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
});

const filesOf = (paths: readonly string[]) =>
  paneFilesOf([
    {
      repo: "web",
      head: { commit: "abc", branch: "main" },
      files: paths.map(entry),
      more: 0,
      stale: false,
    },
  ]);

const NOTHING: Loads = { loaded: new Map(), loading: new Set() };

describe("itemsOf", () => {
  it("keeps an item whose drawing is the same, though the list was built again", () => {
    const first = itemsOf(filesOf(["a.ts", "b.ts"]), new Set(), NOTHING, new Map());
    const again = itemsOf(filesOf(["a.ts", "b.ts"]), new Set(), NOTHING, first);

    expect(again.get("web/a.ts")).toBe(first.get("web/a.ts"));
    expect(again.get("web/a.ts")?.collapsed).toBe(true);
  });

  it("makes a new version of a file that loaded, or was folded", () => {
    const files = filesOf(["a.ts", "b.ts"]);
    const first = itemsOf(files, new Set(), NOTHING, new Map());
    const { patch } = lineUp({ oldName: "a.ts", newName: "a.ts", oldText: "x\n", newText: "y\n" });

    const diff = fileDiffOf({
      names: files[0]!.names,
      oldText: "x\n",
      newText: "y\n",
      patch,
      cacheKey: "a",
    })!;

    const loaded = itemsOf(
      files,
      new Set(["web/b.ts"]),
      {
        loaded: new Map([
          [
            "web/a.ts",
            {
              signature: files[0]!.signature,
              listing: 1,
              contents: { kind: "ready", diff, replaced: false, oldText: "x\n", newText: "y\n" },
            },
          ],
        ]),
        loading: new Set(),
      },
      first,
    );

    expect(loaded.get("web/a.ts")).toMatchObject({ collapsed: false, version: 2 });
    expect(loaded.get("web/a.ts")?.fileDiff).toBe(diff);
    // Folded, and with no lines either way: the same drawing.
    expect(loaded.get("web/b.ts")).toBe(first.get("web/b.ts"));
  });
});
