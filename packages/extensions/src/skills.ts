// @effect-diagnostics missingPipeableSignature:off
// The `skills` extension (docs/spec.md → Filesystem and tools): a `skills` system prompt section that lists the skills
// the agent can read, the way local pi does (`formatSkillsForPrompt` in pi's coding agent): each skill's name,
// description and the path of its `SKILL.md`, which the agent loads with `read` when a task matches. Skills are found
// in the `.agents/skills` directory of the conversation's `cwd` and of each directory above it up to the Workspace root,
// nearest first, so a repo's own skills come before the Workspace's, whose `.agents/skills` holds the bundled skills
// (`skills/`, mounted read-only). Discovery (`skills-discovery.ts`) reads only files, so it never starts the Container:
// an environment that discovers skills itself (`SkillSource`: the Workspace's, which does it next to the files) is asked
// once, and any other is walked through its file operations. The section is read once per Context Window and then
// shown as it was, as `project_context` is (`frozenSection`): a Skill can change during a Session, and a changed
// section would rewrite the system prompt, the head of the provider's cache prefix.
import { frozenSection } from "@cloudpid/effect-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, type Extension, type PromptInput } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import {
  attempt,
  BUNDLED_SKILLS_DIRECTORY,
  discoverSkills,
  isSkillSource,
  type Skill,
  type SkillsError,
} from "./skills-discovery.ts";

export * from "./skills-discovery.ts";

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

/** How the agent loads a skill's file: with `read` if it has it, else `bash`, else however it can. */
const readToolOf = (input: PromptInput): FileReadTool => {
  const offered = (name: string) => Arr.some(input.agent.tools, (tool) => tool.name === name);

  return offered("read") ? "read" : offered("bash") ? "bash" : "indirect";
};

/** The skills of `env`: its own discovery if it has one (one call), else a walk of its files. */
const skillsOf = (
  env: NonNullable<PromptInput["env"]>,
): Effect.Effect<ReadonlyArray<Skill>, SkillsError> =>
  isSkillSource(env)
    ? attempt("Cannot discover skills", () => env.discoverSkills(BACKGROUND_CONTEXT))
    : discoverSkills(env);

const SECTION_KEY = "skills";

/**
 * The section: the Skills found when the context first shows it, then shown as they were (`frozenSection`, as the
 * `project_context` section is). A Skill can change during a Session (a Skill saved or installed), and pi-durable sends
 * a changed section as a patch, which a provider without mid-conversation system messages folds into the system prompt,
 * the head of the cache prefix. A Handoff starts a context without it, so the next request lists the Skills again.
 * A first read that finds none is kept as an empty section, not an absent one (absent cannot be told from never read,
 * so a Skill saved later would be added as a patch); it adds nothing to the prompt's text, as pi-ai leaves empty parts
 * out. A read that fails, or a request without an environment, keeps nothing: the next request tries again.
 * Skill expansion at submit does not read this list: it asks the Workspace for its Skills when a message is admitted.
 */
const Section = frozenSection(SECTION_KEY, (input) =>
  input.env === undefined
    ? Effect.undefined
    : Effect.map(skillsOf(input.env), (skills) => {
        const text = formatSkills(skills, readToolOf(input));

        return text === undefined ? "" : `<${SECTION_KEY}>\n${text}\n</${SECTION_KEY}>`;
      }),
);

/** The `skills` extension: the `skills` section, and no tools (the agent reads skills with its `read` tool). */
export const Skills: Effect.Effect<Extension> = Effect.map(Section, (section) =>
  defineExtension({ name: "skills", sections: [section] }),
);
