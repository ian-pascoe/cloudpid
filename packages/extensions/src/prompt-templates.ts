// Prompt templates (docs/spec.md → Client and protocol → Slash commands): Markdown files in a repo's `.agents/prompts`
// whose Slash command expands into a message, with the command's arguments filled in. Parsing and argument substitution
// follow local pi (`core/prompt-templates.ts` and `utils/frontmatter.ts` of pi's coding agent, MIT, © 2025 Mario
// Zechner), without its file system: the walk goes through the small part of an `ExecutionEnv` that skills discovery
// uses, so the Workspace DO runs it next to its files, as it does for skills. Like `skills-discovery.ts`, a module of its
// own the Workspaces Worker loads without the harness.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain string functions, ported as pi wrote them.
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
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

/**
 * A Prompt template as discovery lists it: `/name` expands into its file's body, its arguments substituted. The body is
 * read when a message uses the template, so a listing stays small whatever the templates hold.
 */
export type PromptTemplate = {
  /** The file's name without `.md`. */
  readonly name: string;
  /** The `description` frontmatter, or the body's first line cut to 60 characters. */
  readonly description: string;
  /** The `argument-hint` frontmatter, shown after the name: `<file> [focus]`. */
  readonly argumentHint?: string;
  /** The absolute path of its file. */
  readonly filePath: string;
};

/** A template with its body, without the frontmatter, as a file is parsed. */
export type ParsedTemplate = PromptTemplate & { readonly content: string };

/**
 * The largest template or Skill file a message is expanded with, in bytes: an expansion is stored in one entry, whose
 * row SQLite holds to 2 MB. A bigger template is not listed; a bigger Skill is left unexpanded.
 */
export const MAX_EXPANDED_FILE_BYTES = 256 * 1024;

/** Where the Prompt templates of a directory are, below it. */
const PROMPTS_DIRECTORY = ".agents/prompts";

/** The most templates found, nearest first. */
const MAX_TEMPLATES = 100;

/** The most entries listed in a `.agents/prompts` directory. */
const MAX_ENTRIES = 1000;

/** How much of a body's first line describes a template that has no `description`. */
const DESCRIPTION_LINE = 60;

/** A Markdown file split as pi's `parseFrontmatter` splits it: its frontmatter's YAML, if any, and its body. */
type Frontmatter = { readonly yaml: string | undefined; readonly body: string };

/** `content` split into its frontmatter's YAML and its body, trimmed when there is a frontmatter, as pi splits it. */
const splitFrontmatter = (content: string): Frontmatter => {
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
export const parseTemplate = (filePath: string, text: string): ParsedTemplate | undefined => {
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

  const template: Types.Mutable<ParsedTemplate> = {
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
 * The template of `templates` whose Slash command `text` starts with, and the arguments after its name. Undefined for
 * any other text.
 */
export const templateCall = <T extends { readonly name: string }>(
  text: string,
  templates: ReadonlyArray<T>,
): { readonly template: T; readonly args: readonly string[] } | undefined => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const template = match === null ? undefined : templates.find(({ name }) => name === match[1]);

  return template === undefined
    ? undefined
    : { template, args: parseCommandArgs(match?.[2] ?? "") };
};

/**
 * The expansion of `text` when it starts with the Slash command of one of `templates`: the template, with the arguments
 * after its name substituted. Undefined for any other text.
 */
export const expandTemplate = (
  text: string,
  templates: ReadonlyArray<Pick<ParsedTemplate, "name" | "content">>,
): string | undefined => {
  const call = templateCall(text, templates);

  return call === undefined ? undefined : substituteArgs(call.template.content, call.args);
};

/** What discovering templates uses of an environment: what skills discovery does, and a file's size where it can. */
export type PromptsEnv = SkillsEnv & Partial<Pick<ExecutionEnv, "fileInfo">>;

/** Whether the file at `path` is small enough to be a template; one whose size cannot be had is read and checked after. */
const smallEnough = (env: PromptsEnv, path: string): Effect.Effect<boolean, SkillsError> =>
  env.fileInfo === undefined
    ? Effect.succeed(true)
    : attempt(`Cannot read ${path}`, () => env.fileInfo!(path, BACKGROUND_CONTEXT)).pipe(
        Effect.map((info) => !info.ok || info.value.size <= MAX_EXPANDED_FILE_BYTES),
      );

/** The UTF-8 length of `text`, in bytes. */
export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The template in the file at `path`, if it is one: a `.md` file small enough to expand, whose frontmatter is YAML. */
const templateAt = (
  env: PromptsEnv,
  path: string,
): Effect.Effect<Option.Option<PromptTemplate>, SkillsError> =>
  Effect.gen(function* () {
    if (!(yield* smallEnough(env, path))) return Option.none();

    const read = yield* attempt(`Cannot read ${path}`, () =>
      env.readTextFile(path, BACKGROUND_CONTEXT),
    );

    // A link to nothing, or to a directory, is not a template.
    if (!read.ok || byteLength(read.value) > MAX_EXPANDED_FILE_BYTES) return Option.none();

    const parsed = parseTemplate(path, read.value);

    if (parsed === undefined) return Option.none();

    const { content: _content, ...template } = parsed;

    return Option.some(template);
  });

/**
 * The templates in one `.agents/prompts` directory, in name order: its `.md` files, not those of directories below it.
 * A file whose name holds whitespace is not one: its Slash command would end at the space.
 */
const templatesIn = (
  env: PromptsEnv,
  root: string,
): Effect.Effect<ReadonlyArray<PromptTemplate>, SkillsError> =>
  Effect.gen(function* () {
    const entries = yield* entriesBelow(env, root, MAX_ENTRIES, "prompt templates");

    const files = Arr.take(
      Arr.filter(
        entries,
        (entry) =>
          entry.kind !== "directory" &&
          !entry.path.includes("/") &&
          !/\s/.test(entry.path) &&
          entry.path.endsWith(".md"),
      ),
      MAX_TEMPLATES,
    );

    const templates = yield* Effect.forEach(
      files,
      ({ path }) => templateAt(env, join(root, path)),
      {
        concurrency: 8,
      },
    );

    return Arr.getSomes(templates);
  });

/**
 * The Prompt templates a conversation in `env`'s `cwd` can use: those in the `.agents/prompts` of its `cwd` and of each
 * directory above it up to the Workspace root, nearest first, and where two have one name the nearest wins, as skills.
 */
export const discoverPrompts = (
  env: PromptsEnv,
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
