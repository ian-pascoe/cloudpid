// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over messages' native arrays.
// The text of a message, read the same way wherever the Session shows or summarizes one: pi-ai's messages and the
// transcript's alike keep it in parts of type "text".
import * as Predicate from "effect/Predicate";

/** A part of a message's content: text, or anything else (an image, a tool call). */
type Part = { readonly type: string };

type TextPart = { readonly type: "text"; readonly text: string };

const isText = (part: Part): part is TextPart =>
  part.type === "text" && "text" in part && Predicate.isString(part.text);

/** The text of `parts`' text parts, in order. */
export const textsOf = (parts: ReadonlyArray<Part>): string[] =>
  parts.flatMap((part) => (isText(part) ? [part.text] : []));

/** The text of a message's content: a plain string as it is, or its text parts joined by `separator`. */
export const contentText = (content: string | ReadonlyArray<Part>, separator = "\n"): string =>
  Predicate.isString(content) ? content : textsOf(content).join(separator);
