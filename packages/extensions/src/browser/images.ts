// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over pi's message arrays.
// Bounding the screenshots that accumulate (`docs/spec.md` → Browser). Every screenshot stays in the transcript, so how
// many are sent grows with a Session: to the model with each request (a provider caps the images and bytes of one), and
// to a client in the transcript snapshot (one socket message has a size cap). Only the latest few are sent; an older one
// is replaced by a short text, in the request and in the snapshot, and stays in the transcript's storage.
import type {
  Api,
  Context,
  Message,
  Model,
  Models,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as Predicate from "effect/Predicate";

/** How many of the latest screenshots a model request carries. */
export const MODEL_IMAGES = 3;

/** How many of the latest screenshots a transcript snapshot carries: what a client shows after it connects. */
export const SNAPSHOT_IMAGES = 10;

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

/** `models` with every request's earlier screenshots replaced (`limitImages` with `keep`). */
export const imageLimitedModels = (models: Models, keep = MODEL_IMAGES): Models => {
  const limited = (context: Context): Context => {
    const messages = limitImages(context.messages, keep);

    return messages === context.messages ? context : { ...context, messages: [...messages] };
  };

  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple"> = {
    stream: (model: Model<Api>, context, options) =>
      models.stream(model, limited(context), options),
    complete: (model: Model<Api>, context, options) =>
      models.complete(model, limited(context), options),
    streamSimple: (model: Model<Api>, context, options) =>
      models.streamSimple(model, limited(context), options),
    completeSimple: (model: Model<Api>, context, options) =>
      models.completeSimple(model, limited(context), options),
  };

  return new Proxy(models, {
    get: (target, key) => {
      if (Object.hasOwn(requests, key)) {
        // SAFETY: `key` is one of the request methods, checked just above.
        return requests[key as keyof typeof requests];
      }

      // SAFETY: every other property is read from the models object itself, as its own type describes it.
      const value: unknown = target[key as keyof Models];

      // Methods run on the models object itself, whose private state a proxy would not have.
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
};
