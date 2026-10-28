// `ls`, `find`, and `grep`: pi's search tools over a Workspace's file system (docs/spec.md → Filesystem and tools,
// ADR-0008). Their parameters and output follow local pi's (`packages/coding-agent/src/core/tools/{ls,find,grep}.ts`),
// except where the Workspace's file system differs: it has no `.gitignore` handling, so `find` and `grep` skip
// `node_modules` and `.git` instead, as local pi's `find` does for a custom backend.
//
// The tools reach the Workspace only through `FileSearch`: directory listing, glob find, and grep. A path is resolved
// and checked through the call's `ExecutionEnv`, narrowed to `PathEnv`, its two path operations (`absolutePath`,
// `fileInfo`). Neither can run a command of the tool's choosing: both are the Workspace DO's file operations, which
// answer from the Workspace's files, and, for a Container-only path, from the Container through scripts of the DO's own
// (ADR-0018, which replaced ADR-0008's "never starts the Container" for these paths).
import { defineEffectTool } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type ConversationTarget, conversationTarget } from "./conversation-target.ts";

export type { ConversationTarget } from "./conversation-target.ts";

/** An entry of a directory. */
export type DirectoryEntry = {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** A Container-only entry of a synced directory, which only the running Container listed. */
  readonly containerOnly?: boolean;
};

/** An entry a glob found, at its absolute path. */
export type FoundEntry = { readonly path: string; readonly type: "file" | "dir" };

/** A line of a match's context; `isMatch` marks the matching line itself. */
export type GrepLine = { readonly line: number; readonly text: string; readonly isMatch: boolean };

/** A matching line at an absolute path; `context` (when asked for) holds the lines around it and the line itself. */
export type GrepMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly context?: ReadonlyArray<GrepLine> | undefined;
};

/** The Workspace's file search, as `@cloudflare/computer`'s `fs.readdir`, `fs.find`, and `fs.grep` answer it. */
export interface FileSearch {
  /** The entries of directory `path`. */
  readdir(path: string): Promise<ReadonlyArray<DirectoryEntry>>;
  /** The entries below `directory` whose path, relative to it, matches the glob `pattern`. */
  find(
    directory: string,
    pattern: string,
    options: { readonly limit: number; readonly exclude: ReadonlyArray<string> },
  ): Promise<ReadonlyArray<FoundEntry>>;
  /** The lines of the files below `path` (or of the file itself) that match `pattern`, in file order. */
  grep(
    pattern: string,
    path: string,
    options: {
      readonly ignoreCase: boolean;
      readonly regex: boolean;
      readonly context: number;
      readonly limit: number;
      readonly include: string | undefined;
      readonly exclude: ReadonlyArray<string>;
    },
  ): Promise<ReadonlyArray<GrepMatch>>;
}

/**
 * The file search of the Workspace a conversation works in, for the tools: the Session provides it over its Workspace, or
 * over the conversation's Subagent Workspace when it has one.
 */
export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  (target: ConversationTarget) => FileSearch
>()("@cloudpid/extensions/files/WorkspaceFiles") {}

/** The file search of the Workspace the calling conversation works in. */
const searchFor = (api: ToolExecutionApi) =>
  Effect.flatMap(conversationTarget(api), (target) =>
    Effect.map(Effect.service(WorkspaceFiles), (files) => files(target)),
  );

/** A search tool call failed; its message is what the model sees. */
export class FilesError extends Schema.TaggedError<FilesError, { readonly brand: unique symbol }>()(
  "FilesError",
  { message: Schema.String },
) {}

const DEFAULT_LS_LIMIT = 500;

const DEFAULT_FIND_LIMIT = 1000;

const DEFAULT_GREP_LIMIT = 100;

const MAX_BYTES = 50 * 1024;

/** Longest grep line kept, in characters. */
const GREP_MAX_LINE_LENGTH = 500;

/** What `find` and `grep` skip, as local pi's `find` does. */
const IGNORED = ["**/node_modules/**", "**/.git/**"] as const;

/**
 * Directories a search from above them skips: the Skill set's mount (`@cloudpid/extensions/skills`), and the
 * harness's own files (temp files, spills, Attachments).
 */
const SKIPPED_FROM_ABOVE = ["/workspace/.agents/skills", "/workspace/.cloudpid"] as const;

/**
 * What a search of `path` skips: `IGNORED`, and each of `SKIPPED_FROM_ABOVE` that is below `path`, so a search from the
 * Workspace root does not walk them; a search of a path in or at one finds its files.
 */
const ignoredIn = (path: string): ReadonlyArray<string> => {
  const prefix = path.endsWith("/") ? path : `${path}/`;

  return [
    ...IGNORED,
    ...Arr.filterMap(SKIPPED_FROM_ABOVE, (skipped) =>
      skipped.startsWith(prefix)
        ? Result.succeed(`${skipped.slice(prefix.length)}/**`)
        : Result.failVoid,
    ),
  ];
};

/** What the tools say of Container-only paths. */
const CONTAINER_NOTE =
  "Paths only the container has (outside /workspace, and dependency, build and cache directories such as node_modules inside it) are searched on the container, starting it if needed.";

const encoder = new TextEncoder();

const sizeOf = (bytes: number): string =>
  bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;

/** `text`'s first lines that fit `MAX_BYTES`, never a partial line. */
const truncateHead = (text: string) => {
  if (encoder.encode(text).length <= MAX_BYTES) return { content: text, truncated: false };

  const kept: string[] = [];
  let bytes = 0;

  for (const line of text.split("\n")) {
    bytes += encoder.encode(line).length + (kept.length > 0 ? 1 : 0);

    if (bytes > MAX_BYTES) break;
    kept.push(line);
  }

  return { content: Arr.join(kept, "\n"), truncated: true };
};

/** `text` and its notices, as local pi appends them: `\n\n[notice. notice]`. */
const withNotices = (text: string, notices: ReadonlyArray<string>): string =>
  notices.length === 0 ? text : `${text}\n\n[${Arr.join(notices, ". ")}]`;

const fail = (message: string) => Effect.fail(FilesError.make({ message }));

/** A call of a search against the Workspace: its failure, as the model sees it. */
const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, FilesError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      FilesError.make({
        message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** What the tools use of the call's environment: resolving a path and reading what is at it, never executing. */
type PathEnv = Pick<ExecutionEnv, "absolutePath" | "fileInfo">;

/** The call's environment, which a tool without one fails on, as pi-durable's own tools do. */
const requireEnv = (api: ToolExecutionApi): Effect.Effect<PathEnv, FilesError> =>
  api.env === undefined ? fail("No execution environment is configured") : Effect.succeed(api.env);

/** `path` (default: the current directory) as an absolute path in the environment. */
const resolvePath = Effect.fnUntraced(function* (
  env: PathEnv,
  path: string | undefined,
): Effect.fn.Return<string, FilesError> {
  const resolved = yield* attempt("Cannot resolve path", () =>
    env.absolutePath(path === undefined || path === "" ? "." : path, BACKGROUND_CONTEXT),
  );

  return resolved.ok ? resolved.value : yield* fail(resolved.error.message);
});

/** What `path` is in the environment: its kind, or undefined when there is nothing there. */
const kindOf = Effect.fnUntraced(function* (env: PathEnv, path: string) {
  const info = yield* attempt("Cannot read path", () => env.fileInfo(path, BACKGROUND_CONTEXT));

  if (info.ok) return info.value.kind;

  return info.error.code === "not_found" ? undefined : yield* fail(info.error.message);
});

/** `path` of a directory the call may search, or a failure saying why not. */
const directoryPath = Effect.fnUntraced(function* (
  env: PathEnv,
  path: string | undefined,
): Effect.fn.Return<string, FilesError> {
  const absolute = yield* resolvePath(env, path);
  const kind = yield* kindOf(env, absolute);

  if (kind === undefined) return yield* fail(`Path not found: ${absolute}`);

  return kind === "directory" ? absolute : yield* fail(`Not a directory: ${absolute}`);
});

/** `path` relative to directory `base`, or as it is when it is not below it. */
const relativeTo = (base: string, path: string): string => {
  const prefix = base.endsWith("/") ? base : `${base}/`;

  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

/**
 * A glob as the Workspace's `fs.find` matches it, against the path relative to the searched directory: like `fd --glob`,
 * a pattern matches at any depth, with or without a `/`.
 */
const anywhere = (glob: string): string =>
  glob.startsWith("**/") || glob === "**" ? glob : `**/${glob}`;

const textResult = (text: string, details: Record<string, JsonValue>): ToolExecutionResult => {
  const output = [{ type: "text" as const, text }];

  return Record.isEmptyRecord(details) ? { output } : { output, details };
};

/** A count of at least one, as `limit` is for `ls`, `find`, and `grep`: a call with anything else fails to decode. */
const optionalLimit = (description: string) =>
  Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description }));

/** Directory entries in alphabetical order, ignoring case, as local pi sorts them. */
const byName = Order.mapInput(
  Order.make<string>((a, b) => {
    const comparison = a.localeCompare(b);

    return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
  }),
  (entry: DirectoryEntry) => entry.name.toLowerCase(),
);

const Ls = defineEffectTool({
  name: "ls",
  description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LS_LIMIT} entries or ${MAX_BYTES / 1024}KB (whichever is hit first). A directory only the container has (outside /workspace, or such as node_modules inside it) is listed on the container, starting it if needed; in other directories, the container-only entries (marked "(container-only)") are listed only while the container runs.`,
  replay: "safe",
  parameters: Schema.Struct({
    path: Schema.optionalKey(
      Schema.String.annotate({ description: "Directory to list (default: current directory)" }),
    ),
    limit: optionalLimit(`Maximum number of entries to return (default: ${DEFAULT_LS_LIMIT})`),
  }),
  execute: Effect.fnUntraced(function* ({ path, limit }, api) {
    const files = yield* searchFor(api);
    const env = yield* requireEnv(api);
    const directory = yield* directoryPath(env, path);
    const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;

    const entries = yield* attempt("Cannot read directory", () => files.readdir(directory));

    const sorted = Arr.sort(entries, byName);

    const listed: string[] = [];
    let entryLimitReached = false;

    for (const entry of sorted) {
      if (listed.length >= effectiveLimit) {
        entryLimitReached = true;
        break;
      }

      let isDirectory = entry.isDirectory;

      // A link to a directory is listed as one; a link to nothing is skipped.
      if (entry.isSymbolicLink) {
        const kind = yield* kindOf(env, `${directory.replace(/\/$/, "")}/${entry.name}`);

        if (kind === undefined) continue;

        isDirectory = kind === "directory";
      }

      const name = isDirectory ? `${entry.name}/` : entry.name;

      listed.push(entry.containerOnly === true ? `${name} (container-only)` : name);
    }

    if (listed.length === 0) return textResult("(empty directory)", {});

    const truncation = truncateHead(Arr.join(listed, "\n"));
    const notices: string[] = [];
    const details: Record<string, JsonValue> = {};

    if (entryLimitReached) {
      notices.push(
        `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
      );
      details["entryLimitReached"] = effectiveLimit;
    }

    if (truncation.truncated) {
      notices.push(`${sizeOf(MAX_BYTES)} limit reached`);
      details["truncated"] = true;
    }

    return textResult(withNotices(truncation.content, notices), details);
  }),
});

const Find = defineEffectTool({
  name: "find",
  description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Skips node_modules and .git below the search directory, and the container-only directories below a synced one. Output is truncated to ${DEFAULT_FIND_LIMIT} results or ${MAX_BYTES / 1024}KB (whichever is hit first). ${CONTAINER_NOTE}`,
  replay: "safe",
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    }),
    path: Schema.optionalKey(
      Schema.String.annotate({
        description: "Directory to search in (default: current directory)",
      }),
    ),
    limit: optionalLimit(`Maximum number of results (default: ${DEFAULT_FIND_LIMIT})`),
  }),
  execute: Effect.fnUntraced(function* ({ pattern, path, limit }, api) {
    const files = yield* searchFor(api);
    const env = yield* requireEnv(api);
    const directory = yield* directoryPath(env, path);
    const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;

    const found = yield* attempt("Cannot search", () =>
      files.find(directory, anywhere(pattern), {
        limit: effectiveLimit,
        exclude: ignoredIn(directory),
      }),
    );

    if (found.length === 0) return textResult("No files found matching pattern", {});

    const lines = Arr.map(found, (entry) => {
      const relative = relativeTo(directory, entry.path);

      return entry.type === "dir" ? `${relative}/` : relative;
    });

    const truncation = truncateHead(Arr.join(lines, "\n"));
    const notices: string[] = [];
    const details: Record<string, JsonValue> = {};

    if (found.length >= effectiveLimit) {
      notices.push(
        `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
      );
      details["resultLimitReached"] = effectiveLimit;
    }

    if (truncation.truncated) {
      notices.push(`${sizeOf(MAX_BYTES)} limit reached`);
      details["truncated"] = true;
    }

    return textResult(withNotices(truncation.content, notices), details);
  }),
});

const Grep = defineEffectTool({
  name: "grep",
  description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Skips node_modules and .git below the search path, and the container-only directories below a synced one. Output is truncated to ${DEFAULT_GREP_LIMIT} matches or ${MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. ${CONTAINER_NOTE}`,
  replay: "safe",
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({ description: "Search pattern (regex or literal string)" }),
    path: Schema.optionalKey(
      Schema.String.annotate({
        description: "Directory or file to search (default: current directory)",
      }),
    ),
    glob: Schema.optionalKey(
      Schema.String.annotate({
        description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
      }),
    ),
    ignoreCase: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Case-insensitive search (default: false)" }),
    ),
    literal: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Treat pattern as literal string instead of regex (default: false)",
      }),
    ),
    context: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Number of lines to show before and after each match (default: 0)",
      }),
    ),
    limit: optionalLimit(`Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})`),
  }),
  execute: Effect.fnUntraced(function* (
    { pattern, path, glob, ignoreCase, literal, context, limit },
    api,
  ) {
    const files = yield* searchFor(api);
    const env = yield* requireEnv(api);
    const searched = yield* resolvePath(env, path);
    const kind = yield* kindOf(env, searched);

    if (kind === undefined) return yield* fail(`Path not found: ${searched}`);

    const isDirectory = kind === "directory";
    const contextLines = context ?? 0;
    const effectiveLimit = limit ?? DEFAULT_GREP_LIMIT;

    const matches = yield* attempt("Cannot search", () =>
      files.grep(pattern, searched, {
        ignoreCase: ignoreCase === true,
        regex: literal !== true,
        context: contextLines,
        limit: effectiveLimit,
        include: glob === undefined ? undefined : anywhere(glob),
        exclude: ignoredIn(searched),
      }),
    );

    if (matches.length === 0) return textResult("No matches found", {});

    let linesTruncated = false;

    const shown = (text: string): string => {
      const line = text.replace(/\r/g, "");

      if (line.length <= GREP_MAX_LINE_LENGTH) return line;

      linesTruncated = true;

      return `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`;
    };

    const lines = Arr.flatMap(matches, (match) => {
      // A searched file is named by its own name; a directory's files by their path below it.
      const name = isDirectory
        ? relativeTo(searched, match.path)
        : (match.path.split("/").pop() ?? "");

      if (match.context === undefined || contextLines === 0) {
        return [`${name}:${match.line}: ${shown(match.text)}`];
      }

      return Arr.map(match.context, (line) =>
        line.isMatch
          ? `${name}:${line.line}: ${shown(line.text)}`
          : `${name}-${line.line}- ${shown(line.text)}`,
      );
    });

    const truncation = truncateHead(Arr.join(lines, "\n"));
    const notices: string[] = [];
    const details: Record<string, JsonValue> = {};

    if (matches.length >= effectiveLimit) {
      notices.push(
        `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
      );
      details["matchLimitReached"] = effectiveLimit;
    }

    if (truncation.truncated) {
      notices.push(`${sizeOf(MAX_BYTES)} limit reached`);
      details["truncated"] = true;
    }

    if (linesTruncated) {
      notices.push(
        `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
      );
      details["linesTruncated"] = true;
    }

    return textResult(withNotices(truncation.content, notices), details);
  }),
});

/** The `files` extension: `ls`, `find`, and `grep` over the Session's Workspace. */
export const Files = Effect.all([Ls, Find, Grep]).pipe(
  Effect.map((tools) => defineExtension({ name: "files", tools })),
);
