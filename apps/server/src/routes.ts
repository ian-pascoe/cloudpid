import { RPC_PATH } from "@cloudpid/protocol";
import { MCP_ROUTE } from "@cloudpid/protocol/mcp-api";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

// The main Worker's routes (`docs/architecture/client-and-protocol.md`). Every one sits behind the Access guard (`access.ts`),
// which verifies the assertion Access adds in front of the Worker.

const SESSION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const SESSION_SOCKET_PATH = new RegExp(`^/sessions/(${SESSION_ID})/socket$`);

const ATTACHMENT_PATH = new RegExp(`^/sessions/(${SESSION_ID})/attachments/([^/]+)$`);

const ASSETS_PREFIX = "/assets/";

// Normalises through `URL`: dot segments and `%2e` are resolved, and a bare `//…` is read as a host. The public sign-in paths
// are matched on the path as it was sent instead (`rawPathOf`, sign-in-routes.ts); do not unify the two.
const pathOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://localhost").pathname;

/**
 * Whether `request` is for the MCP endpoint: its path, normalised as the router reads every path, is exactly `/mcp`. The
 * guard asks the same, so the audience it checks and the route that serves can never disagree; any other form (`/mcp/`,
 * `/MCP`, a sub-path) is a main route, where the endpoint's audience is refused.
 */
export const isMcpRoute = (request: HttpServerRequest.HttpServerRequest): boolean =>
  pathOf(request) === MCP_ROUTE;

/**
 * The Session whose socket `request` opens, if it is a `GET /sessions/:sessionId/socket` (`sessionSocketPath`). The
 * Session DO answers the upgrade. Only Session IDs as the Registry makes them (UUIDs) are routed.
 */
export const sessionSocketId = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined =>
  request.method === "GET" ? SESSION_SOCKET_PATH.exec(pathOf(request))?.[1] : undefined;

/**
 * Whether `request` asks for a file under `/assets/`, where the web build puts its hashed chunks and stylesheets. The
 * Worker serves one that exists from the asset layer after its guard (`serveAsset`); one the current build does not
 * have is a 404 (a tab from before a deploy asks for its own build's chunks).
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
