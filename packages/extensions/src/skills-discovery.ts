// Finding skills (docs/spec.md → Filesystem and tools): what a skill is, how a `SKILL.md` is read, and the walk from a
// conversation's `cwd` up to the Workspace root through each `.agents/skills`. It reads files only, through the small
// part of an `ExecutionEnv` it needs, so it runs where the files are as well as in a Session: the Workspace DO runs it
// next to its own storage (`discoverSkills` of `SkillSource`), so a request costs one RPC however many skills there are.
// It is a module of its own because the Workspaces Worker loads it, and must not load the harness with it.
// @effect-diagnostics missingPipeableSignature:off
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileListEntry } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

/** A skill: a directory with a `SKILL.md` whose frontmatter names and describes it. */
export type Skill = {
  readonly name: string;
  readonly description: string;
  /** The absolute path of its `SKILL.md`. */
  readonly filePath: string;
  /** `disable-model-invocation: true`: the skill is for when the user names it, so the prompt does not list it. */
  readonly disableModelInvocation: boolean;
};

/** Where the skills of a directory are, below it. */
export const SKILLS_DIRECTORY = ".agents/skills";

/** The Workspace root: discovery goes no further up. */
const WORKSPACE_ROOT = "/workspace";

/** Where the Environment's Skill set is mounted, read-only, in every Workspace: the Workspace root's own `.agents/skills`. */
export const SKILL_SET_DIRECTORY = `${WORKSPACE_ROOT}/${SKILLS_DIRECTORY}`;

/** The longest description listed, the Agent Skills limit: a repo's skills are not trusted to size the prompt. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** The most skills listed, nearest first. */
export const MAX_SKILLS = 100;

/** The most entries listed in a `.agents/skills` directory: far above any real one, below a walk of a whole tree. */
const MAX_ROOT_ENTRIES = 5000;

/** The most entries read from a directory a skills link points to: a link may lead anywhere, however large. */
const MAX_LINKED_ENTRIES = 200;

/** What discovery uses of the call's environment: it reads files and never executes. */
export type SkillsEnv = Pick<ExecutionEnv, "cwd" | "listFiles" | "readTextFile">;

/** Reading skills failed in a way that is not "there are none"; the section keeps what it last showed. */
export class SkillsError extends Schema.TaggedError<
  SkillsError,
  { readonly brand: unique symbol }
>()("SkillsError", { message: Schema.String }) {}

export const attempt = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, SkillsError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      SkillsError.make({
        message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** `text` split into its YAML frontmatter and the rest, as pi's `parseFrontmatter` does. */
const frontmatterOf = (text: string): string | undefined => {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  if (!normalized.startsWith("---")) return undefined;

  const end = normalized.indexOf("\n---", 3);

  return end === -1 ? undefined : normalized.slice(4, end);
};

/** The frontmatter fields a skill is read from; the others (`license`, `metadata`, …) are not used. */
const Frontmatter = Schema.Struct({
  name: Schema.optionalKey(Schema.Unknown),
  description: Schema.String,
  "disable-model-invocation": Schema.optionalKey(Schema.Unknown),
});

const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter);

/** The fields of a `SKILL.md`'s frontmatter that a skill is read from, as YAML gives them: not checked yet. */
const FrontmatterFields = Schema.Struct({
  name: Schema.optionalKey(Schema.Unknown),
  description: Schema.optionalKey(Schema.Unknown),
  "disable-model-invocation": Schema.optionalKey(Schema.Unknown),
  /** Agent Skills' free-form mapping; the install from GitHub reads `internal` of it, as the `skills` CLI does. */
  metadata: Schema.optionalKey(Schema.Unknown),
});

export type FrontmatterFields = typeof FrontmatterFields.Type;

const decodeFields = Schema.decodeUnknownOption(FrontmatterFields);

/**
 * The frontmatter of a `SKILL.md`'s `text`, parsed: undefined when it has none, it is not YAML, or it is not a mapping
 * of fields.
 */
export const readFrontmatter = (text: string): FrontmatterFields | undefined => {
  const source = frontmatterOf(text);

  if (source === undefined) return undefined;

  try {
    const parsed: unknown = parse(source);

    return Predicate.isObject(parsed) && !Arr.isArray(parsed)
      ? Option.getOrUndefined(decodeFields(parsed))
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The skill a `SKILL.md` at `filePath` declares, or undefined when its frontmatter is missing, is not YAML, or holds no
 * description (pi loads no such skill). A skill without a `name` takes its directory's.
 */
export const parseSkill = (filePath: string, text: string): Skill | undefined => {
  const frontmatter = readFrontmatter(text);

  if (frontmatter === undefined) return undefined;

  const declared = decodeFrontmatter(frontmatter);

  if (Option.isNone(declared) || declared.value.description.trim() === "") return undefined;

  const { name, description } = declared.value;

  return {
    name: Predicate.isString(name) && name !== "" ? name : (filePath.split("/").at(-2) ?? ""),
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    filePath,
    disableModelInvocation: declared.value["disable-model-invocation"] === true,
  };
};

/** The directories whose `.agents/skills` count for a conversation in `cwd`: it and those above it up to the Workspace root. */
export const skillDirectories = (cwd: string): ReadonlyArray<string> => {
  const directory = cwd.replace(/\/+$/, "") || "/";

  if (!directory.startsWith(`${WORKSPACE_ROOT}/`)) return [directory];

  const segments = directory.slice(WORKSPACE_ROOT.length + 1).split("/");

  return [
    ...Arr.map(
      segments,
      (_, depth) =>
        `${WORKSPACE_ROOT}/${Arr.join(Arr.take(segments, segments.length - depth), "/")}`,
    ),
    WORKSPACE_ROOT,
  ];
};

/** The `SKILL.md` files below a skills directory: those outside dot directories and `node_modules`, and not inside another skill. */
const skillFiles = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const candidates = Arr.filter(
    paths,
    (path) =>
      (path === "SKILL.md" || path.endsWith("/SKILL.md")) &&
      !Arr.some(
        path.split("/"),
        (segment) => segment.startsWith(".") || segment === "node_modules",
      ),
  );

  const roots = Arr.map(candidates, (path) => path.slice(0, -"SKILL.md".length));

  // A directory with a `SKILL.md` is a skill root, and pi does not look below one.
  return Arr.filter(
    candidates,
    (path) =>
      !Arr.some(
        roots,
        (root) => root !== "" && path !== `${root}SKILL.md` && path.startsWith(root),
      ),
  );
};

export const join = (directory: string, path: string): string =>
  directory === "/" ? `/${path}` : `${directory}/${path}`;

/**
 * The entries below `directory`, none when it is absent, is not a directory, or is a link to nothing. `what` names
 * what is looked for there, for the error.
 */
export const entriesBelow = (
  env: SkillsEnv,
  directory: string,
  maxEntries: number,
  what = "skills",
): Effect.Effect<ReadonlyArray<FileListEntry>, SkillsError> =>
  Effect.gen(function* () {
    if (env.listFiles === undefined) return [];

    const listing = yield* attempt(`Cannot list ${what}`, () =>
      // Hidden: the skills are looked for in `.agents`. Not git's ignore rules: they are for the repo's files.
      env.listFiles!(
        directory,
        {
          hidden: true,
          gitignore: false,
          exclude: ["node_modules"],
          maxEntries,
        },
        BACKGROUND_CONTEXT,
      ),
    );

    if (listing.ok) return listing.value.entries;

    return listing.error.code === "not_found" || listing.error.code === "not_directory"
      ? []
      : yield* SkillsError.make({
          message: `Cannot list ${what} in ${directory}: ${listing.error.message}`,
        });
  });

/**
 * The paths below a `.agents/skills` directory that may hold a skill's `SKILL.md`: its files and links, and what the
 * links to directories hold, one level deep, as pi follows a skill installer's symbolic links (`listFiles` itself
 * does not follow them).
 */
const candidatePaths = (
  env: SkillsEnv,
  root: string,
): Effect.Effect<ReadonlyArray<string>, SkillsError> =>
  Effect.gen(function* () {
    const entries = yield* entriesBelow(env, root, MAX_ROOT_ENTRIES);

    const linked = yield* Effect.forEach(
      Arr.filter(
        entries,
        (entry) =>
          entry.kind === "symlink" &&
          !Arr.some(entry.path.split("/"), (part) => part.startsWith(".")),
      ),
      (link) =>
        Effect.map(entriesBelow(env, join(root, link.path), MAX_LINKED_ENTRIES), (inside) =>
          Arr.map(inside, (entry) => ({ ...entry, path: `${link.path}/${entry.path}` })),
        ),
      { concurrency: 8 },
    );

    return Arr.flatMap([...entries, ...Arr.flatten(linked)], (entry) =>
      entry.kind === "directory" ? [] : [entry.path],
    );
  });

/**
 * The skills among files already in hand: `files` are the paths below the skills directory `root` with their text, as
 * a walk of the directory would read them. At most `MAX_SKILLS` are read, as in `skillsIn`.
 */
export const skillsOfFiles = (
  root: string,
  files: Iterable<readonly [path: string, text: string]>,
): ReadonlyArray<Skill> => {
  const texts = new Map(files);

  return Arr.getSomes(
    Arr.map(Arr.take(skillFiles([...texts.keys()]), MAX_SKILLS), (path) =>
      Option.fromNullishOr(parseSkill(join(root, path), texts.get(path) ?? "")),
    ),
  );
};

/** The skills in one `.agents/skills` directory, none when it is absent. */
const skillsIn = (env: SkillsEnv, root: string): Effect.Effect<ReadonlyArray<Skill>, SkillsError> =>
  Effect.gen(function* () {
    // Capped before any file is read: a directory may hold far more than the prompt lists.
    const files = Arr.take(skillFiles(yield* candidatePaths(env, root)), MAX_SKILLS);

    const skills = yield* Effect.forEach(
      files,
      (path) =>
        attempt(`Cannot read ${path}`, () =>
          env.readTextFile(join(root, path), BACKGROUND_CONTEXT),
        ).pipe(
          Effect.map((read) =>
            read.ok
              ? Option.fromNullishOr(parseSkill(join(root, path), read.value))
              : Option.none(),
          ),
        ),
      { concurrency: 8 },
    );

    return Arr.getSomes(skills);
  });

/**
 * The skills a conversation in `env`'s `cwd` can use: nearest directory first, and where two have one name the first
 * wins, as pi keeps the first it finds. `known` holds the skills of a `.agents/skills` directory (by its path) that
 * are not worth a walk, as the Skill set of a read-only mount is not: those are used as they are.
 */
export const discoverSkills = (
  env: SkillsEnv,
  known: ReadonlyMap<string, ReadonlyArray<Skill>> = new Map(),
): Effect.Effect<ReadonlyArray<Skill>, SkillsError> =>
  Effect.forEach(
    skillDirectories(env.cwd),
    (directory) => {
      const root = join(directory, SKILLS_DIRECTORY);

      const skills = known.get(root);

      return skills === undefined ? skillsIn(env, root) : Effect.succeed(skills);
    },
    { concurrency: 4 },
  ).pipe(
    Effect.map((found) =>
      Arr.take(
        Arr.dedupeWith(Arr.flatten(found), (a, b) => a.name === b.name),
        MAX_SKILLS,
      ),
    ),
  );

/**
 * An environment that finds the skills of its `cwd` itself, where its files are: `ComputerExecutionEnv` asks the
 * Workspace DO, which walks next to its storage, so a request is one RPC instead of a listing per directory and a read
 * per skill.
 */
export type SkillSource = {
  readonly discoverSkills: (context: Context) => Promise<ReadonlyArray<Skill>>;
};

/** Whether `env` finds skills itself. */
export const isSkillSource = <Env extends object>(env: Env): env is Env & SkillSource =>
  Predicate.hasProperty(env, "discoverSkills") && Predicate.isFunction(env.discoverSkills);
