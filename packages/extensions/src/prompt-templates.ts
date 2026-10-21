// Prompt templates (docs/spec.md → Client and protocol → Slash commands): Markdown files in a repo's `.agents/prompts`
// whose Slash command expands into a message, with the command's arguments filled in. Parsing and argument substitution
// follow local pi (`core/prompt-templates.ts` and `utils/frontmatter.ts` of pi's coding agent, MIT, © 2025 Mario
// Zechner), without its file system: the walk goes through the small part of an `ExecutionEnv` that skills discovery
// uses, so the Workspace DO runs it next to its files, as it does for skills. Like `skills-discovery.ts`, a module of its
// own the Workspaces Worker loads without the harness.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain string functions, ported as pi wrote them.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { parse } from "yaml";
import {
  attempt,
  entriesBelow,
  join,
  skillDirectories,
  type SkillsEnv,
  type SkillsError,
} from "./skills-discovery.ts";

/** A Prompt template: `/name` expands into `content`, its arguments substituted. */
export type PromptTemplate = {
  /** The file's name without `.md`. */
  readonly name: string;
  /** The `description` frontmatter, or the body's first line cut to 60 characters. */
  readonly description: string;
  /** The `argument-hint` frontmatter, shown after the name: `<file> [focus]`. */
  readonly argumentHint?: string;
  /** The body, without the frontmatter. */
  readonly content: string;
  /** The absolute path of its file. */
  readonly filePath: string;
};

/** Where the Prompt templates of a directory are, below it. */
export const PROMPTS_DIRECTORY = ".agents/prompts";

/** The most templates found, nearest first. */
export const MAX_TEMPLATES = 100;

/** The most entries listed in a `.agents/prompts` directory. */
const MAX_ENTRIES = 1000;

/** How much of a body's first line describes a template that has no `description`. */
const DESCRIPTION_LINE = 60;

/** A Markdown file split as pi's `parseFrontmatter` splits it: its frontmatter's YAML, if any, and its body. */
export type Frontmatter = { readonly yaml: string | undefined; readonly body: string };

/** `content` split into its frontmatter's YAML and its body, trimmed when there is a frontmatter, as pi splits it. */
export const splitFrontmatter = (content: string): Frontmatter => {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = normalized.startsWith("---") ? normalized.indexOf("\n---", 3) : -1;

  return end === -1
    ? { yaml: undefined, body: normalized }
    : { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
};

/** A Markdown file's body without its frontmatter, as a Skill's body is read. */
export const stripFrontmatter = (content: string): string => splitFrontmatter(content).body;

/** The frontmatter fields a template is read from; the others are not used. */
const TemplateFields = Schema.Struct({
  description: Schema.optionalKey(Schema.Unknown),
  "argument-hint": Schema.optionalKey(Schema.Unknown),
});

const decodeFields = Schema.decodeUnknownOption(TemplateFields);

/** The template fields of a frontmatter's YAML: none without one, undefined when it is not YAML. */
const fieldsOf = (yaml: string | undefined): typeof TemplateFields.Type | undefined => {
  if (yaml === undefined) return {};

  try {
    return Option.getOrElse(decodeFields(parse(yaml) ?? {}), () => ({}));
  } catch {
    return undefined;
  }
};

/** The template a file at `filePath` holds, or undefined when its frontmatter is not YAML (pi skips such a file). */
export const parseTemplate = (filePath: string, text: string): PromptTemplate | undefined => {
  const { yaml, body } = splitFrontmatter(text);
  const fields = fieldsOf(yaml);

  if (fields === undefined) return undefined;

  const declared = fields.description;
  let description = Predicate.isString(declared) ? declared : "";

  if (description === "") {
    const first = body.split("\n").find((line) => line.trim() !== "");

    if (first !== undefined) {
      description =
        first.length > DESCRIPTION_LINE ? `${first.slice(0, DESCRIPTION_LINE)}...` : first;
    }
  }

  const template: Types.Mutable<PromptTemplate> = {
    name: (filePath.split("/").at(-1) ?? "").replace(/\.md$/, ""),
    description,
    content: body,
    filePath,
  };

  const hint = fields["argument-hint"];

  if (Predicate.isString(hint) && hint !== "") template.argumentHint = hint;

  return template;
};

/** A command's arguments, split as bash splits words: quotes group, and a quoted empty string is an argument. */
export const parseCommandArgs = (args: string): string[] => {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;

  for (const char of args) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (started) words.push(current);

  return words;
};

/**
 * `content` with its placeholders filled from `args`: `$1`, `$2`… for one argument, `$@` and `$ARGUMENTS` for all,
 * `${N:-default}` (and `${@:-default}`, `${ARGUMENTS:-default}`) with a default for a missing or empty one, `${@:N}` for
 * those from the Nth on and `${@:N:L}` for L of them. Only the template is substituted: an argument that holds `$1` is
 * left as it is.
 */
export const substituteArgs = (content: string, args: readonly string[]): string => {
  const all = args.join(" ");

  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      defaultTarget: string | undefined,
      defaultValue: string | undefined,
      sliceStart: string | undefined,
      sliceLength: string | undefined,
      simple: string | undefined,
    ) => {
      if (defaultTarget !== undefined) {
        const value =
          defaultTarget === "@" || defaultTarget === "ARGUMENTS"
            ? all
            : args[Number.parseInt(defaultTarget, 10) - 1];

        return value === undefined || value === "" ? (defaultValue ?? "") : value;
      }

      if (sliceStart !== undefined) {
        // `${@:0}` is `${@:1}`, as in bash, where the arguments start at 1.
        const start = Math.max(Number.parseInt(sliceStart, 10) - 1, 0);

        return (
          sliceLength === undefined
            ? args.slice(start)
            : args.slice(start, start + Number.parseInt(sliceLength, 10))
        ).join(" ");
      }

      if (simple === "ARGUMENTS" || simple === "@") return all;

      return args[Number.parseInt(simple ?? "0", 10) - 1] ?? "";
    },
  );
};

/**
 * The expansion of `text` when it starts with the Slash command of one of `templates`: the template, with the arguments
 * after its name substituted. Undefined for any other text.
 */
export const expandTemplate = (
  text: string,
  templates: ReadonlyArray<Pick<PromptTemplate, "name" | "content">>,
): string | undefined => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);

  if (match === null) return undefined;

  const template = templates.find(({ name }) => name === match[1]);

  return template === undefined
    ? undefined
    : substituteArgs(template.content, parseCommandArgs(match[2] ?? ""));
};

/** The templates in one `.agents/prompts` directory, in name order: its `.md` files, not those of directories below it. */
const templatesIn = (
  env: SkillsEnv,
  root: string,
): Effect.Effect<ReadonlyArray<PromptTemplate>, SkillsError> =>
  Effect.gen(function* () {
    const entries = yield* entriesBelow(env, root, MAX_ENTRIES, "prompt templates");

    const files = Arr.take(
      Arr.filter(
        entries,
        (entry) =>
          entry.kind !== "directory" && !entry.path.includes("/") && entry.path.endsWith(".md"),
      ),
      MAX_TEMPLATES,
    );

    const templates = yield* Effect.forEach(
      files,
      ({ path }) =>
        attempt(`Cannot read ${path}`, () =>
          env.readTextFile(join(root, path), BACKGROUND_CONTEXT),
        ).pipe(
          // A link to nothing, or to a directory, is not a template.
          Effect.map((read) =>
            read.ok
              ? Option.fromNullishOr(parseTemplate(join(root, path), read.value))
              : Option.none(),
          ),
        ),
      { concurrency: 8 },
    );

    return Arr.getSomes(templates);
  });

/**
 * The Prompt templates a conversation in `env`'s `cwd` can use: those in the `.agents/prompts` of its `cwd` and of each
 * directory above it up to the Workspace root, nearest first, and where two have one name the nearest wins, as skills.
 */
export const discoverPrompts = (
  env: SkillsEnv,
): Effect.Effect<ReadonlyArray<PromptTemplate>, SkillsError> =>
  Effect.forEach(
    skillDirectories(env.cwd),
    (directory) => templatesIn(env, join(directory, PROMPTS_DIRECTORY)),
    { concurrency: 4 },
  ).pipe(
    Effect.map((found) =>
      Arr.take(
        Arr.dedupeWith(Arr.flatten(found), (a, b) => a.name === b.name),
        MAX_TEMPLATES,
      ),
    ),
  );

/** An environment that finds the Prompt templates of its `cwd` itself, where its files are, as `SkillSource` does skills. */
export type PromptSource = {
  readonly discoverPrompts: (context: Context) => Promise<ReadonlyArray<PromptTemplate>>;
};

/** Whether `env` finds Prompt templates itself. */
export const isPromptSource = <Env extends object>(env: Env): env is Env & PromptSource =>
  Predicate.hasProperty(env, "discoverPrompts") && Predicate.isFunction(env.discoverPrompts);
