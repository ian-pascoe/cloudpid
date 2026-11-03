// What an MCP prompt's message shows in the transcript (`docs/architecture/mcp-in-a-session.md` → Into the conversation,
// The transcript): the head line, its arguments, and the block the model got read back into the messages it came from. Pure, so
// it is tested without a thread.

import { flatCut, type McpPromptData, mcpPromptLabel } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";

/** One message of the prompt's result, read back from its block: the text, and whose message it was in. */
export interface PromptSegment {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** The head line of the chip in the transcript: "MCP prompt · docs · Review PR". */
export const promptHead = (prompt: Pick<McpPromptData, "server" | "name" | "title">): string =>
  `MCP prompt · ${mcpPromptLabel(prompt)}`;

/** The most characters of one argument's value the chip shows (the block has it whole). */
const VALUE_CHARS = 80;

/** The arguments the prompt got, one `name: value` each, the value on one line and cut; one with no value is left out. */
export const promptArgumentLines = (
  prompt: Pick<McpPromptData, "arguments">,
): ReadonlyArray<string> =>
  Arr.flatMap(Record.toEntries(prompt.arguments), ([name, value]) => {
    const flat = flatCut(value, VALUE_CHARS);

    return flat === "" ? [] : [`${name}: ${flat}`];
  });

const OPEN = /^<mcp_prompt\b[^\n]*>\n?/u;
const CLOSE = /\n?<\/mcp_prompt>\s*$/u;
const ASSISTANT = /<prompt_message role="assistant">\n?([\s\S]*?)\n?<\/prompt_message>/gu;

/**
 * The messages of `block`, the `<mcp_prompt>` block the model got, in the order they came: the user's text, and each
 * `<prompt_message role="assistant">` as an assistant message. The Session defangs the tags in a prompt's own text, so
 * the ones here are its own. A block that does not read as one is a single user message, whole.
 */
export const promptSegments = (block: string): ReadonlyArray<PromptSegment> => {
  const inner = block.replace(OPEN, "").replace(CLOSE, "").trim();
  const segments: Array<PromptSegment> = [];

  let from = 0;

  for (const match of inner.matchAll(ASSISTANT)) {
    const before = inner.slice(from, match.index).trim();

    if (before !== "") segments.push({ role: "user", text: before });

    segments.push({ role: "assistant", text: (match[1] ?? "").trim() });

    from = match.index + match[0].length;
  }

  const rest = inner.slice(from).trim();

  if (rest !== "") segments.push({ role: "user", text: rest });

  return segments;
};
