// Expanding the owner's message at submit (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md): a message
// that names a Skill (`/skill:name` at its start, `$name` anywhere outside code) or starts with a Prompt template's
// `/name` reaches the model as its expansion, the way local pi expands it (`_expandSkillCommand` and
// `expandPromptTemplate` of pi's coding agent), while the entry keeps what the owner typed.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- string functions over the typed text, and a Promise reader the host provides.
import { expandTemplate, type PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import { type ExpandedSkill, skillBlock, type UserEntryData } from "@cloudpid/protocol";

/** A Skill the message may name: its name and its `SKILL.md`. */
export type NamedSkill = { readonly name: string; readonly filePath: string };

/** The message the model gets, and the data its entry keeps. */
export type Expansion = { readonly content: string; readonly data: UserEntryData };

export type ExpandOptions = {
  readonly skills: ReadonlyArray<NamedSkill>;
  readonly templates: ReadonlyArray<Pick<PromptTemplate, "name" | "content">>;
  /** A Skill's `SKILL.md` without its frontmatter, trimmed; undefined when it cannot be read, which leaves it unexpanded. */
  readonly body: (skill: NamedSkill) => Promise<string | undefined>;
};

/** Whether `text` may name a Skill or a template at all, so a plain message costs no lookup. */
export const mayExpand = (text: string): boolean =>
  text.startsWith("/") || /(?:^|\s)\$[\w-]/.test(text);

/** A fenced block's opening line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * `text` without its code: fenced blocks (to their closing fence, or the end) and inline code spans, so a `$name`
 * written as code is not a Skill. An unclosed backtick opens no span, as in Markdown.
 */
export const withoutCode = (text: string): string => {
  const kept: string[] = [];
  let fence: string | undefined;

  for (const line of text.split("\n")) {
    if (fence === undefined) {
      const opening = FENCE.exec(line)?.[1];

      if (opening === undefined) kept.push(line);
      else fence = opening;
    } else if (
      new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)
    ) {
      fence = undefined;
    }
  }

  return kept.join("\n").replace(/(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g, " ");
};

/** The names after `$` at the start of a word outside code, in order, each once. */
export const mentionedNames = (text: string): string[] => [
  ...new Set(Array.from(withoutCode(text).matchAll(/(?:^|\s)\$([\w-]+)/g), (match) => match[1]!)),
];

/**
 * The expansion of the owner's `text`, or undefined when it names no Skill or template the conversation has:
 *
 * - `/skill:name args` at the start: the Skill's block, then the arguments, as local pi's `/skill:` does.
 * - `$name` at the start of a word outside code, for each known Skill once: its block, before the typed text, which is
 *   kept as it is. A `$` that names no Skill (`$HOME`) is left alone.
 * - `/name args` naming a Prompt template: the template, its arguments substituted.
 *
 * A name nothing knows, or a Skill whose file cannot be read, is left as typed.
 */
export const expandMessage = async (
  text: string,
  options: ExpandOptions,
): Promise<Expansion | undefined> => {
  const byName = new Map(options.skills.map((skill) => [skill.name, skill]));
  const lead = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const leading = lead === null ? undefined : byName.get(lead[1]!);

  if (leading === undefined && lead === null) {
    const template = expandTemplate(text, options.templates);

    if (template !== undefined) return { content: template, data: { display: text, skills: [] } };
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

  for (const skill of named) {
    const body = await options.body(skill);

    if (body === undefined) continue;

    blocks.push(skillBlock({ name: skill.name, location: skill.filePath, body }));
    skills.push({ name: skill.name, location: skill.filePath });
  }

  if (skills.length === 0) return undefined;

  // A `/skill:` that could not be read is left as typed, with the Skills its arguments name before it.
  const typed = leading !== undefined && skills[0]?.name !== leading.name ? text : rest;

  return {
    content: [...blocks, typed].filter((part) => part !== "").join("\n\n"),
    data: { display: text, skills },
  };
};
