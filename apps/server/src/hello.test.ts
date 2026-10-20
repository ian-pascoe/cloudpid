/** @effect-diagnostics unstableApiUsage:skip-file */
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { expect, it } from "vitest";
import { hello } from "./hello.ts";

it("responds 200 with a hello body", () => {
  expect(hello.status).toBe(200);

  return expect(HttpServerResponse.toWeb(hello).text()).resolves.toBe("Hello from cloudpid");
});
