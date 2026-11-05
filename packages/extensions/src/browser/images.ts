// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over pi's message arrays.
// Bounding the screenshots that accumulate (`docs/architecture/browser.md`). Every screenshot stays in the transcript, so how
// many are sent grows with a Session: to the model with each request (a provider caps the images and bytes of one), and
// to a client in what a conversation's watch sends, its view, its operations and its pages of entries (one socket message
// has a size cap). Only the latest few are sent; an older one is replaced by a short text, in the request and in the
// socket message, and stays in the transcript's storage.
import type { JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { Message, Models, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { contextMappedModels } from "../models.ts";

/** How many of the latest screenshots a model request carries. */
export const MODEL_IMAGES = 3;

/**
 * How many of the latest screenshots one socket message of a conversation's watch carries: its view (what a client shows
 * after it connects), its operations, or a page of its entries.
 */
export const WATCH_IMAGES = 10;

/** What stands in for a screenshot that is no longer sent. */
export const OMITTED_IMAGE = "[screenshot omitted]";

const isImageResult = (message: Message): message is ToolResultMessage =>
  message.role === "toolResult" && message.content.some((part) => part.type === "image");

/**
 * The messages of `messages` as they are sent with at most the latest `keep` screenshots of tool results: an earlier
 * one becomes `OMITTED_IMAGE` text. Messages without an omitted image are returned as they are.
 */
export const limitImages = (messages: readonly Message[], keep: number): readonly Message[] => {
  // Walking back from the newest: how many images of each message are kept (its last ones).
  const kept = new Map<Message, number>();
  let budget = keep;
  let omits = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message === undefined || !isImageResult(message)) continue;

    const images = message.content.filter((part) => part.type === "image").length;
    const here = Math.min(images, budget);

    kept.set(message, here);
    budget -= here;
    omits ||= here < images;
  }

  if (!omits) return messages;

  return messages.map((message) => {
    const keptHere = kept.get(message);

    if (keptHere === undefined || !isImageResult(message)) return message;

    const images = message.content.filter((part) => part.type === "image").length;
    let seen = 0;

    const content = message.content.map((part) => {
      if (part.type !== "image") return part;

      seen += 1;

      return seen > images - keptHere ? part : { type: "text" as const, text: OMITTED_IMAGE };
    });

    return { ...message, content };
  });
};

/** `entries` with the screenshots of all but the latest `keep` replaced, as `limitImages` does for the messages they carry. */
export const limitEntryImages = <E extends { readonly model?: readonly Message[] }>(
  entries: readonly E[],
  keep: number,
): readonly E[] => {
  const messages = entries.flatMap((entry) => entry.model ?? []);
  const limited = limitImages(messages, keep);

  if (limited === messages) return entries;

  // Each message sits at the same place in `limited`, so the entries are rebuilt in order.
  let next = 0;

  return entries.map((entry) => {
    if (entry.model === undefined) return entry;

    const model = limited.slice(next, next + entry.model.length);

    next += entry.model.length;

    return model.every((message, at) => message === entry.model?.[at])
      ? entry
      : { ...entry, model };
  });
};

/** `view` with the screenshots of its window's entries bounded as `limitEntryImages` does. */
export const limitViewImages = (view: ConversationView, keep: number): ConversationView => {
  const entries = limitEntryImages(view.entries, keep);

  return entries === view.entries ? view : { ...view, entries };
};

/** What an operation of a conversation view's watch adds to its entries: a whole view, a window, or entries in one. */
type Added =
  | { readonly kind: "view"; readonly view: ConversationView }
  | { readonly kind: "window" | "splice"; readonly entries: readonly EntryRecord[] }
  | { readonly kind: "entry"; readonly entry: EntryRecord };

// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the operations of a conversation view's watch change a `ConversationView`, whose entries are pi's records.
const asView = (value: JsonValue): ConversationView => value as unknown as ConversationView;

const asEntries = (value: JsonValue): readonly EntryRecord[] =>
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: as above, for the entries an operation puts into its `entries`.
  value as unknown as readonly EntryRecord[];

// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: as above, for an entry an operation puts into its `entries`.
const asEntry = (value: JsonValue): EntryRecord => value as unknown as EntryRecord;

// SAFETY: an entry is JSON once it is stored, so an operation can carry it as it carried the one it replaces.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- an entry's model, which pi types apart from JSON.
const asJson = (value: unknown): JsonValue => value as JsonValue;

/** The entries `op` adds to a conversation view: none for an operation on anything but its `entries`. */
const addedBy = (op: Op): Added | undefined => {
  switch (op[0]) {
    case "r":
      return { kind: "view", view: asView(op[1]) };
    case "s": {
      const [, path, value] = op;

      if (path[0] !== "entries") return undefined;

      if (path.length === 1) return { kind: "window", entries: asEntries(value) };

      return path.length === 2 ? { kind: "entry", entry: asEntry(value) } : undefined;
    }

    case "p": {
      const [, path, , , items] = op;

      return path.length === 1 && path[0] === "entries"
        ? { kind: "splice", entries: asEntries(items) }
        : undefined;
    }

    default:
      return undefined;
  }
};

const entriesOf = (added: Added): readonly EntryRecord[] => {
  switch (added.kind) {
    case "view":
      return added.view.entries;
    case "window":
    case "splice":
      return added.entries;
    case "entry":
      return [added.entry];
  }
};

/**
 * `ops`, one call of a conversation view's watch, with the screenshots of the entries they add bounded together as
 * `limitEntryImages` does: a call folds the commits made while the last one was being sent, or replaces the whole view,
 * and it is one socket message. The entries in the view the operations apply to are never changed by them (a committed
 * entry never changes), so a bounded entry stays bounded on the client.
 */
export const limitOpsImages = (ops: readonly Op[], keep: number): readonly Op[] => {
  const added = ops.map(addedBy);
  const entries = added.flatMap((each) => (each === undefined ? [] : entriesOf(each)));
  const limited = limitEntryImages(entries, keep);

  if (limited === entries) return ops;

  // Each entry sits at the same place in `limited`, so the operations are rebuilt in order.
  let next = 0;

  const take = (count: number): readonly EntryRecord[] => {
    const taken = limited.slice(next, next + count);

    next += count;

    return taken;
  };

  return ops.map((op, index): Op => {
    const each = added[index];

    if (each === undefined) return op;

    const bounded = take(entriesOf(each).length);

    switch (op[0]) {
      case "r":
        return ["r", asJson({ ...asView(op[1]), entries: bounded })];
      case "s":
        return ["s", op[1], asJson(each.kind === "entry" ? bounded[0] : bounded)];
      case "p":
        return ["p", op[1], op[2], op[3], [...bounded].map(asJson)];
      default:
        return op;
    }
  });
};

/** `models` with every request's earlier screenshots replaced (`limitImages` with `keep`). */
export const imageLimitedModels = (models: Models, keep = MODEL_IMAGES): Models =>
  contextMappedModels(models, (_model, context) => {
    const messages = limitImages(context.messages, keep);

    return messages === context.messages ? context : { ...context, messages: [...messages] };
  });
