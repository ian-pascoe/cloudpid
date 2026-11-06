// docs/architecture/mcp-apps.md → The bridge, Testing. A fake iframe for the tests of the frame protocol and of the App View's
// bridge on it: the page's window with the proxy frame in it (what is posted to the frame is recorded, and a message event is
// delivered from it or from another window or origin), and the View's side of the handshake by hand.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off -- recorded messages in native lists.
import { MCP_APPS_PROTOCOL_VERSION, type IncomingMessage } from "./frame-protocol.ts";

export const ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";
export const EVIL = "https://evil.example";

export type Post = { readonly data: Record<string, unknown>; readonly target: string };

/** The page's window and the proxy frame in it, as the bridge sees them. */
export const fakePage = () => {
  const listeners = new Set<(message: IncomingMessage) => void>();
  const posts: Post[] = [];

  const frame = {
    postMessage: (data: unknown, target: string) => {
      // SAFETY: the bridge posts JSON-RPC objects.
      posts.push({ data: data as Record<string, unknown>, target });
    },
  };

  const other = { postMessage: () => undefined };

  return {
    listeners,
    posts,
    frame,
    other,
    listen: (handler: (message: IncomingMessage) => void) => {
      listeners.add(handler);

      return () => listeners.delete(handler);
    },
    /** A message event of the page's window. */
    deliver: (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
      for (const listener of Array.from(listeners)) {
        listener({
          source: "source" in from ? from.source : frame,
          origin: from.origin ?? ORIGIN,
          data,
        });
      }
    },
  };
};

export const rpc = (method: string, params: unknown = {}, id?: number) => {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method, params };

  if (id !== undefined) message["id"] = id;

  return message;
};

export const HTML = "<main>view</main>";

export const sent = (page: ReturnType<typeof fakePage>) => page.posts.map((post) => post.data);

export const methodsOf = (page: ReturnType<typeof fakePage>) =>
  page.posts.flatMap((post) =>
    typeof post.data["method"] === "string" ? [post.data["method"]] : [],
  );

/** Drive the View's side of the handshake by hand. */
export const handshake = (page: ReturnType<typeof fakePage>) => {
  page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
  page.deliver(
    rpc(
      "ui/initialize",
      {
        appInfo: { name: "view", version: "1" },
        appCapabilities: {},
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      },
      1,
    ),
  );
  page.deliver(rpc("ui/notifications/initialized"));
};
