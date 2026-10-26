// What the composer sends for its Attachments (GLOSSARY.md → Messages: Attachment): each one's `@path` in the
// Workspace after the typed text, its image inline when it fits, and the names in the queue lanes.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over native arrays, not combinators.

import {
  freeAttachmentName,
  type PageRef,
  sanitizeAttachmentName,
  type UserInput,
} from "@cloudpid/protocol";
import type { OutgoingMessage } from "../session/state.ts";
import type { Encoded } from "./image-budget.ts";

/** An uploaded Attachment as a message sends it: its stored name and path, and its image when it goes inline. */
export type SentAttachment = {
  readonly name: string;
  readonly path: string;
  readonly inline?: Encoded | undefined;
};

/** An attached page as a message sends it: its Owner tab, its title for the lane, and its screen when it goes inline. */
export type SentPage = {
  readonly ref: PageRef;
  readonly title: string;
  readonly screen?: Encoded | undefined;
};

/** The name to upload `fileName` under: sanitised, and apart from the names the composer's other Attachments have. */
export const requestedName = (fileName: string, taken: Iterable<string>): string =>
  freeAttachmentName(sanitizeAttachmentName(fileName), new Set(taken));

/** What a lane shows of a message: the typed text, then the Attachments' names. */
export const laneText = (typed: string, names: readonly string[]): string => {
  const text = typed.trim();

  if (names.length === 0) return text;

  const attached = `Attached: ${names.join(", ")}`;

  return text === "" ? attached : `${text} · ${attached}`;
};

/**
 * The message to submit for `typed`, `attachments` and the attached `pages`: the typed text as it is, then a text part of
 * each Attachment's `@path` on a line of its own, then the pages' screens (in the order of the pages), then the
 * Attachments' inline images in order, and what the lanes show of it. The paths are a part of their own, so a Prompt
 * template or a Skill the Session expands from the typed text (its first text part) neither takes them for arguments nor
 * drops them. The pages travel as `pages`, which the Session reads from the browser and fences as page content (it puts
 * their block before the first image); only their screens, which are pictures like the Attachments', are in the input.
 */
export const outgoingMessage = (
  typed: string,
  attachments: readonly SentAttachment[],
  pages: readonly SentPage[] = [],
): OutgoingMessage => {
  const display = laneText(typed, [
    ...attachments.map((attachment) => attachment.name),
    ...pages.map((page) => page.title),
  ]);

  if (attachments.length === 0 && pages.length === 0) return { input: typed, display };

  const input: UserInput = typed.trim() === "" ? [] : [{ type: "text", text: typed }];

  if (attachments.length > 0) {
    input.push({
      type: "text",
      text: attachments.map((attachment) => `@${attachment.path}`).join("\n"),
    });
  }

  for (const page of pages) {
    if (page.screen !== undefined) input.push({ type: "image", ...page.screen });
  }

  for (const attachment of attachments) {
    if (attachment.inline !== undefined) input.push({ type: "image", ...attachment.inline });
  }

  return pages.length === 0
    ? { input, display }
    : { input, display, pages: pages.map((page) => page.ref) };
};

const KIB = 1024;

const MIB = KIB * 1024;

/** `bytes` for people, in binary units, as the 25 MB limit is. */
export const formatSize = (bytes: number): string => {
  if (bytes < KIB) return `${bytes} B`;

  if (bytes < MIB) return `${Math.round(bytes / KIB)} KB`;

  const megabytes = bytes / MIB;

  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
};

/** Whether a file of `type` is a picture the browser may decode and the model see: a raster image, not an SVG. */
export const isPictureType = (type: string): boolean =>
  type.startsWith("image/") && type !== "image/svg+xml";
