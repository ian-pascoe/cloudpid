// The scrubbing model seam: a separately passed system prompt is redacted too, and a stream whose request fails in the
// seam ends with an error instead of never ending.
// @effect-diagnostics strictEffectProvide:off asyncFunction:off
import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createModels,
  fauxProvider,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { scrubbingModels } from "./models.ts";
import { secretReference } from "./references.ts";
import { Secrets, secretsLayer, type SecretsService, type SecretStorage } from "./store.ts";
import { openVault } from "./vault.ts";

const VALUE = "sk-live-abcdefghijkl";

/** A Session's Secrets over memory storage, holding `API_KEY`. */
const holding = (): Promise<SecretsService> => {
  const map = new Map<string, unknown>();

  const storage: SecretStorage = {
    // SAFETY: the store reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return Effect.runPromise(
    Effect.gen(function* () {
      const vault = yield* openVault("test-master-key-0123456789abcdef0123456789", "session-1");

      const secrets = yield* Effect.provide(
        Effect.service(Secrets),
        secretsLayer({ storage, vault, announce: () => Effect.void }),
      );

      const asking = yield* Effect.forkChild(
        secrets.ask({ id: "1", conversationId: 1, names: ["API_KEY"] }),
      );

      yield* Effect.yieldNow;
      yield* secrets.answer("1", { API_KEY: VALUE });
      yield* Fiber.join(asking);

      return secrets;
    }),
  );
};

/** Models whose streams come from `stream`, recording each context they are given. */
const fakeModels = (stream: (context: Context) => AssistantMessageEventStream) => {
  const contexts: Context[] = [];

  const streamSimple = (_model: Model<Api>, context: Context) => {
    contexts.push(context);

    return stream(context);
  };

  // The seam calls only `streamSimple` here.
  const models: Models = new Proxy(createModels(), {
    get: (_target, key) => (key === "streamSimple" ? streamSimple : undefined),
  });

  return { models, contexts };
};

/** The faux provider's model, which the fake models never call. */
const fauxModel = (): Model<Api> => {
  const models = createModels();

  models.setProvider(fauxProvider().provider);

  const found = models.getModel("faux", "faux-1");

  if (found === undefined) throw new Error("No faux model");

  return found;
};

const model = fauxModel();

describe("scrubbingModels", () => {
  it("redacts a separately passed system prompt as well as the messages", async () => {
    const { models, contexts } = fakeModels(() => {
      const stream = createAssistantMessageEventStream();

      stream.end();

      return stream;
    });

    scrubbingModels(models, await holding()).streamSimple(model, {
      systemPrompt: `use ${VALUE}`,
      messages: [{ role: "user", content: `key ${VALUE}`, timestamp: 1 }],
    });

    await expect.poll(() => contexts.length).toBe(1);
    expect(JSON.stringify(contexts)).not.toContain(VALUE);
    expect(contexts[0]?.systemPrompt).toBe(`use ${secretReference("API_KEY")}`);
  });

  it("ends a stream whose request fails in the seam with an error event", async () => {
    const { models } = fakeModels(() => {
      throw new Error("provider exploded");
    });

    const stream = scrubbingModels(models, await holding()).streamSimple(model, {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    });

    const events = [];

    for await (const event of stream) events.push(event);

    expect(events).toMatchObject([{ type: "error", reason: "error" }]);
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: "provider exploded",
      provider: "faux",
      model: "faux-1",
    });
  });
});
