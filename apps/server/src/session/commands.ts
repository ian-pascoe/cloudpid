// The Session's Slash commands (docs/architecture/client-and-protocol.md → Slash commands): what the composer's menu offers
// (`catalog`), and `/export`'s Markdown. The commands themselves run in the host (`host.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over the catalog and pi's entries.
import { byteLength, type PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import type { Skill } from "@cloudpid/extensions/skills-discovery";
import {
  type Catalog,
  type CatalogEntry,
  flatCut,
  fromApp,
  MCP_PROMPT_COMMAND_PREFIX,
  type McpAppContext,
  projectEntry,
  sessionCommandsFor,
  type TranscriptMessage,
  type TranscriptPart,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { EntryRecord } from "@earendil-works/pi-durable";

const entryOf = (entry: { readonly name: string; readonly description: string }) => ({
  name: entry.name,
  description: entry.description,
});

/**
 * What a catalog offers from a directory that has `skills` and `templates`, nearest first. A template named `mcp__…` is
 * left out: that prefix is reserved for MCP prompts (`docs/architecture/mcp-in-a-session.md` → The `/` menu and the
 * catalog).
 */
export const catalogEntries = (
  skills: ReadonlyArray<Pick<Skill, "name" | "description">>,
  templates: ReadonlyArray<Pick<PromptTemplate, "name" | "description" | "argumentHint">>,
): Pick<Catalog, "templates" | "skills"> => ({
  templates: Arr.flatMap(templates, (template): ReadonlyArray<CatalogEntry> => {
    if (`/${template.name}`.startsWith(MCP_PROMPT_COMMAND_PREFIX)) return [];

    return [
      template.argumentHint === undefined
        ? entryOf(template)
        : { ...entryOf(template), argumentHint: template.argumentHint },
    ];
  }),
  // Every Skill, those the model is not offered too: they exist for the owner to name.
  skills: skills.map(entryOf),
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
  ...catalogEntries(skills, templates),
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

/** `text` as a blockquote: every line, empty ones too, after `> `. */
const quoted = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** The longest an argument's value is shown in an export, in characters. */
const EXPORT_ARGUMENT_CHARACTERS = 200;

/**
 * What an export says of an MCP prompt the owner sent (`TranscriptMessage.mcpPrompt`): which prompt with its arguments
 * (redacted as kept), the block the model got as a blockquote, and the resources it linked or embedded, by URI.
 */
const promptMarkdown = (prompt: NonNullable<TranscriptMessage["mcpPrompt"]>): string[] => {
  const args = Record.toEntries(prompt.arguments)
    .map(([name, value]) => `${name}=${flatCut(value, EXPORT_ARGUMENT_CHARACTERS)}`)
    .join(", ");

  const resources = prompt.resources.map((resource) => `- ${resource.uri}`);

  return [
    `MCP prompt: ${prompt.server}/${prompt.name}${args === "" ? "" : ` (${args})`}`,
    quoted(prompt.text),
    ...(resources.length === 0 ? [] : [["Resources:", ...resources].join("\n")]),
  ];
};

/** What an export says of the App messages an owner's message sent: each text as a blockquote, from the App it came from. */
const appMarkdown = (app: NonNullable<TranscriptMessage["app"]>): string[] =>
  app.map(({ server, text }) => `Sent from ${fromApp(server)}:\n\n${quoted(text)}`);

/** `server/tool` of an MCP tool's model-facing name (`mcp__<server>__<tool>`), or the name as it is. */
const appToolOf = (name: string): string => {
  const [prefix, server, ...tool] = name.split("__");

  return prefix === "mcp" && server !== undefined && tool.length > 0
    ? `${server}/${tool.join("__")}`
    : name;
};

const AppDetails = Schema.Struct({
  meta: Schema.Struct({ ui: Schema.Struct({ resourceUri: Schema.String }) }),
});

const isAppDetails = Schema.is(AppDetails);

/** Whether a tool result's `details.meta.ui.resourceUri` names a `ui://` resource: the call mounted an App an export cannot show. */
const isAppResult = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): boolean => isAppDetails(details) && details.meta.ui.resourceUri.startsWith("ui://");

/** What an export says of an App call: it mounted an App it cannot show, and the last context the App gave the model. */
const appCallMarkdown = (
  part: Extract<TranscriptPart, { type: "tool-result" }>,
  held: ExportedAppContext | undefined,
): string[] => [
  `_App: ${appToolOf(part.name)} (not rendered)_`,
  ...(held === undefined
    ? []
    : [`Last App context (${contextStanding(held)}):\n\n${quoted(held.context.text)}`]),
];

/** A call's last context as seen from the conversation exported: `here` when it was held for that conversation. */
export type ExportedAppContext = {
  readonly context: McpAppContext;
  readonly here: boolean;
};

/**
 * What an export says of where a context stands: what the exported conversation's model has read, or that it was held for
 * another Session branch, whose model's reading says nothing of this one's.
 */
const contextStanding = ({ context, here }: ExportedAppContext): string => {
  if (!here) return "held for another Session branch, not given to this one";

  return context.delivered === true ? "sent to the model" : "pending, not yet sent";
};

/** What an export reads beside the entries: the App contexts the Session holds, by call. */
export type ExportOptions = {
  readonly appContext?: ((callId: string) => ExportedAppContext | undefined) | undefined;
};

/** One message of the History as Markdown. */
const messageMarkdown = (
  message: TranscriptMessage,
  options: ExportOptions,
): string | undefined => {
  switch (message.role) {
    case "user": {
      const skills = (message.skills ?? []).map(({ name }) => `\`${name}\``).join(", ");

      return [
        "## Owner",
        textOf(message.parts),
        ...(message.app === undefined ? [] : appMarkdown(message.app)),
        ...(message.mcpPrompt === undefined ? [] : promptMarkdown(message.mcpPrompt)),
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
                ...(isAppResult(part.details)
                  ? appCallMarkdown(part, options.appContext?.(part.id))
                  : []),
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
  options: ExportOptions = {},
): MarkdownExport => {
  const parts = [`# Conversation ${conversationId}`, `_Exported ${exportedAt}_`];
  // The parts, the blank lines between them, and the final newline.
  let bytes = jsonBytes(parts[0]!) + SEPARATOR_BYTES + jsonBytes(parts[1]!) + jsonBytes("\n");

  return {
    add: (entries) => {
      for (const entry of entries) {
        const message = projectEntry(entry);
        const markdown = message === undefined ? undefined : messageMarkdown(message, options);

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
  options: ExportOptions = {},
): string => {
  const built = markdownExport(conversationId, exportedAt, Number.POSITIVE_INFINITY, options);

  built.add(entries);

  return built.markdown();
};
