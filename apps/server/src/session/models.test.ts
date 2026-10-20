import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_AGENT, proxyModels } from "./models.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("sends the default model's requests to the model proxy with its API key", async () => {
  const requests: Request[] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));

    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "stub" } },
      { status: 400 },
    );
  });

  const models = proxyModels({ url: "https://proxy.example.test", apiKey: "test-key" });
  const model = models.getModel(DEFAULT_AGENT.model.provider, DEFAULT_AGENT.model.modelId);

  expect(model).toBeDefined();
  await models.completeSimple(model!, {
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
  });

  const request = requests[0];

  expect(new URL(request!.url).origin).toBe("https://proxy.example.test");
  expect(request!.headers.get("x-api-key")).toBe("test-key");
});

it("caps the proxied Claude models' context window as the local models.json does", () => {
  const models = proxyModels({ url: "https://proxy.example.test", apiKey: "test-key" });

  expect(models.getModel("anthropic", "claude-opus-5-5")?.contextWindow).toBe(400_000);
  expect(models.getModel("anthropic", "claude-haiku-5-5")?.contextWindow).toBe(400_000);
});
