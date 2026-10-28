// Attachments (GLOSSARY.md → Messages): a file the owner gives with a message is uploaded into the Session's Workspace at
// `/workspace/.cloudpid/uploads/<session-id>/<name>` and pointed at by its path; an attached image also goes inline to the model.
// The web app (to name and size what it uploads and sends) and the server (to place an upload and to bound what a
// submit may hold) share these rules (`docs/architecture/client-and-protocol.md` → Attachments).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain string functions.
import * as Schema from "effect/Schema";
import { WORKSPACE_ROOT } from "./repo.ts";

/** The harness's own hidden directory at the Workspace root: Attachments, clone staging. */
export const CLOUDPID_ROOT = `${WORKSPACE_ROOT}/.cloudpid`;

/** Where every Session's Attachments are kept in its Workspace, one directory per Session below it. */
export const UPLOADS_ROOT = `${CLOUDPID_ROOT}/uploads`;

/**
 * The largest Attachment, in bytes. The Workspace DO holds the whole file in memory to write it (its storage then keeps
 * it in chunks), in an isolate of 128 MB that runs everything else of the Workspace too.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The longest Attachment name, in code points. */
export const MAX_ATTACHMENT_NAME_LENGTH = 100;

/**
 * The longest Attachment name, in UTF-8 bytes: well under the 255 bytes a Linux file name may have (the Container's
 * file system), so a name of wide characters is cut too.
 */
export const MAX_ATTACHMENT_NAME_BYTES = 200;

/** What a name with nothing usable left becomes. */
const FALLBACK_NAME = "attachment";

/**
 * The most a submitted message may hold, in UTF-8 bytes of its JSON (its content, with any inline image, and the data
 * its entry keeps). The entry is one SQLite row, which Cloudflare caps at 2 MB, and a queued message is copied into the
 * conversation's inbox, one row for every message waiting; the rest of 2 MB is left for the row's own fields.
 */
export const MAX_STORED_INPUT_BYTES = 1_900_000;

/**
 * How many base64 characters one message's inline images share, at most: under `MAX_STORED_INPUT_BYTES`, with room
 * for the text, the Attachment paths and an expanded Skill.
 */
export const INLINE_IMAGE_BUDGET = 1_500_000;

/** The image types a message may carry inline: the ones every provider takes. */
export const INLINE_IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** Whether an image part of `mimeType` may go inline to the model. */
export const isInlineImageType = (mimeType: string): boolean =>
  INLINE_IMAGE_TYPES.includes(mimeType);

/** The directory Session `sessionId`'s Attachments are uploaded to. */
export const uploadsDirectory = (sessionId: string): string => `${UPLOADS_ROOT}/${sessionId}`;

/** Where Attachment `name` of Session `sessionId` is kept. */
export const attachmentPath = (sessionId: string, name: string): string =>
  `${uploadsDirectory(sessionId)}/${name}`;

/**
 * The main Worker's route for Attachment `name` of Session `sessionId`: `PUT` uploads the file's bytes as the body,
 * `DELETE` removes one that was not sent.
 */
export const attachmentRoutePath = (sessionId: string, name: string): string =>
  `/sessions/${sessionId}/attachments/${encodeURIComponent(name)}`;

/** The answer to an upload: the name the file was stored under (suffixed when taken) and its path in the Workspace. */
export const StoredAttachment = Schema.Struct({ name: Schema.String, path: Schema.String });

export type StoredAttachment = typeof StoredAttachment.Type;

/** A file name's extension: a dot and up to 16 letters or digits after a non-empty stem. */
const EXTENSION = /^(.+?)(\.[\p{L}\p{N}]{1,16})$/u;

const splitName = (name: string): { readonly stem: string; readonly extension: string } => {
  const match = EXTENSION.exec(name);

  return match === null
    ? { stem: name, extension: "" }
    : { stem: match[1] ?? name, extension: match[2] ?? "" };
};

/** Dots and dashes a name may not start or end with: it would be hidden, read as an option, or end oddly. */
const trimEnds = (text: string): string => text.replace(/^[.-]+/u, "").replace(/[.-]+$/u, "");

const encoder = new TextEncoder();

const bytesOf = (text: string): number => encoder.encode(text).byteLength;

/** Whether `name` is within both limits. */
const fits = (name: string): boolean =>
  Array.from(name).length <= MAX_ATTACHMENT_NAME_LENGTH &&
  bytesOf(name) <= MAX_ATTACHMENT_NAME_BYTES;

/** `stem` cut to at most `length` code points and `bytes` UTF-8 bytes, without a dot or dash left at its end. */
const cutStem = (stem: string, length: number, bytes: number): string => {
  let cut = "";
  let used = 0;

  for (const [index, character] of Array.from(stem).entries()) {
    const size = bytesOf(character);

    if (index >= length || used + size > bytes) break;

    cut += character;
    used += size;
  }

  return trimEnds(cut);
};

/** `stem` and `extension` together, the stem cut so the whole fits both limits. */
const joinWithin = (stem: string, extension: string): string => {
  const whole = `${stem}${extension}`;

  if (fits(whole)) return whole;

  const cut = cutStem(
    stem,
    MAX_ATTACHMENT_NAME_LENGTH - Array.from(extension).length,
    MAX_ATTACHMENT_NAME_BYTES - bytesOf(extension),
  );

  return `${cut === "" ? FALLBACK_NAME : cut}${extension}`;
};

/**
 * `raw` as one safe path segment: letters, digits, `.`, `_` and `-`, every other run of characters (spaces, slashes,
 * quotes, controls) one dash, never starting or ending with a dot or a dash (so never `.`, `..`, hidden or an option),
 * at most `MAX_ATTACHMENT_NAME_LENGTH` code points and `MAX_ATTACHMENT_NAME_BYTES` UTF-8 bytes with its extension kept,
 * and `attachment` when nothing is left.
 */
export const sanitizeAttachmentName = (raw: string): string => {
  const cleaned = trimEnds(
    raw
      .normalize("NFC")
      .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-")
      .replace(/-{2,}/gu, "-")
      .replace(/-+\./gu, ".")
      .replace(/\.-+/gu, "."),
  );

  if (cleaned === "") return FALLBACK_NAME;

  if (fits(cleaned)) return cleaned;

  const { stem, extension } = splitName(cleaned);

  return joinWithin(stem, extension);
};

/** `name`, or the first of `name-2`, `name-3`, … (before its extension) that `taken` does not hold. */
export const freeAttachmentName = (name: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(name)) return name;

  const { stem, extension } = splitName(name);

  for (let suffix = 2; ; suffix += 1) {
    const candidate = joinWithin(stem, `-${suffix}${extension}`);

    if (!taken.has(candidate)) return candidate;
  }
};
