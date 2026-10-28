import { RPC_PATH } from "@cloudpid/protocol";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

// The main Worker's routes (`docs/spec.md` → Client and protocol). Every one is reachable only through the Access gate
// in front of the Worker.

const SESSION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const SESSION_SOCKET_PATH = new RegExp(`^/sessions/(${SESSION_ID})/socket$`);

const ATTACHMENT_PATH = new RegExp(`^/sessions/(${SESSION_ID})/attachments/([^/]+)$`);

const ASSETS_PREFIX = "/assets/";

const pathOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://localhost").pathname;

/**
 * The Session whose socket `request` opens, if it is a `GET /sessions/:sessionId/socket` (`sessionSocketPath`). The
 * Session DO answers the upgrade. Only Session IDs as the Registry makes them (UUIDs) are routed.
 */
export const sessionSocketId = (request: HttpServerRequest.HttpServerRequest): string | undefined =>
  request.method === "GET" ? SESSION_SOCKET_PATH.exec(pathOf(request))?.[1] : undefined;

/**
 * Whether `request` asks for a file under `/assets/`, where the web build puts its hashed chunks and stylesheets. The
 * asset layer answers one that exists without waking the Worker, so a request that reaches the Worker is for a file
 * the current build does not have (a tab from before a deploy asks for its own build's chunks).
 */
export const isAssetPath = (request: HttpServerRequest.HttpServerRequest): boolean =>
  pathOf(request).startsWith(ASSETS_PREFIX);

/** Whether `request` is a call of `RegistryRpcs`: a `POST` to `RPC_PATH`, with the trailing slash Effect's client adds. */
export const isRegistryRpc = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.method === "POST" && [RPC_PATH, `${RPC_PATH}/`].includes(pathOf(request));

/** An upload (`PUT`) or a removal (`DELETE`) of one of a Session's Attachments. */
export type AttachmentRoute = {
  readonly method: "PUT" | "DELETE";
  readonly sessionId: string;
  /** The name as the client escaped it, decoded; undefined when its escapes cannot be read. */
  readonly name: string | undefined;
};

const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * The Attachment `request` uploads or removes, if it is a `PUT` or `DELETE` of `/sessions/:sessionId/attachments/:name`
 * (`attachmentRoutePath`). The name is one escaped segment; what it decodes to is sanitised before it reaches a path.
 */
export const attachmentRoute = (
  request: HttpServerRequest.HttpServerRequest,
): AttachmentRoute | undefined => {
  if (request.method !== "PUT" && request.method !== "DELETE") return undefined;

  const match = ATTACHMENT_PATH.exec(pathOf(request));
  const [, sessionId, segment] = match ?? [];

  if (sessionId === undefined || segment === undefined) return undefined;

  return { method: request.method, sessionId, name: decodeSegment(segment) };
};
