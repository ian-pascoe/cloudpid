// `ls`, `find`, and `grep` over a fake file search: what a program gets of each (the entries the text shows, with the
// flags `details` sets), and where a result is cut. The calls' Promise-based harness makes this file Promise-based too.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off strictEffectProvide:off preferEffectArray:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import { err, FileError, ok } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import {
  type DirectoryEntry,
  type FileSearch,
  Files,
  type FoundEntry,
  type GrepMatch,
  WorkspaceFiles,
} from "./files.ts";
import { MAX_PART_BYTES } from "./outputs.ts";
import { runProgram, runSized } from "./program.fixture.ts";
import { storedBytes } from "./stored-bytes.ts";

const context = BACKGROUND_CONTEXT;

const WORKSPACE = "/workspace";

/** What the fake Workspace holds. */
type Fake = {
  /** Directories by absolute path, with their entries. */
  readonly directories: Readonly<Record<string, ReadonlyArray<DirectoryEntry>>>;
  /** Files by absolute path. */
  readonly files?: ReadonlyArray<string>;
  /** What `find` finds, before its limit. */
  readonly found?: ReadonlyArray<FoundEntry>;
  /** What `grep` matches, before its limit. */
  readonly matches?: ReadonlyArray<GrepMatch>;
};

const file = (name: string, containerOnly = false): DirectoryEntry => ({
  name,
  isDirectory: false,
  isSymbolicLink: false,
  containerOnly,
});

const directory = (name: string): DirectoryEntry => ({
  name,
  isDirectory: true,
  isSymbolicLink: false,
});

/** The path operations of an environment over `fake`, which are all the tools ask of it. */
const fakeEnv = (fake: Fake) => ({
  absolutePath: async (path: string) =>
    ok(path === "." ? WORKSPACE : path.startsWith("/") ? path : `${WORKSPACE}/${path}`),
  fileInfo: async (path: string) => {
    if (path in fake.directories) {
      return ok({ name: path, path, kind: "directory" as const, size: 0, mtimeMs: 0 });
    }

    return fake.files?.includes(path) === true
      ? ok({ name: path, path, kind: "file" as const, size: 0, mtimeMs: 0 })
      : err(new FileError("not_found", "No such file", path));
  },
});

const fakeSearch = (fake: Fake): FileSearch => ({
  readdir: async (path) => fake.directories[path] ?? [],
  find: async (_directory, _pattern, { limit }) => (fake.found ?? []).slice(0, limit),
  grep: async (_pattern, _path, { limit, context: lines }) =>
    (fake.matches ?? [])
      .slice(0, limit)
      .map((match) => (lines === 0 ? { ...match, context: undefined } : match)),
});

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** The items of list `key` of a value, as objects. */
const listOf = (value: JsonValue | undefined, key: string): ReadonlyArray<JsonObject> => {
  const list = isJsonObject(value) ? value[key] : undefined;

  return Array.isArray(list) ? Arr.filter(list, isJsonObject) : [];
};

/** A string or number field as text. */
const textOf = (value: JsonValue | undefined): string =>
  Predicate.isString(value) || Predicate.isNumber(value) ? String(value) : "";

/** The lines of a result's text without its notices. */
const shownLines = (text: string): ReadonlyArray<string> =>
  (text.split("\n\n")[0] ?? "").split("\n");

/** The Files extension over `fake`. */
const extensionOver = (fake: Fake) =>
  Effect.runPromise(Files.pipe(Effect.provideService(WorkspaceFiles, () => fakeSearch(fake))));

/** What a program got of calling `tool` with `args` over `fake`. */
const program = async (fake: Fake, tool: string, args: JsonObject) => {
  // SAFETY: the tools use only `absolutePath` and `fileInfo` of the environment.
  const [called] = await runProgram([await extensionOver(fake)], [[tool, args]], {
    env: fakeEnv(fake) as never,
  });

  if (called === undefined) throw new Error("No call was made");

  return called;
};

/** The result of `tool` as its registration gives it, for the text, the details and the value together. */
const direct = async (fake: Fake, tool: string, args: JsonObject) => {
  const registration = (await extensionOver(fake)).tools?.find(
    (candidate) => candidate.name === tool,
  );

  if (registration === undefined) throw new Error(`No tool ${tool}`);

  // SAFETY: the tools read only the call's environment and conversation from the API.
  const api = { env: fakeEnv(fake), conversationId: "root" } as never;
  const result = await registration.execute(args, api, context);

  return {
    text: Arr.join(
      Arr.flatMap(result.output ?? [], (block) => (block.type === "text" ? [block.text] : [])),
      "",
    ),
    details: result.details,
    structuredOutput: result.structuredOutput,
  };
};

describe("the file tools from a program", () => {
  it("gets the entries ls lists, with their type and whether only the Container has them", async () => {
    const fake = {
      directories: {
        [WORKSPACE]: [file("b.txt"), directory("src"), file("A.md"), file("dist", true)],
        [`${WORKSPACE}/empty`]: [],
      },
    };

    const listed = await program(fake, "ls", {});

    expect(listed).toMatchObject({ isError: false, diagnostics: [] });
    expect(listed.structuredOutput).toEqual({
      entries: [
        { name: "A.md", type: "file", container_only: false },
        { name: "b.txt", type: "file", container_only: false },
        { name: "dist", type: "file", container_only: true },
        { name: "src", type: "directory", container_only: false },
      ],
      entry_limit_reached: null,
      truncated: false,
      structured_truncated: false,
    });

    const limited = await program(fake, "ls", { limit: 2 });

    expect(limited).toMatchObject({ isError: false, diagnostics: [] });
    expect(limited.structuredOutput).toMatchObject({
      entries: [{ name: "A.md" }, { name: "b.txt" }],
      entry_limit_reached: 2,
      truncated: false,
    });

    const empty = await program(fake, "ls", { path: "empty" });

    expect(empty).toMatchObject({ isError: false, diagnostics: [] });
    expect(empty.structuredOutput).toEqual({
      entries: [],
      entry_limit_reached: null,
      truncated: false,
      structured_truncated: false,
    });
  });

  it("gets the paths find lists, relative to the search directory, with their type", async () => {
    const fake = {
      directories: { [WORKSPACE]: [] },
      found: [
        { path: `${WORKSPACE}/src/a.ts`, type: "file" as const },
        { path: `${WORKSPACE}/src/deep`, type: "dir" as const },
      ],
    };

    const found = await program(fake, "find", { pattern: "*" });

    expect(found).toMatchObject({ isError: false, diagnostics: [] });
    expect(found.structuredOutput).toEqual({
      paths: [
        { path: "src/a.ts", type: "file" },
        { path: "src/deep", type: "directory" },
      ],
      result_limit_reached: null,
      truncated: false,
      structured_truncated: false,
    });

    const limited = await program(fake, "find", { pattern: "*", limit: 1 });

    expect(limited).toMatchObject({ isError: false, diagnostics: [] });
    expect(limited.structuredOutput).toMatchObject({
      paths: [{ path: "src/a.ts", type: "file" }],
      result_limit_reached: 1,
    });

    const none = await program({ directories: { [WORKSPACE]: [] } }, "find", { pattern: "*.rs" });

    expect(none).toMatchObject({ isError: false, diagnostics: [] });
    expect(none.structuredOutput).toEqual({
      paths: [],
      result_limit_reached: null,
      truncated: false,
      structured_truncated: false,
    });
  });

  it("gets the lines grep lists, context lines marked, and a long line cut", async () => {
    const fake = {
      directories: { [WORKSPACE]: [] },
      files: [`${WORKSPACE}/src/b.ts`],
      matches: [
        {
          path: `${WORKSPACE}/src/b.ts`,
          line: 3,
          text: "needle here",
          context: [
            { line: 2, text: "line two", isMatch: false },
            { line: 3, text: "needle here", isMatch: true },
            { line: 4, text: "x".repeat(600), isMatch: false },
          ],
        },
      ],
    };

    const searched = await program(fake, "grep", { pattern: "needle", context: 1 });

    expect(searched).toMatchObject({ isError: false, diagnostics: [] });
    expect(searched.structuredOutput).toEqual({
      lines: [
        { path: "src/b.ts", line: 2, text: "line two", match: false },
        { path: "src/b.ts", line: 3, text: "needle here", match: true },
        { path: "src/b.ts", line: 4, text: `${"x".repeat(500)}... [truncated]`, match: false },
      ],
      match_limit_reached: null,
      lines_truncated: true,
      truncated: false,
      structured_truncated: false,
    });

    // Without context lines asked for, a match is its own line, and a searched file is named by its own name.
    const plain = await program(fake, "grep", { pattern: "needle", path: "src/b.ts", limit: 1 });

    expect(plain).toMatchObject({ isError: false, diagnostics: [] });
    expect(plain.structuredOutput).toEqual({
      lines: [{ path: "b.ts", line: 3, text: "needle here", match: true }],
      match_limit_reached: 1,
      lines_truncated: false,
      truncated: false,
      structured_truncated: false,
    });

    const none = await program({ directories: { [WORKSPACE]: [] } }, "grep", { pattern: "x" });

    expect(none).toMatchObject({ isError: false, diagnostics: [] });
    expect(none.structuredOutput).toEqual({
      lines: [],
      match_limit_reached: null,
      lines_truncated: false,
      truncated: false,
      structured_truncated: false,
    });
  });

  it("leaves the model's text and details as they were", async () => {
    const fake = { directories: { [WORKSPACE]: [directory("src"), file("a.ts", true)] } };
    const listed = await direct(fake, "ls", { limit: 1 });

    expect(listed.text).toBe(
      "a.ts (container-only)\n\n[1 entries limit reached. Use limit=2 for more]",
    );
    expect(listed.details).toEqual({ entryLimitReached: 1 });
  });
});

describe("what the file tools cut", () => {
  /** A name that takes 100 bytes of text, distinct from the others. */
  const long = (index: number) => `${String(index).padStart(5, "0")}${"n".repeat(95)}`;

  // A nested call gives no text, so these compare the text and the value of a direct call.
  it("keeps in ls's value only the entries its text shows when the text is cut", async () => {
    const entries = Arr.makeBy(1000, (index) => file(long(index)));
    const listed = await direct({ directories: { [WORKSPACE]: entries } }, "ls", { limit: 1000 });
    const shown = shownLines(listed.text);

    expect(listed.details).toEqual({ truncated: true });
    expect(shown.length).toBeLessThan(1000);
    expect(listed.structuredOutput).toMatchObject({ truncated: true, structured_truncated: false });
    expect(listOf(listed.structuredOutput, "entries").map((entry) => entry["name"])).toEqual(shown);
  });

  it("keeps in find's value only the paths its text shows when the text is cut", async () => {
    const found = Arr.makeBy(1000, (index): FoundEntry => ({
      path: `${WORKSPACE}/${long(index)}`,
      type: "file",
    }));

    const result = await direct({ directories: { [WORKSPACE]: [] }, found }, "find", {
      pattern: "*",
      limit: 1000,
    });

    const shown = shownLines(result.text);

    expect(shown.length).toBeLessThan(1000);
    expect(result.structuredOutput).toMatchObject({
      truncated: true,
      result_limit_reached: 1000,
      structured_truncated: false,
    });
    expect(listOf(result.structuredOutput, "paths").map((entry) => entry["path"])).toEqual(shown);
  });

  it("keeps in grep's value only the lines its text shows when the text is cut", async () => {
    const matches = Arr.makeBy(1000, (index): GrepMatch => ({
      path: `${WORKSPACE}/${long(index)}`,
      line: 1,
      text: "needle",
    }));

    const result = await direct({ directories: { [WORKSPACE]: [] }, matches }, "grep", {
      pattern: "needle",
      limit: 1000,
    });

    const shown = shownLines(result.text);

    expect(shown.length).toBeLessThan(1000);
    expect(result.structuredOutput).toMatchObject({ truncated: true, structured_truncated: false });
    expect(
      listOf(result.structuredOutput, "lines").map(
        (line) => `${textOf(line["path"])}:${textOf(line["line"])}: ${textOf(line["text"])}`,
      ),
    ).toEqual(shown);
  });

  // A short name is a few bytes of text, but an entry of a value is dozens.
  it("cuts a list whose value outweighs its text, and says so, in a nested call", async () => {
    const names = Arr.makeBy(10_000, (index) => index.toString(36).padStart(4, "0"));
    const fake = { directories: { [WORKSPACE]: Arr.map(names, (name) => file(name)) } };

    // SAFETY: the tools use only `absolutePath` and `fileInfo` of the environment.
    const [sized] = await runSized([await extensionOver(fake)], [["ls", { limit: 10_000 }]], {
      env: fakeEnv(fake) as never,
    });

    // The call's text is cut too (what the model would read), which its diagnostics say; its value is not an error.
    expect(sized).toMatchObject({ isError: false, truncated: { structured_truncated: true } });
    expect(sized?.diagnostics.map(({ message }) => message)).toEqual([
      expect.stringMatching(/^Output truncated/),
    ]);
    expect(sized?.lengths["entries"]).toBeGreaterThan(0);
    expect(sized?.lengths["entries"]).toBeLessThan(10_000);
    expect(sized?.bytes).toBeLessThanOrEqual(MAX_PART_BYTES + 200);

    // The entries kept are the first ones, as the direct call shows.
    const listed = await direct(fake, "ls", { limit: 10_000 });
    const entries = listOf(listed.structuredOutput, "entries");

    expect(entries.map((entry) => entry["name"])).toEqual(Arr.take(names, entries.length));
    expect(storedBytes(listed.structuredOutput)).toBe(sized?.bytes);
  });
});
