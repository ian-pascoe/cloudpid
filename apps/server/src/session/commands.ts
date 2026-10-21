// The Session's Slash commands (docs/spec.md → Client and protocol → Slash commands): what the composer's menu offers
// (`catalog`), and `/export`'s Markdown. The commands themselves run in the host (`host.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over the catalog and pi's entries.
import type { PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import type { Skill } from "@cloudpid/extensions/skills-discovery";
import {
  type Catalog,
  type CatalogCommand,
  type CatalogEntry,
  projectEntry,
  type TranscriptMessage,
  type TranscriptPart,
} from "@cloudpid/protocol";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** The Slash commands the Session runs, on the conversation they are typed in. */
export const SERVER_COMMANDS: ReadonlyArray<CatalogCommand> = [
  {
    name: "compact",
    description: "Summarize the context to free room; after the run, if one is in progress",
    argumentHint: "[focus]",
    argument: "optional",
  },
  {
    name: "rollover",
    description: "Ask the agent to write its Handoff and start a fresh context",
    argumentHint: "[focus]",
    argument: "optional",
  },
  {
    name: "todo",
    description: "Clear the Todo List",
    argumentHint: "clear",
    argument: "required",
    choices: [{ value: "clear", description: "Remove every Task" }],
  },
  {
    name: "export",
    description: "Download the whole History as Markdown",
    argument: "none",
  },
];

const entryOf = (entry: { readonly name: string; readonly description: string }) => ({
  name: entry.name,
  description: entry.description,
});

/** The catalog of a conversation whose directory has `skills` and `templates`, nearest first. */
export const catalogOf = (
  skills: ReadonlyArray<Skill>,
  templates: ReadonlyArray<PromptTemplate>,
): Catalog => ({
  commands: SERVER_COMMANDS,
  templates: templates.map((template): CatalogEntry =>
    template.argumentHint === undefined
      ? entryOf(template)
      : { ...entryOf(template), argumentHint: template.argumentHint },
  ),
  // Every Skill, those the model is not offered too: they exist for the owner to name.
  skills: skills.map(entryOf),
});

/** The most characters an export may have: it travels as one socket message. */
export const MAX_EXPORT_CHARACTERS = 8 * 1024 * 1024;

/** `text` in a fenced block that no backtick run inside it closes. */
const fenced = (text: string, language = ""): string => {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = "`".repeat(longest + 1);

  return `${fence}${language}\n${text}\n${fence}`;
};

const textOf = (parts: ReadonlyArray<TranscriptPart>): string =>
  parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];

      return part.type === "image" ? ["_[image]_"] : [];
    })
    .join("\n\n");

const resultText = (content: ReadonlyArray<TranscriptPart>): string =>
  content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");

/** One message of the History as Markdown. */
const messageMarkdown = (message: TranscriptMessage): string | undefined => {
  switch (message.role) {
    case "user": {
      const skills = (message.skills ?? []).map(({ name }) => `\`${name}\``).join(", ");

      return [
        "## Owner",
        textOf(message.parts),
        ...(skills === "" ? [] : [`_Skills: ${skills}_`]),
      ].join("\n\n");
    }

    case "assistant": {
      const body = message.parts.flatMap((part) => {
        switch (part.type) {
          case "text":
            return [part.text];
          case "thinking":
            return part.text.trim() === ""
              ? []
              : [`<details><summary>Thinking</summary>\n\n${part.text}\n\n</details>`];
          case "tool-call":
            return [
              `**Tool call** \`${part.name}\`\n\n${fenced(JSON.stringify(part.arguments, null, 2), "json")}`,
            ];
          default:
            return [];
        }
      });

      return [
        "## Agent",
        ...body,
        ...(message.error === undefined ? [] : [`_Failed: ${message.error}_`]),
      ].join("\n\n");
    }

    case "tool":
      return message.parts
        .flatMap((part) =>
          part.type === "tool-result"
            ? [
                `**Tool result** \`${part.name}\`${part.error ? " (error)" : ""}\n\n${fenced(resultText(part.content))}`,
              ]
            : [],
        )
        .join("\n\n");
    case "notice": {
      const text = textOf(message.parts);

      return [`### ${message.title ?? "Notice"}`, ...(text === "" ? [] : [text])].join("\n\n");
    }
  }
};

/**
 * Conversation `conversationId`'s whole History as Markdown, oldest first, across every Context Window: the owner's
 * messages as typed (with the Skills expanded into them named), the agent's answers, thinking, tool calls and results,
 * and the Handoffs and compactions between windows.
 */
export const exportMarkdown = (
  conversationId: number,
  entries: ReadonlyArray<EntryRecord>,
  exportedAt: string,
): string =>
  [
    `# Conversation ${conversationId}`,
    `_Exported ${exportedAt}_`,
    ...entries.flatMap((entry) => {
      const message = projectEntry(entry);
      const markdown = message === undefined ? undefined : messageMarkdown(message);

      return markdown === undefined || markdown === "" ? [] : [markdown];
    }),
  ].join("\n\n") + "\n";
