// The Call diff of `write`, and the diffs captured from a script's nested calls, as plain functions over text and over a
// fake file system.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BINARY_SCAN_BYTES,
  byteLength,
  capturedDiffs,
  MAX_CODEMODE_DIFF_BYTES,
  MAX_DIFF_INPUT_BYTES,
  MAX_EDIT_LENGTH,
  MAX_PATCH_BYTES,
  oldFile,
  storedBytes,
  writeDetails,
} from "./call-diff.ts";

const lines = (count: number, prefix = "line"): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join("");

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A clock that stands still, as workerd's does while code runs, so that jsdiff's `timeout` cannot fire and only the
 * bound on the lines that differ is under test, however slow the machine.
 */
const stillClock = () => {
  vi.spyOn(Date, "now").mockReturnValue(0);
};

describe("writeDetails", () => {
  it("records a patch of the whole text, and that the file was created, for a new file", () => {
    const details = writeDetails("src/a.txt", { kind: "missing" }, "one\ntwo\n");

    expect(details).toEqual({
      path: "src/a.txt",
      created: true,
      patch: "--- src/a.txt\n+++ src/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    });
  });

  it("records edit's patch for a file it changes: both headers name the path, four lines of context", () => {
    const old = lines(20);
    const next = old.replace("line 10\n", "line ten\n");

    const details = writeDetails("a.txt", { kind: "text", text: old }, next);

    expect(details.created).toBeUndefined();
    expect(details.patch).toBe(
      [
        "--- a.txt",
        "+++ a.txt",
        "@@ -6,9 +6,9 @@",
        " line 6",
        " line 7",
        " line 8",
        " line 9",
        "-line 10",
        "+line ten",
        " line 11",
        " line 12",
        " line 13",
        " line 14",
        "",
      ].join("\n"),
    );
  });

  it("records the headers alone for a write that left the file as it was", () => {
    expect(writeDetails("a.txt", { kind: "text", text: "same\n" }, "same\n")).toEqual({
      path: "a.txt",
      patch: "--- a.txt\n+++ a.txt\n",
    });
  });

  it("records only `binary` for an old file that is binary, and for one that could not be read", () => {
    expect(writeDetails("a.bin", { kind: "binary" }, "text")).toEqual({
      path: "a.bin",
      binary: true,
    });
    expect(writeDetails("a.bin", { kind: "unreadable" }, "text")).toEqual({
      path: "a.bin",
      binary: true,
    });
  });

  it("records only `tooLarge` for an old file too large to read", () => {
    expect(writeDetails("a.txt", { kind: "tooLarge" }, "text")).toEqual({
      path: "a.txt",
      tooLarge: true,
    });
  });

  it("records `tooLarge`, and `created` for a new file, when the two texts pass 1 MiB together", () => {
    const half = "x".repeat(MAX_DIFF_INPUT_BYTES / 2);

    expect(writeDetails("a.txt", { kind: "text", text: `${half}\n` }, `${half}y`)).toEqual({
      path: "a.txt",
      tooLarge: true,
    });
    expect(
      writeDetails("a.txt", { kind: "missing" }, "x".repeat(MAX_DIFF_INPUT_BYTES + 1)),
    ).toEqual({ path: "a.txt", created: true, tooLarge: true });
  });

  it("counts the texts in bytes, not characters", () => {
    // 400,000 characters of 3 bytes each.
    const text = "€".repeat(400_000);

    expect(writeDetails("a.txt", { kind: "text", text }, text)).toEqual({
      path: "a.txt",
      tooLarge: true,
    });
  });

  it("records `tooLarge` when the patch passes 512 KiB, though the texts are within 1 MiB", () => {
    const content = lines(20_000, "a line of the new file");

    expect(content.length).toBeLessThanOrEqual(MAX_DIFF_INPUT_BYTES);

    const details = writeDetails("a.txt", { kind: "missing" }, content);

    expect(details).toEqual({ path: "a.txt", created: true, tooLarge: true });
  });

  it("counts a patch as it is stored, JSON-escaped: quotes take two bytes", () => {
    // Half of the lines' bytes are quotes, so the patch is under 512 KiB raw and over it as stored.
    const quoted = (count: number) => `${'"'.repeat(60)}\n`.repeat(count);

    const within = writeDetails("q.txt", { kind: "missing" }, quoted(4_000));
    const past = writeDetails("q.txt", { kind: "missing" }, quoted(4_400));

    expect(within.patch).toBeDefined();
    expect(storedBytes(within.patch!)).toBeLessThanOrEqual(MAX_PATCH_BYTES);
    expect(past.patch).toBeUndefined();
    expect(past).toEqual({ path: "q.txt", created: true, tooLarge: true });
  });

  it("keeps a patch just within 512 KiB", () => {
    // A line of 99 characters and its newline, 100 bytes with the `+`.
    const content = `${"a".repeat(99)}\n`.repeat(5_000);
    const details = writeDetails("a.txt", { kind: "missing" }, content);

    expect(details.patch).toBeDefined();
    expect(details.patch!.length).toBeLessThan(MAX_PATCH_BYTES);
  });

  it("records `tooLarge` when lining the texts up passes its 1 s budget", () => {
    // A clock that jumps 2 s at each look, as a slow line-up would see.
    let now = 0;

    vi.spyOn(Date, "now").mockImplementation(() => (now += 2_000));

    const slow = writeDetails("a.txt", { kind: "text", text: lines(50) }, lines(50, "other"));

    expect(slow).toEqual({ path: "a.txt", tooLarge: true });

    vi.restoreAllMocks();

    // The same texts, lined up in time, have a patch.
    expect(
      writeDetails("a.txt", { kind: "text", text: lines(50) }, lines(50, "other")).patch,
    ).toBeDefined();
  });

  it("bounds the line-up without a clock: a large file whose every line differs is too large, and quickly", () => {
    stillClock();

    const old = lines(30_000, "old line");
    const next = lines(30_000, "new line");

    expect(byteLength(old) + byteLength(next)).toBeLessThan(MAX_DIFF_INPUT_BYTES);
    expect(old.split("\n").length + next.split("\n").length).toBeGreaterThan(MAX_EDIT_LENGTH);

    const started = performance.now();
    const details = writeDetails("a.txt", { kind: "text", text: old }, next);
    const took = performance.now() - started;

    expect(details).toEqual({ path: "a.txt", tooLarge: true });
    // About 0.13 s here; the bound is what keeps it from being minutes.
    expect(took).toBeLessThan(3_000);
  });

  it("bounds a change in the middle of a file by the lines that differ, however its text is arranged", () => {
    stillClock();

    const head = lines(5_000, "x");
    const tail = lines(5_000, "y");

    const started = performance.now();

    const details = writeDetails(
      "a.txt",
      { kind: "text", text: head + tail },
      head + lines(4_000, "z") + tail,
    );

    expect(details).toEqual({ path: "a.txt", tooLarge: true });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("does not hold a new file, an append or a truncation to that bound: they cost only their length", () => {
    const base = lines(10_000, "x");

    expect(
      writeDetails("a.txt", { kind: "text", text: base }, base + lines(5_000, "y")).patch,
    ).toBeDefined();
    expect(
      writeDetails("a.txt", { kind: "text", text: base }, lines(3_000, "x")).patch,
    ).toBeDefined();
    expect(writeDetails("a.txt", { kind: "missing" }, lines(20_000, "n")).patch).toBeDefined();
    expect(writeDetails("a.txt", { kind: "text", text: base }, "").patch).toBeDefined();
  });

  it("still shows a rewrite within the bound, and not one past it", () => {
    stillClock();

    // 400 lines out and 400 in is 800 lines that differ, under 1,000; 600 and 600 is 1,200.
    const within = writeDetails(
      "a.txt",
      { kind: "text", text: lines(400, "old") },
      lines(400, "new"),
    );

    const past = writeDetails(
      "a.txt",
      { kind: "text", text: lines(600, "old") },
      lines(600, "new"),
    );

    expect(within.patch).toBeDefined();
    expect(past).toEqual({ path: "a.txt", tooLarge: true });
  });

  it("does not build the patch of a new file whose text alone passes 512 KiB", () => {
    // Short lines: 300,000 of them is 600 KB, well within 1 MiB.
    expect(writeDetails("a.txt", { kind: "missing" }, "ab\n".repeat(300_000))).toEqual({
      path: "a.txt",
      created: true,
      tooLarge: true,
    });
  });
});

type Files = Pick<ExecutionEnv, "fileInfo" | "readBinaryFile" | "canonicalPath">;

/**
 * A file system holding `files`, which records the paths it was asked to read. `links` are symbolic links to them: a
 * link's own size is that of its path, as `lstat` has it.
 */
const filesOf = (
  files: Readonly<Record<string, Uint8Array>>,
  reads: string[] = [],
  links: Readonly<Record<string, string>> = {},
): Files => ({
  fileInfo: async (path) => {
    const bytes = files[path];

    if (path in links) {
      return ok({ name: path, path, kind: "symlink" as const, size: path.length, mtimeMs: 0 });
    }

    return bytes === undefined
      ? err(new FileError("not_found", "No such file", path))
      : ok({
          name: path,
          path,
          kind: "file" as const,
          size: bytes.byteLength,
          mtimeMs: 0,
        });
  },
  canonicalPath: async (path) => {
    const target = links[path];

    return target === undefined
      ? ok(path)
      : target in files
        ? ok(target)
        : err(new FileError("not_found", "No such file", target));
  },
  readBinaryFile: async (path) => {
    reads.push(path);

    const bytes = files[links[path] ?? path];

    return bytes === undefined ? err(new FileError("not_found", "No such file", path)) : ok(bytes);
  },
});

const text = (value: string) => new TextEncoder().encode(value);

describe("oldFile", () => {
  const context = BACKGROUND_CONTEXT;

  it("reads a text file", async () => {
    expect(await oldFile(filesOf({ "/a": text("héllo\n") }), "/a", 10, context)).toEqual({
      kind: "text",
      text: "héllo\n",
    });
  });

  it("finds a path with no file missing", async () => {
    expect(await oldFile(filesOf({}), "/a", 10, context)).toEqual({ kind: "missing" });
  });

  it("calls a file with a NUL in its first 8,000 bytes binary, and one with a NUL later text", async () => {
    const early = new Uint8Array(100);
    const late = new Uint8Array(BINARY_SCAN_BYTES + 10).fill(97);

    late[BINARY_SCAN_BYTES + 5] = 0;

    const files = { "/early": early, "/late": late };

    expect(await oldFile(filesOf(files), "/early", 10, context)).toEqual({ kind: "binary" });
    expect((await oldFile(filesOf(files), "/late", 10, context)).kind).toBe("text");
  });

  it("calls a file it cannot read unreadable", async () => {
    const denied: Files = {
      ...filesOf({}),
      fileInfo: async (path) => err(new FileError("permission_denied", "No", path)),
      readBinaryFile: async (path) => err(new FileError("permission_denied", "No", path)),
    };

    expect(await oldFile(denied, "/a", 10, context)).toEqual({ kind: "unreadable" });

    const unreadable: Files = {
      ...filesOf({ "/a": text("x") }),
      readBinaryFile: async (path) => err(new FileError("unknown", "I/O", path)),
    };

    expect(await oldFile(unreadable, "/a", 10, context)).toEqual({ kind: "unreadable" });
  });

  it("does not read a file that, with the new text, would pass 1 MiB", async () => {
    const reads: string[] = [];
    const big = new Uint8Array(MAX_DIFF_INPUT_BYTES - 5).fill(97);

    expect(await oldFile(filesOf({ "/big": big }, reads), "/big", 10, context)).toEqual({
      kind: "tooLarge",
    });
    expect(reads).toEqual([]);
  });

  it("judges a symbolic link by the file it points to, not by its own size", async () => {
    const reads: string[] = [];
    const big = new Uint8Array(MAX_DIFF_INPUT_BYTES - 5).fill(97);
    const files = { "/big": big, "/small": text("ok\n") };
    const links = { "/to-big": "/big", "/to-small": "/small", "/dangling": "/gone" };

    expect(await oldFile(filesOf(files, reads, links), "/to-big", 10, context)).toEqual({
      kind: "tooLarge",
    });
    expect(reads).toEqual([]);
    expect(await oldFile(filesOf(files, reads, links), "/to-small", 10, context)).toEqual({
      kind: "text",
      text: "ok\n",
    });
    expect(await oldFile(filesOf(files, reads, links), "/dangling", 10, context)).toEqual({
      kind: "missing",
    });
  });

  it("does not trust a size that is out of date: a file that grew is too large once read", async () => {
    const big = new Uint8Array(MAX_DIFF_INPUT_BYTES - 5).fill(97);

    const grown: Files = {
      ...filesOf({ "/a": big }),
      fileInfo: async (path) =>
        ok({ name: path, path, kind: "file" as const, size: 3, mtimeMs: 0 }),
    };

    expect(MAX_DIFF_INPUT_BYTES).toBeGreaterThan(0);

    expect(await oldFile(grown, "/a", 10, context)).toEqual({ kind: "tooLarge" });
  });

  it("calls something that is not a file unreadable", async () => {
    const directory: Files = {
      ...filesOf({}),
      fileInfo: async (path) =>
        ok({ name: path, path, kind: "directory" as const, size: 0, mtimeMs: 0 }),
    };

    expect(await oldFile(directory, "/d", 10, context)).toEqual({ kind: "unreadable" });
  });
});

describe("capturedDiffs", () => {
  const listed = (
    ...calls: ReadonlyArray<readonly [id: number, name: string, status: string]>
  ): JsonValue => ({
    calls: calls.map(([id, name, status]) => ({ id, name, args: "{}", status })),
  });

  it("keys the diffs of the finished edit and write calls by their number in the script", async () => {
    const results = new Map<number, JsonValue>([
      [1, { patch: "--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n", diff: "ignored", firstChangedLine: 1 }],
      [2, { path: "b", patch: "--- b\n+++ b\n@@ -0,0 +1 @@\n+z\n", created: true }],
      [3, { path: "c.txt", tooLarge: true, created: true }],
      [4, { path: "d.bin", binary: true }],
      [5, { patch: "--- c\n+++ c\n" }],
    ]);

    const diffs = await capturedDiffs(
      listed(
        [1, "edit", "ok"],
        [2, "write", "ok"],
        [3, "write", "ok"],
        [4, "write", "ok"],
        [5, "bash", "ok"],
      ),
      async (id) => results.get(id),
    );

    // An `edit` records no path: its patch's header names the file.
    expect(diffs).toEqual({
      1: { path: "a", patch: "--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n" },
      2: { path: "b", patch: "--- b\n+++ b\n@@ -0,0 +1 @@\n+z\n", created: true },
      3: { path: "c.txt", tooLarge: true, created: true },
      4: { path: "d.bin", binary: true },
    });
  });

  it("leaves out a call that failed, was stopped, or recorded no diff", async () => {
    const asked: number[] = [];

    const diffs = await capturedDiffs(
      listed(
        [1, "write", "error"],
        [2, "write", "cancelled"],
        [3, "write", "ok"],
        [4, "edit", "ok"],
      ),
      async (id) => {
        asked.push(id);

        // An old `edit` result, or a `write` from before the wrapper, has none.
        return id === 3 ? undefined : { diff: "shown" };
      },
    );

    expect(diffs).toEqual({});
    expect(asked).toEqual([3, 4]);
  });

  it("gives none for details that list no calls", async () => {
    expect(await capturedDiffs({ other: 1 }, async () => ({ patch: "x" }))).toEqual({});
    expect(await capturedDiffs(undefined, async () => ({ patch: "x" }))).toEqual({});
  });

  it("records a patch past 512 KiB as too large, keeping `created` and the path", async () => {
    const diffs = await capturedDiffs(listed([1, "write", "ok"]), async () => ({
      path: "big.txt",
      patch: "x".repeat(MAX_PATCH_BYTES + 1),
      created: true,
    }));

    expect(diffs).toEqual({ 1: { path: "big.txt", created: true, tooLarge: true } });
  });

  it("keeps an edit's path when its patch is dropped as too large", async () => {
    const diffs = await capturedDiffs(listed([1, "edit", "ok"]), async () => ({
      patch: `--- src/a.ts\n+++ src/a.ts\n${"x".repeat(MAX_PATCH_BYTES)}`,
    }));

    expect(diffs).toEqual({ 1: { path: "src/a.ts", tooLarge: true } });
  });

  it("counts a patch as it is stored: JSON-escaped", async () => {
    // Under 512 KiB raw, over it with every quote escaped.
    const patch = `"`.repeat(MAX_PATCH_BYTES - 1000);

    expect(byteLength(patch)).toBeLessThan(MAX_PATCH_BYTES);
    expect(await capturedDiffs(listed([1, "write", "ok"]), async () => ({ patch }))).toEqual({
      1: { tooLarge: true },
    });
  });

  it("holds the patches of one result to a budget they share, in call order", async () => {
    const patch = "p".repeat(MAX_CODEMODE_DIFF_BYTES / 2 - 10);

    const diffs = await capturedDiffs(
      listed([1, "write", "ok"], [2, "write", "ok"], [3, "write", "ok"], [4, "write", "ok"]),
      async () => ({ patch }),
    );

    expect(diffs).toEqual({
      1: { patch },
      2: { patch },
      3: { tooLarge: true },
      4: { tooLarge: true },
    });
  });
});
