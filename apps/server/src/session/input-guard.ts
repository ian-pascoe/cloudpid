// What a submit may hold (`docs/spec.md` → Client and protocol → Attachments). The owner's message is stored as one
// entry, a single SQLite row that Cloudflare caps at 2 MB, and a message that waits for the run is copied into the
// conversation's inbox, one document (one row) for every message waiting. A write over the cap fails the commit, which
// fails the whole Session, so the Session refuses such a message first, with why, and keeps running.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over a draft's JSON.
import { isInlineImageType, MAX_STORED_INPUT_BYTES } from "@cloudpid/protocol";
import type { UserInput } from "@earendil-works/pi-durable";
import * as Predicate from "effect/Predicate";

/** What the Session stores of a submit: its content, and the entry's kind and data when it was expanded. */
export type StoredInput = {
  readonly content: UserInput;
  readonly entry?: { readonly kind: string; readonly data?: unknown } | undefined;
};

const encoder = new TextEncoder();

/** What storage keeps as JSON: a message, or the inbox document of the messages waiting. */
type Stored = StoredInput | { readonly items: ReadonlyArray<object> } | string;

/** The UTF-8 bytes of `value` as JSON, as storage keeps it. */
export const storedBytes = (value: Stored): number =>
  encoder.encode(JSON.stringify(value)).byteLength;

/** `bytes` in megabytes, rounded up to two decimals, so a size just over the limit never reads as the limit. */
const megabytes = (bytes: number): string => (Math.ceil(bytes / 10_000) / 100).toFixed(2);

const LIMIT = `${MAX_STORED_INPUT_BYTES / 1_000_000} MB`;

/**
 * Why `input` cannot be admitted, or undefined when it can: an image of a type that is not PNG, JPEG, WebP or GIF, a
 * message over `MAX_STORED_INPUT_BYTES`, or one that would take the inbox past it beside the `queuedBytes` already
 * waiting there.
 */
export const inputProblem = (input: StoredInput, queuedBytes: number): string | undefined => {
  const parts = Predicate.isString(input.content) ? [] : input.content;

  for (const part of parts) {
    if (part.type === "image" && !isInlineImageType(part.mimeType)) {
      return `An image must be PNG, JPEG, WebP or GIF to go to the model, not ${part.mimeType}.`;
    }
  }

  const bytes = storedBytes({ content: input.content, entry: input.entry });

  if (bytes > MAX_STORED_INPUT_BYTES) {
    return `This message is ${megabytes(bytes)} MB, and one holds at most ${LIMIT}: send fewer or smaller images, or less text.`;
  }

  if (bytes + queuedBytes > MAX_STORED_INPUT_BYTES) {
    return `The messages waiting for the run and this one are ${megabytes(bytes + queuedBytes)} MB together, over the ${LIMIT} the queue holds: send it once the run has taken them.`;
  }

  return undefined;
};
