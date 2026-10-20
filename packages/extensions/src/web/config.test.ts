// @effect-diagnostics asyncFunction:off strictEffectProvide:off missedPipeableOpportunity:off
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import { WebConfig, WebConfigLive } from "./config.ts";

const read = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.service(WebConfig).pipe(
      Effect.provide(
        WebConfigLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
      ),
    ),
  );

it("reads both keys as redacted values", async () => {
  const config = await read({ EXA_API_KEY: "exa-secret", PARALLEL_API_KEY: "par-secret" });

  expect(Option.map(config.exaApiKey, Redacted.value)).toEqual(Option.some("exa-secret"));
  expect(Option.map(config.parallelApiKey, Redacted.value)).toEqual(Option.some("par-secret"));
  expect(String(config.exaApiKey)).not.toContain("exa-secret");
});

it("treats an unset key, and an empty one, as absent", async () => {
  const config = await read({ PARALLEL_API_KEY: "" });

  expect(Option.isNone(config.exaApiKey)).toBe(true);
  expect(Option.isNone(config.parallelApiKey)).toBe(true);
});
