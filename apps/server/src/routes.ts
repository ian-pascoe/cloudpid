import { RPC_PATH } from "@cloudpid/protocol";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

// The main Worker's routes (`docs/spec.md` → Client and protocol). Every one is reachable only through the Access gate
// in front of the Worker.

const SESSION_SOCKET_PATH =
  /^\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/socket$/;

const pathOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://localhost").pathname;

/**
 * The Session whose socket `request` opens, if it is a `GET /sessions/:sessionId/socket` (`sessionSocketPath`). The
 * Session DO answers the upgrade. Only Session IDs as the Registry makes them (UUIDs) are routed.
 */
export const sessionSocketId = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined =>
  request.method === "GET" ? SESSION_SOCKET_PATH.exec(pathOf(request))?.[1] : undefined;

/** Whether `request` is a call of `RegistryRpcs`: a `POST` to `RPC_PATH`, with the trailing slash Effect's client adds. */
export const isRegistryRpc = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.method === "POST" && [RPC_PATH, `${RPC_PATH}/`].includes(pathOf(request));
