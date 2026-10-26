// The Call diff of `write`, and the diffs captured from a script's nested calls, as plain functions over text and over a
// fake file system.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BINARY_SCAN_BYTES,
  capturedDiffs,
  MAX_CODEMODE_DIFF_BYTES,
  MAX_DIFF_INPUT_BYTES,
  MAX_PATCH_BYTES,
  oldFile,
  writeDetails,
} from "./call-diff.ts";

const lines = (count: number, prefix = "line"): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join("");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeDetails", () => {
  it("records a patch of the whole text, and that the file was created, for a new file", () => {
    const details = writeDetails("src/a.txt", { kind: "missing" }, "one\ntwo\n");

    expect(details).toEqual({
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
      patch: "--- a.txt\n+++ a.txt\n",
    });
  });

  it("records only `binary` for an old file that is binary, and for one that could not be read", () => {
    expect(writeDetails("a.bin", { kind: "binary" }, "text")).toEqual({ binary: true });
    expect(writeDetails("a.bin", { kind: "unreadable" }, "text")).toEqual({ binary: true });
  });

  it("records only `tooLarge` for an old file too large to read", () => {
    expect(writeDetails("a.txt", { kind: "tooLarge" }, "text")).toEqual({ tooLarge: true });
  });

  it("records `tooLarge`, and `created` for a new file, when the two texts pass 1 MiB together", () => {
    const half = "x".repeat(MAX_DIFF_INPUT_BYTES / 2);

    expect(writeDetails("a.txt", { kind: "text", text: `${half}\n` }, `${half}y`)).toEqual({
      tooLarge: true,
    });
    expect(
      writeDetails("a.txt", { kind: "missing" }, "x".repeat(MAX_DIFF_INPUT_BYTES + 1)),
    ).toEqual({ created: true, tooLarge: true });
  });

  it("counts the texts in bytes, not characters", () => {
    // 400,000 characters of 3 bytes each.
    const text = "€".repeat(400_000);

    expect(writeDetails("a.txt", { kind: "text", text }, text)).toEqual({ tooLarge: true });
  });

  it("records `tooLarge` when the patch passes 512 KiB, though the texts are within 1 MiB", () => {
    const content = lines(20_000, "a line of the new file");

    expect(content.length).toBeLessThanOrEqual(MAX_DIFF_INPUT_BYTES);

    const details = writeDetails("a.txt", { kind: "missing" }, content);

    expect(details).toEqual({ created: true, tooLarge: true });
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

    expect(slow).toEqual({ tooLarge: true });

    vi.restoreAllMocks();

    // The same texts, lined up in time, have a patch.
    expect(
      writeDetails("a.txt", { kind: "text", text: lines(50) }, lines(50, "other")).patch,
    ).toBeDefined();
  });
});

type Files = Pick<ExecutionEnv, "fileInfo" | "readBinaryFile">;

/** A file system holding `files`, which records the paths it was asked to read. */
const filesOf = (files: Readonly<Record<string, Uint8Array>>, reads: string[] = []): Files => ({
  fileInfo: async (path) => {
    const bytes = files[path];

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
  readBinaryFile: async (path) => {
    reads.push(path);

    const bytes = files[path];

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
      [2, { patch: "--- b\n+++ b\n@@ -0,0 +1 @@\n+z\n", created: true }],
      [3, { tooLarge: true, created: true }],
      [4, { binary: true }],
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

    expect(diffs).toEqual({
      1: { patch: "--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n" },
      2: { patch: "--- b\n+++ b\n@@ -0,0 +1 @@\n+z\n", created: true },
      3: { tooLarge: true, created: true },
      4: { binary: true },
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

  it("records a patch past 512 KiB as too large, keeping `created`", async () => {
    const diffs = await capturedDiffs(listed([1, "write", "ok"]), async () => ({
      patch: "x".repeat(MAX_PATCH_BYTES + 1),
      created: true,
    }));

    expect(diffs).toEqual({ 1: { created: true, tooLarge: true } });
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
