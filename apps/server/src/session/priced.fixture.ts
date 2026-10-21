// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- pi-ai's model streams are Promise code.
// pi-ai's faux provider reports no cost of its own (every response's cost is zero), so a test of what a Session spends
// prices the requests itself.
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { aroundRequests } from "@cloudpid/telemetry";

const priced = (message: AssistantMessage, cost: number): AssistantMessage => ({
  ...message,
  usage: { ...message.usage, cost: { ...message.usage.cost, total: cost } },
});

/** `models` whose every answered request costs `cost` US dollars, however the provider priced it. */
export const pricedModels = (models: Models, cost: number): Models =>
  aroundRequests(models, (_request, start) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const inner = start();

      for await (const event of inner) {
        if (event.type === "done") stream.push({ ...event, message: priced(event.message, cost) });
        else stream.push(event);
      }

      stream.end(priced(await inner.result(), cost));
    })();

    return stream;
  });
