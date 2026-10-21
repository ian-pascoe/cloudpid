// Expanding the owner's message at submit (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md): a message
// that names a Skill (`/skill:name` at its start, `$name` anywhere outside code) or starts with a Prompt template's
// `/name` reaches the model as its expansion, the way local pi expands it (`_expandSkillCommand` and
// `expandPromptTemplate` of pi's coding agent), while the entry keeps what the owner typed.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- string functions over the typed text, and a Promise reader the host provides.
import {
  byteLength,
  MAX_EXPANDED_FILE_BYTES,
  type PromptTemplate,
  stripFrontmatter,
  substituteArgs,
  templateCall,
} from "@cloudpid/extensions/prompt-templates";
import { type ExpandedSkill, skillBlock, type UserEntryData } from "@cloudpid/protocol";

/**
 * The most an expanded message may hold, in UTF-8 bytes: the expansion and the typed text it keeps, both stored in its
 * entry, whose row SQLite holds to 2 MB.
 */
export const MAX_EXPANSION_BYTES = 1024 * 1024;

/** A Skill the message may name: its name and its `SKILL.md`. */
export type NamedSkill = { readonly name: string; readonly filePath: string };

/** The message the model gets, and the data its entry keeps. */
export type Expansion = { readonly content: string; readonly data: UserEntryData };

/** What expanding a message came to: its expansion, if any, and why a Skill or template it names was left as typed. */
export type ExpandResult = {
  readonly expansion: Expansion | undefined;
  readonly unexpanded: ReadonlyArray<string>;
};

export type ExpandOptions = {
  readonly skills: ReadonlyArray<NamedSkill>;
  readonly templates: ReadonlyArray<Pick<PromptTemplate, "name" | "filePath">>;
  /** The text of the file at `path` (a `SKILL.md`, a template); undefined when it cannot be read. */
  readonly read: (path: string) => Promise<string | undefined>;
};

/** Whether `text` may name a Skill or a template at all, so a plain message costs no lookup. */
export const mayExpand = (text: string): boolean =>
  text.startsWith("/") || /(?:^|\s)\$[\w-]/.test(text);

/** A fenced block's opening line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** An indented code block's line: four spaces or a tab, then something. */
const INDENTED = /^(?: {4}|\t)\S*/;

/**
 * An inline code span: a backtick run that is not part of a longer one, its content, and a run of the same length that
 * is not part of a longer one either.
 */
const SPAN = /(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;

/**
 * `text` without its code, so a `$name` written as code is not a Skill: fenced blocks (to their closing fence, or the
 * end), indented code blocks (a line indented by four spaces or a tab after a blank line or another such line: one
 * after a paragraph's line continues the paragraph) and inline code spans. An unclosed backtick opens no span, as in
 * Markdown. It does not parse Markdown: an indented line inside a list item counts as code, as do lines indented in a
 * block quote's continuation, which leaves a `$name` there unexpanded.
 */
export const withoutCode = (text: string): string => {
  const kept: string[] = [];
  let fence: string | undefined;
  // Whether the line before was blank, the start of the text, or itself indented code.
  let mayIndent = true;

  for (const line of text.split("\n")) {
    if (fence !== undefined) {
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) {
        fence = undefined;
      }

      mayIndent = true;
      continue;
    }

    const opening = FENCE.exec(line)?.[1];

    if (opening !== undefined) {
      fence = opening;
    } else if (mayIndent && line.trim() !== "" && INDENTED.test(line)) {
      // Indented code: dropped, and the next indented line is code too.
      continue;
    } else {
      kept.push(line);
    }

    mayIndent = line.trim() === "";
  }

  return kept.join("\n").replace(SPAN, " ");
};

/** The names after `$` at the start of a word outside code, in order, each once. */
export const mentionedNames = (text: string): string[] => [
  ...new Set(Array.from(withoutCode(text).matchAll(/(?:^|\s)\$([\w-]+)/g), (match) => match[1]!)),
];

/** The text of `path`, if it can be read and is small enough to expand; else why not, for the log. */
const readExpandable = async (
  options: ExpandOptions,
  path: string,
  what: string,
): Promise<{ readonly text: string } | { readonly unexpanded: string }> => {
  const text = await options.read(path);

  if (text === undefined) return { unexpanded: `${what}: ${path} cannot be read` };

  return byteLength(text) > MAX_EXPANDED_FILE_BYTES
    ? { unexpanded: `${what}: ${path} is over ${MAX_EXPANDED_FILE_BYTES / 1024} KiB` }
    : { text };
};

/** `expansion`, unless it is too large to store: then nothing, and why. */
const withinLimit = (expansion: Expansion, unexpanded: ReadonlyArray<string>): ExpandResult =>
  byteLength(expansion.content) + byteLength(expansion.data.display) > MAX_EXPANSION_BYTES
    ? {
        expansion: undefined,
        unexpanded: [
          ...unexpanded,
          `the expanded message is over ${MAX_EXPANSION_BYTES / 1024 / 1024} MiB`,
        ],
      }
    : { expansion, unexpanded };

/**
 * The expansion of the owner's `text`, or none when it names no Skill or template the conversation has:
 *
 * - `/skill:name args` at the start: the Skill's block, then the arguments, as local pi's `/skill:` does.
 * - `$name` at the start of a word outside code, for each known Skill once: its block, before the typed text, which is
 *   kept as it is. A `$` that names no Skill (`$HOME`) is left alone.
 * - `/name args` naming a Prompt template: the template, its arguments substituted.
 *
 * A name nothing knows is left as typed. So is a Skill or template whose file cannot be read or is over
 * `MAX_EXPANDED_FILE_BYTES`, and the whole message when its expansion would be over `MAX_EXPANSION_BYTES`: those say why
 * in `unexpanded`.
 */
export const expandMessage = async (
  text: string,
  options: ExpandOptions,
): Promise<ExpandResult> => {
  const byName = new Map(options.skills.map((skill) => [skill.name, skill]));
  const lead = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const leading = lead === null ? undefined : byName.get(lead[1]!);

  if (lead === null) {
    const call = templateCall(text, options.templates);

    if (call !== undefined) {
      const read = await readExpandable(
        options,
        call.template.filePath,
        `Template /${call.template.name}`,
      );

      return "unexpanded" in read
        ? { expansion: undefined, unexpanded: [read.unexpanded] }
        : withinLimit(
            {
              content: substituteArgs(stripFrontmatter(read.text), call.args),
              data: { display: text, skills: [] },
            },
            [],
          );
    }
  }

  const rest = leading === undefined ? text : (lead?.[2] ?? "").trim();

  const named = [
    ...(leading === undefined ? [] : [leading]),
    ...mentionedNames(rest).flatMap((name) => {
      const skill = byName.get(name);

      return skill === undefined || skill === leading ? [] : [skill];
    }),
  ];

  const blocks: string[] = [];
  const skills: ExpandedSkill[] = [];
  const unexpanded: string[] = [];

  for (const skill of named) {
    const read = await readExpandable(options, skill.filePath, `Skill ${skill.name}`);

    if ("unexpanded" in read) {
      unexpanded.push(read.unexpanded);
      continue;
    }

    blocks.push(
      skillBlock({
        name: skill.name,
        location: skill.filePath,
        body: stripFrontmatter(read.text).trim(),
      }),
    );
    skills.push({ name: skill.name, location: skill.filePath });
  }

  if (skills.length === 0) return { expansion: undefined, unexpanded };

  // A `/skill:` that could not be read is left as typed, with the Skills its arguments name before it.
  const typed = leading !== undefined && skills[0]?.name !== leading.name ? text : rest;

  return withinLimit(
    {
      content: [...blocks, typed].filter((part) => part !== "").join("\n\n"),
      data: { display: text, skills },
    },
    unexpanded,
  );
};
