// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over the JSON of one translated entry, which the translation owns and changes in place.
// What a translated entry is held to (`docs/architecture/mcp-endpoint.md` → Session import → Translation, D3.2). An entry is
// one row of the Session's SQLite, which workerd caps at 8 MiB and a write over it fails the whole Session, so no entry
// goes in over `MAX_IMPORTED_ENTRY_BYTES`. The live caps come first (an image the Session would not keep is a text
// placeholder, as `read` and the browser leave one out); then the entry's largest text is cut in the middle until it
// fits, which keeps the start and the end of what was said, where an end usually holds the answer or the error.
import { INLINE_IMAGE_TYPES } from "@cloudpid/protocol";
import type { ImageContent, JsonValue, Message, TextContent } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";

/**
 * The most one translated entry weighs, in bytes of the JSON the Session stores (about 5 MB). cloudpid's largest live
 * entry (a tool result, whose diagnostics and details are bounded apart from its text: `docs/architecture/workspace.md` →
 * The rest of one tool result) stays within it, and it leaves the row's 8 MiB room for the entry's other fields.
 */
export const MAX_IMPORTED_ENTRY_BYTES = 5_000_000;

/**
 * The longest image an entry keeps, in base64 characters: what `read` and the browser hold an image to
 * (`MAX_IMAGE_CHARACTERS` in `@cloudpid/extensions/images`), since the entry is stored, sent to the model with every
 * request and sent to every client.
 */
export const MAX_IMPORTED_IMAGE_CHARACTERS = 750_000;

/** The shortest a part is cut to while others can still be: its start and end, with the note between. */
const MIN_KEPT_CHARACTERS = 256;

const encoder = new TextEncoder();

/** The bytes of `entry` as the Session stores it: JSON, in UTF-8. */
export const storedBytes = (entry: EntryRecord): number =>
  encoder.encode(JSON.stringify(entry)).byteLength;

/** The text that stands in for an image that is not kept. */
const placeholder = (why: string): TextContent => ({
  type: "text",
  text: `[image omitted by the import: ${why}]`,
});

/** Whether `part` is an image the Session would not keep, and why. */
const unkept = (part: ImageContent): string | undefined => {
  if (!INLINE_IMAGE_TYPES.includes(part.mimeType)) {
    return `its type, ${part.mimeType}, is not one the models take`;
  }

  return Predicate.isString(part.data) && part.data.length <= MAX_IMPORTED_IMAGE_CHARACTERS
    ? undefined
    : "it is too large to keep";
};

/**
 * Replace the images of `content` that the Session would not keep with text, in place: one that is not of a type every
 * provider takes, and one over `MAX_IMPORTED_IMAGE_CHARACTERS`. Answers whether any was.
 */
export const capImages = (content: string | Array<TextContent | ImageContent>): boolean => {
  if (!Array.isArray(content)) return false;

  let changed = false;

  for (let at = 0; at < content.length; at++) {
    const part = content[at];
    const why = part?.type === "image" ? unkept(part) : undefined;

    if (why !== undefined) {
      content[at] = placeholder(why);
      changed = true;
    }
  }

  return changed;
};

/** A string somewhere in an entry that may be cut: how long it is, and how to cut it to `keep` characters. */
type Cuttable = { readonly length: number; readonly cut: (keep: number) => void };

type Slots = Record<string, JsonValue>;

/**
 * The slots of `value` (an object's properties, an array's items) when it is a container, else none. A string in an
 * array is a slot as a string in an object is.
 */
const slotsOf = (value: JsonValue | undefined): Slots | undefined =>
  // SAFETY: an object or an array of JSON values is indexed by its keys, which `Object.keys` lists; assigning a string to one replaces that item.
  Predicate.isObject(value) ? (value as Slots) : undefined;

/**
 * The strings of `value`, at any depth (a tool call's arguments, a result's details), as parts that may be cut;
 * `withdraw` runs when one is, for the signature that vouched for the call.
 */
const stringsUnder = (
  value: JsonValue | undefined,
  withdraw: () => void,
  into: Cuttable[],
  depth = 0,
): void => {
  const slots = slotsOf(value);

  if (slots === undefined || depth > 32) return;

  for (const key of Object.keys(slots)) {
    const item = slots[key];

    if (Predicate.isString(item)) {
      into.push({
        length: item.length,
        cut: (keep) => {
          slots[key] = middleCut(item, keep);
          withdraw();
        },
      });
    } else {
      stringsUnder(item, withdraw, into, depth + 1);
    }
  }
};

/** `part` as a part that may be cut, and the signature it is vouched for by, which the cut withdraws. */
const textOf = (part: TextContent, into: Cuttable[]): void => {
  if (!Predicate.isString(part.text)) return;

  into.push({
    length: part.text.length,
    cut: (keep) => {
      part.text = middleCut(part.text, keep);
      delete part.textSignature;
    },
  });
};

/** The text a message holds that may be cut: its words, its reasoning, a call's arguments, a result's details. */
const cuttablesOf = (message: Message, into: Cuttable[]): void => {
  switch (message.role) {
    case "user": {
      const { content } = message;

      if (Predicate.isString(content)) {
        into.push({
          length: content.length,
          cut: (keep) => {
            message.content = middleCut(content, keep);
          },
        });
      } else {
        for (const part of content) if (part.type === "text") textOf(part, into);
      }

      return;
    }

    case "toolResult":
      for (const part of message.content) if (part.type === "text") textOf(part, into);

      stringsUnder(message.details, () => {}, into);

      return;

    case "assistant": {
      for (const part of message.content) {
        if (part.type === "text") {
          textOf(part, into);
        } else if (part.type === "thinking") {
          if (part.redacted !== true && Predicate.isString(part.thinking)) {
            into.push({
              length: part.thinking.length,
              cut: (keep) => {
                part.thinking = middleCut(part.thinking, keep);
                delete part.thinkingSignature;
              },
            });
          }
        } else {
          stringsUnder(
            part.arguments,
            () => {
              delete part.thoughtSignature;
            },
            into,
          );
        }
      }

      const text = message.errorMessage;

      if (Predicate.isString(text)) {
        into.push({
          length: text.length,
          cut: (keep) => {
            message.errorMessage = middleCut(text, keep);
          },
        });
      }

      return;
    }

    case "system":
      return;
  }
};

/** The messages of `entry`: its own, and those its edits replace others with. */
const messagesOf = (entry: EntryRecord): ReadonlyArray<Message> => [
  ...(entry.model ?? []),
  ...Arr.flatMap(entry.edits ?? [], (edit) => (edit.action === "replace" ? edit.messages : [])),
];

/** Cut `text` to `keep` characters in the middle, saying how many went; never inside a surrogate pair. */
export const middleCut = (text: string, keep: number): string => {
  if (text.length <= keep) return text;

  const note = (count: number) =>
    `\n\n[… ${String(count)} characters cut by the cloudpid import …]\n\n`;

  const room = Math.max(0, keep - note(text.length).length);
  let head = Math.ceil(room / 2);
  let tail = room - head;

  // A pair is never split: both of its halves stay, or neither.
  const before = text.charCodeAt(head - 1);

  if (head > 0 && before >= 0xd800 && before <= 0xdbff) head -= 1;

  const after = text.charCodeAt(text.length - tail);

  if (tail > 0 && after >= 0xdc00 && after <= 0xdfff) tail -= 1;

  return `${text.slice(0, head)}${note(text.length - head - tail)}${text.slice(text.length - tail)}`;
};

/**
 * The level every part is cut to so that `target` characters in all go (the largest first, as water fills the lowest
 * place): parts at or under it stay as they are.
 */
const levelFor = (lengths: ReadonlyArray<number>, target: number): number => {
  const sorted = [...lengths].sort((a, b) => b - a);
  let sum = 0;

  for (let taken = 1; taken <= sorted.length; taken++) {
    sum += sorted[taken - 1] ?? 0;

    const level = Math.floor((sum - target) / taken);

    if (level >= (sorted[taken] ?? 0)) return Math.max(level, MIN_KEPT_CHARACTERS);
  }

  return MIN_KEPT_CHARACTERS;
};

/** The images of `entry`, replaced by text, the largest first, until `entry` fits `limit`. */
const dropImages = (entry: EntryRecord, limit: number): void => {
  const images: Array<{ content: Array<TextContent | ImageContent>; at: number; size: number }> =
    [];

  for (const message of messagesOf(entry)) {
    if (message.role !== "user" && message.role !== "toolResult") continue;

    const { content } = message;

    if (Predicate.isString(content)) continue;

    content.forEach((part, at) => {
      if (part.type === "image") images.push({ content, at, size: part.data.length });
    });
  }

  for (const image of images.sort((a, b) => b.size - a.size)) {
    if (storedBytes(entry) <= limit) return;

    image.content[image.at] = placeholder("the entry was over the size the Session keeps");
  }
};

/** What holding an entry to its bound did. */
export type Fitted = {
  /** The entry as it is kept (`undefined`: nothing could make it fit, so it is dropped). */
  readonly entry: EntryRecord | undefined;
  /** Whether any of it was cut or replaced. */
  readonly cut: boolean;
};

/**
 * `entry` held to `limit` bytes, changed in place: its images capped, then, while it is over, its largest text parts cut
 * in the middle down to one level (so each keeps its start and its end), then its images replaced largest first. A cut
 * thinking block or message loses its provider signature: a provider rejects one whose words changed.
 */
export const fitEntry = (entry: EntryRecord, limit = MAX_IMPORTED_ENTRY_BYTES): Fitted => {
  let cut = false;

  for (const message of messagesOf(entry)) {
    if ((message.role === "user" || message.role === "toolResult") && capImages(message.content)) {
      cut = true;
    }
  }

  // Counting bytes copies the entry: one whose JSON cannot reach the limit (3 bytes a character at most) is not counted.
  if (JSON.stringify(entry).length * 3 <= limit) return { entry, cut };

  // Each round cuts what is over, with the room the notes take; the escapes that characters grow into make it more than one.
  for (let round = 0; round < 6; round++) {
    const over = storedBytes(entry) - limit;

    if (over <= 0) return { entry, cut };

    const found: Cuttable[] = [];

    for (const message of messagesOf(entry)) cuttablesOf(message, found);

    const cuttables = found.filter((part) => part.length > MIN_KEPT_CHARACTERS);

    if (cuttables.length === 0) break;

    const level = levelFor(
      cuttables.map((part) => part.length),
      over + over / 50 + 128 * cuttables.length,
    );

    for (const part of cuttables) if (part.length > level) part.cut(level);

    cut = true;
  }

  if (storedBytes(entry) > limit) {
    dropImages(entry, limit);
    cut = true;
  }

  return storedBytes(entry) > limit ? { entry: undefined, cut } : { entry, cut };
};
