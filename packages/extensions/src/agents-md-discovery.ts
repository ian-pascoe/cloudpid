// Finding project instructions (docs/architecture/workspace.md → Filesystem and tools → Project instructions): the `AGENTS.md` (or
// `CLAUDE.md`) of a directory and of each directory above it up to the Workspace root, as local pi finds them
// (`loadProjectContextFiles` in pi's coding agent: the first of `INSTRUCTION_FILE_NAMES` in each directory, the farthest
// first). It reads files only, through the small part of an `ExecutionEnv` it needs, so it runs where the files are as
// well as in a Session: the Workspace DO runs it next to its own storage (`discoverInstructions` of `InstructionSource`),
// so a lookup costs one RPC however deep the directory is. It is a module of its own because the Workspaces Worker loads
// it, and must not load the harness with it.
// @effect-diagnostics missingPipeableSignature:off
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * The names a directory's instructions file may have, in the order they are looked for; the first one there is the
 * directory's. pi's list: codex's local override first, then `AGENTS.md`, then Claude Code's `CLAUDE.md`.
 */
export const INSTRUCTION_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/** The Workspace root: discovery goes no further up. */
export const INSTRUCTIONS_ROOT = "/workspace";

/**
 * The most characters of one file that are shown; the rest is left for the agent to `read`. Far above a real
 * `AGENTS.md` (this repo's is about 30 KB), below what a repo could make every request carry.
 */
export const MAX_INSTRUCTION_CHARACTERS = 64 * 1024;

/** The most lines of one file that are shown, for the same reason. */
export const MAX_INSTRUCTION_LINES = 1_000;

/** One directory's instructions. */
export type InstructionFile = {
  /** The absolute path of the file. */
  readonly path: string;
  /** The directory it is for: its files and everything below it. */
  readonly directory: string;
  /** Its text, cut to `MAX_INSTRUCTION_CHARACTERS` and `MAX_INSTRUCTION_LINES` with a note saying so. */
  readonly content: string;
};

/** What discovery uses of an environment: it reads files and never executes. */
export type InstructionsEnv = Pick<ExecutionEnv, "readTextFile">;

/** Reading instructions failed in a way that is not "there are none". */
export class InstructionsError extends Schema.TaggedError<
  InstructionsError,
  { readonly brand: unique symbol }
>()("InstructionsError", { message: Schema.String }) {}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** `directory` without trailing slashes; `/` stays `/`. */
const normalize = (directory: string) => directory.replace(/\/+$/, "") || "/";

const join = (directory: string, name: string) =>
  directory === "/" ? `/${name}` : `${directory}/${name}`;

/**
 * The directories whose instructions apply to the files of `directory`: `root`, each directory between, and `directory`
 * itself, the farthest first, as they are shown. A directory outside `root` has only its own.
 */
export const instructionDirectories = (
  directory: string,
  root: string = INSTRUCTIONS_ROOT,
): ReadonlyArray<string> => {
  const target = normalize(directory);
  const top = normalize(root);

  if (target === top) return [top];

  const prefix = top === "/" ? "/" : `${top}/`;

  if (!target.startsWith(prefix)) return [target];

  const segments = target.slice(prefix.length).split("/");

  return [
    top,
    ...Arr.map(segments, (_, index) => join(top, Arr.join(Arr.take(segments, index + 1), "/"))),
  ];
};

/** `text` cut to the bounds of one file, ending with a note that names what was left out. */
export const boundInstructions = (path: string, text: string): string => {
  const lines = text.split("\n");
  const byLines = lines.length > MAX_INSTRUCTION_LINES;
  const kept = byLines ? Arr.join(Arr.take(lines, MAX_INSTRUCTION_LINES), "\n") : text;
  const bounded = kept.length > MAX_INSTRUCTION_CHARACTERS;

  if (!byLines && !bounded) return text;

  const shown = bounded ? kept.slice(0, MAX_INSTRUCTION_CHARACTERS) : kept;

  return `${shown}\n[${path} is longer than shown here (${text.length} characters, ${lines.length} lines): read it for the rest.]`;
};

/** The first instructions file of `directory`, if it has one with any text. */
const instructionsIn = (
  env: InstructionsEnv,
  directory: string,
  context: Context,
): Effect.Effect<InstructionFile | undefined, InstructionsError> =>
  Effect.gen(function* () {
    for (const name of INSTRUCTION_FILE_NAMES) {
      const path = join(directory, name);

      const read = yield* Effect.tryPromise({
        try: () => env.readTextFile(path, context),
        catch: (cause) =>
          InstructionsError.make({ message: `Cannot read ${path}: ${message(cause)}` }),
      });

      if (!read.ok) {
        const { code } = read.error;

        // Not there (or not a file): the next name, as pi's `existsSync` and `isFile` checks go on to it.
        if (code === "not_found" || code === "not_directory" || code === "is_directory") continue;

        return yield* InstructionsError.make({
          message: `Cannot read ${path}: ${read.error.message}`,
        });
      }

      const text = read.value.replace(/^\uFEFF/, "");

      // An empty file says nothing, as codex leaves one out; the directory has no instructions then.
      if (text.trim() === "") return undefined;

      return { path, directory, content: boundInstructions(path, text) };
    }

    return undefined;
  });

/**
 * The instructions that apply to the files of `directory`: the first instructions file of each directory from `root`
 * down to it, the farthest first.
 */
export const discoverInstructions = (
  env: InstructionsEnv,
  directory: string,
  root: string = INSTRUCTIONS_ROOT,
  context: Context = BACKGROUND_CONTEXT,
): Effect.Effect<ReadonlyArray<InstructionFile>, InstructionsError> =>
  Effect.map(
    Effect.forEach(
      instructionDirectories(directory, root),
      (each) => instructionsIn(env, each, context),
      { concurrency: 4 },
    ),
    Arr.filter(Predicate.isNotUndefined),
  );

/**
 * An environment that finds the instructions of a directory itself, where its files are: `ComputerExecutionEnv` asks
 * the Workspace DO, which reads next to its storage, so a lookup is one RPC instead of a read per name and directory.
 */
export type InstructionSource = {
  readonly discoverInstructions: (
    directory: string,
    context: Context,
  ) => Promise<ReadonlyArray<InstructionFile>>;
};

/** Whether `env` finds instructions itself. */
export const isInstructionSource = <Env extends object>(env: Env): env is Env & InstructionSource =>
  Predicate.hasProperty(env, "discoverInstructions") &&
  Predicate.isFunction(env.discoverInstructions);
