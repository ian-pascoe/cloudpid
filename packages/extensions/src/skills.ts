// @effect-diagnostics missingPipeableSignature:off
// The `skills` extension (docs/spec.md → Filesystem and tools): a `skills` system prompt section that lists the skills
// the agent can read, the way local pi does (`formatSkillsForPrompt` in pi's coding agent): each skill's name,
// description and the path of its `SKILL.md`, which the agent loads with `read` when a task matches. Skills are found
// in the `.agents/skills` directory of the conversation's `cwd` and of each directory above it up to the Workspace root,
// nearest first, so a repo's own skills come before the Workspace's, whose `.agents/skills` holds the bundled skills
// (`skills/`, mounted read-only). Discovery reads only files, through the conversation's environment, so it never
// starts the Container.
import { effectSection } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, type Extension, type PromptInput } from "@earendil-works/pi-durable";
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

/** Where the bundled skills are mounted, read-only, in every Workspace: the Workspace root's own `.agents/skills`. */
export const BUNDLED_SKILLS_DIRECTORY = `${WORKSPACE_ROOT}/${SKILLS_DIRECTORY}`;

/** The longest description listed, the Agent Skills limit: a repo's skills are not trusted to size the prompt. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** The most skills listed, nearest first. */
export const MAX_SKILLS = 100;

/** The most entries listed in a `.agents/skills` directory: far above any real one, below a walk of a whole tree. */
const MAX_ROOT_ENTRIES = 5000;

/** The most entries read from a directory a skills link points to: a link may lead anywhere, however large. */
const MAX_LINKED_ENTRIES = 200;

/** What discovery uses of the call's environment: it reads files and never executes. */
type SkillsEnv = Pick<ExecutionEnv, "cwd" | "listFiles" | "readTextFile">;

/** Reading skills failed in a way that is not "there are none"; the section keeps what it last showed. */
export class SkillsError extends Schema.TaggedError<
  SkillsError,
  { readonly brand: unique symbol }
>()("SkillsError", { message: Schema.String }) {}

const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, SkillsError> =>
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

/**
 * The skill a `SKILL.md` at `filePath` declares, or undefined when its frontmatter is missing, is not YAML, or holds no
 * description (pi loads no such skill). A skill without a `name` takes its directory's.
 */
export const parseSkill = (filePath: string, text: string): Skill | undefined => {
  const source = frontmatterOf(text);

  if (source === undefined) return undefined;

  let frontmatter: unknown;

  try {
    frontmatter = parse(source);
  } catch {
    return undefined;
  }

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

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** The tool a skill's file is read with, as pi's `formatSkillsForPrompt` names it. */
export type FileReadTool = "read" | "bash" | "indirect";

const LOADING: Readonly<Record<FileReadTool, string>> = {
  read: "Use the read tool to load a skill's file when the task matches its description.",
  bash: "Use bash to load a skill's file when the task matches its description.",
  indirect: "Load a skill's file when the task matches its description.",
};

/**
 * The skills as pi's `formatSkillsForPrompt` lists them (the Agent Skills standard's XML), without the skills that are
 * for the user to name, which get one line saying how to find them. Undefined when there is nothing to list.
 */
export const formatSkills = (
  skills: ReadonlyArray<Skill>,
  fileReadTool: FileReadTool = "read",
): string | undefined => {
  const visible = Arr.filter(skills, (skill) => !skill.disableModelInvocation);

  if (visible.length === 0) return undefined;

  const hidden = skills.length > visible.length;

  const bundled = Arr.some(visible, (skill) =>
    skill.filePath.startsWith(`${BUNDLED_SKILLS_DIRECTORY}/`),
  );

  return Arr.join(
    [
      "The following skills provide specialized instructions for specific tasks.",
      LOADING[fileReadTool],
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      ...(bundled
        ? [
            `The skills in ${BUNDLED_SKILLS_DIRECTORY} are bundled with the agent and read-only: do not write there.`,
          ]
        : []),
      ...(hidden
        ? [
            "Skills that are not listed are for when the user asks for one by name: then read its SKILL.md from the same skills directories.",
          ]
        : []),
      "",
      "<available_skills>",
      ...Arr.flatMap(visible, (skill) => [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        `    <location>${escapeXml(skill.filePath)}</location>`,
        "  </skill>",
      ]),
      "</available_skills>",
    ],
    "\n",
  );
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

const join = (directory: string, path: string): string =>
  directory === "/" ? `/${path}` : `${directory}/${path}`;

/** The entries below `directory`, none when it is absent, is not a directory, or is a link to nothing. */
const entriesBelow = (
  env: SkillsEnv,
  directory: string,
  maxEntries: number,
): Effect.Effect<ReadonlyArray<FileListEntry>, SkillsError> =>
  Effect.gen(function* () {
    if (env.listFiles === undefined) return [];

    const listing = yield* attempt("Cannot list skills", () =>
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
          message: `Cannot list skills in ${directory}: ${listing.error.message}`,
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
 * wins, as pi keeps the first it finds.
 */
export const discoverSkills = (env: SkillsEnv): Effect.Effect<ReadonlyArray<Skill>, SkillsError> =>
  Effect.forEach(
    skillDirectories(env.cwd),
    (directory) => skillsIn(env, join(directory, SKILLS_DIRECTORY)),
    {
      concurrency: 4,
    },
  ).pipe(
    Effect.map((found) =>
      Arr.take(
        Arr.dedupeWith(Arr.flatten(found), (a, b) => a.name === b.name),
        MAX_SKILLS,
      ),
    ),
  );

/** How the agent loads a skill's file: with `read` if it has it, else `bash`, else however it can. */
const readToolOf = (input: PromptInput): FileReadTool => {
  const offered = (name: string) => Arr.some(input.agent.tools, (tool) => tool.name === name);

  return offered("read") ? "read" : offered("bash") ? "bash" : "indirect";
};

const Section = effectSection("skills", (input) =>
  input.env === undefined
    ? Effect.undefined
    : Effect.map(discoverSkills(input.env), (skills) => formatSkills(skills, readToolOf(input))),
);

/** The `skills` extension: the `skills` section, and no tools (the agent reads skills with its `read` tool). */
export const Skills: Effect.Effect<Extension> = Effect.map(Section, (section) =>
  defineExtension({ name: "skills", sections: [section] }),
);
