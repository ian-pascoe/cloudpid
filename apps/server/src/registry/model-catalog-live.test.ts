// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off processEnv:off preferEffectArray:off -- a live check: plain Promise code over the model proxy.
// The live check of the Model catalog (`docs/architecture/overview.md` → Models, ADR-0052): reads the model proxy's
// (Commissary's) `GET /v1/models` as the Registry does, and checks that it parses into the catalog and into pi-ai models
// the Session can use. It is opt-in: it runs only with the proxy's URL and key in the environment, and is skipped
// without them, as in CI.
//
//   MODEL_PROXY_URL=https://api.ai.ianpascoe.dev MODEL_PROXY_API_KEY=<a Commissary key> \
//     bun --cwd apps/server vitest run src/registry/model-catalog-live.test.ts
import { describe, expect, it } from "vitest";
import { catalogModels } from "../session/models.ts";
import { fetchCommissaryCatalog } from "./model-catalog.ts";

const url = process.env["MODEL_PROXY_URL"];
const apiKey = process.env["MODEL_PROXY_API_KEY"];

describe.skipIf(url === undefined || apiKey === undefined)("the model proxy's live catalog", () => {
  it("parses into the Model catalog and into pi-ai models", async () => {
    const models = await fetchCommissaryCatalog(
      { url: url ?? "", apiKey: apiKey ?? "" },
      fetch,
      AbortSignal.timeout(15_000),
    );

    expect(models.length).toBeGreaterThan(0);

    for (const model of models) {
      expect(model.id).toMatch(/^anthropic\/\S+$/);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
    }

    const piAi = catalogModels({ models, fetchedAt: Date.now() }, url ?? "");

    expect(piAi).toHaveLength(models.length);
    expect(piAi.find((model) => model.id === "claude-opus-5-5")?.cost.input).toBeGreaterThan(0);
  });
});
