// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectRecord:off globalDate:off -- pi-ai's model streams are Promise code, with its own request timestamps.
// The Session's model seam (`docs/spec.md` → Secrets, Telemetry): a wrapper sees every request a conversation's Harness
// makes through its `Models`: generations, compaction summaries, a subagent's `compact` summary, and the title call.
import type {
  Api,
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  Models,
} from "@earendil-works/pi-ai";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import * as Predicate from "effect/Predicate";

/** What a wrapper is told of a request. */
export type ModelRequest = {
  readonly model: Model<Api>;
  readonly reasoning: ModelThinkingLevel | undefined;
};

/** Runs one request: `start` makes the request itself, and the stream the wrapper returns is what the caller gets. */
export type AroundRequest = (
  request: ModelRequest,
  start: () => AssistantMessageEventStream,
) => AssistantMessageEventStream;

/** The error a request ends with when a wrapper itself fails, shaped as pi-ai's own setup errors. */
export const requestFailure = (
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  message: string,
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
  errorMessage: message,
  timestamp,
});

/** A stream that has already ended with `error`. */
export const failedStream = (
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  message: string,
  timestamp: number,
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  const error = requestFailure(model, message, timestamp);

  stream.push({ type: "error", reason: "error", error });
  stream.end(error);

  return stream;
};

/**
 * `models` with every request run through `around`: `stream` and `streamSimple` return what it returns, and
 * `complete` and `completeSimple` are the result of that, as pi-ai's own are of its streams. Everything else is the
 * models object's own.
 */
export const aroundRequests = (models: Models, around: AroundRequest): Models => {
  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple"> = {
    stream: (model, context, options) =>
      around({ model, reasoning: undefined }, () => models.stream(model, context, options)),
    complete: (model, context, options) =>
      around({ model, reasoning: undefined }, () =>
        models.stream(model, context, options),
      ).result(),
    streamSimple: (model, context, options) =>
      around({ model, reasoning: options?.reasoning }, () =>
        models.streamSimple(model, context, options),
      ),
    completeSimple: (model, context, options) =>
      around({ model, reasoning: options?.reasoning }, () =>
        models.streamSimple(model, context, options),
      ).result(),
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

/**
 * `models` with every request a `pi.ai.request` span of `telemetry`, in pi-ai's own vocabulary
 * (`AI_TELEMETRY_SCHEMA`): provider, API, model and reasoning level, and on the response its stop reason, token counts
 * and cost, and the first chunk's arrival as an event. Content is never recorded. pi-ai 1.3.0 starts no such span itself;
 * when it does, take this wrapper out.
 */
export const tracingModels = (models: Models, telemetry: TelemetryContext): Models =>
  aroundRequests(models, ({ model, reasoning }, start) => {
    const stream = createAssistantMessageEventStream();
    const timestamp = Date.now();

    // An undefined `reasoning` is left out of the span, as pi-telemetry has undefined attributes ignored.
    const attributes = { provider: model.provider, api: model.api, model: model.id, reasoning };

    telemetry
      .startSpan({ name: "pi.ai.request", attributes }, async (span) => {
        const inner = start();
        let first = true;

        /** The final message is recorded before its event is forwarded: the caller's result may resolve at once. */
        const record = (message: AssistantMessage): void => {
          span.setAttributes({
            stop: message.stopReason,
            "usage.input": message.usage.input,
            "usage.output": message.usage.output,
            "usage.cache_read": message.usage.cacheRead,
            "usage.cache_write": message.usage.cacheWrite,
            "cost.total": message.usage.cost.total,
            "response.id": message.responseId,
          });

          if (message.stopReason === "error") {
            span.setStatus({
              status: "error",
              error: { name: "provider_error", message: message.errorMessage?.slice(0, 500) ?? "" },
            });
          }
        };

        for await (const event of inner) {
          if (first) {
            first = false;
            span.addEvent("pi.ai.first_chunk");
          }

          if (event.type === "done") record(event.message);

          if (event.type === "error") record(event.error);

          stream.push(event);
        }

        stream.end(await inner.result());
      })
      // Any failure still ends the stream, so its consumer never waits forever; a stream already ended ignores it.
      .catch((cause) => {
        const error = requestFailure(
          model,
          cause instanceof Error ? cause.message : String(cause),
          timestamp,
        );

        stream.push({ type: "error", reason: "error", error });
        stream.end(error);
      });

    return stream;
  });
