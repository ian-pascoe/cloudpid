import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { expect, it } from "vitest";
import { isRegistryRpc, sessionSocketId } from "./routes.ts";

const request = (method: string, path: string) =>
  HttpServerRequest.fromWeb(new Request(`http://worker.test${path}`, { method }));

const session = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

it("routes a Session's socket by its ID, and nothing else", () => {
  expect(sessionSocketId(request("GET", `/sessions/${session}/socket`))).toBe(session);
  expect(sessionSocketId(request("POST", `/sessions/${session}/socket`))).toBeUndefined();
  expect(sessionSocketId(request("GET", "/sessions/not-a-session/socket"))).toBeUndefined();
  expect(sessionSocketId(request("GET", `/sessions/${session}`))).toBeUndefined();
});

it("routes Registry RPC calls", () => {
  expect(isRegistryRpc(request("POST", "/rpc"))).toBe(true);
  expect(isRegistryRpc(request("GET", "/rpc"))).toBe(false);
  expect(isRegistryRpc(request("POST", "/sessions"))).toBe(false);
});
