import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, parseModelId, SUPPORTED_MODELS } from "@cloudpid/config";
import { proxyModels } from "./models.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  const models = proxyModels({ url: "https://proxy.example.test", apiKey: "test-key" });
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

it("caps the proxied Claude models' context window as the local models.json does", () => {
  const models = proxyModels({ url: "https://proxy.example.test", apiKey: "test-key" });

  expect(models.getModel("anthropic", "claude-opus-5-5")?.contextWindow).toBe(400_000);
  expect(models.getModel("anthropic", "claude-haiku-5-5")?.contextWindow).toBe(400_000);
});

it("serves every model the settings accept", () => {
  const models = proxyModels({ url: "https://proxy.example.test", apiKey: "test-key" });

  for (const id of SUPPORTED_MODELS) {
    const { provider, modelId } = parseModelId(id);

    expect(models.getModel(provider, modelId), id).toBeDefined();
  }
});
