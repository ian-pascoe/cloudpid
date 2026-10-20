// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectRecord:off globalDate:off
// Scrubbing at the Session's model seam (`docs/spec.md` → Secrets): every request a conversation's Harness makes
// through its `Models` — generations, pi-durable's compaction summaries, a subagent's `compact` summary, and any later
// small-role call — has its messages scrubbed of the Session's Secrets before it leaves the object.
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { SecretsService } from "./store.ts";

/** The error a request ends with when the scrubbing seam itself fails, shaped as pi-ai's own setup errors. */
const failure = (
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  cause: unknown,
  timestamp: number,
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: cause instanceof Error ? cause.message : String(cause),
  timestamp,
});

/**
 * `models` with every request's messages scrubbed by `secrets` (`SecretsService.scrub`), and a separately passed system
 * prompt redacted. A scrub that fails falls back to redacting the messages with the values held now, so a request never
 * leaves unscrubbed; a stream whose request fails in this seam ends with an `error` event rather than never ending.
 */
export const scrubbingModels = (models: Models, secrets: SecretsService): Models => {
  const scrubbed = (context: Context): Promise<Context> =>
    Effect.runPromise(
      secrets.scrub(context.messages).pipe(
        Effect.map((messages) =>
          messages === context.messages ? context : { ...context, messages: [...messages] },
        ),
        Effect.catchCause(() =>
          Effect.sync(() => ({ ...context, messages: secrets.redact(context.messages) })),
        ),
        Effect.map((clean) =>
          clean.systemPrompt === undefined
            ? clean
            : { ...clean, systemPrompt: secrets.redact(clean.systemPrompt) },
        ),
      ),
    );

  /** A stream that starts `request` once the context is scrubbed, and forwards its events. */
  const forward = (
    model: Pick<Model<Api>, "api" | "provider" | "id">,
    context: Context,
    request: (context: Context) => AssistantMessageEventStream,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const timestamp = Date.now();

    const relay = async () => {
      const inner = request(await scrubbed(context));

      for await (const event of inner) stream.push(event);

      stream.end(await inner.result());
    };

    // Any failure here still ends the stream, so its consumer never waits forever; a stream already ended ignores it.
    relay().catch((cause: unknown) => {
      const error = failure(model, cause, timestamp);

      stream.push({ type: "error", reason: "error", error });
      stream.end(error);
    });

    return stream;
  };

  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple"> = {
    stream: (model, context, options) =>
      forward(model, context, (clean) => models.stream(model, clean, options)),
    complete: async (model, context, options) =>
      models.complete(model, await scrubbed(context), options),
    streamSimple: (model, context, options) =>
      forward(model, context, (clean) => models.streamSimple(model, clean, options)),
    completeSimple: async (model, context, options) =>
      models.completeSimple(model, await scrubbed(context), options),
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
