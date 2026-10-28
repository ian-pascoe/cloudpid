// The model tools' file operations on Container-only paths (GLOSSARY.md), run on the Container (ADR-0018).
// `@cloudflare/computer` reaches a Container only through commands, so each operation is a bash script there. Bytes cross
// through the Workspace's own files: a script copies a file to a stage under `/workspace/.cloudpid/tmp`, which computer
// pulls into the Workspace DO after the command, and a write stages its bytes there first, which computer pushes to the
// Container before the command. Metadata, listings and matches come back on standard output.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off preferEffectArray:off
import type { FileErrorCode, FileInfo, FileKind } from "@earendil-works/pi-durable/env";
import { HARNESS_ROOT, isContainerOnly } from "./container-paths.ts";
import { HostFailure } from "./failure.ts";
import { basename } from "./paths.ts";
import type {
  DirectoryEntry,
  FindOptions,
  FoundEntry,
  GrepLine,
  GrepMatch,
  GrepOptions,
} from "./wire.ts";

/** How a script on the Container ended: its exit status (null when it did not run to its end), and its two streams. */
export type ContainerScriptRun = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** What the Workspace DO gives the Container's file operations. */
export type ContainerAccess = {
  /** The Container-only patterns of the Container's current launch (or the next one), the harness's kept last. */
  readonly patterns: () => Promise<readonly string[] | undefined>;
  /** Whether the Container runs now, so a listing may ask it without starting it. */
  readonly running: () => boolean;
  /**
   * Run a bash script on the Container, starting it if it is stopped, with `env` in its environment. `writes` says
   * whether it may change the Container's disk (a write of a Container-only file), so its idle stop snapshots it;
   * unsaid, it may.
   */
  readonly run: (
    script: string,
    env: Readonly<Record<string, string>>,
    options?: { readonly writes?: boolean | undefined },
  ) => Promise<ContainerScriptRun>;
};

/** The Workspace DO's file operations the Container's need: its stage files, read and removed. */
export type StageFiles = {
  readonly read: (path: string) => Promise<Uint8Array>;
  readonly write: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
};

/** Where a file crossing between the Container and the Workspace DO is staged: synced, and the harness's own. */
export const STAGE_DIR = `${HARNESS_ROOT}/tmp`;

/**
 * The largest file `read`, `edit` and a reader copy over: the whole file crosses through the Workspace's files, since
 * pi-durable's line scan needs every byte (a ranged read on the Container could not count decoded UTF-8 as it does).
 * Larger ones are left to `bash` (`head`, `sed -n`).
 */
export const MAX_CONTAINER_FILE_BYTES = 32 * 1024 * 1024;

/** How many lines of a listing or a search a script prints at most, so a huge tree cannot flood the answer. */
const MAX_LISTED = 20_000;

/** How many reads' hashes a write is checked against, so a long-lived Workspace DO does not keep one per file read. */
const MAX_HASHED = 256;

/** The exit statuses the scripts end with for each failure, and the code pi-durable gives it. */
const FAILURES: ReadonlyMap<number, FileErrorCode> = new Map([
  [10, "not_found"],
  [11, "not_directory"],
  [12, "is_directory"],
  [13, "permission_denied"],
  [14, "invalid"],
  [15, "invalid"],
]);

/**
 * The start of every script: `fail` ends it with one of `FAILURES`, `failed` with the one an error message says, and
 * `exists` fails unless `$P` is there (as a link, too).
 */
const PRELUDE = String.raw`set -o pipefail
fail() { printf '%s' "$2" >&2; exit "$1"; }
failed() {
  case "$1" in
    *"No such file"*) fail 10 "No such file or directory" ;;
    *"Not a directory"*) fail 11 "Not a directory" ;;
    *"Is a directory"*) fail 12 "Is a directory" ;;
    *"Permission denied"*|*"Read-only file system"*|*"Operation not permitted"*) fail 13 "$1" ;;
    *) fail 1 "$1" ;;
  esac
}
exists() { [ -e "$P" ] || [ -L "$P" ] || fail 10 "No such file or directory"; }
`;

/** Prints `$P`'s kind, size and modification time (seconds, to the millisecond), following a link when `FOLLOW=1`. */
const STAT = String.raw`out=$( { if [ "$FOLLOW" = 1 ]; then stat -L --printf '%F\t%s\t%.3Y' -- "$P"; else stat --printf '%F\t%s\t%.3Y' -- "$P"; fi; } 2>&1 ) || failed "$out"
printf '%s\n' "$out"
`;

/** Copies the regular file `$P` to the stage `$S`, unless it is larger than `$MAX` bytes. */
const COPY_OUT = String.raw`[ -d "$P" ] && fail 12 "Is a directory"
[ -f "$P" ] || fail 14 "Not a regular file"
size=$(stat -L -c %s -- "$P" 2>&1) || failed "$size"
[ "$size" -le "$MAX" ] || fail 14 "The file is $size bytes, more than the $MAX the file tools copy from the Container: read parts of it with bash (head, sed -n) instead"
out=$( { mkdir -p -- "$(dirname -- "$S")" && cp -- "$P" "$S"; } 2>&1 ) || failed "$out"
`;

const READ_FILE = `${PRELUDE}exists\n${COPY_OUT}`;

const OPEN_READER = `${PRELUDE}exists
[ "$NOFOLLOW" = 1 ] && [ -L "$P" ] && fail 14 "Refusing to follow a symbolic link"
${COPY_OUT}FOLLOW=1
${STAT}`;

const INFO = `${PRELUDE}exists\n${STAT}`;

const CANONICAL = String.raw`${PRELUDE}exists
out=$(realpath -e -- "$P" 2>&1) || failed "$out"
printf '%s\n' "$out"
`;

/**
 * Writes or appends the stage `$S` to `$P`, making its parents. A write replaces the file in one step (a temp file
 * beside it, with its mode, moved over it); with `$EXPECT`, only while the file still has that SHA-256, so a change made
 * on the Container since the file was read is not lost.
 */
const WRITE_FILE = String.raw`${PRELUDE}[ -d "$P" ] && fail 12 "Is a directory"
out=$(mkdir -p -- "$(dirname -- "$P")" 2>&1) || failed "$out"
if [ -n "$EXPECT" ] && [ -f "$P" ]; then
  now=$( { sha256sum < "$P"; } 2>&1 ) || failed "$now"
  [ "$now" = "$EXPECT  -" ] || fail 15 "The file changed on the Container since it was read: read it again"
fi
if [ "$APPEND" = 1 ]; then
  out=$(cat -- "$S" 2>&1 >> "$P") || failed "$out"
else
  t="$P.cloudpid-$$"
  out=$(cat -- "$S" 2>&1 > "$t") || { rm -f -- "$t"; failed "$out"; }
  [ -e "$P" ] && chmod --reference="$P" -- "$t" 2>/dev/null
  out=$(mv -f -- "$t" "$P" 2>&1) || { rm -f -- "$t"; failed "$out"; }
fi
rm -f -- "$S"
`;

/** Lists directory `$P`: one `kind<TAB>name` line per entry, the kind find's `%y` (`d`, `f`, `l`, …). */
const LIST = String.raw`${PRELUDE}exists
[ -d "$P" ] || fail 11 "Not a directory"
find "$P" -mindepth 1 -maxdepth 1 -printf '%y\t%f\n' 2>/dev/null | head -n "$LIMIT"
`;

/**
 * Lists everything below directory `$P` whose path matches find's `-path` pattern `$GLOB` (a superset of the glob,
 * filtered exactly afterwards), pruning the directories named in the positional arguments: `kind<TAB>relative path`.
 */
const FIND = String.raw`${PRELUDE}exists
[ -d "$P" ] || fail 11 "Not a directory"
names=$#
for name in "$@"; do
  set -- "$@" -o -name "$name"
done
shift "$names"
if [ "$#" -gt 0 ]; then
  find "$P" -mindepth 1 \( -type d \( -false "$@" \) \) -prune -o -path "$GLOB" -printf '%y\t%P\n' 2>/dev/null | head -n "$LIMIT"
else
  find "$P" -mindepth 1 -path "$GLOB" -printf '%y\t%P\n' 2>/dev/null | head -n "$LIMIT"
fi
exit 0
`;

/**
 * The directory searched (`$P`, or the one of file `$P`), then ripgrep's JSON events for `$PATTERN` there, with the
 * options in the positional arguments. ripgrep runs in that directory, as it tests its globs against the path it
 * prints. With `pipefail` the pipeline's status is ripgrep's (`head` ends with 0): 1 for no match, 141 when `head`
 * stopped reading, 2 for an error, which leaves the matches found elsewhere (in a file it could not read, say).
 */
const GREP = String.raw`${PRELUDE}exists
if [ -d "$P" ]; then root=$P; target=.; else root=$(dirname -- "$P"); target="./$(basename -- "$P")"; fi
out=$(cd -- "$root" 2>&1) || failed "$out"
cd -- "$root"
printf '%s\n' "$root"
out=$(rg --json --no-ignore --hidden --no-config "$@" -e "$PATTERN" -- "$target" | head -n "$LIMIT")
code=$?
if [ "$code" = 2 ]; then
  case "$out" in *'"type":"match"'*) ;; *) exit 1 ;; esac
elif [ "$code" -gt 1 ] && [ "$code" != 141 ]; then
  exit 1
fi
printf '%s\n' "$out"
`;

const decoder = new TextDecoder();

/** The kinds `stat`'s `%F` names, as pi-durable's. */
const KINDS: ReadonlyMap<string, FileKind> = new Map([
  ["regular file", "file"],
  ["regular empty file", "file"],
  ["directory", "directory"],
  ["symbolic link", "symlink"],
]);

/** A `kind<TAB>size<TAB>mtime` line of `STAT` as pi-durable's metadata of `path`. */
const parseInfo = (path: string, line: string): FileInfo => {
  const [kind = "", size = "0", mtime = "0"] = line.trim().split("\t");
  const known = KINDS.get(kind);

  if (known === undefined) throw new HostFailure("invalid", "Unsupported file type", path);

  return {
    name: basename(path),
    path,
    kind: known,
    size: Number(size),
    mtimeMs: Math.round(Number(mtime) * 1000),
  };
};

const escape = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * A glob, as computer's `fs.find` and `fs.grep` take them, as a test of a path relative to the searched directory:
 * `**` any number of segments, `*` and `?` within one, `{a,b}` either.
 */
export const globTest = (glob: string): RegExp => {
  let source = "";

  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? "";

    if (char === "*" && glob[index + 1] === "*") {
      const slash = glob[index + 2] === "/";

      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const close = glob.indexOf("}", index);

      if (close === -1) {
        source += "\\{";
      } else {
        source += `(?:${glob
          .slice(index + 1, close)
          .split(",")
          .map((part) => globTest(part).source.slice(1, -1))
          .join("|")})`;
        index = close;
      }
    } else {
      source += escape(char);
    }
  }

  return new RegExp(`^${source}$`);
};

/** The names of the directories `**` + `/NAME/**` excludes, which the Container can prune without walking them. */
const prunedNames = (exclude: ReadonlyArray<string>): string[] =>
  exclude.flatMap((glob) => {
    const name = /^\*\*\/([^/*?{}[\]]+)\/\*\*$/.exec(glob)?.[1];

    return name === undefined ? [] : [name];
  });

/** `relative` is left out by one of the exclude globs: itself, or a directory above it. */
const excluded = (relative: string, exclude: ReadonlyArray<RegExp>): boolean => {
  const segments = relative.split("/");

  return segments.some((_, index) => {
    const prefix = segments.slice(0, index + 1).join("/");

    return exclude.some((test) => test.test(prefix) || test.test(`${prefix}/`));
  });
};

/** A path below `directory`, which may be the root. */
const below = (directory: string, name: string): string =>
  directory === "/" ? `/${name}` : `${directory}/${name}`;

type RgText = { readonly text?: string; readonly bytes?: string };

type RgEvent = {
  readonly type: string;
  readonly data?: {
    readonly path?: RgText;
    readonly lines?: RgText;
    readonly line_number?: number;
  };
};

/** `LIST`'s `kind<TAB>name` lines as directory entries. */
const entriesOf = (out: string): DirectoryEntry[] =>
  out.split("\n").flatMap((line) => {
    const tab = line.indexOf("\t");
    const name = line.slice(tab + 1);

    if (tab === -1 || name === "") return [];

    const kind = line.slice(0, tab);

    return [{ name, isDirectory: kind === "d", isSymbolicLink: kind === "l" }];
  });

const rgText = (value: RgText | undefined): string => {
  if (value?.text !== undefined) return value.text;

  if (value?.bytes !== undefined)
    return decoder.decode(Uint8Array.from(atob(value.bytes), (c) => c.charCodeAt(0)));

  return "";
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** The file operations of the model's tools on Container-only paths. Each one is a script on the Container. */
export class ContainerFiles {
  readonly #access: ContainerAccess;
  readonly #stage: StageFiles;
  readonly #stageDir: string;
  /**
   * The SHA-256 each Container file had when it was last read whole (`edit` reads, then writes), the latest
   * `MAX_HASHED` reads only.
   */
  readonly #hashes = new Map<string, string>();

  /** @param stageDir Where files cross, seen alike by both sides: `STAGE_DIR`, except in tests. */
  constructor(access: ContainerAccess, stage: StageFiles, stageDir = STAGE_DIR) {
    this.#access = access;
    this.#stage = stage;
    this.#stageDir = stageDir;
  }

  /** For each path, whether it is a Container-only path for the Container's current launch. */
  async classify(paths: readonly string[]): Promise<boolean[]> {
    const patterns = await this.#access.patterns();

    return paths.map((path) => isContainerOnly(path, patterns));
  }

  async info(path: string, follow: boolean): Promise<FileInfo> {
    const out = await this.#run(path, INFO, { P: path, FOLLOW: follow ? "1" : "0" });

    return parseInfo(path, out);
  }

  async canonical(path: string): Promise<string> {
    return (await this.#run(path, CANONICAL, { P: path })).trim();
  }

  /** The bytes of file `path`, remembered by hash so that a write after them can check the file is unchanged. */
  async readFile(path: string): Promise<Uint8Array> {
    const bytes = await this.#copyOut(path, READ_FILE, {});

    const hash = await sha256(bytes);

    this.#hashes.delete(path);
    this.#hashes.set(path, hash);

    // The oldest read goes first: an edit writes right after its read.
    for (const oldest of this.#hashes.keys()) {
      if (this.#hashes.size <= MAX_HASHED) break;

      this.#hashes.delete(oldest);
    }

    return bytes;
  }

  /**
   * Write or append `bytes` to `path`. A write after `readFile` of the same path (as `edit` does) replaces the file only
   * if it still has the bytes read.
   */
  async writeFile(path: string, bytes: Uint8Array, append: boolean): Promise<void> {
    const stage = this.#stagePath();
    const expected = this.#hashes.get(path);

    this.#hashes.delete(path);
    await this.#stage.write(stage, bytes);

    try {
      await this.#run(
        path,
        WRITE_FILE,
        { P: path, S: stage, APPEND: append ? "1" : "0", EXPECT: expected ?? "" },
        { writes: true },
      );
    } finally {
      await this.#stage.remove(stage);
    }
  }

  /**
   * Copy file `path` into the Workspace's files for a reader, and its metadata. `open` turns the stage into the
   * Workspace DO's own reader (a hard link that keeps it), so the copy is a snapshot of the file as it was opened.
   */
  async openReader<Opened>(
    path: string,
    noFollow: boolean,
    open: (stage: string) => Promise<Opened>,
  ): Promise<{ readonly opened: Opened; readonly info: FileInfo }> {
    const stage = this.#stagePath();

    try {
      const out = await this.#run(path, OPEN_READER, {
        P: path,
        S: stage,
        MAX: String(MAX_CONTAINER_FILE_BYTES),
        NOFOLLOW: noFollow ? "1" : "0",
      });

      return { opened: await open(stage), info: parseInfo(path, out) };
    } finally {
      await this.#stage.remove(stage);
    }
  }

  /** The entries of Container directory `path`. */
  async readdir(path: string): Promise<DirectoryEntry[]> {
    return entriesOf(await this.#run(path, LIST, { P: path, LIMIT: String(MAX_LISTED) }));
  }

  /**
   * The Container-only entries of synced directory `path` that the running Container has, marked: none when it is
   * stopped (a listing does not start it), or when no pattern could name one.
   */
  async containerOnlyEntries(path: string): Promise<DirectoryEntry[]> {
    const patterns = await this.#access.patterns();

    if (!this.#access.running() || patterns === undefined || patterns.length === 0) return [];

    let out: string;

    try {
      out = await this.#run(path, LIST, { P: path, LIMIT: String(MAX_LISTED) });
    } catch {
      // A listing that cannot ask the Container still lists the Workspace's own entries.
      return [];
    }

    return entriesOf(out)
      .filter((entry) => isContainerOnly(below(path, entry.name), patterns))
      .map((entry) => ({ ...entry, containerOnly: true }));
  }

  async find(directory: string, pattern: string, options: FindOptions): Promise<FoundEntry[]> {
    const test = globTest(pattern);
    const exclude = options.exclude.map(globTest);
    // find's `*` crosses `/`, so `**` and `*` both become it: every path the glob matches matches this too. What the
    // glob takes literally (and all of the directory) is escaped, as find would read `[` as a class.
    const literal = (text: string) => text.replace(/[*?[\]\\]/g, "\\$&");

    const approximate = `${directory === "/" ? "" : literal(directory)}/${pattern
      .replace(/[[\]\\]/g, "\\$&")
      .replace(/\*\*\/?/g, "*")
      .replace(/\{[^}]*\}/g, "*")}`;

    const out = await this.#run(
      directory,
      FIND,
      { P: directory, GLOB: approximate, LIMIT: String(MAX_LISTED) },
      { args: prunedNames(options.exclude) },
    );

    const found: FoundEntry[] = [];

    for (const line of out.split("\n")) {
      if (found.length >= options.limit) break;

      const tab = line.indexOf("\t");

      if (tab === -1) continue;

      const relative = line.slice(tab + 1);

      if (!test.test(relative) || excluded(relative, exclude)) continue;

      found.push({
        path: below(directory, relative),
        type: line.slice(0, tab) === "d" ? "dir" : "file",
      });
    }

    return found;
  }

  async grep(pattern: string, path: string, options: GrepOptions): Promise<GrepMatch[]> {
    const args = [
      ...(options.ignoreCase ? ["-i"] : []),
      ...(options.regex ? [] : ["-F"]),
      ...(options.context > 0 ? ["-C", String(options.context)] : []),
      ...(options.include === undefined ? [] : ["-g", options.include]),
      ...options.exclude.map((glob) => `-g!${glob}`),
    ];

    // Each match brings at most its context on either side, and each file a begin and an end event.
    const events = options.limit * (2 * options.context + 3) + 1000;

    const out = await this.#run(
      path,
      GREP,
      { P: path, PATTERN: pattern, LIMIT: String(events) },
      { args },
    );

    // Every line of each file in order, then each match with the lines around it.
    const files = new Map<string, Map<number, GrepLine>>();

    const matches: Array<{ readonly path: string; readonly line: number; readonly text: string }> =
      [];

    const [root = path, ...printed] = out.split("\n");

    for (const raw of printed) {
      if (raw === "") continue;

      let event: RgEvent;

      try {
        // SAFETY: `rg --json` prints one such object per line; every field read below is optional and checked.
        event = JSON.parse(raw) as RgEvent;
      } catch {
        continue;
      }

      if ((event.type !== "match" && event.type !== "context") || event.data === undefined)
        continue;

      // ripgrep names each file from the directory it ran in, as `./relative`.
      const file = below(root, rgText(event.data.path).replace(/^\.\//, ""));
      const line = event.data.line_number ?? 0;
      const text = rgText(event.data.lines).replace(/\r?\n$/, "");
      const lines = files.get(file) ?? new Map<number, GrepLine>();

      files.set(file, lines);
      lines.set(line, { line, text, isMatch: event.type === "match" });

      if (event.type === "match" && matches.length < options.limit) {
        matches.push({ path: file, line, text });
      }
    }

    return matches.map((match) => {
      if (options.context === 0) return match;

      const lines = files.get(match.path);
      const context: GrepLine[] = [];

      for (let line = match.line - options.context; line <= match.line + options.context; line++) {
        const found = lines?.get(line);

        if (found !== undefined) context.push(found);
      }

      return { ...match, context };
    });
  }

  async #copyOut(path: string, script: string, env: Record<string, string>): Promise<Uint8Array> {
    const stage = this.#stagePath();

    try {
      await this.#run(path, script, {
        ...env,
        P: path,
        S: stage,
        MAX: String(MAX_CONTAINER_FILE_BYTES),
      });

      return await this.#stage.read(stage);
    } finally {
      await this.#stage.remove(stage);
    }
  }

  #stagePath(): string {
    return `${this.#stageDir}/xfer-${crypto.randomUUID()}`;
  }

  /**
   * Run `script` for an operation on `path` (one that changes a Container-only file when `writes`; the others only read
   * it), with `args` as its positional parameters; its standard output, or the failure it ended with, named as the
   * Container's.
   */
  async #run(
    path: string,
    script: string,
    env: Record<string, string>,
    {
      args = [],
      writes = false,
    }: { readonly args?: readonly string[]; readonly writes?: boolean } = {},
  ): Promise<string> {
    const quoted = args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
    const body = args.length === 0 ? script : `set -- ${quoted}\n${script}`;

    let ran: ContainerScriptRun;

    try {
      ran = await this.#access.run(body, env, { writes });
    } catch (cause) {
      throw new HostFailure(
        "unknown",
        `The Container could not run the file operation: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
      );
    }

    if (ran.exitCode === 0) return ran.stdout;

    if (ran.exitCode === null) {
      throw new HostFailure(
        "unknown",
        `The Container could not run the file operation: ${ran.stderr}`,
        path,
      );
    }

    const message = ran.stderr.trim() || `exit status ${ran.exitCode}`;

    throw new HostFailure(
      FAILURES.get(ran.exitCode) ?? "unknown",
      `${message} (on the Container)`,
      path,
    );
  }
}
