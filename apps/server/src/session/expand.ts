// Expanding the owner's message at submit (docs/adr/0001-expand-skills-and-prompt-templates-at-submit.md): a message
// that starts with `/skill:name` or a Prompt template's `/name` reaches the model as its expansion, the way local pi
// expands it (`_expandSkillCommand` and `expandPromptTemplate` of pi's coding agent), and a `$name` naming a Skill
// becomes a link to it, as the owner's pi-skills-selector makes it; the entry keeps what the owner typed.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- string functions over the typed text, and a Promise reader the host provides.
import {
  byteLength,
  MAX_EXPANDED_FILE_BYTES,
  type PromptTemplate,
  stripFrontmatter,
  substituteArgs,
  templateCall,
} from "@cloudpid/extensions/prompt-templates";
import { skillBlock, type UserEntryData } from "@cloudpid/protocol";
import { linkSkillReferences } from "./skill-references.ts";

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
  text.startsWith("/") || /(?<![\p{L}\p{M}\p{N}$/+-])\$[^\s$]/u.test(text);

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
 * - `/name args` naming a Prompt template: the template, its arguments substituted.
 * - `$name` naming a known Skill, in the prose of the message or of a `/skill:`'s arguments: a link to the Skill's
 *   `SKILL.md`, in place (`linkSkillReferences`), which the model reads when it needs it. No file is read for it.
 *
 * A name nothing knows is left as typed. So is a Skill or template whose file cannot be read or is over
 * `MAX_EXPANDED_FILE_BYTES` (a `/skill:` so left keeps its references linked), and the whole message when its expansion
 * would be over `MAX_EXPANSION_BYTES`: those say why in `unexpanded`. Only an embedded Skill is in the data's `skills`.
 */
export const expandMessage = async (
  text: string,
  options: ExpandOptions,
): Promise<ExpandResult> => {
  const lead = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const leading = lead === null ? undefined : options.skills.find(({ name }) => name === lead[1]);
  const linked = (part: string) => linkSkillReferences(part, options.skills);
  const unexpanded: string[] = [];

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

  if (leading !== undefined) {
    const read = await readExpandable(options, leading.filePath, `Skill ${leading.name}`);

    if (!("unexpanded" in read)) {
      const block = skillBlock({
        name: leading.name,
        location: leading.filePath,
        body: stripFrontmatter(read.text).trim(),
      });

      const args = linked((lead?.[2] ?? "").trim());

      return withinLimit(
        {
          content: args === "" ? block : `${block}\n\n${args}`,
          data: { display: text, skills: [{ name: leading.name, location: leading.filePath }] },
        },
        [],
      );
    }

    unexpanded.push(read.unexpanded);
  }

  const content = linked(text);

  return content === text
    ? { expansion: undefined, unexpanded }
    : withinLimit({ content, data: { display: text, skills: [] } }, unexpanded);
};
