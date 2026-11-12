// @effect-diagnostics preferEffectArray:off
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SETTINGS,
  FALLBACK_CATALOG,
  type ModelCatalog,
  parseModelId,
} from "@cloudpid/config";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { COMMISSARY_MODELS_PAGE } from "../registry/commissary-models.fixture.ts";
import { parseCommissaryPage } from "../registry/model-catalog.ts";
import { catalogModels, proxyModels } from "./models.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROXY = { url: "https://proxy.example.test", apiKey: "test-key" };

/** The catalog the fixture page of the proxy's list gives. */
const fixtureCatalog = (): ModelCatalog => {
  const parsed = parseCommissaryPage(JSON.stringify(COMMISSARY_MODELS_PAGE));

  if ("problem" in parsed) throw new Error(parsed.problem);

  return { models: parsed.models, fetchedAt: 1 };
};

/** pi-ai's own entry for an anthropic model. */
const piAi = (id: string) =>
  anthropicProvider()
    .getModels()
    .find((model) => model.id === id);

it("sends the default model's requests to the model proxy with its API key", () => {
  const requests: Request[] = [];

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));

    return Promise.resolve(
      Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "stub" } },
        { status: 400 },
      ),
    );
  });

  const models = proxyModels(PROXY);
  const { provider, modelId } = parseModelId(DEFAULT_SETTINGS.model);
  const model = models.getModel(provider, modelId);

  expect(model).toBeDefined();

  return models
    .completeSimple(model!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] })
    .then(() => {
      const request = requests[0];

      expect(new URL(request!.url).origin).toBe("https://proxy.example.test");
      expect(request!.headers.get("x-api-key")).toBe("test-key");
    });
});

it("serves every model of the fallback catalog", () => {
  const models = proxyModels(PROXY);

  for (const { id } of FALLBACK_CATALOG.models) {
    const { provider, modelId } = parseModelId(id);

    expect(models.getModel(provider, modelId), id).toBeDefined();
  }
});

describe("the proxy's catalog as pi-ai models", () => {
  const byId = new Map(
    catalogModels(fixtureCatalog(), PROXY.url).map((model) => [model.id, model]),
  );

  it("lists every model of the proxy's list, as an anthropic model served by the proxy", () => {
    expect(byId.size).toBe(COMMISSARY_MODELS_PAGE.data.length);

    for (const model of byId.values()) {
      expect(model).toMatchObject({
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: PROXY.url,
      });
    }
  });

  it("keeps pi-ai's price and thinking for a Claude model its catalog has, with the proxy's name and limits", () => {
    const opus = byId.get("claude-opus-5-5");

    expect(opus?.cost).toEqual(piAi("claude-opus-5-5")?.cost);
    expect(opus?.thinkingLevelMap).toEqual(piAi("claude-opus-5-5")?.thinkingLevelMap);
    expect(opus?.name).toBe("Claude Opus 5.5");
    // `models.json`'s cap of the window holds; a model it does not cap takes the proxy's.
    expect(opus?.contextWindow).toBe(400_000);
    expect(byId.get("claude-opus-4-6")?.contextWindow).toBe(1_000_000);
    expect(byId.get("claude-opus-4-6")?.cost).toEqual(piAi("claude-opus-4-6")?.cost);
  });

  it("takes a newer Claude model's metadata from the newest of its family pi-ai has", () => {
    const fable = byId.get("claude-fable-5-2");
    const template = piAi("claude-fable-5-1");

    expect(template).toBeDefined();
    expect(piAi("claude-fable-5-2")).toBeUndefined();
    expect(fable).toMatchObject({
      id: "claude-fable-5-2",
      name: "Claude Fable 5.2",
      reasoning: template?.reasoning,
      cost: template?.cost,
      thinkingLevelMap: template?.thinkingLevelMap,
      input: template?.input,
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("makes a model the proxy aliases (one that is not Claude) a generic, unpriced one, never a family's", () => {
    expect(byId.get("claude-fable-5-dd-5-tpg")).toEqual({
      id: "claude-fable-5-dd-5-tpg",
      name: "GPT-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: PROXY.url,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(byId.get("claude-opus-4-6-thinking")?.cost.input).toBe(0);
    expect(byId.get("claude-3-5-haiku-20241022")?.cost.input).toBe(0);
  });

  it("are what the Session's models resolve, following the catalog it holds", () => {
    let held: ModelCatalog = FALLBACK_CATALOG;
    const models = proxyModels(PROXY, () => held);

    expect(models.getModel("anthropic", "claude-fable-5-2")).toBeUndefined();

    held = fixtureCatalog();

    expect(models.getModel("anthropic", "claude-fable-5-2")?.cost).toEqual(
      piAi("claude-fable-5-1")?.cost,
    );
  });
});
