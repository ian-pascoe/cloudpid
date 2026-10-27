import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { expect, it } from "vitest";
import { missingAsset } from "./missing-asset.ts";

it("answers a missing asset with a 404 that is not cached, never a 200", () => {
  const response = HttpServerResponse.toWeb(missingAsset);

  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
