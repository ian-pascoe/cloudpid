// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectRecord:off
// Scrubbing at the Session's model seam (`docs/spec.md` → Secrets): every request a conversation's Harness makes
// through its `Models` — generations, pi-durable's compaction summaries, a subagent's `compact` summary, and any later
// small-role call — has its messages scrubbed of the Session's Secrets before it leaves the object.
import type { Context, Models } from "@earendil-works/pi-ai";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { SecretsService } from "./store.ts";

/**
 * `models` with every request's messages scrubbed by `secrets` (`SecretsService.scrub`). A scrub that fails falls back
 * to redacting the request with the values held now, so a request never leaves unscrubbed.
 */
export const scrubbingModels = (models: Models, secrets: SecretsService): Models => {
  const scrubbed = (context: Context): Promise<Context> =>
    Effect.runPromise(
      secrets.scrub(context.messages).pipe(
        Effect.map((messages) =>
          messages === context.messages ? context : { ...context, messages: [...messages] },
        ),
        Effect.catchCause(() => Effect.sync(() => secrets.redact(context))),
      ),
    );

  /** A stream that starts `request` once the context is scrubbed, and forwards its events. */
  const forward = (
    context: Context,
    request: (context: Context) => AssistantMessageEventStream,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    void scrubbed(context).then(async (clean) => {
      const inner = request(clean);

      for await (const event of inner) stream.push(event);

      stream.end(await inner.result());
    });

    return stream;
  };

  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple"> = {
    stream: (model, context, options) =>
      forward(context, (clean) => models.stream(model, clean, options)),
    complete: async (model, context, options) =>
      models.complete(model, await scrubbed(context), options),
    streamSimple: (model, context, options) =>
      forward(context, (clean) => models.streamSimple(model, clean, options)),
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
