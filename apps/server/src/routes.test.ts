import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { expect, it } from "vitest";
import { attachmentRoute, isAssetPath, isRegistryRpc, sessionSocketId } from "./routes.ts";

const request = (method: string, path: string) =>
  HttpServerRequest.fromWeb(new Request(`http://worker.test${path}`, { method }));

const session = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

it("routes a Session's socket by its ID, and nothing else", () => {
  expect(sessionSocketId(request("GET", `/sessions/${session}/socket`))).toBe(session);
  expect(sessionSocketId(request("POST", `/sessions/${session}/socket`))).toBeUndefined();
  expect(sessionSocketId(request("GET", "/sessions/not-a-session/socket"))).toBeUndefined();
  expect(sessionSocketId(request("GET", `/sessions/${session}`))).toBeUndefined();
});

it("knows a request for a file under /assets/, whatever the method", () => {
  expect(isAssetPath(request("GET", "/assets/patch-view-iLOTrZXd.js"))).toBe(true);
  expect(isAssetPath(request("GET", "/assets/index-CDZ3SOBd.css?v=1"))).toBe(true);
  expect(isAssetPath(request("HEAD", "/assets/a/b.js"))).toBe(true);
  expect(isAssetPath(request("GET", "/assets"))).toBe(false);
  expect(isAssetPath(request("GET", "/assetsx/a.js"))).toBe(false);
  expect(isAssetPath(request("GET", `/sessions/${session}`))).toBe(false);
  expect(isAssetPath(request("GET", `/sessions/${session}/assets/a.js`))).toBe(false);
  expect(isAssetPath(request("GET", "/"))).toBe(false);
});

it("routes Registry RPC calls", () => {
  expect(isRegistryRpc(request("POST", "/rpc"))).toBe(true);
  expect(isRegistryRpc(request("POST", "/rpc/"))).toBe(true);
  expect(isRegistryRpc(request("GET", "/rpc"))).toBe(false);
  expect(isRegistryRpc(request("POST", "/sessions"))).toBe(false);
});

it("routes an upload or a removal of a Session's Attachment, its name decoded", () => {
  expect(attachmentRoute(request("PUT", `/sessions/${session}/attachments/a%20b.png`))).toEqual({
    method: "PUT",
    sessionId: session,
    name: "a b.png",
  });
  expect(attachmentRoute(request("DELETE", `/sessions/${session}/attachments/a.png`))).toEqual({
    method: "DELETE",
    sessionId: session,
    name: "a.png",
  });
  // An escaped slash stays in the one name, which the upload then sanitises.
  expect(attachmentRoute(request("PUT", `/sessions/${session}/attachments/..%2F..%2Fx`))).toEqual({
    method: "PUT",
    sessionId: session,
    name: "../../x",
  });
  expect(attachmentRoute(request("GET", `/sessions/${session}/attachments/a.png`))).toBeUndefined();
  expect(attachmentRoute(request("PUT", `/sessions/${session}/attachments/a/b`))).toBeUndefined();
  expect(attachmentRoute(request("PUT", `/sessions/${session}/attachments/`))).toBeUndefined();
  expect(attachmentRoute(request("PUT", "/sessions/nope/attachments/a.png"))).toBeUndefined();
  expect(attachmentRoute(request("PUT", `/sessions/${session}/attachments/%E0%A4%A`))).toEqual({
    method: "PUT",
    sessionId: session,
    name: undefined,
  });
});
