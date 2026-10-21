// The Session's Slash commands (docs/spec.md → Client and protocol → Slash commands): what the composer's menu offers
// (`catalog`), and `/export`'s Markdown. The commands themselves run in the host (`host.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over the catalog and pi's entries.
import { byteLength, type PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import type { Skill } from "@cloudpid/extensions/skills-discovery";
import {
  type Catalog,
  type CatalogEntry,
  projectEntry,
  sessionCommandsFor,
  type TranscriptMessage,
  type TranscriptPart,
} from "@cloudpid/protocol";
import type { EntryRecord } from "@earendil-works/pi-durable";

const entryOf = (entry: { readonly name: string; readonly description: string }) => ({
  name: entry.name,
  description: entry.description,
});

/**
 * The catalog of a conversation whose directory has `skills` and `templates`, nearest first, and whose agent can
 * (`rollover`) or cannot roll over: `/rollover` is offered only where it can.
 */
export const catalogOf = (
  skills: ReadonlyArray<Skill>,
  templates: ReadonlyArray<PromptTemplate>,
  rollover: boolean,
): Catalog => ({
  commands: sessionCommandsFor(rollover),
  templates: templates.map((template): CatalogEntry =>
    template.argumentHint === undefined
      ? entryOf(template)
      : { ...entryOf(template), argumentHint: template.argumentHint },
  ),
  // Every Skill, those the model is not offered too: they exist for the owner to name.
  skills: skills.map(entryOf),
});

/**
 * The most an export may hold, in UTF-8 bytes of the JSON string it travels as. The file goes to the client as one
 * `result` socket message, which workerd caps at 32 MiB; while it is built the Session holds the Markdown, the message's
 * JSON and the page of entries being read at once, in an isolate of 128 MB that runs the Session's work too, and the
 * browser makes a Blob of it. A quarter of the message limit leaves room for all of them.
 */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

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

/** What `text` adds to a JSON string, in UTF-8 bytes: its escapes count, a newline being two bytes there. */
const jsonBytes = (text: string): number => byteLength(JSON.stringify(text)) - 2;

/** The blank line between two parts of an export, as JSON escapes it. */
const SEPARATOR_BYTES = jsonBytes("\n\n");

/** `/export`'s Markdown as it is built a page of entries at a time, with what it would weigh as a socket message. */
export type MarkdownExport = {
  /** Add `entries`, oldest first: false once the export is over its limit, when it should be given up. */
  readonly add: (entries: ReadonlyArray<EntryRecord>) => boolean;
  /** The Markdown so far. */
  readonly markdown: () => string;
};

/**
 * Conversation `conversationId`'s History as Markdown, built from its entries oldest first, across every Context
 * Window: the owner's messages as typed (with the Skills expanded into them named), the agent's answers, thinking, tool
 * calls and results, and the Handoffs and compactions between windows. Each entry is rendered as it is added and its
 * size counted, so an export over `limit` bytes is known before the rest of the History is read.
 */
export const markdownExport = (
  conversationId: number,
  exportedAt: string,
  limit: number = MAX_EXPORT_BYTES,
): MarkdownExport => {
  const parts = [`# Conversation ${conversationId}`, `_Exported ${exportedAt}_`];
  // The parts, the blank lines between them, and the final newline.
  let bytes = jsonBytes(parts[0]!) + SEPARATOR_BYTES + jsonBytes(parts[1]!) + jsonBytes("\n");

  return {
    add: (entries) => {
      for (const entry of entries) {
        const message = projectEntry(entry);
        const markdown = message === undefined ? undefined : messageMarkdown(message);

        if (markdown === undefined || markdown === "") continue;

        bytes += SEPARATOR_BYTES + jsonBytes(markdown);

        if (bytes > limit) return false;

        parts.push(markdown);
      }

      return true;
    },
    markdown: () => parts.join("\n\n") + "\n",
  };
};

/** `markdownExport` of `entries` at once, whatever its size. */
export const exportMarkdown = (
  conversationId: number,
  entries: ReadonlyArray<EntryRecord>,
  exportedAt: string,
): string => {
  const built = markdownExport(conversationId, exportedAt, Number.POSITIVE_INFINITY);

  built.add(entries);

  return built.markdown();
};
