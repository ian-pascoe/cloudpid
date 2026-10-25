// @effect-diagnostics preferEffectArray:off -- a message's parts are a short native array.

/** A part of a message as assistant-ui holds it: only its text parts are read. */
interface MessagePart {
  readonly type: string;
  readonly text?: string;
}

/**
 * What copying a message puts on the clipboard: its text parts, a blank line between each (the owner's words, or the
 * markdown the agent wrote between its tool calls). Tool calls, thinking and images are left out.
 */
export const messageText = (content: ReadonlyArray<MessagePart>): string =>
  content
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text.trim()] : []))
    .filter((text) => text !== "")
    .join("\n\n");
